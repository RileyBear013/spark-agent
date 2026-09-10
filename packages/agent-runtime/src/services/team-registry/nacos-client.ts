/**
 * @module team-registry/nacos-client
 *
 * Nacos v3 控制台 OpenAPI 客户端（团队注册中心专用）
 *
 * 认证：POST /v3/auth/login (username/password) → accessToken，
 * 后续请求带 `Authorization: Bearer <token>`；token 缓存并按 TTL 提前重登。
 *
 * 已实测（2026-09-10，192.168.163.174:8080 / v3.3.0-SNAPSHOT）：
 *   GET  /v3/console/cs/config/list          配置列表（public 现存 6 条 nacos.ai.resource.search.*）
 *   GET  /v3/console/ai/skills/list           AI Skill 列表（当前为空）
 *   GET  /v3/console/ai/skills?skillName=     AI Skill 详情
 *   POST /v3/console/ai/mcp                   存在（空载荷 400「serverSpecification 不能为空」）
 * 写端点（发布配置 / AI skill 写入）按 v3 标准 shape 实现，字段以服务端
 * 错误信息为准现场修正——本客户端把服务端 code/message 原样透出，便于诊断。
 */

import { fetchJson, HttpError } from '@spark/shared'

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

interface NacosApiEnvelope {
  code?: number
  message?: string
  data?: unknown
  // 部分旧端点直接平铺在顶层
  accessToken?: string
  tokenTtlMs?: number
}

const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000
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
    const res = await this.rawRequest('POST', '/v3/auth/login', {
      body: { username: this.username, password: this.password },
      auth: false,
    })
    const token =
      pickString(res, ['accessToken', 'data.accessToken']) ??
      pickString(res, ['token', 'data.token'])
    if (!token) throw new NacosClientError('Nacos 登录响应中没有 accessToken')
    const ttl = pickNumber(res, ['tokenTtlMs', 'data.tokenTtlMs'])
    this.token = token
    this.tokenExpiresAt = Date.now() + (ttl && ttl > 0 ? ttl : this.tokenTtlMs) - TOKEN_EXPIRY_MARGIN_MS
    return token
  }

  /** 清空缓存 token（401 后强制重登 / 测试用） */
  invalidateToken(): void {
    this.token = null
    this.tokenExpiresAt = 0
  }

  // ─── 配置中心 ───────────────────────────────────────────────────────

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
    const res = await this.apiRequest('POST', '/v3/console/cs/config', { body })
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

  // ─── AI 资源（发现层，best-effort） ──────────────────────────────────

  /** AI Skill 列表（团队源发现卡片数据；失败由调用方降级为配置中心信封） */
  async listAiSkills(): Promise<Array<Record<string, unknown>>> {
    const query = new URLSearchParams({ namespaceId: this.namespace, pageNo: '1', pageSize: '200' })
    const res = await this.apiRequest('GET', '/v3/console/ai/skills/list', { query })
    const items = pickArray(res, ['data.pageItems', 'pageItems', 'data'])
    return items.filter((item) => item != null && typeof item === 'object') as Array<
      Record<string, unknown>
    >
  }

  /**
   * 写入/更新一条 AI Skill 元数据条目（发现层，best-effort）。
   * 字段结构按 v3 控制台 `skillSpecification` 惯例拼装；服务端校验失败抛
   * NacosClientError（消息含服务端 code/message），调用方降级不阻断信封发布。
   */
  async publishAiSkill(meta: {
    skillName: string
    version: string
    name: string
    description: string
    author?: string
    skillMd?: string
  }): Promise<void> {
    const body = {
      namespaceId: this.namespace,
      skillName: meta.skillName,
      skillSpecification: JSON.stringify({
        syncRun: false,
        skillVersion: meta.version,
        skillDescriptor: {
          name: meta.name,
          description: meta.description,
          version: meta.version,
          ...(meta.author ? { author: meta.author } : {}),
        },
        sourceContent: meta.skillMd ?? '',
      }),
    }
    await this.apiRequest('POST', '/v3/console/ai/skills', { body })
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
    opts: { query?: URLSearchParams; body?: unknown; auth?: boolean } = {},
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
    opts: { query?: URLSearchParams; body?: unknown; token?: string; auth?: boolean } = {},
  ): Promise<unknown> {
    const url = new URL(`${this.serverUrl}${path}`)
    if (opts.query) for (const [k, v] of opts.query.entries()) url.searchParams.set(k, v)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`
    let body: string | undefined
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body)
      headers['Content-Type'] = 'application/json'
    }
    let res: unknown
    try {
      res = await fetchJson<unknown>(url.toString(), {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        timeoutMs: 15_000,
        maxRetries: 1,
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
