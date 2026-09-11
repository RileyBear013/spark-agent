/**
 * @module team-registry/agentspec
 *
 * 信封 ⇄ Nacos 原生 AgentSpec 编解码（M3/M4 原生承载）
 *
 * 背景：工作流 / 平台 Agent / 子应用最初用配置中心裸配置承载（SPARK_TEAM 组），
 * 控制台里是运维视角的 JSON，对不上 Skill/MCP 的原生管理页。2026-09-11 真机探针
 * 确认原生 AgentSpec 资源可承载同类管理（docs/plan/team-registry-sharing.md）：
 *   - 包格式 = manifest.json + 资源文件（zip 上传，服务端解析 manifest 建版本）；
 *   - 控制台独立管理页：版本生命周期（draft→submit→publish→online）、共享
 *     scope（PRIVATE/PUBLIC）、下载统计；
 *   - 自定义 manifest 扩展字段 `x-spark` 服务端原样保留（实测），携带信封元数据；
 *   - 版本详情端点返回 manifest 原文 + 全部资源内容（上游尚无 zip 下载端点，
 *     内容回读即安装/更新比对的依据）。
 *
 * 编解码保持既有 spark.team.asset.v1 信封形状不变：发布侧 envelope→zip，
 * 安装/比对侧 zip 内容→envelope，下游（端口/pins/六态判定/UI）零改动。
 */

import { buildZip } from './zip.js'
import {
  TEAM_ASSET_SCHEMA,
  verifyEnvelopeChecksum,
  type TeamAssetEnvelope,
  type TeamAssetType,
} from './types.js'
import type { TeamAgentSpecVersionDetail } from './nacos-client.js'

/** manifest 里的 SparkWork 扩展字段名（服务端对未知字段原样保留，实测） */
export const AGENT_SPEC_X_FIELD = 'x-spark'

/** SparkWork 资产在 AgentSpec 命名空间里的统一前缀 */
export const AGENT_SPEC_PREFIX = 'spark-'

/** manifest x-spark 载荷 schema 版本 */
const AGENT_SPEC_X_SCHEMA = 1

/** AgentSpec 承载的信封资产类型（skill/mcp 走各自原生资源，不经此编解码） */
export type AgentSpecAssetType = Extract<TeamAssetType, 'workflow' | 'agent' | 'app'>

/** agentSpecName 规则：`spark-<assetType>-<slug>`（全 ASCII，跨机器稳定） */
export function agentSpecNameFor(assetType: AgentSpecAssetType, slug: string): string {
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
    throw new Error(`非法的资产 slug：${slug}`)
  }
  return `${AGENT_SPEC_PREFIX}${assetType}-${slug}`
}

/** 从 agentSpecName 反解资产归属；非 SparkWork 命名返回 null（浏览列表过滤他人条目） */
export function parseAgentSpecName(
  name: string,
): { assetType: AgentSpecAssetType; slug: string } | null {
  if (!name.startsWith(AGENT_SPEC_PREFIX)) return null
  const rest = name.slice(AGENT_SPEC_PREFIX.length)
  for (const assetType of ['workflow', 'agent', 'app'] as const) {
    if (rest.startsWith(`${assetType}-`)) {
      const slug = rest.slice(assetType.length + 1)
      return slug ? { assetType, slug } : null
    }
  }
  return null
}

const TYPE_LABEL: Record<AgentSpecAssetType, string> = {
  workflow: '工作流',
  agent: '平台Agent',
  app: '应用',
}

/** 控制台列表/详情页 description 列长度保护 */
const MAX_DESCRIPTION = 200

/**
 * 构建 AGENTS.md（控制台预览区按 markdown 渲染的唯一入口，真机实测：
 * 只渲染名为 AGENTS.md 的资源文件，manifest.json 不进预览）。
 * 携带完整未截断介绍 + 元数据表 + 包内文件说明，保证「介绍能看全」。
 */
export function buildAgentSpecReadme(
  envelope: TeamAssetEnvelope,
  agentSpecName: string,
  fullDescription: string,
): string {
  const updated = envelope.updatedAt ? envelope.updatedAt.slice(0, 19).replace('T', ' ') : '—'
  const checksumShort = envelope.checksum.slice(0, 16)
  return [
    '# ' + envelope.name,
    '',
    '> SparkWork ' + TYPE_LABEL[assetTypeLabel(envelope.assetType)] + ' · 团队共享资产',
    '',
    fullDescription || '（暂无介绍）',
    '',
    '## 基本信息',
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    '| 资产类型 | ' + TYPE_LABEL[assetTypeLabel(envelope.assetType)] + ' |',
    '| 团队版本 | ' + envelope.version + ' |',
    '| 发布者 | ' + (envelope.author || '—') + ' |',
    '| 更新时间 | ' + updated + ' |',
    '| 内容校验 | ' + checksumShort + ' |',
    '| 安装名称 | ' + agentSpecName + ' |',
    '',
    '## 包内文件',
    '',
    '- `manifest.json` — 身份与元数据（含 x-spark 扩展字段）',
    '- `payload.json` — 完整载荷数据',
    '',
    '## 安装方式',
    '',
    '在 SparkWork 客户端对应管理页（工作流 / Agent / 子应用）的「团队」区块一键安装；',
    '安装后为草稿/停用态，确认可用后手动启用。版本更新同样在团队区块内比对与一键升级。',
    '',
  ].join('\n')
}

function assetTypeLabel(t: string): 'workflow' | 'agent' | 'app' {
  if (t === 'workflow' || t === 'agent' || t === 'app') return t
  throw new Error('AgentSpec 承载不支持该资产类型：' + t)
}

/**
 * 构建上传包：manifest.json（含 x-spark 信封元数据）+ payload.json。
 * STORE zip 确定性输出；zip 体积上限沿用信封限制（发布前拦截）。
 */
export function buildAgentSpecPackage(envelope: TeamAssetEnvelope): {
  zip: Buffer
  agentSpecName: string
} {
  const { assetType } = envelope
  if (assetType !== 'workflow' && assetType !== 'agent' && assetType !== 'app') {
    throw new Error(`AgentSpec 承载不支持该资产类型：${assetType}`)
  }
  const agentSpecName = agentSpecNameFor(assetType, envelope.slug)
  const fullDesc =
    `${envelope.name} · SparkWork ${TYPE_LABEL[assetType]}` +
    (envelope.description ? ` — ${envelope.description}` : '')
  const description = fullDesc.length > MAX_DESCRIPTION ? `${fullDesc.slice(0, 197)}...` : fullDesc
  // 注意：服务端以 worker.suggested_name 为条目身份、版本号自分配——
  // manifest.version 只是展示值，实际版本以发布后回读的 editingVersion 为准。
  const manifest = {
    name: agentSpecName,
    version: envelope.version,
    description,
    // ⚠️ 服务端以 worker.suggested_name 作为条目身份（真机实测：与 manifest.name
    // 不一致时条目建到 suggested_name 名下，导致按 manifest.name 回读 404）。
    // 因此这里必须与 manifest.name 同值；展示名放 description 与 x-spark.name。
    worker: { suggested_name: agentSpecName },
    [AGENT_SPEC_X_FIELD]: {
      schema: AGENT_SPEC_X_SCHEMA,
      teamSchema: TEAM_ASSET_SCHEMA,
      assetType: envelope.assetType,
      slug: envelope.slug,
      name: envelope.name,
      author: envelope.author,
      checksum: envelope.checksum,
      updatedAt: envelope.updatedAt,
      ...(envelope.description ? { description: envelope.description } : {}),
    },
  }
  const zip = buildZip([
    { path: 'AGENTS.md', content: Buffer.from(buildAgentSpecReadme(envelope, agentSpecName, fullDesc), 'utf-8') },
    { path: 'manifest.json', content: Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8') },
    { path: 'payload.json', content: Buffer.from(JSON.stringify(envelope.payload), 'utf-8') },
  ])
  return { zip, agentSpecName }
}

/**
 * AgentSpec 版本详情 → 信封。以下情形返回 null（调用方按「非本团队资产/损坏」跳过）：
 *   - manifest 不是合法 JSON / 缺 x-spark / teamSchema 不符（他人条目）；
 *   - 资源里没有 payload.json / payload 不是 JSON 对象；
 *   - checksum 校验不过（传输损坏或被手改）。
 */
export function envelopeFromAgentSpecVersion(
  detail: TeamAgentSpecVersionDetail,
  expectedType?: AgentSpecAssetType,
): TeamAssetEnvelope | null {
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(detail.manifestRaw) as Record<string, unknown>
  } catch {
    return null
  }
  if (manifest == null || typeof manifest !== 'object') return null
  const x = manifest[AGENT_SPEC_X_FIELD]
  if (x == null || typeof x !== 'object') return null
  const meta = x as Record<string, unknown>
  if (meta.teamSchema !== TEAM_ASSET_SCHEMA) return null
  const assetType = meta.assetType
  if (typeof assetType !== 'string') return null
  if (expectedType != null && assetType !== expectedType) return null
  const payloadEntry = detail.resources.find((r) => r.path === 'payload.json')
  if (!payloadEntry) return null
  let payload: unknown
  try {
    payload = JSON.parse(payloadEntry.content)
  } catch {
    return null
  }
  if (payload == null || typeof payload !== 'object') return null
  const slug = meta.slug
  const checksum = meta.checksum
  if (typeof slug !== 'string' || !slug || typeof checksum !== 'string' || !checksum) return null
  const envelope: TeamAssetEnvelope = {
    schema: TEAM_ASSET_SCHEMA,
    assetType: assetType as TeamAssetType,
    slug,
    name: typeof meta.name === 'string' && meta.name ? meta.name : slug,
    // 服务端自分配版本（0.0.N 递增）是权威；manifest.version 仅展示用
    version: detail.version || (typeof manifest.version === 'string' ? manifest.version : ''),
    author: typeof meta.author === 'string' ? meta.author : '',
    description: typeof meta.description === 'string' ? meta.description : '',
    updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : '',
    checksum,
    payload: payload as TeamAssetEnvelope['payload'],
  }
  if (!verifyEnvelopeChecksum(envelope)) return null
  return envelope
}
