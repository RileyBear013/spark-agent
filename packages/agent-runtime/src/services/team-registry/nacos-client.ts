/**
 * @module team-registry/nacos-client
 *
 * Nacos v3 控制台 OpenAPI 客户端（团队注册中心专用）
 *
 * 认证：POST /v3/auth/user/login（form：username/password）→ accessToken（TTL 5h），
 * 后续请求带 `Authorization: Bearer <token>`；token 缓存、提前过期、401 自动重登一轮。
 *
 * 传输事实（2026-09-11 真机联调核实，见 docs/plan/team-registry-sharing.md）：
 *   - 写端点一律 form 编码（x-www-form-urlencoded / multipart），不是 JSON body；
 *   - 读端点 JSON 信封 {code, message, data}，code!==0 视为业务失败；
 *   - 技能包为 zip（upload multipart / download 返回二进制）；
 *   - MCP list 必须带 search 参数，否则服务端版本 join 异常。
 *
 * 端点分组：
 *   - 配置中心（cs/config）：工作流 / 子应用信封运输（M3/M4 用）
 *   - AI Skill 原生 API：技能推拉（M1.5 起为权威路径）
 *   - AI MCP 原生 API：MCP 推拉（M2）
 *   - AI AgentSpec 原生 API：工作流 / 平台 Agent / 子应用信封承载（M3/M4 原生化）
 */

import { fetchJson, HttpError } from '@spark/shared'
import type { McpPublishDraftFields } from './mcp-mapping.js'

/** 团队资产在配置中心的固定 group */
export const TEAM_NACOS_GROUP = 'SPARK_TEAM'

export interface NacosClientOptions {
  /** 控制台地址，如 http://192.168.163.174:8080 */
  serverUrl: string
  /** 命名空间 id，如 public */
  namespace: string
  username?: string
  password?: string
  /** 直接提供 token（跳过登录；用于测试或已有会话） */
  accessToken?: string
  /** token 有效期（ms）；登录响应没给时的兜底默认值 */
  tokenTtlMs?: number
  /** 测试注入 */
  fetchImpl?: typeof fetch
}

export interface NacosConfigSummary {
  dataId: string
  group: string
  /** 配置类型（JSON 等） */
  type?: string
  /** 最后修改时间（ms epoch，服务端给什么透传什么） */
  modifiedTime?: number
}

export interface NacosConfigContent {
  dataId: string
  group: string
  content: string
  md5?: string
  type?: string
}

/** precheck 返回的服务端解析结果（字段按 2026-09-11 真机响应） */
export interface SkillUploadPrecheck {
  skillName: string
  targetVersion: string
  parsedVersion: string | null
  /** READY | ...（其他值视为不可上传，透传给上层展示 reason） */
  precheckCode: string
  reason: string | null
  exists: boolean
  maxPublishedVersion: string | null
  editingVersion: string | null
  reviewingVersion: string | null
  entryPath: string | null
  owner: string | null
}

/** 技能版本行（详情接口 data.versions 元素，宽容提取） */
export interface TeamSkillVersionInfo {
  version: string
  status: string
}

/** 技能详情（详情接口 data，宽容提取） */
export interface TeamSkillDetail {
  skillName: string
  name: string
  scope: string
  description: string
  versions: TeamSkillVersionInfo[]
  raw: Record<string, unknown>
}

/** MCP 版本行 */
export interface TeamMcpVersionInfo {
  version: string
  status: string
}

/** MCP 详情（详情接口 data，宽容提取；serverSpecification 为原始对象） */
export interface TeamMcpDetail {
  mcpName: string
  description: string
  versions: TeamMcpVersionInfo[]
  serverSpecification: Record<string, unknown> | null
  raw: Record<string, unknown>
}

/** AgentSpec 版本行（详情接口 data.versions 元素，宽容提取） */
export interface TeamAgentSpecVersionRow {
  version: string
  /** draft → (submit) → (publish) → online；中间态透传 */
  status: string
  author: string | null
}

/** AgentSpec 详情（详情接口 data，宽容提取） */
export interface TeamAgentSpecDetail {
  name: string
  description: string
  scope: string
  /** 最新已发布（online）版本（labels.latest）；null = 尚无发布版本 */
  latestPublished: string | null
  /** 当前草稿编辑版本（editingVersion） */
  editingVersion: string | null
  versions: TeamAgentSpecVersionRow[]
  raw: Record<string, unknown>
}

/** AgentSpec 版本详情（manifest 原文 + 资源内容；上游无 zip 下载端点，内容回读为准） */
export interface TeamAgentSpecVersionDetail {
  name: string
  version: string
  /** manifest.json 原文（JSON 字符串） */
  manifestRaw: string
  /** 资源文件（相对路径由 resourceIdentifier/name 还原） */
  resources: Array<{ path: string; content: string }>
  raw: Record<string, unknown>
}

interface NacosApiEnvelope {
  code?: number
  message?: string
  data?: unknown
  // 部分旧端点直接平铺在顶层
  accessToken?: string
  tokenTtlMs?: number
}

const DEFAULT_TOKEN_TTL_MS = 4 * 60 * 60 * 1000
/** 提前 60s 过期，避免临界请求失败 */
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000

export class NacosClientError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly nacosCode?: number,
  ) {
    super(message)
    this.name = 'NacosClientError'
  }
}

export class NacosClient {
  private readonly serverUrl: string
  private readonly namespace: string
  private readonly username: string | undefined
  private readonly password: string | undefined
  private readonly tokenTtlMs: number
  private readonly fetchImpl: typeof fetch

  private token: string | null
  private tokenExpiresAt = 0

  constructor(opts: NacosClientOptions) {
    this.serverUrl = opts.serverUrl.replace(/\/+$/, '')
    this.namespace = opts.namespace
    this.username = opts.username
    this.password = opts.password
    this.tokenTtlMs = opts.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.token = opts.accessToken ?? null
    if (opts.accessToken != null) {
      // 外部注入的 token 无法得知真实 TTL，按默认 TTL 对待（到期自动重登，
      // 无账密时重登会失败并显式报错，而不是静默用过期 token）
      this.tokenExpiresAt = Date.now() + this.tokenTtlMs
    }
  }

  // ─── 认证 ───────────────────────────────────────────────────────────

  async ensureToken(): Promise<string> {
    if (this.token != null && Date.now() < this.tokenExpiresAt) return this.token
    if (!this.username || !this.password) {
      if (this.token != null) {
        // 无账密但有旧 token：TTL 到了只能尝试继续用（部分部署 token 长效），
        // 失败由服务端 401 显式暴露
        return this.token
      }
      throw new NacosClientError(
        '团队注册中心未配置账号密码，无法登录获取 token（请到 设置 → 团队注册中心 补全凭据）',
      )
    }
    // 真机核实的登录端点与编码（form）；token 位置做多重兜底
    const res = await this.rawRequest('POST', '/v3/auth/user/login', {
      form: { username: this.username, password: this.password },
      auth: false,
    })
    const token =
      pickString(res, ['accessToken', 'data.accessToken']) ??
      pickString(res, ['token', 'data.token']) ??
      pickString(res, ['data.accessTokenValue', 'accessTokenValue'])
    if (!token) throw new NacosClientError('Nacos 登录响应中没有 accessToken')
    const ttl = pickNumber(res, ['tokenTtlMs', 'data.tokenTtlMs', 'data.tokenTtl'])
    this.token = token
    this.tokenExpiresAt = Date.now() + (ttl && ttl > 0 ? ttl : this.tokenTtlMs) - TOKEN_EXPIRY_MARGIN_MS
    return token
  }

  /** 清空缓存 token（401 后强制重登 / 测试用） */
  invalidateToken(): void {
    this.token = null
    this.tokenExpiresAt = 0
  }

  // ─── 配置中心（工作流 / 子应用信封，M3/M4 用） ───────────────────────

  /** 列出团队 group 下的配置（按 dataId 前缀过滤可选） */
  async listConfigs(opts: {
    group?: string
    dataIdPrefix?: string
    pageNo?: number
    pageSize?: number
  } = {}): Promise<NacosConfigSummary[]> {
    const group = opts.group ?? TEAM_NACOS_GROUP
    const pageNo = opts.pageNo ?? 1
    const pageSize = opts.pageSize ?? 200
    const query = new URLSearchParams({
      pageNo: String(pageNo),
      pageSize: String(pageSize),
      namespaceId: this.namespace,
      groupName: group,
      search: 'accurate',
    })
    const res = await this.apiRequest('GET', '/v3/console/cs/config/list', { query })
    // v3 返回 {data: {pageItems: [...]}}；兼容平铺数组
    const items = pickArray(res, ['data.pageItems', 'pageItems', 'data'])
    return items
      .map((item) => normalizeConfigSummary(item))
      .filter((item): item is NacosConfigSummary => item != null)
      .filter((item) => (opts.dataIdPrefix ? item.dataId.startsWith(opts.dataIdPrefix) : true))
  }

  /** 读取单条配置内容；不存在返回 null */
  async getConfig(dataId: string, group?: string): Promise<NacosConfigContent | null> {
    const groupName = group ?? TEAM_NACOS_GROUP
    const query = new URLSearchParams({
      dataId,
      groupName,
      namespaceId: this.namespace,
    })
    try {
      const res = await this.apiRequest('GET', '/v3/console/cs/config', { query })
      const content = pickString(res, ['data.content', 'content'])
      if (content == null) return null
      const out: NacosConfigContent = { dataId, group: groupName, content }
      const md5 = pickString(res, ['data.md5', 'md5'])
      if (md5 != null) out.md5 = md5
      const type = pickString(res, ['data.type', 'type'])
      if (type != null) out.type = type
      return out
    } catch (err) {
      if (err instanceof NacosClientError && isNotFound(err)) return null
      throw err
    }
  }

  /** 发布（新增或更新）一条配置 */
  async publishConfig(args: {
    dataId: string
    group?: string
    content: string
    type?: string
  }): Promise<boolean> {
    const body = {
      dataId: args.dataId,
      groupName: args.group ?? TEAM_NACOS_GROUP,
      namespaceId: this.namespace,
      content: args.content,
      type: args.type ?? 'JSON',
    }
    // 配置中心写端点与 AI 写端点同形态：form 编码（JSON body 会报 Required parameter）
    const res = await this.apiRequest('POST', '/v3/console/cs/config', {
      form: {
        dataId: args.dataId,
        groupName: args.group ?? TEAM_NACOS_GROUP,
        namespaceId: this.namespace,
        content: args.content,
        type: args.type ?? 'JSON',
      },
    })
    return pickBoolean(res, ['data', 'success']) ?? true
  }

  /** 删除一条配置（发布方撤回资产时用；需用户显式确认） */
  async deleteConfig(dataId: string, group?: string): Promise<boolean> {
    const query = new URLSearchParams({
      dataId,
      groupName: group ?? TEAM_NACOS_GROUP,
      namespaceId: this.namespace,
    })
    const res = await this.apiRequest('DELETE', '/v3/console/cs/config', { query })
    return pickBoolean(res, ['data', 'success']) ?? true
  }

  /** 配置历史（版本链证据，Nacos 原生保留） */
  async listConfigHistory(
    dataId: string,
    group?: string,
    pageNo = 1,
    pageSize = 20,
  ): Promise<Array<{ modifyTimestamp?: number; lastModified?: number; md5?: string }>> {
    const query = new URLSearchParams({
      dataId,
      groupName: group ?? TEAM_NACOS_GROUP,
      namespaceId: this.namespace,
      pageNo: String(pageNo),
      pageSize: String(pageSize),
    })
    const res = await this.apiRequest('GET', '/v3/console/cs/history/list', { query })
    const items = pickArray(res, ['data.pageItems', 'pageItems', 'historyItems', 'data'])
    return items.filter((item) => item != null && typeof item === 'object') as Array<{
      modifyTimestamp?: number
      lastModified?: number
      md5?: string
    }>
  }

  // ─── AI Skill 原生 API（技能推拉权威路径） ──────────────────────────

  /** 团队技能列表（原生发现数据源） */
  async listTeamSkills(): Promise<Array<Record<string, unknown>>> {
    const query = new URLSearchParams({ namespaceId: this.namespace, pageNo: '1', pageSize: '200' })
    const res = await this.apiRequest('GET', '/v3/console/ai/skills/list', { query })
    return pickArray(res, ['data.pageItems', 'pageItems', 'data']).filter(
      (item) => item != null && typeof item === 'object',
    ) as Array<Record<string, unknown>>
  }

  /** 技能详情（含 versions/scope）；不存在返回 null */
  async getTeamSkill(skillName: string): Promise<TeamSkillDetail | null> {
    const query = new URLSearchParams({ namespaceId: this.namespace, skillName })
    try {
      const res = await this.apiRequest('GET', '/v3/console/ai/skills', { query })
      const data = asRecord(getPath(res, 'data')) ?? asRecord(res)
      if (!data) return null
      return normalizeSkillDetail(data, skillName)
    } catch (err) {
      if (err instanceof NacosClientError && skillMissing(err)) return null
      throw err
    }
  }

  /**
   * 上传前预检：服务端解 zip 解析 SKILL.md frontmatter，返回
   * skillName/targetVersion/exists/maxPublishedVersion 等（用于版本决策与防御）。
   */
  async precheckTeamSkillUpload(zip: Buffer): Promise<SkillUploadPrecheck | null> {
    const res = await this.apiRequest('POST', '/v3/console/ai/skills/upload/precheck', {
      multipart: buildSkillZipMultipart(zip, this.namespace),
    })
    // 真机响应 data 为数组（单包单元素）
    const data = pickArray(res, ['data'])
    const first = asRecord(data[0])
    if (!first) return null
    return {
      skillName: pickString(first, ['skillName']) ?? '',
      targetVersion: pickString(first, ['targetVersion']) ?? '',
      parsedVersion: pickString(first, ['parsedVersion']),
      precheckCode: pickString(first, ['precheckCode']) ?? '',
      reason: pickString(first, ['reason']),
      exists: pickBoolean(first, ['exists']) ?? false,
      maxPublishedVersion: pickString(first, ['maxPublishedVersion']),
      editingVersion: pickString(first, ['editingVersion']),
      reviewingVersion: pickString(first, ['reviewingVersion']),
      entryPath: pickString(first, ['entryPath']),
      owner: pickString(first, ['owner']),
    }
  }

  /** 上传技能 zip（服务端解析 frontmatter 建草稿）；返回服务端确认的 skillName */
  async uploadTeamSkillZip(args: {
    zip: Buffer
    overwrite: boolean
    commitMsg: string
  }): Promise<string> {
    const res = await this.apiRequest('POST', '/v3/console/ai/skills/upload', {
      multipart: buildSkillZipMultipart(args.zip, this.namespace, {
        overwrite: String(args.overwrite),
        commitMsg: args.commitMsg,
      }),
    })
    return pickString(res, ['data']) ?? ''
  }

  /** 草稿 → 提交审核（form） */
  async submitTeamSkillVersion(skillName: string, version: string): Promise<void> {
    await this.apiRequest('POST', '/v3/console/ai/skills/submit', {
      form: { namespaceId: this.namespace, skillName, version },
    })
  }

  /** 提交 → 发布（form） */
  async publishTeamSkillVersion(skillName: string, version: string): Promise<void> {
    await this.apiRequest('POST', '/v3/console/ai/skills/publish', {
      form: { namespaceId: this.namespace, skillName, version },
    })
  }

  /** 发布 → 上线（form）；已是终态时服务端可能拒绝，由调用方决定是否容忍 */
  async onlineTeamSkillVersion(skillName: string, version: string): Promise<void> {
    await this.apiRequest('POST', '/v3/console/ai/skills/online', {
      form: { namespaceId: this.namespace, skillName, version },
    })
  }

  /** 共享范围：PRIVATE → PUBLIC（团队可见的前提） */
  async setTeamSkillScope(skillName: string, scope: 'PRIVATE' | 'PUBLIC'): Promise<void> {
    await this.apiRequest('PUT', '/v3/console/ai/skills/scope', {
      form: { namespaceId: this.namespace, skillName, scope },
    })
  }

  /** 下载指定版本技能包 zip（二进制） */
  async downloadTeamSkillVersion(skillName: string, version: string): Promise<Buffer> {
    const query = new URLSearchParams({ namespaceId: this.namespace, skillName, version })
    const token = await this.ensureToken()
    return this.rawBinaryRequest('GET', '/v3/console/ai/skills/version/download', { query, token })
  }

  /** 删除整个技能（清理/撤回用；调用方必须先取得用户确认） */
  async deleteTeamSkill(skillName: string): Promise<boolean> {
    const query = new URLSearchParams({ namespaceId: this.namespace, skillName })
    const res = await this.apiRequest('DELETE', '/v3/console/ai/skills', { query })
    return res != null
  }

  // ─── AI MCP 原生 API（MCP 推拉） ────────────────────────────────────

  /**
   * 团队 MCP 列表。注意：list 必须带 search 参数（缺失会触发服务端版本 join
   * 异常，整个接口 404——真机复现过的坑）。
   */
  async listTeamMcpServers(search = 'blur'): Promise<Array<Record<string, unknown>>> {
    const query = new URLSearchParams({
      namespaceId: this.namespace,
      search,
      pageNo: '1',
      pageSize: '200',
    })
    const res = await this.apiRequest('GET', '/v3/console/ai/mcp/list', { query })
    return pickArray(res, ['data.pageItems', 'pageItems', 'data']).filter(
      (item) => item != null && typeof item === 'object',
    ) as Array<Record<string, unknown>>
  }

  /** MCP 详情（含 versions/serverSpecification）；不存在返回 null */
  async getTeamMcpServer(mcpName: string): Promise<TeamMcpDetail | null> {
    const query = new URLSearchParams({ namespaceId: this.namespace, mcpName })
    try {
      const res = await this.apiRequest('GET', '/v3/console/ai/mcp', { query })
      const data = asRecord(getPath(res, 'data')) ?? asRecord(res)
      if (!data) return null
      return normalizeMcpDetail(data, mcpName)
    } catch (err) {
      if (err instanceof NacosClientError && mcpMissing(err)) return null
      throw err
    }
  }

  /**
   * MCP 版本级详情（该版本的 serverSpecification；顶层详情恒为最新发布版本）。
   * 路由已在真机核实存在（虚构名称返回业务 404 而非网关 No static resource）。
   */
  async getTeamMcpVersion(mcpName: string, version: string): Promise<Record<string, unknown> | null> {
    const query = new URLSearchParams({ namespaceId: this.namespace, mcpName, version })
    try {
      const res = await this.apiRequest('GET', '/v3/console/ai/mcp/version', { query })
      return getPath(res, 'data') != null && typeof getPath(res, 'data') === 'object'
        ? (getPath(res, 'data') as Record<string, unknown>)
        : asRecord(res)
    } catch (err) {
      if (err instanceof NacosClientError && mcpMissing(err)) return null
      throw err
    }
  }

  /**
   * 创建 MCP 草稿（form）。
   *
   * ⚠️ 孤儿行陷阱（真机复现）：spec 校验不过时 server 行已建、version 行缺失，
   * 且会卡死整个 /mcp/list。调用方（service 层）创建后必须立即回读校验，
   * 失败即调用 deleteTeamMcpServer 清理——本方法只做传输。
   */
  async createTeamMcpDraft(fields: McpPublishDraftFields): Promise<void> {
    await this.apiRequest('POST', '/v3/console/ai/mcp/draft', { form: { ...fields } })
  }

  async submitTeamMcpVersion(mcpName: string, version: string): Promise<void> {
    await this.apiRequest('POST', '/v3/console/ai/mcp/submit', {
      form: { namespaceId: this.namespace, mcpName, version },
    })
  }

  async publishTeamMcpVersion(mcpName: string, version: string): Promise<void> {
    await this.apiRequest('POST', '/v3/console/ai/mcp/publish', {
      form: { namespaceId: this.namespace, mcpName, version },
    })
  }

  async onlineTeamMcpVersion(mcpName: string, version: string): Promise<void> {
    await this.apiRequest('POST', '/v3/console/ai/mcp/online', {
      form: { namespaceId: this.namespace, mcpName, version },
    })
  }

  /** 删除 MCP（含孤儿行清理；调用方必须先取得用户确认或用于失败回滚） */
  async deleteTeamMcpServer(mcpName: string): Promise<boolean> {
    const query = new URLSearchParams({ namespaceId: this.namespace, mcpName })
    const res = await this.apiRequest('DELETE', '/v3/console/ai/mcp', { query })
    return res != null
  }

  // ─── AI AgentSpec 原生 API（工作流 / 平台 Agent / 子应用承载） ──────

/** 团队 AgentSpec 列表（控制台原生管理页同一数据源） */
  async listTeamAgentSpecs(): Promise<Array<Record<string, unknown>>> {
    const query = new URLSearchParams({ namespaceId: this.namespace, pageNo: '1', pageSize: '200' })
    const res = await this.apiRequest('GET', '/v3/console/ai/agentspecs/list', { query })
    return pickArray(res, ['data.pageItems', 'pageItems', 'data']).filter(
      (item) => item != null && typeof item === 'object',
    ) as Array<Record<string, unknown>>
  }

  /** AgentSpec 详情（含 versions[] 生命周期）；不存在返回 null */
  async getTeamAgentSpec(agentSpecName: string): Promise<TeamAgentSpecDetail | null> {
    const query = new URLSearchParams({ namespaceId: this.namespace, agentSpecName })
    try {
      const res = await this.apiRequest('GET', '/v3/console/ai/agentspecs', { query })
      const data = asRecord(getPath(res, 'data')) ?? asRecord(res)
      if (!data) return null
      return normalizeAgentSpecDetail(data, agentSpecName)
    } catch (err) {
      if (err instanceof NacosClientError && agentspecMissing(err)) return null
      throw err
    }
  }

  /**
   * 上传 AgentSpec zip（服务端解析 manifest.json 建版本）。真机实测：条目不存在
   * 时直接创建（无需先调 create——create 端点在当前 SNAPSHOT 上 500，不依赖）；
   * 已存在且版本更新时生成新草稿版本。返回服务端确认的 agentSpecName。
   */
  async uploadTeamAgentSpecZip(args: { zip: Buffer; commitMsg?: string }): Promise<string> {
    const extra: Record<string, string> = {}
    if (args.commitMsg != null) extra.commitMsg = args.commitMsg
    const res = await this.apiRequest('POST', '/v3/console/ai/agentspecs/upload', {
      multipart: buildZipMultipart(args.zip, this.namespace, 'agentspec-package.zip', extra),
    })
    return pickString(res, ['data']) ?? ''
  }

  /** 草稿 → 提交审核（query 参数形态，真机核实） */
  async submitTeamAgentSpecVersion(agentSpecName: string, version: string): Promise<void> {
    await this.agentSpecAction('submit', agentSpecName, version)
  }

  /** 提交 → 发布（query 参数形态） */
  async publishTeamAgentSpecVersion(agentSpecName: string, version: string): Promise<void> {
    await this.agentSpecAction('publish', agentSpecName, version)
  }

  /** 发布 → 上线（query 参数形态）；终态拒绝由调用方容忍 */
  async onlineTeamAgentSpecVersion(agentSpecName: string, version: string): Promise<void> {
    await this.agentSpecAction('online', agentSpecName, version)
  }

  /** 下线（撤回共享时用） */
  async offlineTeamAgentSpecVersion(agentSpecName: string, version: string): Promise<void> {
    await this.agentSpecAction('offline', agentSpecName, version)
  }

  /** 共享范围：PRIVATE → PUBLIC（团队可见前提；真机核实为 PUT + form） */
  async setTeamAgentSpecScope(agentSpecName: string, scope: 'PRIVATE' | 'PUBLIC'): Promise<void> {
    await this.apiRequest('PUT', '/v3/console/ai/agentspecs/scope', {
      form: { namespaceId: this.namespace, agentSpecName, scope },
    })
  }

  /**
   * 版本详情：manifest 原文 + 全部资源内容（安装/更新比对依据）。
   * 不存在（条目或版本）返回 null。
   */
  async getTeamAgentSpecVersion(
    agentSpecName: string,
    version: string,
  ): Promise<TeamAgentSpecVersionDetail | null> {
    const query = new URLSearchParams({ namespaceId: this.namespace, agentSpecName, version })
    try {
      const res = await this.apiRequest('GET', '/v3/console/ai/agentspecs/version', { query })
      const data = asRecord(getPath(res, 'data'))
      if (!data) return null
      return normalizeAgentSpecVersionDetail(data, agentSpecName, version)
    } catch (err) {
      if (err instanceof NacosClientError && agentspecMissing(err)) return null
      throw err
    }
  }

  /** 删除整个 AgentSpec（清理/撤回用；调用方必须先取得用户确认） */
  async deleteTeamAgentSpec(agentSpecName: string): Promise<boolean> {
    const query = new URLSearchParams({ namespaceId: this.namespace, agentSpecName })
    const res = await this.apiRequest('DELETE', '/v3/console/ai/agentspecs', { query })
    return res != null
  }

  private async agentSpecAction(action: string, agentSpecName: string, version: string): Promise<void> {
    await this.apiRequest('POST', `/v3/console/ai/agentspecs/${action}`, {
      query: new URLSearchParams({ namespaceId: this.namespace, agentSpecName, version }),
    })
  }

  // ─── 健康 ───────────────────────────────────────────────────────────

  /** 连接测试：探 /v3/console/server/state（只读、无需业务数据） */
  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now()
    try {
      await this.apiRequest('GET', '/v3/console/server/state', { auth: false })
      return { healthy: true, latencyMs: Date.now() - start }
    } catch (err) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** 登录 + 列表全链路测试（保存配置前的「测试连接」用） */
  async testRoundTrip(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now()
    try {
      await this.ensureToken()
      await this.listConfigs({ pageSize: 1 })
      return { healthy: true, latencyMs: Date.now() - start }
    } catch (err) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // ─── 内部请求设施 ───────────────────────────────────────────────────

  private async apiRequest(
    method: string,
    path: string,
    opts: {
      query?: URLSearchParams
      body?: unknown
      form?: Record<string, string>
      multipart?: { body: Buffer; contentType: string }
      auth?: boolean
    } = {},
  ): Promise<unknown> {
    const useAuth = opts.auth !== false
    let token: string | undefined
    if (useAuth) token = await this.ensureToken()
    try {
      return await this.rawRequest(method, path, { ...opts, ...(token ? { token } : {}) })
    } catch (err) {
      // token 过期被服务端拒：重登一次再试（只重试一轮，防循环）
      if (err instanceof NacosClientError && (err.statusCode === 401 || err.statusCode === 403)) {
        this.invalidateToken()
        if (useAuth) {
          const newToken = await this.ensureToken()
          return await this.rawRequest(method, path, { ...opts, token: newToken })
        }
      }
      throw err
    }
  }

  private async rawRequest(
    method: string,
    path: string,
    opts: {
      query?: URLSearchParams
      body?: unknown
      form?: Record<string, string>
      multipart?: { body: Buffer; contentType: string }
      token?: string
      auth?: boolean
    } = {},
  ): Promise<unknown> {
    const url = new URL(`${this.serverUrl}${path}`)
    if (opts.query) for (const [k, v] of opts.query.entries()) url.searchParams.set(k, v)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`

    // 三种载荷：JSON（配置中心）/ form（AI 写端点统一形态）/ multipart（zip 上传）
    let body: string | Buffer | undefined
    if (opts.multipart != null) {
      headers['Content-Type'] = opts.multipart.contentType
      body = opts.multipart.body
    } else if (opts.form != null) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(opts.form).toString()
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body)
      headers['Content-Type'] = 'application/json'
    }

    let res: unknown
    try {
      res = await fetchJson<unknown>(url.toString(), {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        timeoutMs: 20_000,
        // 写端点非幂等：只在 GET/DELETE 上允许一次重试
        maxRetries: method === 'GET' ? 1 : 0,
        retryBackoffMs: 300,
        fetchImpl: this.fetchImpl,
      })
    } catch (err) {
      if (err instanceof HttpError) {
        throw new NacosClientError(
          `Nacos ${method} ${path} 失败：HTTP ${err.statusCode ?? 'network'} ${err.message}`,
          err.statusCode,
        )
      }
      throw err
    }
    // Nacos 统一信封 {code, message, data}；code!==0 视为失败
    const envelope = res as NacosApiEnvelope | null
    if (envelope != null && typeof envelope === 'object') {
      const code = typeof envelope.code === 'number' ? envelope.code : 0
      if (code !== 0) {
        throw new NacosClientError(
          `Nacos ${method} ${path} 业务失败：code=${code} ${envelope.message ?? ''}`.trim(),
          200,
          code,
        )
      }
      return envelope
    }
    return res
  }

  /** 二进制下载（zip），无业务信封；非 2xx 报错并带响应体摘要 */
  private async rawBinaryRequest(
    method: string,
    path: string,
    opts: { query?: URLSearchParams; token?: string },
  ): Promise<Buffer> {
    const url = new URL(`${this.serverUrl}${path}`)
    if (opts.query) for (const [k, v] of opts.query.entries()) url.searchParams.set(k, v)
    try {
      return await fetchJson<Buffer>(url.toString(), {
        method,
        headers: {
          Accept: 'application/zip, application/octet-stream, */*',
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        binary: true,
        timeoutMs: 30_000,
        maxRetries: 1,
        retryBackoffMs: 300,
        fetchImpl: this.fetchImpl,
      })
    } catch (err) {
      if (err instanceof HttpError) {
        throw new NacosClientError(
          `Nacos ${method} ${path} 下载失败：HTTP ${err.statusCode ?? 'network'} ${err.message}`,
          err.statusCode,
        )
      }
      throw err
    }
  }
}

// ─── multipart 编码（zip 上传；手写以复用 fetchJson 的超时/重试/错误包装） ──

interface MultipartPart {
  name: string
  value: string | Buffer
  filename?: string
  contentType?: string
}

function buildMultipartBody(parts: MultipartPart[], boundary: string): Buffer {
  const chunks: Buffer[] = []
  const preamble = (s: string) => Buffer.from(s, 'utf-8')
  for (const part of parts) {
    chunks.push(preamble(`--${boundary}\r\n`))
    if (part.filename != null) {
      chunks.push(
        preamble(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
        ),
      )
    } else {
      chunks.push(preamble(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`))
    }
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value, 'utf-8'))
    chunks.push(preamble('\r\n'))
  }
  chunks.push(preamble(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

/** 通用 zip multipart（skill / agentspec 上传共用） */
function buildZipMultipart(
  zip: Buffer,
  namespaceId: string,
  filename: string,
  extra: Record<string, string> = {},
): { body: Buffer; contentType: string } {
  const boundary = `spark-team-${Math.abs(hashString(`${filename}-${zip.length}-${namespaceId}`))}-${partCounter++}`
  const parts: MultipartPart[] = [
    { name: 'file', value: zip, filename, contentType: 'application/zip' },
    { name: 'namespaceId', value: namespaceId },
  ]
  for (const [key, value] of Object.entries(extra)) parts.push({ name: key, value })
  return { body: buildMultipartBody(parts, boundary), contentType: `multipart/form-data; boundary=${boundary}` }
}

function buildSkillZipMultipart(
  zip: Buffer,
  namespaceId: string,
  extra: { overwrite?: string; commitMsg?: string } = {},
): { body: Buffer; contentType: string } {
  return buildZipMultipart(zip, namespaceId, 'skill-package.zip', { ...extra })
}

let partCounter = 0

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return h
}

// ─── 响应字段宽容提取（v3 各端点 shape 不一，多重兜底） ─────────────────

function pickString(source: unknown, paths: string[]): string | null {
  for (const p of paths) {
    const value = getPath(source, p)
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function pickNumber(source: unknown, paths: string[]): number | null {
  for (const p of paths) {
    const value = getPath(source, p)
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function pickBoolean(source: unknown, paths: string[]): boolean | null {
  for (const p of paths) {
    const value = getPath(source, p)
    if (typeof value === 'boolean') return value
  }
  return null
}

function pickArray(source: unknown, paths: string[]): unknown[] {
  for (const p of paths) {
    const value = getPath(source, p)
    if (Array.isArray(value)) return value
  }
  return []
}

function getPath(source: unknown, dottedPath: string): unknown {
  let current: unknown = source
  for (const segment of dottedPath.split('.')) {
    if (current == null || typeof current !== 'object') return null
    current = (current as Record<string, unknown>)[segment] ?? null
  }
  return current
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeSkillDetail(data: Record<string, unknown>, fallbackName: string): TeamSkillDetail {
  const versions = pickArray(data, ['versions', 'data.versions'])
    .map((v) => asRecord(v))
    .filter((v): v is Record<string, unknown> => v != null)
    .map((v) => ({
      version: pickString(v, ['version']) ?? '',
      status: pickString(v, ['status']) ?? '',
    }))
    .filter((v) => v.version)
  const out: TeamSkillDetail = {
    skillName: pickString(data, ['skillName', 'name']) ?? fallbackName,
    name: pickString(data, ['name', 'displayName']) ?? fallbackName,
    scope: pickString(data, ['scope']) ?? 'PRIVATE',
    description: pickString(data, ['description']) ?? '',
    versions,
    raw: data,
  }
  return out
}

function normalizeMcpDetail(data: Record<string, unknown>, fallbackName: string): TeamMcpDetail {
  // 真机形态：详情 data.versions 不存在，版本列表在 allVersions（无 status）；
  // spec 相关字段（protocol/localServerConfig/...）平铺在 data 顶层。
  const versionsRaw = (() => {
    for (const key of ['allVersions', 'versions', 'versionDetails']) {
      const arr = data[key]
      if (Array.isArray(arr)) return arr
    }
    return []
  })()
  const versions = (versionsRaw as unknown[])
    .map((v) => asRecord(v))
    .filter((v): v is Record<string, unknown> => v != null)
    .map((v) => ({
      version: pickString(v, ['version']) ?? '',
      // 真机形态：allVersions 行无 status；「已发布」以 release_date 有值为信号
      //（草稿行无 release_date），合成 published 供版本过滤/安装校验使用。
      status:
        pickString(v, ['status']) ??
        (pickString(v, ['release_date']) != null ? 'published' : ''),
    }))
    .filter((v) => v.version)
  const explicitSpec = asRecord(data.serverSpecification)
  const spec =
    explicitSpec ??
    (() => {
      // 平铺形态：提取 spec 相关顶层字段组成视图
      const view: Record<string, unknown> = {}
      for (const key of [
        'protocol',
        'frontProtocol',
        'localServerConfig',
        'remoteServerConfig',
        'endpointSpecification',
        'versionDetail',
        'description',
        'name',
      ]) {
        if (data[key] !== undefined) view[key] = data[key]
      }
      return Object.keys(view).length > 0 ? view : null
    })()
  const out: TeamMcpDetail = {
    mcpName: pickString(data, ['mcpName', 'name', 'serverName']) ?? fallbackName,
    description: pickString(data, ['description']) ?? '',
    versions,
    serverSpecification: spec,
    raw: data,
  }
  return out
}

function normalizeConfigSummary(item: unknown): NacosConfigSummary | null {
  if (item == null || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const dataId =
    typeof record.dataId === 'string' ? record.dataId : undefined
  if (!dataId) return null
  const out: NacosConfigSummary = {
    dataId,
    group: typeof record.group === 'string' ? record.group : (record.groupName as string) ?? '',
  }
  if (typeof record.type === 'string') out.type = record.type
  const modified = record.lastModifiedTime ?? record.modifiedTime ?? record.modifyTime
  if (typeof modified === 'number') out.modifiedTime = modified
  return out
}

function normalizeAgentSpecDetail(data: Record<string, unknown>, fallbackName: string): TeamAgentSpecDetail {
  const versions = pickArray(data, ['versions'])
    .map((v) => asRecord(v))
    .filter((v): v is Record<string, unknown> => v != null)
    .map((v) => ({
      version: pickString(v, ['version']) ?? '',
      status: pickString(v, ['status']) ?? '',
      author: pickString(v, ['author']),
    }))
    .filter((v) => v.version)
  const labels = asRecord(data.labels)
  const out: TeamAgentSpecDetail = {
    name: pickString(data, ['name', 'agentSpecName']) ?? fallbackName,
    description: pickString(data, ['description']) ?? '',
    scope: pickString(data, ['scope']) ?? 'PRIVATE',
    latestPublished: labels ? pickString(labels, ['latest']) : null,
    editingVersion: pickString(data, ['editingVersion']),
    versions,
    raw: data,
  }
  return out
}

function normalizeAgentSpecVersionDetail(
  data: Record<string, unknown>,
  fallbackName: string,
  fallbackVersion: string,
): TeamAgentSpecVersionDetail {
  const resources: Array<{ path: string; content: string }> = []
  const resourceMap = asRecord(data.resource)
  if (resourceMap) {
    for (const [key, value] of Object.entries(resourceMap)) {
      const entry = asRecord(value)
      if (!entry) continue
      const content = pickString(entry, ['content'])
      if (content == null) continue
      // 服务端把资源键里的 / 与 . 转义（payload.json → payload__json）；
      // 相对路径以 resourceIdentifier（子目录资源为 `res::path`）或 name 还原。
      const identifier = pickString(entry, ['resourceIdentifier'])
      const name = pickString(entry, ['name'])
      const path =
        identifier != null && identifier.includes('::')
          ? identifier.slice(identifier.indexOf('::') + 2)
          : (name ?? key)
      resources.push({ path, content })
    }
  }
  const out: TeamAgentSpecVersionDetail = {
    name: pickString(data, ['name']) ?? fallbackName,
    version: fallbackVersion,
    manifestRaw: pickString(data, ['content']) ?? '',
    resources,
    raw: data,
  }
  return out
}

/** AgentSpec / 版本不存在的确定语义（详情与版本详情接口） */
function agentspecMissing(err: NacosClientError): boolean {
  return (
    err.statusCode === 404 ||
    err.nacosCode === 404 ||
    /agents?\s?spec.{0,24}not exist|agentspecname not exist|agent spec.{0,24}不存在/i.test(err.message) ||
    /not exist|不存在/i.test(err.message)
  )
}

function isNotFound(err: NacosClientError): boolean {
  const msg = err.message
  // 只匹配「配置不存在」这一确定语义；宽泛的 not found/不存在 会把
  // 「命名空间不存在」等其它错误误判成配置缺失。
  return (
    err.statusCode === 404 ||
    err.nacosCode === 404 ||
    /config not exist|config is not exist|配置不存在|配置信息不存在/i.test(msg)
  )
}

/** 技能不存在的确定语义（详情接口） */
function skillMissing(err: NacosClientError): boolean {
  return (
    err.statusCode === 404 ||
    err.nacosCode === 404 ||
    /skill (not|is not) exist|skillName not exist|技能不存在/i.test(err.message)
  )
}

/** MCP 不存在的确定语义（详情接口） */
function mcpMissing(err: NacosClientError): boolean {
  return (
    err.statusCode === 404 ||
    err.nacosCode === 404 ||
    /(mcp|server) (not|is not) exist|mcpName not exist|no server/i.test(err.message)
  )
}
