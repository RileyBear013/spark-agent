/**
 * @module team-registry/team-bundle
 *
 * 自包含捆绑（v2）：收集（发布方）与物化（接收方）
 *
 * 目标：团队包里除了主资产（工作流图 / Agent 配置 / 应用源码），把全部运行
 * 依赖一并随包——图/Agent 引用的技能（完整文件内联，二进制 base64 保真）、
 * MCP 配置（密钥脱敏为占位符）、被引用的平台 Agent 定义（级联其技能/MCP）。
 * 对方在「什么技能、MCP、Agent 都没有」的空机器上一键安装即可运行；
 * 跨环境不可移植项（规则/自定义工具/绑定工作流）与收集失败项（目录超限等）
 * 一律转入 unresolved，安装侧显式 warning，不静默。
 *
 * 物化语义（与 .sparkflow 工作流包同源、按团队 slug 确定性 id 幂等）：
 *   - bundleId = `team-<assetType>-<slug>`：重复安装/更新复用同一 id；
 *   - 技能：id = `bundle:<bundleId>:<slug>`，落 `_bundles/<bundleId>/<slug>/`，
 *     替换语义（新版本删陈旧、覆盖内容）；
 *   - MCP：bundle_id 标记、enabled=0，激活显式（activateMcp 既有通道）；
 *     更新时保留接收方已补的非占位符密钥值；
 *   - Agent：id = `team-agent-<bundleId>-<sha8(originAgentId)>`，新建为停用态，
 *     更新保留本地运行状态；
 *   - 登记 workflow_bundles 行 → 复用既有工作流包管理 UI（卸载/校验/激活 MCP）。
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

import { BUNDLE_SKILLS_DIR_NAME, workflowBundleSecretPathFromPlaceholder } from '@spark/protocol'
import type {
  AgentRepository,
  McpServerRepository,
  SkillRepository,
  WorkflowBundleRepository,
} from '@spark/storage'

import { slugify } from '../workflow-bundle/bundle-exporter.js'
import { BundleLimitError, collectDirectory, hashDirectoryEntries } from '../workflow-bundle/bundle-fs.js'
import { redactMcpConfig } from '../workflow-bundle/secret-redact.js'
import {
  TEAM_BUNDLE_LIMITS,
  type TeamAgentEntryLike,
  type TeamBundleAgent,
  type TeamBundleFile,
  type TeamBundleMcp,
  type TeamBundleSkill,
  type TeamBundleSpec,
  type TeamBundleUnresolved,
} from './types.js'

// ─── 收集（发布方） ─────────────────────────────────────────────────────

/** 发布方仓库查找口（desktop 主进程注入真实仓库；agent-runtime 不直接依赖存储实现） */
export interface TeamBundleCollectorDeps {
  getSkill(id: string): { id: string; name: string; root_path: string; manifest_json: string } | null
  getMcp(id: string): { id: string; name: string; config_json: string } | null
  getAgent(id: string): TeamAgentEntryLike | null
  /** 全部本地 MCP（应用侧按名称扫描源码引用用） */
  listMcpNames(): Array<{ id: string; name: string }>
}

export interface CollectTeamBundleInput {
  deps: TeamBundleCollectorDeps
  skillOriginIds?: string[]
  mcpOriginIds?: string[]
  agentOriginIds?: string[]
  /** 图级/配置级不可移植项（规则、自定义工具等）直接透传 */
  extraUnresolved?: TeamBundleUnresolved[]
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true })

function isUtf8Text(bytes: Uint8Array): boolean {
  try {
    utf8Strict.decode(bytes)
    return true
  } catch {
    return false
  }
}

function toBundleFiles(entries: Map<string, Uint8Array>): {
  files: TeamBundleFile[]
  totalBytes: number
} {
  const files: TeamBundleFile[] = []
  let totalBytes = 0
  for (const [path, bytes] of entries) {
    totalBytes += bytes.byteLength
    if (isUtf8Text(bytes)) {
      files.push({ path, encoding: 'utf8', content: utf8Strict.decode(bytes) })
    } else {
      files.push({ path, encoding: 'base64', content: Buffer.from(bytes).toString('base64') })
    }
  }
  // 路径排序 canonical 化：发布方追加 manifest 的插入序与接收方目录枚举序
  // 可能不同，不排序则两侧 payload checksum 不可比（本地恒判 local-modified）
  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
  return { files, totalBytes }
}

/** 从 slug 还原技能展示名（收集侧直接携带原始 name，此处仅兜底） */
function skillDisplayName(row: { name: string; root_path: string }, slug: string): string {
  if (row.name && row.name.trim()) return row.name.trim()
  const tail = row.root_path.replaceAll('\\', '/').split('/').filter(Boolean).pop()
  return tail || slug
}

/**
 * 收集自包含捆绑。永不因单个依赖失败而整体失败：
 * 内建技能静默跳过（目标环境必有）；找不到/超限/损坏项转入 unresolved。
 * 若捆绑总体积超 maxBundleTotalBytes，按体积从大到小降级为 unresolved，保证可发布。
 */
export async function collectTeamBundle(input: CollectTeamBundleInput): Promise<TeamBundleSpec> {
  const { deps } = input
  const unresolved: TeamBundleUnresolved[] = [...(input.extraUnresolved ?? [])]
  const takenSkillSlugs = new Set<string>()
  const takenMcpRefIds = new Set<string>()
  const skills: TeamBundleSkill[] = []
  const mcps: TeamBundleMcp[] = []
  const agents: TeamBundleAgent[] = []

  const skillIds = new Set<string>(input.skillOriginIds ?? [])
  const mcpIds = new Set<string>(input.mcpOriginIds ?? [])
  const agentIds = new Set<string>(input.agentOriginIds ?? [])

  // —— Agent 条目先行：级联其技能/MCP 依赖（图引用通常已含，Set 去重兜底） ——
  for (const agentId of agentIds) {
    const agent = deps.getAgent(agentId)
    if (!agent) {
      unresolved.push({
        type: 'agent',
        name: agentId,
        hint: '被引用的 Agent 在当前环境未找到，安装后需重新绑定或手动创建',
      })
      continue
    }
    for (const id of agent.skillIds ?? []) skillIds.add(id)
    for (const id of agent.disabledSkillIds ?? []) skillIds.add(id)
    for (const id of agent.mcpServerIds ?? []) mcpIds.add(id)
    agents.push({ originAgentId: agentId, config: agent as unknown as Record<string, unknown> })
  }

  // —— 技能：内联完整文件（builtin 静默跳过；找不到/超限转 unresolved） ——
  for (const skillId of skillIds) {
    if (skillId.startsWith('builtin:')) continue
    const row = deps.getSkill(skillId)
    if (!row) {
      unresolved.push({
        type: 'skill',
        name: skillId,
        hint: '技能在当前环境未找到，接收方需单独安装',
      })
      continue
    }
    const slugBase = slugify(row.name || skillId, 'skill')
    let slug = slugBase
    for (let i = 2; takenSkillSlugs.has(slug); i += 1) slug = `${slugBase}-${i}`
    takenSkillSlugs.add(slug)
    try {
      const entries = await collectDirectory(row.root_path)
      if (entries.size > TEAM_BUNDLE_LIMITS.maxSkillFiles) {
        throw new BundleLimitError(`文件数 ${entries.size} 超过上限 ${TEAM_BUNDLE_LIMITS.maxSkillFiles}`)
      }
      let manifestJson = '{}'
      try {
        const parsed: unknown = JSON.parse(row.manifest_json || '{}')
        if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          manifestJson = JSON.stringify(parsed)
        }
      } catch {
        /* manifest 非法时兜底 '{}'，技能文件本身仍随包 */
      }
      entries.set('.spark-skill-manifest.json', new TextEncoder().encode(manifestJson))
      const { files, totalBytes } = toBundleFiles(entries)
      const oversized = files.find((f) => Buffer.byteLength(f.content, f.encoding) > TEAM_BUNDLE_LIMITS.maxSkillFileBytes)
      if (oversized) {
        throw new BundleLimitError(`单文件 ${oversized.path} 超过上限 ${TEAM_BUNDLE_LIMITS.maxSkillFileBytes}`)
      }
      skills.push({
        slug,
        name: skillDisplayName(row, slug),
        originSkillId: skillId,
        sha256: hashDirectoryEntries(entries),
        manifestJson,
        files,
        totalBytes,
      })
    } catch (err) {
      takenSkillSlugs.delete(slug)
      const reason = err instanceof Error ? err.message : String(err)
      unresolved.push({
        type: 'skill',
        name: skillDisplayName(row, slug),
        hint: `技能目录超出团队包上限或读取失败（${reason}），接收方可经技能团队源单独安装「${skillDisplayName(row, slug)}」`,
      })
    }
  }

  // —— MCP：查行 + 脱敏（占位符化），安装侧落禁用行待激活 ——
  for (const serverId of mcpIds) {
    const row = deps.getMcp(serverId)
    if (!row) {
      unresolved.push({
        type: 'mcp',
        name: serverId,
        hint: 'MCP 配置在当前环境未找到，接收方需自行添加',
      })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(row.config_json)
    } catch {
      unresolved.push({ type: 'mcp', name: row.name, hint: 'MCP 配置不是有效 JSON，未随包携带' })
      continue
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      unresolved.push({ type: 'mcp', name: row.name, hint: 'MCP 配置必须是 JSON 对象，未随包携带' })
      continue
    }
    const { config, secrets } = redactMcpConfig(JSON.stringify(parsed))
    const refBase = slugify(row.name, 'mcp')
    let refId = refBase
    for (let i = 2; takenMcpRefIds.has(refId); i += 1) refId = `${refBase}-${i}`
    takenMcpRefIds.add(refId)
    const transport =
      typeof config.transport === 'string'
        ? config.transport
        : typeof (config as { type?: unknown }).type === 'string'
          ? ((config as { type: string }).type as 'stdio' | 'http' | 'sse')
          : 'stdio'
    mcps.push({
      refId,
      name: row.name,
      transport: transport === 'http' || transport === 'sse' ? transport : 'stdio',
      config,
      requiredSecrets: secrets.map((s) => ({ path: s.path, label: s.label })),
      originServerId: serverId,
    })
  }

  // —— 总体积守门：超限按技能体积从大到小降级为 unresolved，保证发布可完成 ——
  const limit = TEAM_BUNDLE_LIMITS.maxBundleTotalBytes
  let total = skills.reduce((sum, s) => sum + s.totalBytes, 0)
  if (total > limit) {
    const ordered = [...skills].sort((a, b) => b.totalBytes - a.totalBytes)
    for (const skill of ordered) {
      if (total <= limit) break
      skills.splice(skills.indexOf(skill), 1)
      takenSkillSlugs.delete(skill.slug)
      total -= skill.totalBytes
      unresolved.push({
        type: 'skill',
        name: skill.name,
        hint: `技能体积 ${skill.totalBytes} 字节使团队包超过上限 ${limit}，未随包携带；接收方可经技能团队源单独安装「${skill.name}」`,
      })
    }
  }

  return { skills, mcps, agents, unresolved }
}

/** 发布侧捆绑内容提示（发布确认/结果弹窗展示；desktop 端口与探针共用） */
export function bundlePublishWarnings(bundle: TeamBundleSpec): string[] {
  const warnings: string[] = []
  if (bundle.skills.length > 0) {
    warnings.push(`随包捆绑 ${bundle.skills.length} 个技能（接收方安装后自动落位，无需自备）`)
  }
  if (bundle.mcps.length > 0) {
    warnings.push(`随包捆绑 ${bundle.mcps.length} 个 MCP 配置（密钥已脱敏，接收方激活时需补齐）`)
  }
  if (bundle.agents.length > 0) {
    warnings.push(`随包捆绑 ${bundle.agents.length} 个 Agent 定义（接收方安装后为停用态）`)
  }
  return warnings
}

// ─── 物化（接收方） ─────────────────────────────────────────────────────

/**
 * 结构化仓库依赖：只依赖安装实际用到的方法（Pick），desktop 注入真实仓库，
 * 单测可注入内存假仓库（agent-runtime 测试不直接依赖 SQLite ABI）。
 */
export interface TeamBundleInstallDeps {
  skills: Pick<SkillRepository, 'get' | 'list' | 'create' | 'update' | 'deleteById'>
  mcps: Pick<McpServerRepository, 'get' | 'listAll' | 'findByBundleId' | 'create' | 'update' | 'deleteById'>
  agents: Pick<AgentRepository, 'get' | 'create' | 'update' | 'delete'>
  bundles: Pick<WorkflowBundleRepository, 'get' | 'create' | 'update' | 'delete'>
  /** 用户技能根目录（bundle 技能落 `_bundles/<bundleId>/<slug>/`） */
  userSkillsDir: string
}

export interface TeamBundleMeta {
  bundleId: string
  assetType: 'workflow' | 'agent' | 'app'
  slug: string
  assetName: string
  version: string
  author?: string
  description?: string
}

export interface TeamBundleMaterializeResult {
  bundleId: string
  skillIdMap: Map<string, string>
  mcpIdMap: Map<string, string>
  agentIdMap: Map<string, string>
  /** 本次新建（非更新）的捆绑 Agent——handler 层需补运行时刷新 */
  createdAgentIds: string[]
  warnings: string[]
  /** 回滚所需内部信息 */
  _createdSkillIds: string[]
  _createdMcpIds: string[]
  _createdBundleRow: boolean
}

/** bundle 内容是否为空（空捆绑不物化、不登记 workflow_bundles 行） */
export function isBundleEmpty(spec: TeamBundleSpec | null | undefined): boolean {
  if (!spec) return true
  return spec.skills.length === 0 && spec.mcps.length === 0 && spec.agents.length === 0
}

function decodeBundleFile(f: TeamBundleFile): Uint8Array {
  return f.encoding === 'base64'
    ? new Uint8Array(Buffer.from(f.content, 'base64'))
    : new Uint8Array(Buffer.from(f.content, 'utf-8'))
}

/** 确定性捆绑 Agent id：team-agent-<bundleId>-<sha8(originAgentId)> */
function bundledAgentId(bundleId: string, originAgentId: string): string {
  const hash = createHash('sha256').update(originAgentId, 'utf-8').digest('hex').slice(0, 8)
  return `team-agent-${bundleId}-${hash}`
}

/** 用本地已补齐的非占位符密钥值，覆盖新配置中的占位符（更新不丢接收方密钥） */
function mergePreserveSecrets(localJson: string, incoming: Record<string, unknown>): string {
  let local: unknown
  try {
    local = JSON.parse(localJson)
  } catch {
    return JSON.stringify(incoming)
  }
  const restore = (incomingValue: unknown, path: string): unknown => {
    if (incomingValue != null && typeof incomingValue === 'object' && !Array.isArray(incomingValue)) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(incomingValue as Record<string, unknown>)) {
        out[k] = restore(v, path ? `${path}.${k}` : k)
      }
      return out
    }
    if (Array.isArray(incomingValue)) {
      return incomingValue.map((v, i) => restore(v, `${path}.${i}`))
    }
    if (typeof incomingValue === 'string') {
      const secretPath = workflowBundleSecretPathFromPlaceholder(incomingValue)
      if (secretPath == null) return incomingValue
      let cursor: unknown = local
      for (const seg of secretPath.split('.')) {
        if (cursor == null || typeof cursor !== 'object') {
          cursor = undefined
          break
        }
        cursor = (cursor as Record<string, unknown>)[seg]
      }
      if (
        typeof cursor === 'string' &&
        cursor.length > 0 &&
        workflowBundleSecretPathFromPlaceholder(cursor) == null
      ) {
        return cursor
      }
      return incomingValue
    }
    return incomingValue
  }
  return JSON.stringify(restore(incoming, ''))
}

export class TeamBundleInstaller {
  constructor(private readonly deps: TeamBundleInstallDeps) {}

  /**
   * 物化自包含捆绑（幂等：同 bundleId 重复安装为替换式更新）。
   * 技能校验 sha256 后落盘 + upsert；MCP 保留本地密钥刷新；Agent 确定性 id 落位；
   * 登记 workflow_bundles 行（复用工作流包管理 UI 的卸载/校验/激活能力）。
   */
  async materialize(spec: TeamBundleSpec, meta: TeamBundleMeta): Promise<TeamBundleMaterializeResult> {
    const result: TeamBundleMaterializeResult = {
      bundleId: meta.bundleId,
      skillIdMap: new Map(),
      mcpIdMap: new Map(),
      agentIdMap: new Map(),
      createdAgentIds: [],
      warnings: [],
      _createdSkillIds: [],
      _createdMcpIds: [],
      _createdBundleRow: false,
    }
    if (isBundleEmpty(spec)) return result
    const skillPrefix = `bundle:${meta.bundleId}:`
    const bundleRoot = join(this.deps.userSkillsDir, BUNDLE_SKILLS_DIR_NAME, meta.bundleId)

    // —— 技能：校验 → 替换式落盘 → upsert（确定性 id） ——
    const seenSlugs = new Set<string>()
    for (const entry of spec.skills) {
      const id = `${skillPrefix}${entry.slug}`
      const files = new Map<string, Uint8Array>(entry.files.map((f) => [f.path, decodeBundleFile(f)]))
      if (!files.has('SKILL.md')) {
        result.warnings.push(`捆绑技能 ${entry.name} 缺少 SKILL.md，已跳过`)
        continue
      }
      if (hashDirectoryEntries(files) !== entry.sha256) {
        throw new Error(`捆绑技能 ${entry.name} 的目录校验和不匹配（传输损坏或被篡改）`)
      }
      seenSlugs.add(entry.slug)
      const targetDir = join(bundleRoot, entry.slug)
      await rm(targetDir, { recursive: true, force: true })
      for (const [rel, content] of files) {
        const abs = join(targetDir, rel)
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, content)
      }
      const manifestJson =
        entry.manifestJson && typeof entry.manifestJson === 'object'
          ? JSON.stringify(entry.manifestJson)
          : typeof entry.manifestJson === 'string'
            ? entry.manifestJson
            : '{}'
      const existing = this.deps.skills.get(id)
      if (existing) {
        this.deps.skills.update(id, {
          name: entry.name,
          rootPath: targetDir,
          manifestJson,
          enabled: true,
        })
      } else {
        this.deps.skills.create({
          id,
          scope: 'user',
          name: entry.name,
          version: '1.0.0',
          rootPath: targetDir,
          manifestJson,
          enabled: true,
        })
        result._createdSkillIds.push(id)
      }
      result.skillIdMap.set(entry.originSkillId, id)
    }
    // 替换语义：清理本 bundle 下新版本不再携带的技能（行 + 目录）
    for (const row of this.deps.skills.list()) {
      if (!row.id.startsWith(skillPrefix)) continue
      const slug = row.id.slice(skillPrefix.length)
      if (!seenSlugs.has(slug)) {
        this.deps.skills.deleteById(row.id)
        await rm(join(bundleRoot, slug), { recursive: true, force: true })
      }
    }

    // —— MCP：bundle_id 标记 + 默认禁用；更新保留本地已补密钥 ——
    const existingMcps = this.deps.mcps.findByBundleId(meta.bundleId)
    const seenMcpNames = new Set<string>()
    for (const entry of spec.mcps) {
      seenMcpNames.add(entry.name)
      const configJson = JSON.stringify(entry.config)
      const existing = existingMcps.find((r) => r.name === entry.name)
      if (existing) {
        this.deps.mcps.update(existing.id, {
          configJson: mergePreserveSecrets(existing.config_json, entry.config),
        })
        result.mcpIdMap.set(entry.originServerId, existing.id)
      } else {
        const row = this.deps.mcps.create({
          scope: 'user',
          name: entry.name,
          configJson,
          enabled: false,
          bundleId: meta.bundleId,
        })
        result._createdMcpIds.push(row.id)
        result.mcpIdMap.set(entry.originServerId, row.id)
      }
      if (entry.requiredSecrets.length > 0) {
        result.warnings.push(
          `MCP「${entry.name}」含 ${entry.requiredSecrets.length} 项密钥待补（已安装为禁用，激活时需补齐：${entry.requiredSecrets
            .map((s) => s.path)
            .join('、')}）`,
        )
      } else {
        result.warnings.push(`MCP「${entry.name}」已随包装为禁用态，需在扩展中心确认启用`)
      }
    }
    for (const row of existingMcps) {
      if (!seenMcpNames.has(row.name)) this.deps.mcps.deleteById(row.id)
    }

    // —— Agent：确定性 id + 引用改写落位；新建停用、更新保留运行状态 ——
    for (const entry of spec.agents) {
      const raw = entry.config as Record<string, unknown>
      const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
      const id = bundledAgentId(meta.bundleId, entry.originAgentId)
      const fields = {
        name: typeof raw.name === 'string' ? raw.name : entry.originAgentId,
        description: typeof raw.description === 'string' ? raw.description : '',
        agentAdapter: typeof raw.agentAdapter === 'string' ? raw.agentAdapter : 'claude-sdk',
        permissionMode: typeof raw.permissionMode === 'string' ? raw.permissionMode : 'default',
        reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort : 'medium',
        prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
        skillIds: strArr(raw.skillIds).map((x) => result.skillIdMap.get(x) ?? x),
        disabledSkillIds: strArr(raw.disabledSkillIds).map((x) => result.skillIdMap.get(x) ?? x),
        mcpServerIds: strArr(raw.mcpServerIds).map((x) => result.mcpIdMap.get(x) ?? x),
        ruleIds: strArr(raw.ruleIds),
        hookConfig:
          raw.hookConfig != null && typeof raw.hookConfig === 'object'
            ? (raw.hookConfig as Record<string, unknown>)
            : {},
        workflowId: typeof raw.workflowId === 'string' && raw.workflowId ? raw.workflowId : null,
        metadata:
          raw.metadata != null && typeof raw.metadata === 'object'
            ? (raw.metadata as Record<string, unknown>)
            : {},
      }
      const existing = this.deps.agents.get(id)
      if (existing) {
        this.deps.agents.update(id, fields) // 不传 enabled → 保留本地运行状态
      } else {
        this.deps.agents.create({ id, ...fields, enabled: false, builtIn: false })
        result.createdAgentIds.push(id)
      }
      result.agentIdMap.set(entry.originAgentId, id)
      result.warnings.push(
        existing
          ? `捆绑 Agent「${fields.name}」已更新（保留本地启用状态）`
          : `捆绑 Agent「${fields.name}」已安装为停用态，启用后生效`,
      )
    }

    // —— 登记 workflow_bundles 行（空捆绑不登记） ——
    if (spec.skills.length > 0 || spec.mcps.length > 0 || spec.agents.length > 0) {
      const manifestJson = JSON.stringify({
        source: 'spark-team-registry',
        assetType: meta.assetType,
        slug: meta.slug,
        bundleId: meta.bundleId,
        skills: spec.skills.map((s) => ({ slug: s.slug, name: s.name })),
        mcps: spec.mcps.map((m) => ({ refId: m.refId, name: m.name, transport: m.transport })),
        agents: spec.agents.map((a) => ({ originAgentId: a.originAgentId })),
        unresolved: spec.unresolved,
      })
      const existingBundle = this.deps.bundles.get(meta.bundleId)
      if (existingBundle) {
        this.deps.bundles.update(meta.bundleId, {
          name: meta.assetName,
          version: meta.version,
          ...(meta.author !== undefined ? { author: meta.author ?? null } : {}),
          ...(meta.description !== undefined ? { description: meta.description ?? null } : {}),
          manifestJson,
        })
      } else {
        this.deps.bundles.create({
          id: meta.bundleId,
          name: meta.assetName,
          version: meta.version,
          author: meta.author ?? null,
          description: meta.description ?? null,
          manifestJson,
          source: 'team-registry',
          verificationStatus: 'unverified',
        })
        result._createdBundleRow = true
      }
    }

    // —— unresolved 转 warning（显式可见，不静默） ——
    for (const u of spec.unresolved) {
      result.warnings.push(`${u.name}：${u.hint}`)
    }
    return result
  }

  /**
   * 主资产落位失败时的尽力回滚：只删本次「新建」的行与目录
   * （更新过的行保留——接收方已有数据不因一次失败丢失）。
   */
  async rollback(result: TeamBundleMaterializeResult): Promise<void> {
    for (const id of result.createdAgentIds) {
      try {
        this.deps.agents.delete(id)
      } catch {
        /* 尽力而为 */
      }
    }
    for (const id of result._createdSkillIds) {
      try {
        this.deps.skills.deleteById(id)
      } catch {
        /* 尽力而为 */
      }
    }
    for (const id of result._createdMcpIds) {
      try {
        this.deps.mcps.deleteById(id)
      } catch {
        /* 尽力而为 */
      }
    }
    if (result._createdBundleRow) {
      try {
        this.deps.bundles.delete(result.bundleId)
      } catch {
        /* 尽力而为 */
      }
    }
    await rm(join(this.deps.userSkillsDir, BUNDLE_SKILLS_DIR_NAME, result.bundleId), {
      recursive: true,
      force: true,
    }).catch(() => {})
  }
}
