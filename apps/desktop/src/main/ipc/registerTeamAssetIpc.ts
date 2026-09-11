/**
 * Team Registry 信封资产（工作流 / 平台 Agent / 子应用）推拉 IPC（M3/M4）。
 *
 * 与 registerWorkflowBundleIpc 同构：领域逻辑在 agent-runtime 的
 * TeamAssetService（信封编排 + 版本比对 + pins 锚点），本模块只提供
 * 三类资产的 TeamAssetPort 适配（真实仓库读写）与 handler 装配；
 * Agent 安装后的运行时副作用（RuntimeComposition / pushConfigChanged）
 * 经 deps 注入在 handler 层补触发，保持端口纯 DB 语义。
 *
 * 信封语义：安装「新建」一律落为草稿/禁用态，由使用者确认后启用；
 * 「更新」只覆盖内容字段，保留本地 status/enabled 等运行状态。
 */
import { randomUUID } from 'node:crypto'

import { createLogger } from '@spark/shared'
import {
  TeamAssetService,
  TeamRegistryConfigStore,
  slugifyAssetName,
  type TeamAssetPort,
} from '@spark/agent-runtime'
import type { TeamAssetEnvelope } from '@spark/agent-runtime'
import {
  AgentRepository,
  SubAppRepository,
  TeamAssetPinsRepository,
  WorkflowRepository,
} from '@spark/storage'
import type { WorkflowItem } from '@spark/storage'
import type { SubAppManifest } from '@spark/protocol'

import { getDatabase } from './db.js'
import { typedIpcHandle } from './typed-ipc.js'
import { SparkError } from '@spark/shared'

const log = createLogger('team-asset-ipc')

export interface TeamAssetIpcDeps {
  /** 工作流图环/条件引用校验（与 workflow:create/update 同一实现） */
  assertWorkflowGraphValid: (graph: unknown) => void
  /** Agent 安装/更新后的运行时提示词与技能配置刷新 */
  refreshAgentRuntime: (agentId: string, prompt: string, skillIds: string[], disabledSkillIds: string[]) => void
  /** 配置变更广播（agent install/update 后触发渲染端刷新） */
  pushConfigChanged: (kind: string, action: string, id: string) => void
}

// ─── workflow 端口 ──────────────────────────────────────────────────────

function createWorkflowPort(deps: TeamAssetIpcDeps): TeamAssetPort {
  const repo = () => new WorkflowRepository(getDatabase())
  return {
    buildPayload(localId) {
      const item: WorkflowItem | null = repo().get(localId)
      if (!item) return null
      return {
        name: item.name,
        description: item.description,
        payload: {
          kind: 'workflow',
          graph: item.graph as Record<string, unknown>,
          meta: { scope: item.scope, status: item.status, tags: item.tags, enabled: item.enabled },
        },
      }
    },
    findInstalledLocalId(slug) {
      for (const item of repo().list({ includeArchived: true })) {
        if (slugifyAssetName(item.name, 'wf') === slug) return item.id
      }
      return null
    },
    installFromPayload(envelope, existingLocalId) {
      if (envelope.payload.kind !== 'workflow') throw new Error('信封载荷不是工作流类型')
      const { graph, meta } = envelope.payload
      const metaTags = meta && typeof meta === 'object' && Array.isArray((meta as { tags?: unknown }).tags)
        ? ((meta as { tags: string[] }).tags ?? [])
        : []
      if (existingLocalId != null) {
        const updated = repo().update(existingLocalId, {
          name: envelope.name,
          version: envelope.version,
          description: envelope.description,
          graph,
          tags: metaTags,
          // 更新保留本地 status/enabled（运行状态归本地）
        })
        if (!updated) throw new Error(`本地工作流不存在，无法更新：${existingLocalId}`)
        return { localId: existingLocalId, updatedExisting: true }
      }
      const created = repo().create({
        name: envelope.name,
        version: envelope.version,
        description: envelope.description,
        graph,
        tags: metaTags,
        status: 'draft',
        enabled: false,
      })
      return { localId: created.id, updatedExisting: false }
    },
    validatePayload(envelope) {
      if (envelope.payload.kind !== 'workflow') return
      deps.assertWorkflowGraphValid(envelope.payload.graph)
    },
  }
}

// ─── agent 端口 ─────────────────────────────────────────────────────────

/** Agent 信封载荷形状（与 agent:export-to-file 的 AgentExportPayload 单条目一致） */
interface TeamAgentEntry {
  name: string
  description: string
  agentAdapter: string
  permissionMode: string
  reasoningEffort: string
  prompt: string
  skillIds: string[]
  disabledSkillIds: string[]
  ruleIds: string[]
  hookConfig: Record<string, unknown>
  workflowId: string | null
  metadata: Record<string, unknown>
}

function createAgentPort(): TeamAssetPort {
  const repo = () => new AgentRepository(getDatabase())
  return {
    buildPayload(localId) {
      const item = repo().get(localId)
      if (!item) return null
      const entry: TeamAgentEntry = {
        name: item.name,
        description: item.description,
        agentAdapter: item.agentAdapter,
        permissionMode: item.permissionMode,
        reasoningEffort: item.reasoningEffort,
        prompt: item.prompt,
        skillIds: item.skillIds,
        disabledSkillIds: item.disabledSkillIds,
        ruleIds: item.ruleIds,
        hookConfig: item.hookConfig,
        workflowId: item.workflowId ?? null,
        metadata: item.metadata,
      }
      return {
        name: item.name,
        description: item.description,
        payload: { kind: 'agent-config', config: entry as unknown as Record<string, unknown> },
        warnings: [
          '技能 / 规则 / 工作流引用是机器本地 id——对方机器需存在同 id 的资产才能完整生效。',
        ],
      }
    },
    findInstalledLocalId(slug) {
      for (const item of repo().list({ includeDisabled: true })) {
        if (slugifyAssetName(item.name, 'agent') === slug) return item.id
      }
      return null
    },
    installFromPayload(envelope, existingLocalId) {
      if (envelope.payload.kind !== 'agent-config') throw new Error('信封载荷不是 Agent 配置类型')
      const entry = envelope.payload.config as unknown as TeamAgentEntry
      const fields = {
        name: envelope.name,
        description: envelope.description,
        agentAdapter: entry.agentAdapter,
        permissionMode: entry.permissionMode,
        reasoningEffort: entry.reasoningEffort,
        prompt: entry.prompt,
        skillIds: entry.skillIds,
        disabledSkillIds: entry.disabledSkillIds,
        ruleIds: entry.ruleIds,
        hookConfig: entry.hookConfig,
        workflowId: entry.workflowId,
        metadata: entry.metadata,
      }
      if (existingLocalId != null) {
        const updated = repo().update(existingLocalId, fields)
        if (!updated) throw new Error(`本地 Agent 不存在，无法更新：${existingLocalId}`)
        return { localId: existingLocalId, updatedExisting: true }
      }
      const created = repo().create(fields)
      return { localId: created.id, updatedExisting: false }
    },
  }
}

// ─── app（子应用）端口 ──────────────────────────────────────────────────

function createAppPort(): TeamAssetPort {
  const repo = () => new SubAppRepository(getDatabase())
  return {
    buildPayload(localId) {
      const details = repo().get(localId)
      if (!details) return null
      if (details.draft.format === 'v2') {
        throw new Error('V2 多文件子应用暂不支持发布到团队（当前支持 V1 单文件应用）')
      }
      const manifest = details.draft.manifest
      const entry = manifest.entry || 'index.html'
      return {
        name: details.name,
        description: details.description,
        payload: {
          kind: 'app-release',
          files: [{ path: entry, content: details.draft.source }],
          entry,
          manifest: { ...manifest, draftConfig: details.draft.config },
        },
        warnings: [
          '子应用在对方机器以「新草稿」安装，需对方确认并发布后才会出现在应用入口。',
        ],
      }
    },
    findInstalledLocalId(slug) {
      for (const item of repo().list({ includeArchived: true }).items) {
        if (slugifyAssetName(item.name, 'app') === slug) return item.id
      }
      return null
    },
    installFromPayload(envelope, existingLocalId) {
      if (envelope.payload.kind !== 'app-release') throw new Error('信封载荷不是子应用类型')
      const { files, entry } = envelope.payload
      const source = files.find((f) => f.path === entry) ?? files[0]
      if (!source) throw new Error(`子应用信封缺少入口文件内容：${envelope.slug}`)
      const raw = (envelope.payload.manifest ?? {}) as Record<string, unknown>
      const draftConfig =
        raw.draftConfig != null && typeof raw.draftConfig === 'object'
          ? (raw.draftConfig as Record<string, unknown>)
          : {}
      const manifest: SubAppManifest = {
        name: envelope.name,
        description: envelope.description,
        icon: typeof raw.icon === 'string' ? raw.icon : null,
        entry: typeof raw.entry === 'string' && raw.entry ? raw.entry : entry,
        surface: (typeof raw.surface === 'string' ? raw.surface : 'content') as SubAppManifest['surface'],
        permissions: Array.isArray(raw.permissions) ? (raw.permissions as string[]) : [],
      }
      if (existingLocalId != null) {
        const details = repo().get(existingLocalId)
        if (!details) throw new Error(`本地子应用不存在，无法更新：${existingLocalId}`)
        const patched = repo().updateDraft(existingLocalId, details.draft.revision, {
          name: manifest.name,
          description: manifest.description,
          icon: manifest.icon,
          entry: manifest.entry,
          surface: manifest.surface,
          permissions: manifest.permissions,
          source: source.content,
          config: draftConfig,
        })
        if (!patched) throw new Error('子应用草稿更新失败（可能正被编辑，请稍后重试）')
        return { localId: existingLocalId, updatedExisting: true }
      }
      const created = repo().importApp({
        id: randomUUID(),
        manifest,
        draft: { source: source.content, config: draftConfig },
        releases: [],
        publishedVersion: null,
        data: [],
      })
      return { localId: created.id, updatedExisting: false }
    },
  }
}

// ─── 服务单例 + handler ─────────────────────────────────────────────────

let _service: TeamAssetService | null = null
function getTeamAssetService(): TeamAssetService {
  if (_service == null) {
    throw new Error('TeamAssetService 未初始化（registerTeamAssetIpc 未调用）')
  }
  return _service
}

/** 对齐 ipc/index.ts 的 runTeamRegistryTask：业务 Error → SparkError 透传 */
async function runAssetTask<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (err) {
    if (err instanceof SparkError) throw err
    throw new SparkError('UNKNOWN', err instanceof Error ? err.message : String(err))
  }
}

export function registerTeamAssetIpc(deps: TeamAssetIpcDeps): void {
  const db = getDatabase()
  _service = new TeamAssetService(
    new TeamRegistryConfigStore(db),
    {
      workflow: createWorkflowPort(deps),
      agent: createAgentPort(),
      app: createAppPort(),
    },
    new TeamAssetPinsRepository(db),
  )
  const service = () => getTeamAssetService()

  typedIpcHandle('team-registry:list-assets', async (req) =>
    runAssetTask(async () => {
      const items = await service().listTeamAssets(req.assetType)
      return { items }
    }),
  )

  typedIpcHandle('team-registry:publish-asset', async (req) =>
    runAssetTask(async () => {
      log.info(
        `team-registry:publish-asset requested, assetType=${req.assetType}, localId=${req.localId}, version=${req.version ?? 'auto-bump'}`,
      )
      const result = await service().publishToTeam(req.assetType, req.localId, {
        ...(req.version !== undefined ? { version: req.version } : {}),
      })
      return {
        slug: result.slug,
        name: result.name,
        version: result.version,
        previousRemoteVersion: result.previousRemoteVersion,
        warnings: result.warnings,
      }
    }),
  )

  typedIpcHandle('team-registry:install-asset', async (req) =>
    runAssetTask(async () => {
      log.info(`team-registry:install-asset requested, assetType=${req.assetType}, slug=${req.slug}`)
      const result = await service().installFromTeam(req.assetType, req.slug)
      // Agent 安装/更新后补运行时副作用（提示词/技能配置刷新 + 变更广播）
      if (req.assetType === 'agent') {
        const agent = new AgentRepository(db).get(result.localId)
        if (agent) {
          deps.refreshAgentRuntime(agent.id, agent.prompt, agent.skillIds, agent.disabledSkillIds)
          deps.pushConfigChanged('agent', result.updatedExisting ? 'update' : 'create', agent.id)
        }
      }
      return {
        slug: result.slug,
        name: result.name,
        version: result.version,
        localId: result.localId,
        updatedExisting: result.updatedExisting,
      }
    }),
  )

  typedIpcHandle('team-registry:list-asset-updates', async (req) =>
    runAssetTask(async () => {
      const updates = await service().listTeamUpdates(req.assetType)
      return { updates }
    }),
  )
}
