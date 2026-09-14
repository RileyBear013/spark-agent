/**
 * @module team-registry/asset-service
 *
 * TeamAssetService — 工作流 / 平台 Agent / 子应用的团队推拉（M3/M4 原生承载）
 *
 * 三类资产以 Nacos 原生 AgentSpec 资源承载（最初走配置中心裸配置，因控制台
 * 管理体验对不上 Skill/MCP 于 2026-09-11 切换）：发布 = envelope →
 * manifest.json(含 x-spark 元数据) + payload.json 的 zip → 原生上传 →
 * submit→publish→online→PUBLIC；安装/更新比对 = 版本详情内容回读 → envelope。
 * 信封形状（spark.team.asset.v1）、六态判定与 pins 锚点语义不变，本地落地
 * 经由 TeamAssetPort 由 desktop 主进程适配真实仓库（WorkflowRepository /
 * AgentRepository / SubAppRepository），保持 agent-runtime 不反向依赖主进程
 * 副作用（RuntimeCompositionService / pushConfigChanged 在 handler 层补触发）。
 */

import crypto from 'node:crypto'

import type { TeamAssetPinsRepository } from '@spark/storage'

import { listInstallableTeamVersions, pickLatestTeamVersion } from './index.js'
import {
  AGENT_SPEC_PREFIX,
  agentSpecNameFor,
  buildAgentSpecPackage,
  envelopeFromAgentSpecVersion,
  parseAgentSpecName,
} from './agentspec.js'
import { TeamRegistryConfigStore } from './team-registry-config.js'
import {
  TEAM_ASSET_LIMITS,
  bumpPatchVersion,
  classifyTeamAssetState,
  compareSemver,
  computeNormalizedPayloadChecksum,
  computePayloadChecksum,
  type TeamAssetEnvelope,
  type TeamAssetState,
  type TeamAssetType,
  type TeamAssetPayload,
} from './types.js'
import type { NacosClient } from './nacos-client.js'

/** 信封型资产类型（skill/mcp 走各自原生 API，不经此服务） */
export type EnvelopeAssetType = Extract<TeamAssetType, 'workflow' | 'agent' | 'app'>

/** 本地实体 → 信封载荷的构建结果 */
export interface TeamAssetBuildResult {
  name: string
  description: string
  payload: TeamAssetPayload
  /** 发布确认弹窗展示的提示（如「技能/规则引用是机器本地 id，对方需自行映射」） */
  warnings?: string[]
}

/** 安装端口的扩展副作用：随包捆绑物化产生的新建 Agent 与 warning 列表 */
interface TeamAssetInstallSideEffects {
  /** 本次随包新建（停用态）的捆绑 Agent——handler 层补运行时刷新 */
  createdAgentIds?: string[]
  /** 捆绑物化 warning（缺密钥/停用态/unresolved 等），原样透出展示 */
  warnings?: string[]
  /**
   * 安装完成后的本地载荷 checksum（v2 自包含必需：图引用已改写为本地 id，
   * 与远端信封 checksum 不可比；pins 记录本地基准供六态判定）。
   * 缺省时 pins 回退记远端 envelope checksum（v1 行为，非捆绑资产等价）。
   */
  installedLocalChecksum?: string
}

/**
 * 信封型资产的本地侧端口。desktop 主进程为每类资产提供实现：
 *   - workflow：WorkflowRepository（graph + 元数据）
 *   - agent：AgentRepository（AgentExportPayload 形状，与文件导入互认）
 *   - app：SubAppRepository（V1 单文件草稿快照）
 */
export interface TeamAssetPort {
  /**
   * 本地实体 → 信封载荷；null = 实体不存在或不可发布（如 V2 多文件应用）。
   * v2 起为异步：自包含捆绑需要读技能目录（collectDirectory）。
   */
  buildPayload(localId: string): Promise<TeamAssetBuildResult | null>
  /** 团队 slug → 本地对应实体 id；无则 null（按名称推导 slug 反查，本地改名后视为未安装） */
  findInstalledLocalId(slug: string): string | null
  /** 落地安装/更新；existingLocalId 为 null = 新建；可返回捆绑物化副作用 */
  installFromPayload(
    envelope: TeamAssetEnvelope,
    existingLocalId: string | null,
  ): Promise<{ localId: string; updatedExisting: boolean } & TeamAssetInstallSideEffects>
  /** 安装前结构校验（如工作流图环检测）；抛错即中止安装 */
  validatePayload?(envelope: TeamAssetEnvelope): void
}

export interface TeamAssetListItem {
  slug: string
  name: string
  description: string
  version: string
  author: string
  updatedAt: string
}

export interface TeamAssetUpdateInfo {
  slug: string
  name: string
  localId: string | null
  localVersion: string | null
  remoteVersion: string
  state: TeamAssetState
}

/** 团队资产版本行（安装历史版本 / 回滚选择；仅含已发布可安装版本） */
export interface TeamAssetVersionInfo {
  version: string
  status: string
  author: string | null
}

export interface TeamAssetPublishResult {
  slug: string
  name: string
  version: string
  previousRemoteVersion: string | null
  warnings: string[]
}

export interface TeamAssetInstallResult {
  slug: string
  name: string
  version: string
  localId: string
  updatedExisting: boolean
  /** 随包新建的捆绑 Agent（handler 层补运行时刷新） */
  createdAgentIds?: string[]
  /** 捆绑物化 warning（密钥待补/停用态/unresolved） */
  warnings?: string[]
}

const SLUG_PREFIX: Record<EnvelopeAssetType, string> = {
  workflow: 'wf',
  agent: 'agent',
  app: 'app',
}

/**
 * 资产 slug：名称 ASCII 归一；中文名归不出 ASCII 时回退
 * `<prefix>-<sha256 前 8 位>`（跨机器确定，同名同 slug）。
 */
export function slugifyAssetName(name: string, prefix: string): string {
  const lower = name.trim().toLowerCase()
  // 只看是否含非 ASCII 字符（空格等仍走干净归一，如 daily-report）
  const asciiOnly = !/[^ -~]/.test(lower)
  const remnant = lower
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const usable = remnant && remnant !== '.' && remnant !== '..' ? remnant : ''
  if (asciiOnly && usable) return usable
  // 含非 ASCII（或退化名）：ASCII 残段 + 名称哈希——中文团队命名（如
  // 「数据分析Agent」「报表Agent」）不会塌缩到同一个 slug，且跨机器确定。
  const hash = crypto.createHash('sha256').update(lower, 'utf-8').digest('hex').slice(0, 8)
  return usable ? `${usable}-${hash}` : `${prefix}-${hash}`
}

/** 从远端列表条目按点路径取字符串（labels.latest 等嵌套字段） */
function fieldStr(record: unknown, path: string[]): string | null {
  let current: unknown = record
  for (const segment of path) {
    if (current == null || typeof current !== 'object') return null
    current = (current as Record<string, unknown>)[segment] ?? null
  }
  return typeof current === 'string' && current.length > 0 ? current : null
}

export class TeamAssetService {
  constructor(
    private readonly configStore: TeamRegistryConfigStore,
    private readonly ports: Record<EnvelopeAssetType, TeamAssetPort>,
    private readonly pinsRepo: TeamAssetPinsRepository,
  ) {}

  private async requireClient(): Promise<NacosClient> {
    const client = await this.configStore.buildClient()
    if (!client) {
      throw new Error('团队注册中心尚未配置（设置 → 团队注册中心），团队功能不可用')
    }
    return client
  }

  /** 浏览团队某类资产（团队商店列表；未配置时返回空）。服务端分页 + 按类型前缀 blur 过滤。 */
  async listTeamAssets(
    assetType: EnvelopeAssetType,
    opts: { page?: number; pageSize?: number; query?: string } = {},
  ): Promise<{ items: TeamAssetListItem[]; total: number }> {
    const client = await this.configStore.buildClient()
    if (!client) return { items: [], total: 0 }
    // search 用类型前缀 blur（`spark-<type>-`），用户搜索词拼在前缀后；服务端
    // 不支持 search 时会忽略该参数，此时本地 parseAgentSpecName 过滤兜底，
    // 仅分页计数退化为全局（分页语义不受影响）。
    const q = opts.query?.trim() ?? ''
    const page = await client.listTeamAgentSpecs({
      ...(opts.page !== undefined ? { page: opts.page } : {}),
      ...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
      search: `${AGENT_SPEC_PREFIX}${assetType}-${q}`,
    })
    // 列表只有 agentSpecName/labels.latest；取 x-spark 元数据需逐条版本详情
    const ours: Array<{ agentSpecName: string; slug: string; latest: string }> = []
    for (const item of page.items) {
      const name = fieldStr(item, ['name'])
      if (!name) continue
      const parsed = parseAgentSpecName(name)
      if (!parsed || parsed.assetType !== assetType) continue // 他人/异类条目跳过
      const latest = fieldStr(item, ['labels', 'latest'])
      if (!latest) continue // 尚无发布版本（同 MCP 列表语义，不展示草稿）
      ours.push({ agentSpecName: name, slug: parsed.slug, latest })
    }
    const results = await Promise.all(
      ours.map(async (entry): Promise<TeamAssetListItem | null> => {
        try {
          const detail = await client.getTeamAgentSpecVersion(entry.agentSpecName, entry.latest)
          const envelope = detail ? envelopeFromAgentSpecVersion(detail, assetType) : null
          if (!envelope) return null
          return {
            slug: envelope.slug,
            name: envelope.name,
            description: envelope.description,
            version: envelope.version,
            author: envelope.author,
            updatedAt: envelope.updatedAt,
          }
        } catch {
          return null // 单条详情失败不拖垮整个列表
        }
      }),
    )
    return { items: results.filter((item): item is TeamAssetListItem => item != null), total: page.total }
  }

  /**
   * 发布本地资产到团队注册中心（原生 AgentSpec 承载）。
   * 链路：buildPayload → slug → zip 上传（自动建条目/新草稿）→ 回读服务端
   * 分配的版本 → submit→publish→online→PUBLIC → pins。
   * 版本语义：AgentSpec 服务端对版本号自分配（0.0.N 单调递增，上传包里的
   * manifest.version 不生效，真机实测），防回退由单调性天然保证；
   * opts.version 仅作记录并回显 warning。
   */
  async publishToTeam(
    assetType: EnvelopeAssetType,
    localId: string,
    opts: { version?: string } = {},
  ): Promise<TeamAssetPublishResult> {
    const port = this.ports[assetType]
    const built = await port.buildPayload(localId)
    if (!built) {
      throw new Error(`本地资产不存在或不可发布：${assetType}/${localId}`)
    }
    const slug = slugifyAssetName(built.name, SLUG_PREFIX[assetType])
    const agentSpecName = agentSpecNameFor(assetType, slug)
    const author = (await this.configStore.getSnapshot()).username
    const client = await this.requireClient()

    // 远端现状：已发布最高版本仅作展示（previousRemoteVersion）
    const remoteDetail = await client.getTeamAgentSpec(agentSpecName)
    const remoteVersion = remoteDetail ? pickLatestTeamVersion(remoteDetail.versions) : null

    const envelope: TeamAssetEnvelope = {
      schema: 'spark.team.asset.v1',
      assetType,
      slug,
      name: built.name,
      // 仅为 manifest 展示值；实际发布版本由服务端分配（见方法注释）
      version: bumpPatchVersion(remoteVersion),
      author,
      description: built.description,
      updatedAt: new Date().toISOString(),
      checksum: computePayloadChecksum(built.payload),
      payload: built.payload,
    }
    const pkg = buildAgentSpecPackage(envelope)
    if (pkg.zip.length > TEAM_ASSET_LIMITS.maxEnvelopeBytes) {
      throw new Error(
        `资产包 ${pkg.zip.length} 字节超过上限 ${TEAM_ASSET_LIMITS.maxEnvelopeBytes}；请精简载荷`,
      )
    }
    await client.uploadTeamAgentSpecZip({
      zip: pkg.zip,
      commitMsg: `SparkWork ${assetType} ${built.name}`,
    })

    // 回读服务端分配的实际版本（新条目固定 0.0.1 起步，逐次 +1）
    const assigned = (await client.getTeamAgentSpec(agentSpecName))?.editingVersion ?? null
    if (!assigned) {
      if (!remoteDetail) {
        // 全新条目上传异常 → 清理半成品，避免控制台孤儿条目
        await client.deleteTeamAgentSpec(agentSpecName).catch(() => {})
      }
      throw new Error(
        `上传后回读校验失败（远端读不到编辑版本）${remoteDetail ? '' : '；已清理新建条目'}。agentSpecName=${agentSpecName}`,
      )
    }
    const versionDetail = await client
      .getTeamAgentSpecVersion(agentSpecName, assigned)
      .catch(() => null)
    if (!versionDetail) {
      throw new Error(
        `上传后版本 ${assigned} 内容回读失败，已中止发布。agentSpecName=${agentSpecName}`,
      )
    }

    await client.submitTeamAgentSpecVersion(agentSpecName, assigned)
    await client.publishTeamAgentSpecVersion(agentSpecName, assigned)
    const warnings: string[] = [...(built.warnings ?? [])]
    if (opts.version?.trim()) {
      warnings.push(
        `指定版本号 ${opts.version.trim()} 不生效：AgentSpec 服务端自动分配版本号（本次为 ${assigned}）`,
      )
    }
    try {
      await client.onlineTeamAgentSpecVersion(agentSpecName, assigned)
    } catch (err) {
      warnings.push(
        `上线（online）步骤被服务端拒绝（版本可能已是终态，不影响发布）：${err instanceof Error ? err.message : String(err)}`,
      )
    }
    try {
      await client.setTeamAgentSpecScope(agentSpecName, 'PUBLIC')
    } catch (err) {
      warnings.push(
        `共享范围未设为 PUBLIC（当前可能仅自己可见，请到控制台 AgentSpec 页手工公开）：${err instanceof Error ? err.message : String(err)}`,
      )
    }

    this.pinsRepo.upsert(assetType, slug, {
      publishedVersion: assigned,
      publishedChecksum: envelope.checksum,
      publishedAt: envelope.updatedAt,
    })
    return {
      slug,
      name: built.name,
      version: assigned,
      previousRemoteVersion: remoteVersion,
      warnings,
    }
  }

  /**
   * 从团队注册中心安装/更新资产（落地经端口；副作用由 handler 层补触发）。
   */
  async installFromTeam(
    assetType: EnvelopeAssetType,
    slug: string,
    opts: { version?: string } = {},
  ): Promise<TeamAssetInstallResult> {
    if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
      throw new Error(`非法的资产 slug：${slug}`)
    }
    const client = await this.requireClient()
    const agentSpecName = agentSpecNameFor(assetType, slug)
    const detail = await client.getTeamAgentSpec(agentSpecName)
    if (!detail) {
      throw new Error(`团队注册中心中不存在该资产：${assetType}/${slug}`)
    }
    // 显式版本（安装历史版本/回滚）必须落在已发布版本集合内；缺省取最新已发布
    let version: string
    if (opts.version?.trim()) {
      const wanted = opts.version.trim()
      const row = detail.versions.find((v) => v.version === wanted)
      if (!row || !/online|publish/i.test(row.status)) {
        throw new Error(
          `资产 ${assetType}/${slug} 不存在可安装的版本 ${wanted}（仅已发布版本可安装/回滚）`,
        )
      }
      version = wanted
    } else {
      const latest = pickLatestTeamVersion(detail.versions)
      if (!latest) {
        throw new Error(`团队资产尚无已发布版本：${assetType}/${slug}`)
      }
      version = latest
    }
    const versionDetail = await client.getTeamAgentSpecVersion(agentSpecName, version)
    const envelope = versionDetail ? envelopeFromAgentSpecVersion(versionDetail, assetType) : null
    if (!envelope) {
      throw new Error(
        `团队资产版本内容不可读或不是 SparkWork 信封：${assetType}/${slug} v${version}`,
      )
    }
    const port = this.ports[assetType]
    port.validatePayload?.(envelope)

    const existingLocalId = port.findInstalledLocalId(slug)
    const installed = await port.installFromPayload(envelope, existingLocalId)

    this.pinsRepo.upsert(assetType, slug, {
      installedVersion: envelope.version,
      installedChecksum: installed.installedLocalChecksum ?? envelope.checksum,
      installedAt: new Date().toISOString(),
    })
    return {
      slug,
      name: envelope.name,
      version: envelope.version,
      localId: installed.localId,
      updatedExisting: installed.updatedExisting,
      ...(installed.createdAgentIds?.length ? { createdAgentIds: installed.createdAgentIds } : {}),
      ...(installed.warnings?.length ? { warnings: installed.warnings } : {}),
    }
  }

  /**
   * pins 锚点 vs 远端最新发布版本的更新比对（六态判定复用 classifyTeamAssetState）。
   * 远端 checksum 来自版本详情回读的 envelope；本地 checksum 由端口按与发布
   * 一致的 canonical 规则重算，本地改过即 local-modified。
   */
  async listTeamUpdates(assetType: EnvelopeAssetType): Promise<TeamAssetUpdateInfo[]> {
    const client = await this.configStore.buildClient()
    if (!client) return []
    const port = this.ports[assetType]
    const items = (await client.listTeamAgentSpecs()).items
    const remoteBySlug = new Map<string, { agentSpecName: string; version: string }>()
    for (const item of items) {
      const name = fieldStr(item, ['name'])
      if (!name) continue
      const parsed = parseAgentSpecName(name)
      if (!parsed || parsed.assetType !== assetType) continue
      const latest = fieldStr(item, ['labels', 'latest'])
      if (!latest) continue
      remoteBySlug.set(parsed.slug, { agentSpecName: name, version: latest })
    }

    const pins = this.pinsRepo.listByType(assetType)
    const results = await Promise.all(
      pins.map(async (pin): Promise<TeamAssetUpdateInfo | null> => {
        const slug = pin.slug
        const remote = remoteBySlug.get(slug)
        const localId = port.findInstalledLocalId(slug)
        if (!remote) {
          if (localId != null) {
            return {
              slug,
              name: (await this.portName(port, localId)) ?? slug,
              localId,
              localVersion: pin.installed_version,
              remoteVersion: '',
              state: 'remote-missing',
            }
          }
          return null
        }
        if (localId == null) return null // 装过又删了/改了名 → 不算更新项
        // 远端 checksum：版本详情回读（失败按空串处理，退化到版本号比对）
        let remoteChecksum = ''
        let remoteName = slug
        try {
          const vDetail = await client.getTeamAgentSpecVersion(remote.agentSpecName, remote.version)
          const envelope = vDetail ? envelopeFromAgentSpecVersion(vDetail, assetType) : null
          if (envelope) {
            remoteChecksum = envelope.checksum
            remoteName = envelope.name
          }
        } catch {
          // 详情失败 → checksum 不可比，走版本号判定
        }
        const localPayload = (await port.buildPayload(localId))?.payload
        const state = classifyTeamAssetState({
          // 本地侧归一化（剥离 bundle origin*）；远端侧仍是完整信封 checksum，
          // 二者不相等是预期（rule 1 不触发），一致性判定走 pins 基准（rule 3）
          localChecksum: localPayload ? computeNormalizedPayloadChecksum(localPayload) : null,
          installedChecksum: pin.installed_checksum,
          installedVersion: pin.installed_version,
          remoteVersion: remote.version,
          remoteChecksum,
        })
        return {
          slug,
          name: remoteName,
          localId,
          localVersion: pin.installed_version,
          remoteVersion: remote.version,
          state,
        }
      }),
    )
    return results.filter((item): item is TeamAssetUpdateInfo => item != null)
  }

  /**
   * 团队资产的可安装版本列表（已发布终态，semver 降序）——安装历史版本/回滚用。
   */
  async listTeamAssetVersions(
    assetType: EnvelopeAssetType,
    slug: string,
  ): Promise<TeamAssetVersionInfo[]> {
    if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
      throw new Error(`非法的资产 slug：${slug}`)
    }
    const client = await this.configStore.buildClient()
    if (!client) return []
    const agentSpecName = agentSpecNameFor(assetType, slug)
    const detail = await client.getTeamAgentSpec(agentSpecName)
    if (!detail) return []
    return listInstallableTeamVersions(detail.versions).map((v) => ({
      version: v.version,
      status: v.status,
      author: v.author,
    }))
  }

  private async portName(port: TeamAssetPort, localId: string): Promise<string | null> {
    return (await port.buildPayload(localId))?.name ?? null
  }
}
