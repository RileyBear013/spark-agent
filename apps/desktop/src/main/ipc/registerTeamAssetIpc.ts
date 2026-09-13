/**
 * Team Registry 信封资产（工作流 / 平台 Agent / 子应用）推拉 IPC（M3/M4）。
 *
 * 与 registerWorkflowBundleIpc 同构：领域逻辑在 agent-runtime 的
 * TeamAssetService（信封编排 + 版本比对 + pins 锚点），本模块只提供
 * 三类资产的 TeamAssetPort 适配（真实仓库读写）与 handler 装配；
 * Agent 安装后的运行时副作用（RuntimeComposition / pushConfigChanged）
 * 经 deps 注入在 handler 层补触发，保持端口纯 DB 语义。
 *
 * v2 自包含（2026-09-12）：发布载荷内联全部运行依赖——图/Agent 引用的技能
 * （完整文件，二进制 base64 保真）、MCP 配置（密钥脱敏）、被引用的平台
 * Agent（级联其技能/MCP）；安装侧经 TeamBundleInstaller 以确定性 id 幂等
 * 物化（bundle 技能 + 禁用 MCP + 停用 Agent + workflow_bundles 登记），
 * 并改写图/Agent 引用。对方空机器安装即可运行，不可移植项走 warnings 显式可见。
 *
 * 信封语义：安装「新建」一律落为草稿/停用态，由使用者确认后启用；
 * 「更新」只覆盖内容字段，保留本地 status/enabled 等运行状态。
 */
import { randomUUID } from 'node:crypto'

import { createLogger, SparkError } from '@spark/shared'
import {
  TeamAssetService,
  TeamRegistryConfigStore,
  TeamBundleInstaller,
  bundlePublishWarnings,
  collectGraphDependencies,
  collectTeamBundle,
  isBundleEmpty,
  rewriteGraphReferences,
  slugifyAssetName,
  computeNormalizedPayloadChecksum,
  type TeamAssetPort,
  type TeamBundleCollectorDeps,
  type TeamBundleMaterializeResult,
  type TeamBundleSpec,
  type TeamBundleUnresolved,
} from '@spark/agent-runtime'
import type { TeamAssetEnvelope } from '@spark/agent-runtime'
import type { WorkflowGraph } from '@spark/protocol'
import type { SubAppManifest } from '@spark/protocol'
import {
  AgentRepository,
  McpServerRepository,
  SkillRepository,
  SubAppRepository,
  TeamAssetPinsRepository,
  WorkflowBundleRepository,
  WorkflowRepository,
} from '@spark/storage'
import type { WorkflowItem } from '@spark/storage'

import { getAppSkillsManager } from '../services/AppSkillsManager.js'
import { getDatabase } from '../db.js'
import { typedIpcHandle } from './typed-ipc.js'

const log = createLogger('team-asset-ipc')

export interface TeamAssetIpcDeps {
  /** 工作流图环/条件引用校验（与 workflow:create/update 同一实现） */
  assertWorkflowGraphValid: (graph: unknown) => void
  /** Agent 安装/更新后的运行时提示词与技能配置刷新 */
  refreshAgentRuntime: (agentId: string, prompt: string, skillIds: string[], disabledSkillIds: string[]) => void
  /**
   * 配置变更广播（agent install/update 后触发渲染端刷新）。
   * 签名收敛为实际用到的字面量子集：与 ipc/index.ts 的 pushConfigChanged
   * （ConfigChangedScope/Action 联合）在 strictFunctionTypes 下双向兼容。
   */
  pushConfigChanged: (scope: 'agent', action: 'create' | 'update' | 'delete' | 'import', id: string) => void
}

// ─── 捆绑收集/物化的公共装配 ────────────────────────────────────────────

/** 发布方仓库查找口（ collector 只做查行，目录收集在 agent-runtime 侧完成） */
function makeCollectorDeps(): TeamBundleCollectorDeps {
  const db = getDatabase()
  const skills = new SkillRepository(db)
  const mcps = new McpServerRepository(db)
  const agents = new AgentRepository(db)
  return {
    getSkill: (id) => skills.get(id) ?? null,
    getMcp: (id) => mcps.get(id) ?? null,
    getAgent: (id) => {
      const a = agents.get(id)
      if (!a) return null
      return {
        id: a.id,
        name: a.name,
        description: a.description,
        agentAdapter: a.agentAdapter,
        permissionMode: a.permissionMode,
        reasoningEffort: a.reasoningEffort,
        prompt: a.prompt,
        skillIds: a.skillIds,
        disabledSkillIds: a.disabledSkillIds,
        mcpServerIds: a.mcpServerIds ?? [],
        ruleIds: a.ruleIds,
        hookConfig: a.hookConfig,
        workflowId: a.workflowId ?? null,
        metadata: a.metadata,
      }
    },
    listMcpNames: () => mcps.listAll().map((r) => ({ id: r.id, name: r.name })),
  }
}

let _installer: TeamBundleInstaller | null = null
function getInstaller(): TeamBundleInstaller {
  if (_installer == null) {
    const db = getDatabase()
    _installer = new TeamBundleInstaller({
      skills: new SkillRepository(db),
      mcps: new McpServerRepository(db),
      agents: new AgentRepository(db),
      bundles: new WorkflowBundleRepository(db),
      userSkillsDir: getAppSkillsManager().userDir,
    })
  }
  return _installer
}

/** 信封 → 捆绑物化（空捆绑返回 null，不产生任何落位） */
async function materializeBundle(
  envelope: TeamAssetEnvelope,
): Promise<TeamBundleMaterializeResult | null> {
  const bundle = (envelope.payload as { bundle?: TeamBundleSpec }).bundle
  if (!bundle || isBundleEmpty(bundle)) return null
  const assetType = envelope.assetType
  if (assetType !== 'workflow' && assetType !== 'agent' && assetType !== 'app') {
    throw new Error(`捆绑物化不支持该资产类型：${assetType}`)
  }
  return getInstaller().materialize(bundle, {
    bundleId: `team-${assetType}-${envelope.slug}`,
    assetType,
    slug: envelope.slug,
    assetName: envelope.name,
    version: envelope.version,
    ...(envelope.author ? { author: envelope.author } : {}),
    ...(envelope.description ? { description: envelope.description } : {}),
  })
}

/**
 * 安装完成后的本地载荷 checksum：pins 记录该基准（而非远端信封 checksum），
 * 六态判定才能正确处理 v2 捆绑的图引用改写（本地 payload 与远端逐字节不可比）。
 */
async function installedLocalChecksumOf(
  self: TeamAssetPort,
  localId: string,
): Promise<{ installedLocalChecksum?: string }> {
  const payload = (await self.buildPayload(localId))?.payload
  return payload ? { installedLocalChecksum: computeNormalizedPayloadChecksum(payload) } : {}
}

// ─── workflow 端口 ──────────────────────────────────────────────────────

function createWorkflowPort(deps: TeamAssetIpcDeps): TeamAssetPort {
  const repo = () => new WorkflowRepository(getDatabase())
  const self: TeamAssetPort = {
    async buildPayload(localId) {
      const item: WorkflowItem | null = repo().get(localId)
      if (!item) return null
      const graph = item.graph as Record<string, unknown>
      const graphDeps = collectGraphDependencies(graph as unknown as WorkflowGraph)
      const unresolved: TeamBundleUnresolved[] = [
        ...graphDeps.ruleIds.map(
          (id): TeamBundleUnresolved => ({ type: 'rule', name: id, hint: '规则不随包迁移，安装后需重新选择' }),
        ),
        ...graphDeps.toolIds.map(
          (id): TeamBundleUnresolved => ({
            type: 'tool',
            name: id,
            hint: '自定义工具不随包迁移（内置工具不受影响），安装后请核对',
          }),
        ),
      ]
      const bundle = await collectTeamBundle({
        deps: makeCollectorDeps(),
        skillOriginIds: graphDeps.skillIds,
        mcpOriginIds: graphDeps.mcpServerIds,
        agentOriginIds: graphDeps.agentIds,
        extraUnresolved: unresolved,
      })
      return {
        name: item.name,
        description: item.description,
        payload: {
          kind: 'workflow',
          graph,
          meta: { scope: item.scope, status: item.status, tags: item.tags, enabled: item.enabled },
          bundle,
        },
        warnings: bundlePublishWarnings(bundle),
      }
    },
    findInstalledLocalId(slug) {
      for (const item of repo().list({ includeArchived: true })) {
        if (slugifyAssetName(item.name, 'wf') === slug) return item.id
      }
      return null
    },
    async installFromPayload(envelope, existingLocalId) {
      if (envelope.payload.kind !== 'workflow') throw new Error('信封载荷不是工作流类型')
      const { graph, meta } = envelope.payload
      const metaTags = meta && typeof meta === 'object' && Array.isArray((meta as { tags?: unknown }).tags)
        ? ((meta as { tags: string[] }).tags ?? [])
        : []
      // 捆绑先物化（技能/MCP/Agent 落位 + 引用映射），再改写图引用
      const mat = await materializeBundle(envelope)
      let finalGraph = graph
      if (mat) {
        finalGraph = rewriteGraphReferences(graph as unknown as WorkflowGraph, {
          skillIdMap: mat.skillIdMap,
          mcpServerIdMap: mat.mcpIdMap,
          agentIdMap: mat.agentIdMap,
        }) as unknown as Record<string, unknown>
      }
      try {
        if (existingLocalId != null) {
          const updated = repo().update(existingLocalId, {
            name: envelope.name,
            version: envelope.version,
            description: envelope.description,
            graph: finalGraph,
            tags: metaTags,
            // 更新保留本地 status/enabled（运行状态归本地）
          })
          if (!updated) throw new Error(`本地工作流不存在，无法更新：${existingLocalId}`)
          return {
            localId: existingLocalId,
            updatedExisting: true,
            ...(await installedLocalChecksumOf(self, existingLocalId)),
            ...(mat?.createdAgentIds.length ? { createdAgentIds: mat.createdAgentIds } : {}),
            ...(mat?.warnings.length ? { warnings: mat.warnings } : {}),
          }
        }
        const created = repo().create({
          name: envelope.name,
          version: envelope.version,
          description: envelope.description,
          graph: finalGraph,
          tags: metaTags,
          status: 'draft',
          enabled: false,
        })
        return {
          localId: created.id,
          updatedExisting: false,
          ...(await installedLocalChecksumOf(self, created.id)),
          ...(mat?.createdAgentIds.length ? { createdAgentIds: mat.createdAgentIds } : {}),
          ...(mat?.warnings.length ? { warnings: mat.warnings } : {}),
        }
      } catch (err) {
        if (mat) await getInstaller().rollback(mat)
        throw err
      }
    },
    validatePayload(envelope) {
      if (envelope.payload.kind !== 'workflow') return
      deps.assertWorkflowGraphValid(envelope.payload.graph)
    },
  }
  return self
}

// ─── agent 端口 ─────────────────────────────────────────────────────────

/** Agent 信封载荷形状（与 agent:export-to-file 的 AgentExportPayload 单条目一致；v2 加 mcpServerIds） */
interface TeamAgentEntry {
  name: string
  description: string
  agentAdapter: string
  permissionMode: string
  reasoningEffort: string
  prompt: string
  skillIds: string[]
  disabledSkillIds: string[]
  mcpServerIds: string[]
  ruleIds: string[]
  hookConfig: Record<string, unknown>
  workflowId: string | null
  metadata: Record<string, unknown>
}

function createAgentPort(): TeamAssetPort {
  const repo = () => new AgentRepository(getDatabase())
  const self: TeamAssetPort = {
    async buildPayload(localId) {
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
        mcpServerIds: item.mcpServerIds ?? [],
        ruleIds: item.ruleIds,
        hookConfig: item.hookConfig,
        workflowId: item.workflowId ?? null,
        metadata: item.metadata,
      }
      const unresolved: TeamBundleUnresolved[] = [
        ...entry.ruleIds.map(
          (id): TeamBundleUnresolved => ({ type: 'rule', name: id, hint: '规则不随包迁移，安装后需重新选择' }),
        ),
        ...(entry.workflowId
          ? [
              {
                type: 'workflow' as const,
                name: entry.workflowId,
                hint: '绑定的团队工作流不随 Agent 包携带，接收方需单独安装或重建',
              },
            ]
          : []),
      ]
      const bundle = await collectTeamBundle({
        deps: makeCollectorDeps(),
        // 内建技能（builtin: 前缀）在收集器内静默跳过——目标环境必有
        skillOriginIds: [...entry.skillIds, ...entry.disabledSkillIds],
        mcpOriginIds: entry.mcpServerIds,
        agentOriginIds: [],
        extraUnresolved: unresolved,
      })
      return {
        name: item.name,
        description: item.description,
        payload: { kind: 'agent-config', config: entry as unknown as Record<string, unknown>, bundle },
        warnings: bundlePublishWarnings(bundle),
      }
    },
    findInstalledLocalId(slug) {
      for (const item of repo().list({ includeDisabled: true })) {
        if (slugifyAssetName(item.name, 'agent') === slug) return item.id
      }
      return null
    },
    async installFromPayload(envelope, existingLocalId) {
      if (envelope.payload.kind !== 'agent-config') throw new Error('信封载荷不是 Agent 配置类型')
      const entry = envelope.payload.config as unknown as TeamAgentEntry
      const mat = await materializeBundle(envelope)
      const remap = (ids: string[], map: Map<string, string>) => ids.map((id) => map.get(id) ?? id)
      const fields = {
        name: envelope.name,
        description: envelope.description,
        agentAdapter: entry.agentAdapter,
        permissionMode: entry.permissionMode,
        reasoningEffort: entry.reasoningEffort,
        prompt: entry.prompt,
        skillIds: mat ? remap(entry.skillIds, mat.skillIdMap) : entry.skillIds,
        disabledSkillIds: mat ? remap(entry.disabledSkillIds, mat.skillIdMap) : entry.disabledSkillIds,
        mcpServerIds: mat ? remap(entry.mcpServerIds ?? [], mat.mcpIdMap) : (entry.mcpServerIds ?? []),
        ruleIds: entry.ruleIds,
        hookConfig: entry.hookConfig,
        workflowId: entry.workflowId,
        metadata: entry.metadata,
      }
      try {
        if (existingLocalId != null) {
          const updated = repo().update(existingLocalId, fields)
          if (!updated) throw new Error(`本地 Agent 不存在，无法更新：${existingLocalId}`)
          return {
            localId: existingLocalId,
            updatedExisting: true,
            ...(await installedLocalChecksumOf(self, existingLocalId)),
            ...(mat?.createdAgentIds.length ? { createdAgentIds: mat.createdAgentIds } : {}),
            ...(mat?.warnings.length ? { warnings: mat.warnings } : {}),
          }
        }
        const created = repo().create(fields)
        return {
          localId: created.id,
          updatedExisting: false,
          ...(await installedLocalChecksumOf(self, created.id)),
          ...(mat?.createdAgentIds.length ? { createdAgentIds: mat.createdAgentIds } : {}),
          ...(mat?.warnings.length ? { warnings: mat.warnings } : {}),
        }
      } catch (err) {
        if (mat) await getInstaller().rollback(mat)
        throw err
      }
    },
  }
  return self
}

// ─── app（子应用）端口 ──────────────────────────────────────────────────

function createAppPort(): TeamAssetPort {
  const repo = () => new SubAppRepository(getDatabase())
  const self: TeamAssetPort = {
    async buildPayload(localId) {
      const details = repo().get(localId)
      if (!details) return null
      if (details.draft.format === 'v2') {
        throw new Error('V2 多文件子应用暂不支持发布到团队（当前支持 V1 单文件应用）')
      }
      const manifest = details.draft.manifest
      const entry = manifest.entry || 'index.html'
      const source = details.draft.source
      // 应用源码按名称扫描本地 MCP 引用（V1 应用无正式 MCP 绑定面，名称
      // 字符串匹配是可移植引用的唯一可靠信号；误报仅多携带一个禁用配置）
      const collector = makeCollectorDeps()
      const referenced = collector
        .listMcpNames()
        .filter((m) => m.name && m.name.length >= 3 && source.includes(m.name))
      const bundle = await collectTeamBundle({
        deps: collector,
        mcpOriginIds: referenced.map((m) => m.id),
      })
      return {
        name: details.name,
        description: details.description,
        payload: {
          kind: 'app-release',
          files: [{ path: entry, content: source }],
          entry,
          manifest: { ...manifest, draftConfig: details.draft.config },
          bundle,
        },
        warnings: [
          '子应用在对方机器以「新草稿」安装，需对方确认并发布后才会出现在应用入口。',
          ...bundlePublishWarnings(bundle),
        ],
      }
    },
    findInstalledLocalId(slug) {
      for (const item of repo().list({ includeArchived: true }).items) {
        if (slugifyAssetName(item.name, 'app') === slug) return item.id
      }
      return null
    },
    async installFromPayload(envelope, existingLocalId) {
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
      const mat = await materializeBundle(envelope)
      try {
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
          return {
            localId: existingLocalId,
            updatedExisting: true,
            ...(await installedLocalChecksumOf(self, existingLocalId)),
            ...(mat?.createdAgentIds.length ? { createdAgentIds: mat.createdAgentIds } : {}),
            ...(mat?.warnings.length ? { warnings: mat.warnings } : {}),
          }
        }
        const created = repo().importApp({
          id: randomUUID(),
          manifest,
          draft: { source: source.content, config: draftConfig },
          releases: [],
          publishedVersion: null,
          data: [],
        })
        return {
          localId: created.id,
          updatedExisting: false,
          ...(await installedLocalChecksumOf(self, created.id)),
          ...(mat?.createdAgentIds.length ? { createdAgentIds: mat.createdAgentIds } : {}),
          ...(mat?.warnings.length ? { warnings: mat.warnings } : {}),
        }
      } catch (err) {
        if (mat) await getInstaller().rollback(mat)
        throw err
      }
    },
  }
  return self
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
      log.info(
        `team-registry:install-asset requested, assetType=${req.assetType}, slug=${req.slug}, version=${req.version ?? 'latest'}`,
      )
      const result = await service().installFromTeam(req.assetType, req.slug, {
        ...(req.version !== undefined ? { version: req.version } : {}),
      })
      // 主资产为 Agent：补运行时副作用（提示词/技能配置刷新 + 变更广播）
      if (req.assetType === 'agent') {
        const agent = new AgentRepository(db).get(result.localId)
        if (agent) {
          deps.refreshAgentRuntime(agent.id, agent.prompt, agent.skillIds, agent.disabledSkillIds)
          deps.pushConfigChanged('agent', result.updatedExisting ? 'update' : 'create', agent.id)
        }
      }
      // 随包捆绑新建的 Agent（任意资产类型）：逐个补运行时刷新与广播
      const bundled = result.createdAgentIds ?? []
      if (bundled.length > 0) {
        const agents = new AgentRepository(db)
        for (const agentId of bundled) {
          const agent = agents.get(agentId)
          if (!agent) continue
          deps.refreshAgentRuntime(agent.id, agent.prompt, agent.skillIds, agent.disabledSkillIds)
          deps.pushConfigChanged('agent', 'create', agent.id)
        }
      }
      return {
        slug: result.slug,
        name: result.name,
        version: result.version,
        localId: result.localId,
        updatedExisting: result.updatedExisting,
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      }
    }),
  )

  typedIpcHandle('team-registry:list-asset-updates', async (req) =>
    runAssetTask(async () => {
      const updates = await service().listTeamUpdates(req.assetType)
      return { updates }
    }),
  )
  typedIpcHandle('team-registry:list-asset-versions', async (req) =>
    runAssetTask(async () => {
      const versions = await service().listTeamAssetVersions(req.assetType, req.slug)
      return { versions }
    }),
  )
}
