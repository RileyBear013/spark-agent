/**
 * @module team-registry/mcp-mapping
 *
 * 本地 MCP config_json ↔ Nacos AI MCP serverSpecification 双向映射
 *
 * Nacos 侧结构为 2026-09-11 真机联调核实的控制台标准形态（docs/plan/
 * team-registry-sharing.md「MCP 原生 API」一节）：
 *   - stdio 型：localServerConfig 承载 command/args/env，无 endpointSpecification
 *   - 远程型：endpointSpecification（DIRECT/REF）+ remoteServerConfig.exportPath
 *
 * 映射原则：
 *   - 只映射传输相关信息（transport/command/args/env/url/headers）；本地行的
 *     scope/enabled/描述等管理字段不进团队注册中心。
 *   - env/headers 可能含密钥：原样发布（团队共享的前提就是成员可见配置），
 *     但 buildMcpPublishSummary 会提取敏感键名列表，UI 发布确认时向用户展示
 *     「将包含哪些敏感命名变量」（只展示键名，不展示值）。
 */

import { resolveMcpConfig } from '../../mcp/index.js'

/** Nacos MCP 协议取值（stdio 已真机验证；streamable/sse 待真机复核，字段常量集中便于修正） */
export const NACOS_MCP_PROTOCOL = {
  stdio: 'stdio',
  streamableHttp: 'streamable-http',
  sse: 'sse',
} as const

export type NacosMcpProtocol = (typeof NACOS_MCP_PROTOCOL)[keyof typeof NACOS_MCP_PROTOCOL]

/** Nacos endpointSpecification 的 DIRECT 形态（REF 形态暂不支持发布，见下） */
export interface NacosEndpointDirect {
  type: 'DIRECT'
  data: {
    transportProtocol: string
    address: string
    port: string
  }
}

export interface NacosServerSpecification {
  name: string
  version: string
  protocol: NacosMcpProtocol
  frontProtocol: NacosMcpProtocol
  enabled: boolean
  status: string
  capabilities: unknown[]
  description: string
  localServerConfig: { command: string; args?: string[]; env?: Record<string, string> } | null
  remoteServerConfig: { exportPath?: string } | null
  versionDetail: { version: string; is_latest: boolean | null; release_date: string | null }
}

export interface McpPublishDraftFields {
  namespaceId: string
  mcpName: string
  version: string
  serverSpecification: string
  /** 仅远程型需要（stdio 不带）；JSON 字符串 */
  endpointSpecification?: string
}

const SENSITIVE_KEY_PATTERN = /(token|secret|key|password|credential|apikey|api_key|auth)/i

/** 提取配置中「看起来敏感」的键名（只返回键名，绝不返回值） */
export function sensitiveConfigKeys(config: Record<string, unknown>): string[] {
  const keys: string[] = []
  const collect = (record: Record<string, unknown> | undefined) => {
    if (!record) return
    for (const [k, v] of Object.entries(record)) {
      if (SENSITIVE_KEY_PATTERN.test(k) && v != null) keys.push(k)
    }
  }
  collect(asRecord(config.env))
  collect(asRecord(config.headers))
  return keys
}

/**
 * 本地 config_json（原始解析对象）→ Nacos 创建草稿的表单字段。
 * config_json 结构宽容（transport/type 双写法），内部经 resolveMcpConfig 归一化。
 */
export function buildMcpDraftFields(args: {
  mcpName: string
  version: string
  namespaceId: string
  configJson: string
  description?: string
}): McpPublishDraftFields {
  const config = parseConfigJson(args.configJson)
  const resolved = resolveMcpConfig(config)
  if (!resolved) {
    throw new Error(`MCP 配置无法解析出有效传输（需要 command 或 url）：${args.mcpName}`)
  }

  const spec: NacosServerSpecification = {
    name: args.mcpName,
    version: args.version,
    protocol: 'stdio',
    frontProtocol: 'stdio',
    enabled: true,
    status: 'active',
    capabilities: [],
    description: args.description?.trim() || args.mcpName,
    localServerConfig: null,
    remoteServerConfig: null,
    versionDetail: { version: args.version, is_latest: null, release_date: null },
  }

  let endpointSpecification: string | undefined
  if (resolved.type === 'stdio') {
    spec.protocol = NACOS_MCP_PROTOCOL.stdio
    spec.frontProtocol = NACOS_MCP_PROTOCOL.stdio
    spec.localServerConfig = {
      command: resolved.command,
      ...(resolved.args && resolved.args.length > 0 ? { args: resolved.args } : {}),
      ...(resolved.env && Object.keys(resolved.env).length > 0 ? { env: resolved.env } : {}),
    }
  } else {
    // http / sse → 远程型：endpointSpecification DIRECT + exportPath
    const url = new URL(resolved.url)
    const transportProtocol = url.protocol.replace(':', '') // http / https
    spec.protocol =
      resolved.type === 'sse' ? NACOS_MCP_PROTOCOL.sse : NACOS_MCP_PROTOCOL.streamableHttp
    spec.frontProtocol = spec.protocol
    spec.remoteServerConfig = {
      exportPath: `${url.pathname}${url.search}` === '/' ? '' : `${url.pathname}${url.search}`,
    }
    const endpoint: NacosEndpointDirect = {
      type: 'DIRECT',
      data: {
        transportProtocol,
        address: url.hostname,
        port: url.port || (transportProtocol === 'https' ? '443' : '80'),
      },
    }
    endpointSpecification = JSON.stringify(endpoint)
  }

  const fields: McpPublishDraftFields = {
    namespaceId: args.namespaceId,
    mcpName: args.mcpName,
    version: args.version,
    serverSpecification: JSON.stringify(spec),
  }
  if (endpointSpecification != null) fields.endpointSpecification = endpointSpecification
  return fields
}

/** Nacos serverSpecification（详情接口返回的对象）→ 本地 config_json 字符串；不支持的结构返回 null */
export function specToLocalConfigJson(spec: unknown): string | null {
  if (spec == null || typeof spec !== 'object') return null
  const s = spec as Record<string, unknown>
  const protocol = typeof s.protocol === 'string' ? s.protocol.toLowerCase() : ''

  if (protocol === NACOS_MCP_PROTOCOL.stdio) {
    const local = asRecord(s.localServerConfig)
    const command = typeof local?.command === 'string' ? local.command : undefined
    if (!command) return null
    const args = Array.isArray(local?.args)
      ? local.args.filter((a): a is string => typeof a === 'string')
      : undefined
    const env = asRecord(local?.env)
    return JSON.stringify({
      transport: 'stdio',
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
    })
  }

  // 远程型：从 endpointSpecification（DIRECT）或 remoteServerConfig 还原 url
  const endpoint = asRecord(s.endpointSpecification) ?? extractEndpointFromDetail(s)
  const remote = asRecord(s.remoteServerConfig)
  const exportPath = typeof remote?.exportPath === 'string' ? remote.exportPath : ''
  const directData = endpoint != null && endpoint.type === 'DIRECT' ? asRecord(endpoint.data) : null
  const transportProtocol = typeof directData?.transportProtocol === 'string'
    ? directData.transportProtocol
    : 'http'
  const address = typeof directData?.address === 'string' ? directData.address : undefined
  if (!address) return null
  const port = directData?.port != null ? String(directData.port) : ''
  const portSuffix = port && port !== '80' && port !== '443' ? `:${port}` : ''
  const url = `${transportProtocol}://${address}${portSuffix}${exportPath.startsWith('/') ? exportPath : exportPath ? `/${exportPath}` : ''}`
  const transport = protocol.includes('sse')
    ? 'sse'
    : protocol.includes('streamable') || protocol.includes('http')
      ? 'http'
      : null
  if (!transport) return null
  return JSON.stringify({ transport, url })
}

// ─── 内部 ───────────────────────────────────────────────────────────────

function parseConfigJson(configJson: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(configJson)
  } catch {
    throw new Error('MCP config_json 不是合法 JSON')
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP config_json 必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * 详情接口的嵌套形态兜底：部分版本把 endpointSpecification 嵌在
 * remoteServerConfig / 顶层 detail 里，这里做宽容提取。
 */
function extractEndpointFromDetail(spec: Record<string, unknown>): Record<string, unknown> | null {
  const remote = asRecord(spec.remoteServerConfig)
  const nested = asRecord(remote?.endpointSpecification) ?? asRecord(spec.endpointSpecification)
  return nested ?? null
}
