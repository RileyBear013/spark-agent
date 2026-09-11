/**
 * @module team-registry/asset-service
 *
 * TeamAssetService — 工作流 / 平台 Agent / 子应用的团队推拉（M3/M4）
 *
 * 这三类资产没有 Nacos 原生 AI 资源类型，走配置中心统一信封
 * （dataId = `<assetType>/<slug>`，group = SPARK_TEAM）。本模块只做
 * 「信封编排 + 版本比对 + pins 锚点」，本地落地经由 TeamAssetPort
 * 由 desktop 主进程适配真实仓库（WorkflowRepository / AgentRepository /
 * SubAppRepository），保持 agent-runtime 不反向依赖主进程副作用
 * （RuntimeCompositionService / pushConfigChanged 在 handler 层补触发）。
 */

import crypto from 'node:crypto'

import type { TeamAssetPinsRepository } from '@spark/storage'

import { TeamRegistryService } from './index.js'
import { TeamRegistryConfigStore } from './team-registry-config.js'
import {
  bumpPatchVersion,
  classifyTeamAssetState,
  compareSemver,
  computePayloadChecksum,
  type TeamAssetEnvelope,
  type TeamAssetState,
  type TeamAssetType,
  type TeamAssetPayload,
} from './types.js'

/** 信封型资产类型（skill/mcp 走原生 API，不经此服务） */
export type EnvelopeAssetType = Extract<TeamAssetType, 'workflow' | 'agent' | 'app'>

/** 本地实体 → 信封载荷的构建结果 */
export interface TeamAssetBuildResult {
  name: string
  description: string
  payload: TeamAssetPayload
  /** 发布确认弹窗展示的提示（如「技能/规则引用是机器本地 id，对方需自行映射」） */
  warnings?: string[]
}

/**
 * 信封型资产的本地侧端口。desktop 主进程为每类资产提供实现：
 *   - workflow：WorkflowRepository（graph + 元数据）
 *   - agent：AgentRepository（AgentExportPayload 形状，与文件导入互认）
 *   - app：SubAppRepository（V1 单文件草稿快照）
 */
export interface TeamAssetPort {
  /** 本地实体 → 信封载荷；null = 实体不存在或不可发布（如 V2 多文件应用） */
  buildPayload(localId: string): TeamAssetBuildResult | null
  /** 团队 slug → 本地对应实体 id；无则 null（按名称推导 slug 反查，本地改名后视为未安装） */
  findInstalledLocalId(slug: string): string | null
  /** 落地安装/更新；existingLocalId 为 null = 新建 */
  installFromPayload(
    envelope: TeamAssetEnvelope,
    existingLocalId: string | null,
  ): { localId: string; updatedExisting: boolean }
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

export class TeamAssetService {
  private readonly registry: TeamRegistryService

  constructor(
    private readonly configStore: TeamRegistryConfigStore,
    private readonly ports: Record<EnvelopeAssetType, TeamAssetPort>,
    private readonly pinsRepo: TeamAssetPinsRepository,
  ) {
    this.registry = new TeamRegistryService(configStore)
  }

  /** 浏览团队某类信封资产（团队商店列表；未配置时返回空） */
  async listTeamAssets(assetType: EnvelopeAssetType): Promise<TeamAssetListItem[]> {
    const client = await this.configStore.buildClient()
    if (!client) return []
    const envelopes = await this.registry.listEnvelopes(assetType)
    return envelopes.map((envelope) => ({
      slug: envelope.slug,
      name: envelope.name,
      description: envelope.description,
      version: envelope.version,
      author: envelope.author,
      updatedAt: envelope.updatedAt,
    }))
  }

  /**
   * 发布本地资产到团队注册中心。
   * 链路：buildPayload → slug → 远端现状（默认 patch+1、防回退）→ 信封 → pins。
   */
  async publishToTeam(
    assetType: EnvelopeAssetType,
    localId: string,
    opts: { version?: string } = {},
  ): Promise<TeamAssetPublishResult> {
    const port = this.ports[assetType]
    const built = port.buildPayload(localId)
    if (!built) {
      throw new Error(`本地资产不存在或不可发布：${assetType}/${localId}`)
    }
    const slug = slugifyAssetName(built.name, SLUG_PREFIX[assetType])
    const author = (await this.configStore.getSnapshot()).username

    const remote = await this.registry.getEnvelope(assetType, slug)
    const remoteVersion = remote?.version ?? null
    const explicitVersion = opts.version?.trim()
    const version = explicitVersion || bumpPatchVersion(remoteVersion)
    if (remoteVersion && explicitVersion && compareSemver(explicitVersion, remoteVersion) <= 0) {
      throw new Error(
        `指定版本 ${explicitVersion} 不高于远端当前版本 ${remoteVersion}；如需覆盖请升版本号`,
      )
    }

    const envelope: TeamAssetEnvelope = {
      schema: 'spark.team.asset.v1',
      assetType,
      slug,
      name: built.name,
      version,
      author,
      description: built.description,
      updatedAt: new Date().toISOString(),
      checksum: computePayloadChecksum(built.payload),
      payload: built.payload,
    }
    await this.registry.publishEnvelope(envelope)

    this.pinsRepo.upsert(assetType, slug, {
      publishedVersion: version,
      publishedChecksum: envelope.checksum,
      publishedAt: envelope.updatedAt,
    })
    return {
      slug,
      name: built.name,
      version,
      previousRemoteVersion: remoteVersion,
      warnings: built.warnings ?? [],
    }
  }

  /**
   * 从团队注册中心安装/更新资产（落地经端口；副作用由 handler 层补触发）。
   */
  async installFromTeam(assetType: EnvelopeAssetType, slug: string): Promise<TeamAssetInstallResult> {
    if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
      throw new Error(`非法的资产 slug：${slug}`)
    }
    const port = this.ports[assetType]
    const envelope = await this.registry.getEnvelope(assetType, slug)
    if (!envelope) {
      throw new Error(`团队注册中心中不存在该资产：${assetType}/${slug}`)
    }
    port.validatePayload?.(envelope)

    const existingLocalId = port.findInstalledLocalId(slug)
    const installed = port.installFromPayload(envelope, existingLocalId)

    this.pinsRepo.upsert(assetType, slug, {
      installedVersion: envelope.version,
      installedChecksum: envelope.checksum,
      installedAt: new Date().toISOString(),
    })
    return {
      slug,
      name: envelope.name,
      version: envelope.version,
      localId: installed.localId,
      updatedExisting: installed.updatedExisting,
    }
  }

  /**
   * pins 锚点 vs 远端信封的更新比对（六态判定复用 classifyTeamAssetState）。
   * 本地 checksum 由端口按与发布一致的 canonical 规则重算，本地改过即 local-modified。
   */
  async listTeamUpdates(assetType: EnvelopeAssetType): Promise<TeamAssetUpdateInfo[]> {
    const client = await this.configStore.buildClient()
    if (!client) return []
    const port = this.ports[assetType]
    const envelopes = await this.registry.listEnvelopes(assetType)
    const remoteBySlug = new Map(envelopes.map((envelope) => [envelope.slug, envelope]))

    const pins = this.pinsRepo.listByType(assetType)
    const results: TeamAssetUpdateInfo[] = []
    for (const pin of pins) {
      const slug = pin.slug
      const remote = remoteBySlug.get(slug)
      const localId = port.findInstalledLocalId(slug)
      if (!remote) {
        if (localId != null) {
          results.push({
            slug,
            name: this.portName(port, localId) ?? slug,
            localId,
            localVersion: pin.installed_version,
            remoteVersion: '',
            state: 'remote-missing',
          })
        }
        continue
      }
      if (localId == null) continue // 装过又删了/改了名 → 不算更新项
      const localChecksum = port.buildPayload(localId)?.payload
      const state = classifyTeamAssetState({
        localChecksum: localChecksum ? computePayloadChecksum(localChecksum) : null,
        installedChecksum: pin.installed_checksum,
        installedVersion: pin.installed_version,
        remoteVersion: remote.version,
        remoteChecksum: remote.checksum,
      })
      results.push({
        slug,
        name: remote.name,
        localId,
        localVersion: pin.installed_version,
        remoteVersion: remote.version,
        state,
      })
    }
    return results
  }

  private portName(port: TeamAssetPort, localId: string): string | null {
    return port.buildPayload(localId)?.name ?? null
  }
}
