/**
 * @module team-registry/types
 *
 * 团队注册中心资产信封（spark.team.asset.v1）+ 版本比对
 *
 * 所有推送到团队 Nacos 注册中心的资产（技能/MCP/工作流/子应用）共用一个
 * 信封结构：semver 版本 + 内容 checksum 双轴，配置中心天然保留发布历史，
 * 本地 team_asset_pins 表记录安装/发布锚点，「可更新」= 锚点 vs 远端信封。
 */

import crypto from 'node:crypto'

import type { SubAppShareV2FileEntry } from '@spark/protocol'

export const TEAM_ASSET_SCHEMA = 'spark.team.asset.v1' as const

/**
 * 团队资产类型：
 *   skill/mcp 走 Nacos 原生 AI 资源（zip API / serverSpecification）；
 *   workflow/agent/app 走原生 AgentSpec 承载（M3/M4，2026-09-12 起载荷升级为
 *   自包含 bundle：图引用的技能/MCP/Agent 全量随包，空机器安装即可运行）。
 */
export type TeamAssetType = 'skill' | 'mcp' | 'workflow' | 'agent' | 'app'

/** 技能载荷：相对路径 → utf-8 文本（M1 不携带二进制） */
export interface TeamSkillFile {
  /** 相对技能根目录的 posix 风格路径（正斜杠，不含 ..） */
  path: string
  /** utf-8 文件内容 */
  content: string
}

// ─── 自包含捆绑（bundle：随包携带全部依赖，对方空机器安装即可运行） ────

/** 捆绑文件内容编码：utf8 文本直接存；二进制（图片/字体等）base64 保真 */
export type TeamBundleFileEncoding = 'utf8' | 'base64'

export interface TeamBundleFile {
  /** 相对技能根目录的 posix 风格路径（不含 .. 与盘符） */
  path: string
  encoding: TeamBundleFileEncoding
  /** utf8 → 原文本；base64 → 字节的 base64 编码 */
  content: string
}

/** 随包捆绑的技能（完整文件内联；安装侧落为 bundle 隔离技能并改写引用） */
export interface TeamBundleSkill {
  /** 包内唯一 slug（名称 ASCII 归一 + 去重） */
  slug: string
  /** 原技能展示名 */
  name: string
  /** 发布方机器上的技能 id（安装后按此改写图/Agent 引用） */
  originSkillId: string
  /** 目录整体指纹（与 hashDirectoryEntries 同规则，安装侧校验保真） */
  sha256: string
  /** SkillLoader manifest 原文（'{}' 兜底），安装侧原样落库 */
  manifestJson: string
  files: TeamBundleFile[]
  /** 收集时统计的原始字节总量（体积守门与展示用；随包序列化） */
  totalBytes: number
}

/** 随包捆绑的 MCP（密钥已脱敏为占位符；安装侧落为禁用行，激活时补密钥） */
export interface TeamBundleMcp {
  refId: string
  name: string
  transport: 'stdio' | 'http' | 'sse'
  /** 脱敏后的 config（JSON 对象） */
  config: Record<string, unknown>
  /** 被脱敏的密钥路径清单（激活前需补齐） */
  requiredSecrets: Array<{ path: string; label: string }>
  /** 发布方机器上的 MCP 行 id（安装后按此改写图/Agent 引用） */
  originServerId: string
}

/**
 * Agent 捆绑条目的源形状（TeamAgentEntry + mcpServerIds；desktop 的
 * AgentRepository.get 返回 AgentItem 为其超集，直接收敛为可移植字段）
 */
export interface TeamAgentEntryLike {
  id: string
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

/** 随包捆绑的平台 Agent 定义（prompt 等纯配置；技能/MCP 引用为发布方本地 id，安装侧改写） */
export interface TeamBundleAgent {
  /** 发布方机器上的 agent id（安装后按此改写图引用） */
  originAgentId: string
  config: Record<string, unknown>
}

/** 跨环境不可移植 / 收集失败项（安装侧转为 warning 显式展示，不静默） */
export interface TeamBundleUnresolved {
  type: 'skill' | 'mcp' | 'agent' | 'rule' | 'tool' | 'workflow' | 'provider'
  name: string
  hint: string
}

/** 自包含捆绑：payload 内联携带的全部依赖（缺省 = 旧版无捆绑载荷，安装侧跳过） */
export interface TeamBundleSpec {
  skills: TeamBundleSkill[]
  mcps: TeamBundleMcp[]
  agents: TeamBundleAgent[]
  unresolved: TeamBundleUnresolved[]
}

export interface TeamSkillPayload {
  kind: 'skill-files'
  files: TeamSkillFile[]
}

/** 工作流载荷：完整流程图 DAG + 展示元数据（M3）；v2 起带自包含 bundle */
export interface TeamWorkflowPayload {
  kind: 'workflow'
  graph: Record<string, unknown>
  meta?: Record<string, unknown>
  /** 图引用的技能/MCP/Agent 全量随包（2026-09-12 v2；缺省 = 旧载荷） */
  bundle?: TeamBundleSpec
}

/** 平台 Agent 载荷：Agent 配置（prompt/技能/MCP/工作流绑定等）（M3）；v2 起带自包含 bundle */
export interface TeamAgentPayload {
  kind: 'agent-config'
  config: Record<string, unknown>
  /** Agent 引用的技能/MCP 随包（2026-09-12 v2；缺省 = 旧载荷） */
  bundle?: TeamBundleSpec
}

/**
 * 子应用 V2 受管项目的团队分享段（2026-09-14）：草稿项目文件（base64，可含
 * 二进制资源）。发布版本/制品与连接槽绑定不随团队分享——制品属发布方本地
 * 历史应由接收方自行发布产生，连接槽绑定指向本机连接/Provider（跨机器
 * 无意义，同工作流 bundle 密钥脱敏的边界）；接收方安装后自行发布与绑定。
 */
export interface TeamAppV2State {
  draftFiles: SubAppShareV2FileEntry[]
}

/** 子应用载荷：源码文件树 + 入口 + manifest 摘要（M4） */
export interface TeamAppPayload {
  kind: 'app-release'
  files: TeamSkillFile[]
  entry: string
  manifest?: Record<string, unknown>
  /** 应用源码内引用的 MCP 随包（发布侧按名称扫描发现；2026-09-12 v2） */
  bundle?: TeamBundleSpec
  /** V2 受管多文件应用的项目文件段；V1 单文件应用无此字段（2026-09-14 起） */
  v2?: TeamAppV2State
}

export type TeamAssetPayload =
  | TeamSkillPayload
  | TeamWorkflowPayload
  | TeamAgentPayload
  | TeamAppPayload

/** 按 kind 收窄 payload（信封解析后使用） */
export function payloadOf<T extends TeamAssetPayload['kind']>(
  envelope: TeamAssetEnvelope,
  kind: T,
): Extract<TeamAssetPayload, { kind: T }> | null {
  return envelope.payload != null &&
    typeof envelope.payload === 'object' &&
    (envelope.payload as { kind?: unknown }).kind === kind
    ? (envelope.payload as Extract<TeamAssetPayload, { kind: T }>)
    : null
}

export interface TeamAssetEnvelope {
  schema: typeof TEAM_ASSET_SCHEMA
  assetType: TeamAssetType
  /** 稳定标识：安装/更新/信封寻址都按此对齐 */
  slug: string
  name: string
  /** semver（宽松解析：缺段补 0，非 semver 按字符串比较回退） */
  version: string
  author: string
  description: string
  /** 发布时刻（ISO，发布方写入） */
  updatedAt: string
  /** sha256(canonical(payload))，hex，无前缀 */
  checksum: string
  payload: TeamAssetPayload
}

// ─── 发布约束（超限在发布前拦截，避免把巨型包塞进配置中心） ─────────────

export const TEAM_ASSET_LIMITS = {
  /** 单文件上限 1MB */
  maxFileBytes: 1_000_000,
  /** 单资产文件数上限 */
  maxFileCount: 200,
  /**
   * 信封整体（zip 序列化后）上限。承载已切到 AgentSpec 原生 zip 上传后不再受
   * 配置中心 1MB 限制（2026-09-12 真机实测 ~12MB 包上传/回读通过），当前上限
   * 取 40MB 防失控；捆绑内容另有 TEAM_BUNDLE_LIMITS 分级约束。
   */
  maxEnvelopeBytes: 40_000_000,
} as const

/**
 * 自包含捆绑的分级上限：超限的技能不硬失败，转入 unresolved 显式提示
 * （提示接收方经技能团队源单独安装），保证发布永远可完成、依赖缺口可见。
 */
export const TEAM_BUNDLE_LIMITS = {
  /** 单技能文件数上限 */
  maxSkillFiles: 2000,
  /** 单文件字节上限 */
  maxSkillFileBytes: 4_000_000,
  /** 单技能目录总字节上限 */
  maxSkillTotalBytes: 20_000_000,
  /** 单资产全部捆绑内容总字节上限 */
  maxBundleTotalBytes: 24_000_000,
} as const

// ─── checksum ───────────────────────────────────────────────────────────

/**
 * canonical JSON：键排序、无缩进、无 BOM，\n 行尾。
 * 两侧机器按同一规则序列化，checksum 才可比。
 */
export function canonicalJson(value: unknown): string {
  return stringifyStable(value)
}

function stringifyStable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => stringifyStable(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const key of keys) {
    if (obj[key] === undefined) continue
    parts.push(`${JSON.stringify(key)}:${stringifyStable(obj[key])}`)
  }
  return `{${parts.join(',')}}`
}

/** 对 payload 计算 sha256 hex checksum */
export function computePayloadChecksum(payload: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(payload), 'utf-8').digest('hex')
}

/**
 * 归一化 payload checksum：剔除 bundle 后计算（本地一致性基准专用）。
 * v2 自包含资产安装时图引用被改写为本地 id、捆绑行以本地确定性 id 落位，
 * 且 Agent config 内嵌本地 id——bundle 内容在「重算本地」与「远端信封」两个
 * 视角下逐字节不可比。故 pins 基准与本地重算均剔除 bundle：本地一致性只看
 * 主资产（工作流图/Agent 配置/应用源码），捆绑内容随每次安装整体更新。
 * 跨机器比对远端信封仍用 computePayloadChecksum（完整 payload）。
 */
export function computeNormalizedPayloadChecksum(payload: unknown): string {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return computePayloadChecksum(payload)
  }
  if (!('bundle' in payload)) return computePayloadChecksum(payload)
  const { bundle: _bundle, ...rest } = payload as Record<string, unknown>
  return computePayloadChecksum(rest)
}

/** 校验信封 checksum 是否与 payload 一致（防传输损坏/手改） */
export function verifyEnvelopeChecksum(envelope: TeamAssetEnvelope): boolean {
  const expected = computePayloadChecksum(envelope.payload)
  return expected === envelope.checksum
}

/** 解析配置中心里的文本为信封；结构不符/校验失败返回 null */
export function parseTeamAssetEnvelope(raw: string): TeamAssetEnvelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed == null || typeof parsed !== 'object') return null
  const env = parsed as Partial<TeamAssetEnvelope>
  if (
    env.schema !== TEAM_ASSET_SCHEMA ||
    typeof env.slug !== 'string' ||
    !env.slug ||
    typeof env.version !== 'string' ||
    typeof env.checksum !== 'string' ||
    env.payload == null ||
    typeof env.payload !== 'object'
  ) {
    return null
  }
  const envelope: TeamAssetEnvelope = {
    schema: TEAM_ASSET_SCHEMA,
    assetType: (env.assetType as TeamAssetType) ?? 'skill',
    slug: env.slug,
    name: typeof env.name === 'string' && env.name ? env.name : env.slug,
    version: env.version,
    author: typeof env.author === 'string' ? env.author : '',
    description: typeof env.description === 'string' ? env.description : '',
    updatedAt: typeof env.updatedAt === 'string' ? env.updatedAt : '',
    checksum: env.checksum,
    payload: env.payload as TeamAssetPayload,
  }
  if (!verifyEnvelopeChecksum(envelope)) return null
  return envelope
}

// ─── 版本比对 ───────────────────────────────────────────────────────────

/**
 * 宽松 semver 比较：`1.2.3` / `1.2` / `1` 都可解析，缺段补 0；
 * 解析失败时回退字符串比较（localeCompare，不做语义保证）。
 * 返回 -1 / 0 / 1。
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (pa != null && pb != null) {
    for (let i = 0; i < 3; i += 1) {
      const x = pa[i] ?? 0
      const y = pb[i] ?? 0
      if (x !== y) return x < y ? -1 : 1
    }
    return 0
  }
  return a < b ? -1 : a > b ? 1 : 0
}

function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim())
  if (!m) return null
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

/** 资产四态（+未安装/版本同内容异） */
export type TeamAssetState =
  | 'not-installed'
  | 'up-to-date'
  | 'remote-newer'
  | 'local-newer'
  | 'local-modified'
  | 'version-equal-content-differs'
  /** 远端信封已被删除（本地装过但团队源里没了） */
  | 'remote-missing'

export interface TeamAssetClassifyInput {
  /** 本地当前实算 checksum（文件树重算）；null = 目录缺失 */
  localChecksum: string | null
  /** 安装时锚定的 checksum（pins.installed_checksum） */
  installedChecksum: string | null
  /** 安装时锚定的版本（pins.installed_version） */
  installedVersion: string | null
  /** 远端信封版本 */
  remoteVersion: string
  /** 远端信封 checksum */
  remoteChecksum: string
}

/**
 * 判定顺序（重要的先判）：
 *   1. 无安装锚点 → not-installed
 *   2. 本地内容 == 远端内容 → up-to-date（无论版本号写什么）
 *   3. 本地内容 != 安装锚点 → local-modified（本地改过，优先提示分叉）
 *   4. semver 比较 → remote-newer / local-newer
 *   5. 版本相等但内容异（远端被同版本号重发）→ version-equal-content-differs
 */
export function classifyTeamAssetState(input: TeamAssetClassifyInput): TeamAssetState {
  if (input.installedVersion == null && input.installedChecksum == null) return 'not-installed'
  if (input.localChecksum != null && input.localChecksum === input.remoteChecksum) {
    return 'up-to-date'
  }
  // 自包含捆绑（v2）：安装时图引用会被改写为本地 id，本地 payload 与远端
  // 信封逐字节不可比。pins.installedChecksum 记录「安装完成时的本地载荷
  // checksum」——本地未被改动且版本一致即视为 up-to-date。AgentSpec 承载下
  // 服务端版本号每次发布必递增，「同版本内容不同」形态不可达，此规则安全。
  if (
    input.localChecksum != null &&
    input.installedChecksum != null &&
    input.localChecksum === input.installedChecksum &&
    compareSemver(input.remoteVersion, input.installedVersion ?? '0.0.0') === 0
  ) {
    return 'up-to-date'
  }
  if (input.localChecksum != null && input.installedChecksum != null) {
    if (input.localChecksum !== input.installedChecksum) return 'local-modified'
  }
  const installedVersion = input.installedVersion ?? '0.0.0'
  const cmp = compareSemver(input.remoteVersion, installedVersion)
  if (cmp > 0) return 'remote-newer'
  if (cmp < 0) return 'local-newer'
  return 'version-equal-content-differs'
}

/** 计算一个技能文件树的 checksum（与安装/发布共用同一 canonical 规则） */
export function computeSkillFilesChecksum(files: TeamSkillFile[]): string {
  return computePayloadChecksum({ kind: 'skill-files', files })
}

/** patch 位 +1；解析不了或为空时给 1.0.0（首次发布） */
export function bumpPatchVersion(v?: string | null): string {
  if (!v) return '1.0.0'
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim())
  if (!m) return '1.0.0'
  return `${m[1] ?? 0}.${m[2] ?? 0}.${Number(m[3] ?? 0) + 1}`
}
