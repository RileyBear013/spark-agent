/**
 * @module team-registry/service
 *
 * TeamRegistryService — 团队 Nacos 注册中心运输层（信封 + 连接）
 * TeamMcpService — MCP 推拉服务（发布/安装/更新比对，M2）
 *
 * 职责边界：
 *   - TeamRegistryService：配置 CRUD / 连接测试 / 配置中心信封读写
 *     （dataId = `<assetType>/<slug>`，group = SPARK_TEAM；M3/M4 工作流与
 *     子应用用）。技能自 M1.5 起走 Nacos 原生 zip API，不再用信封。
 *   - TeamMcpService：本地 mcp_servers ↔ Nacos AI MCP 双向映射与生命周期编排
 *     （draft→回读校验→submit→publish→online），含孤儿行防御。
 * 技能的落盘安装/DB 记录/pins 锚点归 SkillRegistryService；MCP 的启动/连接
 * 归 McpService，本模块只写 mcp_servers 表行。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { McpServerRepository } from '@spark/storage'
import { TeamAssetPinsRepository } from '@spark/storage'
import { NacosClient } from './nacos-client.js'
import { TeamRegistryConfigStore } from './team-registry-config.js'
import { buildMcpDraftFields, sensitiveConfigKeys, specToLocalConfigJson } from './mcp-mapping.js'
import {
  TEAM_ASSET_LIMITS,
  bumpPatchVersion,
  compareSemver,
  classifyTeamAssetState,
  computeSkillFilesChecksum,
  parseTeamAssetEnvelope,
  type TeamAssetEnvelope,
  type TeamSkillFile,
} from './types.js'

export { NacosClient, TEAM_NACOS_GROUP } from './nacos-client.js'
export type {
  NacosConfigContent,
  NacosConfigSummary,
  SkillUploadPrecheck,
  TeamMcpDetail,
  TeamMcpVersionInfo,
  TeamSkillDetail,
  TeamSkillVersionInfo,
} from './nacos-client.js'
export { TeamRegistryConfigStore } from './team-registry-config.js'
export type { TeamRegistryConfigInput, TeamRegistryConfigSnapshot } from './team-registry-config.js'
export {
  NACOS_MCP_PROTOCOL,
  buildMcpDraftFields,
  sensitiveConfigKeys,
  specToLocalConfigJson,
} from './mcp-mapping.js'
export type {
  McpPublishDraftFields,
  NacosEndpointDirect,
  NacosServerSpecification,
} from './mcp-mapping.js'
export { buildZip, readZip, stripZipCommonRoot } from './zip.js'
export type { ZipEntryInput, ZipEntryOutput } from './zip.js'
export * from './types.js'

export interface CollectSkillFilesResult {
  files: TeamSkillFile[]
  /** 因二进制/超限/忽略规则被跳过的文件（相对路径） */
  skipped: Array<{ path: string; reason: 'binary' | 'too-large' | 'ignored' }>
}

/** 收集技能目录文件树（utf-8 文本；递归；带忽略规则与上限） */
export function collectSkillFiles(rootPath: string): CollectSkillFilesResult {
  const files: TeamSkillFile[] = []
  const skipped: CollectSkillFilesResult['skipped'] = []
  walk(rootPath, rootPath, files, skipped)
  return { files, skipped }
}

const IGNORED_ENTRIES = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', 'Thumbs.db'])

function statSizeOf(full: string): number | null {
  try {
    return statSync(full).size
  } catch {
    return null
  }
}
const IGNORED_SUFFIXES = ['.tmp', '.log', '.lock']

function walk(
  rootPath: string,
  currentDir: string,
  files: TeamSkillFile[],
  skipped: CollectSkillFilesResult['skipped'],
): void {
  let entries
  try {
    entries = readdirSync(currentDir, { withFileTypes: true })
  } catch {
    return
  }
  if (files.length >= TEAM_ASSET_LIMITS.maxFileCount) return
  for (const entry of entries) {
    if (files.length >= TEAM_ASSET_LIMITS.maxFileCount) {
      skipped.push({ path: relative(rootPath, join(currentDir, entry.name)), reason: 'ignored' })
      continue
    }
    if (IGNORED_ENTRIES.has(entry.name) || IGNORED_SUFFIXES.some((s) => entry.name.endsWith(s))) {
      skipped.push({ path: relative(rootPath, join(currentDir, entry.name)), reason: 'ignored' })
      continue
    }
    const full = join(currentDir, entry.name)
    if (entry.isDirectory()) {
      walk(rootPath, full, files, skipped)
      continue
    }
    if (!entry.isFile()) continue
    const size = statSizeOf(full)
    if (size == null) continue
    const rel = relative(rootPath, full).split(sep).join('/')
    if (size > TEAM_ASSET_LIMITS.maxFileBytes) {
      skipped.push({ path: rel, reason: 'too-large' })
      continue
    }
    const buf = readFileSync(full)
    const text = buf.toString('utf-8')
    // 二进制启发式：utf-8 解码出现替换符或原文含 NUL → 视为二进制跳过
    if (text.includes('�') || text.includes('\0')) {
      skipped.push({ path: rel, reason: 'binary' })
      continue
    }
    files.push({ path: rel, content: text })
  }
}

export class TeamRegistryService {
  constructor(private readonly configStore: TeamRegistryConfigStore) {}

  /** 当前配置快照（UI 用） */
  async getSnapshot() {
    return this.configStore.getSnapshot()
  }

  /** 构造已认证客户端；未配置完整返回 null */
  async client(): Promise<NacosClient | null> {
    return this.configStore.buildClient()
  }

  private async requireClient(): Promise<NacosClient> {
    const client = await this.configStore.buildClient()
    if (!client) {
      throw new Error('团队注册中心尚未配置（设置 → 团队注册中心），团队功能不可用')
    }
    return client
  }

  /** dataId 规则：`<assetType>/<slug>` */
  static dataIdFor(assetType: string, slug: string): string {
    return `${assetType}/${slug}`
  }

  /** 列出远端某类资产的全部信封（解析失败/校验不过的条目跳过） */
  async listEnvelopes(assetType: 'skill' | 'mcp' | 'workflow' | 'app'): Promise<TeamAssetEnvelope[]> {
    const client = await this.requireClient()
    const summaries = await client.listConfigs({ dataIdPrefix: `${assetType}/` })
    const envelopes: TeamAssetEnvelope[] = []
    for (const summary of summaries) {
      const config = await client.getConfig(summary.dataId)
      if (!config) continue
      const envelope = parseTeamAssetEnvelope(config.content)
      if (envelope && envelope.assetType === assetType) envelopes.push(envelope)
    }
    return envelopes
  }

  /** 读取单个信封；不存在或损坏返回 null */
  async getEnvelope(
    assetType: 'skill' | 'mcp' | 'workflow' | 'app',
    slug: string,
  ): Promise<TeamAssetEnvelope | null> {
    if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
      throw new Error(`非法的资产 slug：${slug}`)
    }
    const client = await this.requireClient()
    const config = await client.getConfig(TeamRegistryService.dataIdFor(assetType, slug))
    if (!config) return null
    const envelope = parseTeamAssetEnvelope(config.content)
    if (!envelope) {
      throw new Error(`远端信封损坏（JSON 结构或 checksum 校验不过）：${assetType}/${slug}`)
    }
    return envelope
  }

  /** 发布信封到配置中心（工作流 / 子应用用；技能自 M1.5 起不走信封） */
  async publishEnvelope(envelope: TeamAssetEnvelope): Promise<{ dataId: string }> {
    const serialized = JSON.stringify(envelope)
    if (serialized.length > TEAM_ASSET_LIMITS.maxEnvelopeBytes) {
      throw new Error(
        `信封序列化后 ${serialized.length} 字节，超过上限 ${TEAM_ASSET_LIMITS.maxEnvelopeBytes}；请精简载荷`,
      )
    }
    const client = await this.requireClient()
    const dataId = TeamRegistryService.dataIdFor(envelope.assetType, envelope.slug)
    await client.publishConfig({ dataId, content: serialized, type: 'JSON' })
    return { dataId }
  }

  /** 删除远端信封（撤回发布；调用方必须先取得用户确认） */
  async deleteEnvelope(
    assetType: 'skill' | 'mcp' | 'workflow' | 'app',
    slug: string,
  ): Promise<boolean> {
    const client = await this.requireClient()
    return client.deleteConfig(TeamRegistryService.dataIdFor(assetType, slug))
  }

  /** 本地技能文件树 checksum（供 SkillRegistryService 做 local-modified 判定） */
  static checksumForFiles(files: TeamSkillFile[]): string {
    return computeSkillFilesChecksum(files)
  }
}

// ─── TeamMcpService（M2：MCP 推拉） ─────────────────────────────────────

/** 团队 MCP 商店条目（浏览列表用，宽容映射） */
export interface TeamMcpListItem {
  slug: string
  name: string
  description: string
  version: string
  protocol: string
}

export interface TeamMcpPublishResult {
  /** 发布用 slug（= 本地 server name 归一化） */
  slug: string
  version: string
  /** spec 里携带的敏感命名变量键（env/headers；只报键名不报值） */
  sensitiveKeys: string[]
  previousRemoteVersion: string | null
}

export interface TeamMcpInstallResult {
  slug: string
  version: string
  /** 本地 server 行 id（新建或更新） */
  localServerId: string
  /** true = 更新了已存在的同名本地行 */
  updatedExisting: boolean
  /** 提示：安装后需要重连/重启才生效 */
  requiresRestart: boolean
}

export interface TeamMcpUpdateInfo {
  slug: string
  localServerId: string | null
  name: string
  localVersion: string | null
  remoteVersion: string
  state: 'not-installed' | 'up-to-date' | 'remote-newer' | 'local-newer' | 'version-equal-content-differs' | 'remote-missing'
}

/** 本地 server name → 团队 slug 归一化（Nacos mcpName 约束保守处理） */
export function mcpSlugOf(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  if (!slug || slug === '.' || slug === '..') throw new Error(`无法从 MCP 名称推导 slug：${name}`)
  return slug
}

export class TeamMcpService {
  constructor(
    private readonly configStore: TeamRegistryConfigStore,
    private readonly mcpRepo: McpServerRepository,
    private readonly pinsRepo: TeamAssetPinsRepository,
  ) {}

  /** 浏览团队 MCP 列表（团队商店数据源；未配置时返回空） */
  async listTeamServers(): Promise<TeamMcpListItem[]> {
    const client = await this.configStore.buildClient()
    if (!client) return []
    const items = await client.listTeamMcpServers()
    return items
      .map((item) => {
        // 真机字段：列表条目用 name（非 mcpName）；已发布最高版本在
        // latestPublishedVersion（草稿态为 null），version 是当前编辑版本
        const slug = pickStr(item, ['name', 'mcpName', 'serverName'])
        if (!slug) return null
        return {
          slug,
          name: pickStr(item, ['displayName', 'name']) ?? slug,
          description: pickStr(item, ['description']) ?? '',
          version:
            pickStr(item, ['latestPublishedVersion']) ??
            pickStr(item, ['version', 'latestVersion']) ??
            '',
          protocol: pickStr(item, ['protocol', 'frontProtocol']) ?? '',
        }
      })
      .filter((x): x is TeamMcpListItem => x != null)
  }

  /**
   * 发布本地 MCP 到团队注册中心。
   * 链路：draft → 回读校验（孤儿行防御）→ submit → publish → online → pins。
   * @param mcpServerId 本地 mcp_servers 行 id
   */
  async publishToTeam(
    mcpServerId: string,
    opts: { version?: string } = {},
  ): Promise<TeamMcpPublishResult> {
    const row = this.mcpRepo.get(mcpServerId)
    if (!row) throw new Error(`本地 MCP 不存在：${mcpServerId}`)
    const slug = mcpSlugOf(row.name)
    const client = await this.requireClient()
    const snapshot = await this.configStore.getSnapshot()

    const config = parseJsonObject(row.config_json, `MCP ${row.name} config_json`)
    const sensitiveKeys = sensitiveConfigKeys(config)

    // 远端现状（已发布最高版本，用于默认 patch+1 与回退防护）
    const remote = await client.getTeamMcpServer(slug)
    const remoteLatest = remote ? latestPublishedVersion(remote.versions.map((v) => v.version)) : null
    const explicitVersion = opts.version?.trim()
    const version = explicitVersion || bumpPatchVersion(remoteLatest)
    if (remoteLatest && explicitVersion && compareSemver(explicitVersion, remoteLatest) <= 0) {
      throw new Error(
        `指定版本 ${explicitVersion} 不高于远端当前版本 ${remoteLatest}；如需覆盖请升版本号`,
      )
    }

    const description = typeof config.description === 'string' ? config.description : undefined
    const fields = buildMcpDraftFields({
      mcpName: slug,
      version,
      namespaceId: this.configStore.readNamespace(),
      configJson: row.config_json,
      ...(description != null ? { description } : {}),
    })

    // 创建草稿 + 孤儿行防御：创建后立即回读，失败即清理（真机复现过孤儿行卡死列表）
    await client.createTeamMcpDraft(fields)
    const verify = await client.getTeamMcpServer(slug)
    if (!verify || !verify.versions.some((v) => v.version === version)) {
      await this.cleanupDraftQuietly(client, slug)
      throw new Error(
        `MCP 草稿创建后回读校验失败（服务端可能拒绝了 serverSpecification）：
        已清理草稿避免遗留孤儿行。slug=${slug} version=${version}`,
      )
    }

    await client.submitTeamMcpVersion(slug, version)
    await client.publishTeamMcpVersion(slug, version)
    await this.onlineTolerantly(client, slug, version)

    this.pinsRepo.upsert('mcp', slug, {
      publishedVersion: version,
      publishedChecksum: null,
      publishedAt: new Date().toISOString(),
    })
    return {
      slug,
      version,
      sensitiveKeys,
      previousRemoteVersion: remoteLatest,
    }
  }

  /**
   * 从团队注册中心安装/更新 MCP（写 mcp_servers 行；启动/重连归 McpService）。
   * @param slug 团队 MCP 名
   */
  async installFromTeam(slug: string): Promise<TeamMcpInstallResult> {
    if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
      throw new Error(`非法的 MCP slug：${slug}`)
    }
    const client = await this.requireClient()
    const detail = await client.getTeamMcpServer(slug)
    if (!detail) throw new Error(`团队注册中心中不存在该 MCP：${slug}`)
    const version = latestPublishedVersion(detail.versions.map((v) => v.version))
    if (!version) throw new Error(`MCP ${slug} 没有已发布版本`)

    const spec = detail.serverSpecification
    if (!spec) throw new Error(`MCP ${slug} 详情缺少 serverSpecification，无法安装`)
    // endpointSpecification 可能与 serverSpecification 平级，合并后交给映射器
    const mergedSpec = {
      ...spec,
      ...(detail.raw.endpointSpecification != null
        ? { endpointSpecification: detail.raw.endpointSpecification }
        : {}),
    }
    const configJson = specToLocalConfigJson(mergedSpec)
    if (!configJson) {
      throw new Error(`MCP ${slug} 的 serverSpecification 结构无法映射为本地配置（可能是 REF 型远程服务）`)
    }

    // 同名行更新，否则 user 作用域新建
    const existing = this.mcpRepo.listAll().find((r) => r.name === slug && r.scope === 'user')
    let row
    let updatedExisting: boolean
    if (existing) {
      row = this.mcpRepo.update(existing.id, { configJson })
      updatedExisting = true
    } else {
      row = this.mcpRepo.create({ scope: 'user', name: slug, configJson, enabled: true })
      updatedExisting = false
    }

    this.pinsRepo.upsert('mcp', slug, {
      installedVersion: version,
      installedChecksum: null,
      installedAt: new Date().toISOString(),
    })
    return {
      slug,
      version,
      localServerId: row!.id,
      updatedExisting,
      requiresRestart: true,
    }
  }

  /**
   * 已安装团队 MCP（pins 锚点）vs 远端版本的比对。
   * 注意：MCP 本地配置允许用户改写（env 覆盖等），不做内容 checksum 判定，
   * 因此不会出现 local-modified 态；比对纯看版本号。
   */
  async listTeamUpdates(): Promise<TeamMcpUpdateInfo[]> {
    const client = await this.configStore.buildClient()
    if (!client) return []
    const remoteItems = await client.listTeamMcpServers()
    const remoteByName = new Map<string, { version: string; name: string }>()
    for (const item of remoteItems) {
      const slug = pickStr(item, ['name', 'mcpName', 'serverName'])
      if (!slug) continue
      const version = pickStr(item, ['latestPublishedVersion', 'version', 'latestVersion']) ?? ''
      const existing = remoteByName.get(slug)
      if (!existing || (version && compareSemver(version, existing.version) > 0)) {
        remoteByName.set(slug, { version, name: pickStr(item, ['displayName', 'name']) ?? slug })
      }
    }

    const pins = this.pinsRepo.listByType('mcp')
    const results: TeamMcpUpdateInfo[] = []
    for (const pin of pins) {
      const slug = pin.slug
      const remote = remoteByName.get(slug)
      const localRow = this.mcpRepo.listAll().find((r) => r.name === slug && r.scope === 'user')
      if (!remote) {
        if (localRow) {
          results.push({
            slug,
            localServerId: localRow.id,
            name: localRow.name,
            localVersion: pin.installed_version,
            remoteVersion: '',
            state: 'remote-missing',
          })
        }
        continue
      }
      if (!localRow) continue // 装过又删了 → 不算更新项
      const state = classifyTeamAssetState({
        localChecksum: null,
        installedChecksum: null,
        installedVersion: pin.installed_version,
        remoteVersion: remote.version || '0.0.0',
        remoteChecksum: '',
      })
      results.push({
        slug,
        localServerId: localRow.id,
        name: localRow.name,
        localVersion: pin.installed_version,
        remoteVersion: remote.version,
        state: state === 'local-modified' ? 'up-to-date' : state,
      })
    }
    return results
  }

  // ─── 内部 ───────────────────────────────────────────────────────────

  private async requireClient(): Promise<NacosClient> {
    const client = await this.configStore.buildClient()
    if (!client) {
      throw new Error('团队注册中心尚未配置（设置 → 团队注册中心），团队功能不可用')
    }
    return client
  }

  /** online 步骤：已是终态时容忍（服务端拒绝「状态不允许 online」不视为发布失败） */
  private async onlineTolerantly(
    client: NacosClient,
    slug: string,
    version: string,
  ): Promise<void> {
    try {
      await client.onlineTeamMcpVersion(slug, version)
    } catch (err) {
      const detail = await client.getTeamMcpServer(slug)
      const status = detail?.versions.find((v) => v.version === version)?.status ?? ''
      if (/online|published/i.test(status)) {
        console.warn(
          `[team-registry] MCP online 被拒但版本已是终态（${status}），继续：${
            err instanceof Error ? err.message : err
          }`,
        )
        return
      }
      throw err
    }
  }

  private async cleanupDraftQuietly(client: NacosClient, slug: string): Promise<void> {
    try {
      await client.deleteTeamMcpServer(slug)
    } catch (cleanupErr) {
      console.error(
        `[team-registry] 孤儿草稿清理失败（需要到 Nacos 控制台手动删除 ${slug}）：${
          cleanupErr instanceof Error ? cleanupErr.message : cleanupErr
        }`,
      )
    }
  }
}

/**
 * 从团队资产的版本行里挑「最新已发布」版本（skill 与 MCP 共用）。
 * 优先 online/publish 终态中的最高 semver；没有终态时取非 draft 最高；
 * 再退化取最高。返回 null 表示没有可用版本。
 */
export function pickLatestTeamVersion(
  versions: Array<{ version: string; status: string }>,
): string | null {
  const online = versions.filter((v) => /online|publish/i.test(v.status) && /^\d/.test(v.version))
  const nonDraft = versions.filter(
    (v) => !/draft|submit|review/i.test(v.status) && /^\d/.test(v.version),
  )
  const all = versions.filter((v) => /^\d/.test(v.version))
  const pool = online.length > 0 ? online : nonDraft.length > 0 ? nonDraft : all
  if (pool.length === 0) return null
  return pool.reduce((a, b) => (compareSemver(b.version, a.version) > 0 ? b : a)).version
}

/** 把团队版本行数组归一为 {version,status}（宽容） */
export function toVersionInfos(raw: unknown): Array<{ version: string; status: string }> {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((v) => v != null && typeof v === 'object')
    .map((v) => {
      const r = v as Record<string, unknown>
      return {
        version: typeof r.version === 'string' ? r.version : '',
        status: typeof r.status === 'string' ? r.status : '',
      }
    })
    .filter((v) => v.version)
}

/** 版本列表中最高 semver（过滤空值） */
function latestPublishedVersion(versions: string[]): string | null {
  const valid = versions.filter((v) => v && /^\d/.test(v))
  if (valid.length === 0) return null
  return valid.reduce((a, b) => (compareSemver(b, a) > 0 ? b : a))
}

function pickStr(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = record[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fallthrough
  }
  throw new Error(`${label} 不是合法 JSON 对象`)
}
