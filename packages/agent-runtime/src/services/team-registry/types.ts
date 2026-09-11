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

export const TEAM_ASSET_SCHEMA = 'spark.team.asset.v1' as const

/**
 * 团队资产类型：
 *   skill/mcp 走 Nacos 原生 AI 资源（zip API / serverSpecification）；
 *   workflow/agent/app 走配置中心统一信封（M3/M4）。
 */
export type TeamAssetType = 'skill' | 'mcp' | 'workflow' | 'agent' | 'app'

/** 技能载荷：相对路径 → utf-8 文本（M1 不携带二进制） */
export interface TeamSkillFile {
  /** 相对技能根目录的 posix 风格路径（正斜杠，不含 ..） */
  path: string
  /** utf-8 文件内容 */
  content: string
}

export interface TeamSkillPayload {
  kind: 'skill-files'
  files: TeamSkillFile[]
}

/** 工作流载荷：完整流程图 DAG + 展示元数据（M3） */
export interface TeamWorkflowPayload {
  kind: 'workflow'
  graph: Record<string, unknown>
  meta?: Record<string, unknown>
}

/** 平台 Agent 载荷：Agent 配置（prompt/技能/MCP/工作流绑定等）（M3） */
export interface TeamAgentPayload {
  kind: 'agent-config'
  config: Record<string, unknown>
}

/** 子应用载荷：源码文件树 + 入口 + manifest 摘要（M4） */
export interface TeamAppPayload {
  kind: 'app-release'
  files: TeamSkillFile[]
  entry: string
  manifest?: Record<string, unknown>
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
   * 信封整体（序列化后）上限。Nacos 配置中心实测 1MB 可写 / 2MB 报 413，
   * 留余量取 900KB；子应用快照超限时发布侧会给出明确报错（后续可选 gzip/MinIO）。
   */
  maxEnvelopeBytes: 900_000,
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
