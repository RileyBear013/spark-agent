/**
 * @module skill-registry/service
 *
 * Skill Registry Service — Skill 市场源管理 + 搜索/安装/卸载
 */

import crypto from 'node:crypto'
import os from 'node:os'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { fetchJson, fetchText, HttpError } from '@spark/shared'
import type {
  RemoteSkillItem,
  SkillHubShowcaseSection,
  SkillItem,
  SkillRegistry,
} from '@spark/protocol'
import type { SparkDatabase } from '@spark/storage'
import { SkillRegistryRepository, SkillRepository } from '@spark/storage'
import type { SkillRegistryAdapter, SkillRegistryAdapterConfig } from './adapter.js'
import { SkillHubAdapter } from './skillhub-adapter.js'
import { SkillsMPAdapter } from './skillsmp-adapter.js'
import {
  INSTALLABLE_SKILL_CATALOG,
  getInstallableSkillBySlug,
  type InstallableSkillCatalogItem,
} from './installable-catalog.js'
import {
  fetchSparkInstallManifest,
  findSparkInstallArtifact,
  resolveArtifactUrl,
  resolveArtifactUrlString,
} from './artifact-manifest.js'
import {
  installBinaryArchive,
  installFromGithubTarball,
  installFromZip,
  tarballSourceFingerprint,
  type TarballInstallParams,
} from './tarball-installer.js'
import { TeamAssetPinsRepository } from '@spark/storage'
import {
  buildZip,
  bumpPatchVersion,
  classifyTeamAssetState,
  collectSkillFiles,
  compareSemver,
  computeSkillFilesChecksum,
  pickLatestTeamVersion,
  readZip,
  stripZipCommonRoot,
  type NacosClient,
  type TeamAssetState,
  type TeamRegistryService,
  type TeamSkillFile,
} from '../team-registry/index.js'
import { NacosTeamAdapter, TEAM_REGISTRY_ID } from './nacos-team-adapter.js'

// ─── registryId / remoteSkillId 归一化 helper ─────────────────────────
// agent 调 skills_install 时，常把搜索结果的显示名（registryName，如 "SkillHub"）
// 或内置目录字样（"catalog"/"builtin"）当作 registryId 传进来；remoteSkillId 也常
// 带上 "skill:" 或 "<registryId>:" 前缀。这两个 helper 把这些不精确的输入归一化，
// 让 agent 不必完美填表也能命中正确的安装路径。

const REGISTRY_ID_ALIASES: Record<string, string> = {
  // 显示名 / 大小写变体 → 小写 registryId
  skillhub: 'skillhub',
  'skill-hub': 'skillhub',
  'skill hub': 'skillhub',
  skillsmp: 'skillsmp',
  'skills-mp': 'skillsmp',
  'skills mp': 'skillsmp',
  // 内置精选目录的各种叫法 → catalog（走 installFromCatalog，不经 adapter Map）
  catalog: 'catalog',
  builtin: 'catalog',
  'built-in': 'catalog',
  'built in': 'catalog',
  内置目录: 'catalog',
  内置精选: 'catalog',
  精选: 'catalog',
  团队: 'team',
  团队源: 'team',
  'nacos-team': 'team',
}

// 表驱动：新增市场源在此登记（createAdapter 同步分发）。
// team（团队 Nacos 源）的 adapter 仅在配置保存后激活，但 id 始终在集合内——
// 否则 listRegistries/initialize 会把已配置的团队源当未知市场过滤掉。
const SUPPORTED_REMOTE_REGISTRY_IDS = new Set(['skillhub', 'skillsmp', TEAM_REGISTRY_ID])

/** 把 agent 传入的 registryId 归一化：去空白、转小写、映射常见显示名。 */
export function normalizeRegistryId(raw: string): string {
  const key = raw.trim().toLowerCase()
  if (!key) return ''
  return REGISTRY_ID_ALIASES[key] ?? key
}

/**
 * 剥掉 remoteSkillId 的前缀，得到纯 slug。
 * 处理 "skill:catalog:ppt-master"、"skillhub:tapd-api"、"catalog:ppt-master" 等，
 * 最终返回 "ppt-master" / "tapd-api"。
 */
export function stripRemoteIdPrefix(rawId: string, registryId: string): string {
  let id = rawId.trim()
  if (!id) return ''
  // 前缀按小写比较（registryId 已归一化为小写；rawId 前缀大小写不一），slug 原始大小写保留
  if (id.toLowerCase().startsWith('skill:')) id = id.slice('skill:'.length)
  if (registryId && id.toLowerCase().startsWith(`${registryId}:`)) {
    id = id.slice(registryId.length + 1)
  }
  return id
}

export class SkillRegistryService {
  private registryRepo: SkillRegistryRepository
  private skillRepo: SkillRepository
  private adapters = new Map<string, SkillRegistryAdapter>()
  private pinsRepo: TeamAssetPinsRepository

  /**
   * @param db          数据库
   * @param userSkillsDir 用户技能落盘目录（来自 AppSkillsManager.userDir）。
   *   提供时，从市场安装的技能会把 SKILL.md 写到真实磁盘目录，使其能被 agent 运行时
   *   实际加载/原生发现；不提供时回落到虚拟 registry:// 路径（仅元数据，无法加载）。
   * @param binaryDir   通用二进制产物落盘根目录（如 `{userData}/bin`）。
   *   用于 installBinaryArtifact()（ffmpeg 等非技能二进制包）。每个产物会落在
   *   `<binaryDir>/<artifact.name>/` 下；不提供时 installBinaryArtifact 会抛错。
   */
  constructor(
    private readonly db: SparkDatabase,
    private readonly userSkillsDir?: string,
    private readonly binaryDir?: string,
    private readonly teamRegistry?: TeamRegistryService,
  ) {
    this.registryRepo = new SkillRegistryRepository(db)
    this.skillRepo = new SkillRepository(db)
    this.pinsRepo = new TeamAssetPinsRepository(db)
  }

  /**
   * 初始化：确保默认市场源存在，并创建 Adapter 实例
   */
  initialize(): void {
    this.registryRepo.ensureDefaults()
    const registries = this.registryRepo.listEnabled()
    for (const reg of registries) {
      if (!SUPPORTED_REMOTE_REGISTRY_IDS.has(reg.id)) {
        // 旧数据库可能仍有实验市场（例如 mcp-market）。正式版不显示 Mock 数据，
        // 但也不能让一条遗留配置阻断 SkillHub/内置目录初始化。
        continue
      }
      // team 源由 refreshTeamRegistry() 统一装配（未配置时静默不注册，不报错）
      if (reg.id === TEAM_REGISTRY_ID) continue
      if (!this.adapters.has(reg.id)) {
        this.adapters.set(
          reg.id,
          this.createAdapter({
            registryId: reg.id,
            apiBaseUrl: reg.api_base_url,
            configJson: reg.config_json,
          }),
        )
      }
    }
    this.refreshTeamRegistry()
  }

  // ─── Registry CRUD ─────────────────────────────────────────────────

  listRegistries(): SkillRegistry[] {
    return this.registryRepo.list()
      .filter((row) => SUPPORTED_REMOTE_REGISTRY_IDS.has(row.id))
      .map(toSkillRegistry)
  }

  updateRegistry(id: string, fields: { enabled?: boolean; configJson?: string }): SkillRegistry {
    const updateFields: Record<string, unknown> = {}
    if (fields.enabled !== undefined) updateFields.enabled = fields.enabled
    if (fields.configJson !== undefined) updateFields.configJson = fields.configJson

    const row = this.registryRepo.update(id, updateFields)
    if (row == null) throw new Error(`Registry not found: ${id}`)

    // 如果禁用，移除 adapter；如果启用，重新创建
    if (fields.enabled === false) {
      this.adapters.delete(id)
    } else if (fields.enabled === true && !this.adapters.has(id)) {
      this.adapters.set(
        id,
        this.createAdapter({
          registryId: row.id,
          apiBaseUrl: row.api_base_url,
          configJson: row.config_json,
        }),
      )
    }

    return toSkillRegistry(row)
  }

  // ─── Search & Browse ───────────────────────────────────────────────

  /**
   * 跨市场搜索 Skill
   * 如果指定了 registryId，只搜索该市场；否则搜索所有启用的市场
   */
  async search(params: {
    query: string
    registryId?: string
    category?: string
    limit?: number
    offset?: number
  }): Promise<{ skills: RemoteSkillItem[]; total: number }> {
    const installedMap = this.buildInstalledMap()
    const allRows = this.skillRepo.list()

    // 内置精选目录（catalog）始终参与搜索——它不在 adapter Map 里，
    // 否则 agent / UI 都搜不到 ppt-master、playwright 这类一键安装技能。
    const catalogItems = this.searchCatalog(params.query).map((item) =>
      this.catalogItemToRemoteSkill(item, allRows),
    )

    if (params.registryId) {
      // catalog 单独返回，不经 getAdapterOrThrow（否则抛 "Registry not available: catalog"）
      if (params.registryId === 'catalog') {
        return { skills: catalogItems, total: catalogItems.length }
      }
      const adapter = this.getAdapterOrThrow(params.registryId)
      const searchOptions: { category?: string; limit?: number; offset?: number } = {}
      if (params.category !== undefined) searchOptions.category = params.category
      if (params.limit !== undefined) searchOptions.limit = params.limit
      if (params.offset !== undefined) searchOptions.offset = params.offset
      const result = await adapter.search(params.query, searchOptions)
      return {
        skills: result.skills.map((s) => this.enrichWithInstallStatus(s, installedMap)),
        total: result.total,
      }
    }

    // 聚合所有市场（catalog 已在上面单独算好，并入结果集）
    const allAdapters = Array.from(this.adapters.values())
    const results = await Promise.allSettled(
      allAdapters.map((a) => {
        const searchOptions: { category?: string; limit?: number; offset?: number } = {}
        if (params.category !== undefined) searchOptions.category = params.category
        if (params.limit !== undefined) searchOptions.limit = params.limit
        if (params.offset !== undefined) searchOptions.offset = params.offset
        return a
          .search(params.query, searchOptions)
          .catch(() => ({ skills: [] as RemoteSkillItem[], total: 0 }))
      }),
    )

    const allSkills: RemoteSkillItem[] = [...catalogItems]
    let total = catalogItems.length
    for (const r of results) {
      if (r.status === 'fulfilled') {
        allSkills.push(...r.value.skills)
        total += r.value.total
      }
    }

    // 按评分排序（catalog rating 给了 4.8，相关时排在市场结果之前，符合「精选」定位）
    allSkills.sort((a, b) => b.rating - a.rating)

    const offset = params.offset ?? 0
    const limit = params.limit ?? 20
    const paged = allSkills.slice(offset, offset + limit)

    return {
      skills: paged.map((s) => this.enrichWithInstallStatus(s, installedMap)),
      total,
    }
  }

  /**
   * 获取热门/推荐 Skill
   */
  async featured(params: {
    registryId?: string
    limit?: number
    section?: SkillHubShowcaseSection
    category?: string
  }): Promise<RemoteSkillItem[]> {
    const installedMap = this.buildInstalledMap()

    if (params.registryId) {
      const adapter = this.getAdapterOrThrow(params.registryId)
      const skills = await adapter.featured(params.limit, params.section, params.category)
      return skills.map((s) => this.enrichWithInstallStatus(s, installedMap))
    }

    // 聚合所有市场
    const allAdapters = Array.from(this.adapters.values())
    const results = await Promise.allSettled(
      allAdapters.map((a) =>
        a
          .featured(params.limit, params.section, params.category)
          .catch(() => [] as RemoteSkillItem[]),
      ),
    )

    const allSkills: RemoteSkillItem[] = []
    for (const r of results) {
      if (r.status === 'fulfilled') allSkills.push(...r.value)
    }

    allSkills.sort((a, b) => b.downloadCount - a.downloadCount)
    return allSkills
      .slice(0, params.limit ?? 12)
      .map((s) => this.enrichWithInstallStatus(s, installedMap))
  }

  /**
   * 获取市场分类列表
   */
  async categories(registryId: string): Promise<Array<{ key: string; name: string }>> {
    const adapter = this.getAdapterOrThrow(registryId)
    const list = await adapter.categories()
    // 兜底 prepend "全部"：adapter 应保证已 prepend；防御性再 prepend 一次
    if (list.length > 0 && list[0]?.key === 'all') return list
    return [{ key: 'all', name: '全部' }, ...list]
  }

  // ─── Install / Uninstall ────────────────────────────────────────────

  /**
   * 从市场安装 Skill 到本地
   */
  async install(params: { remoteSkillId: string; registryId: string }): Promise<SkillItem> {
    // 团队源走专用安装路径（多文件保真 + checksum 校验 + pins 锚点），
    // 通用路径只落 SKILL.md 单文件，会丢技能附带资源。
    if (params.registryId === TEAM_REGISTRY_ID) {
      return this.installFromTeam(stripRemoteIdPrefix(params.remoteSkillId, TEAM_REGISTRY_ID))
    }
    const adapter = this.getAdapterOrThrow(params.registryId)

    // 搜索找到对应的 remote skill
    const searchResult = await adapter.search('')
    const remoteSkill = searchResult.skills.find((s) => s.id === params.remoteSkillId)
    if (!remoteSkill) {
      throw new Error(`Skill not found in registry: ${params.remoteSkillId}`)
    }

    // 检查是否已安装
    const existing = this.skillRepo
      .list()
      .find((s) => s.registry_id === params.registryId && s.remote_id === params.remoteSkillId)
    if (existing) {
      throw new Error(`Skill already installed: ${existing.name}`)
    }

    // 获取 manifest
    const manifestJson = await adapter.fetchManifest(remoteSkill.manifestUrl)
    const manifest = safeParseJson(manifestJson)

    // 落盘：把技能写成真实目录（SKILL.md + manifest.json），
    // 否则 rootPath 是虚拟 registry:// 路径，agent 运行时无法加载/原生发现。
    const skillBody = extractSkillBody(manifest, remoteSkill)
    const rootPath =
      this.materializeSkill(remoteSkill.name, skillBody, remoteSkill, manifest) ??
      `registry://${params.registryId}/${remoteSkill.id}`

    // 创建本地 Skill 记录
    const id = `skill:${crypto.randomUUID()}`
    const row = this.skillRepo.create({
      id,
      scope: 'user',
      name: remoteSkill.name,
      version: remoteSkill.version,
      rootPath,
      manifestJson: JSON.stringify({
        ...(manifest ?? {}),
        desc: remoteSkill.description,
        description: remoteSkill.description,
        source: remoteSkill.registryName,
        author: remoteSkill.author,
        category: remoteSkill.category,
        tags: remoteSkill.tags,
        // systemPrompt 兜底：即使未落盘，skills_load 也能从 manifest 取到正文
        systemPrompt: skillBody,
        homepage: remoteSkill.homepageUrl,
      }),
      enabled: true,
    })

    // 更新扩展字段
    const extendedFields: {
      registryId?: string | null
      remoteId?: string | null
      author?: string
      category?: string
      tagsJson?: string
      rating?: number
      downloadCount?: number
      homepageUrl?: string | null
      iconUrl?: string | null
    } = {
      registryId: params.registryId,
      remoteId: params.remoteSkillId,
      author: remoteSkill.author,
      category: remoteSkill.category,
      tagsJson: JSON.stringify(remoteSkill.tags),
      rating: remoteSkill.rating,
      downloadCount: remoteSkill.downloadCount,
    }
    if (remoteSkill.homepageUrl !== undefined) extendedFields.homepageUrl = remoteSkill.homepageUrl
    if (remoteSkill.iconUrl !== undefined) extendedFields.iconUrl = remoteSkill.iconUrl
    this.skillRepo.updateExtendedFields(id, extendedFields)

    // 更新 registry 的 last_sync_at
    this.registryRepo.update(params.registryId, { lastSyncAt: new Date().toISOString() })

    return toSkillItem(row)
  }

  /**
   * 卸载本地已安装的 Skill
   *
   * 对于落盘到真实磁盘目录的技能（market / catalog / SkillHub 安装），
   * 一并删除磁盘目录；虚拟路径（builtin:// / registry://）只清 DB。
   */
  uninstall(localSkillId: string): boolean {
    const row = this.skillRepo.list().find((s) => s.id === localSkillId)
    if (row?.root_path && existsSync(row.root_path)) {
      if (!row.root_path.startsWith('builtin://') && !row.root_path.startsWith('registry://')) {
        try {
          rmSync(row.root_path, { recursive: true, force: true })
        } catch {
          // 删除失败不阻断 DB 清理
        }
      }
    }
    if (row?.registry_id === TEAM_REGISTRY_ID && row.remote_id) {
      this.pinsRepo.deleteByAsset('skill', row.remote_id)
    }
    return this.skillRepo.deleteById(localSkillId)
  }

  // ─── SkillHub 远程安装（zip 整包，腾讯云 COS 加速） ───────────────────

  /**
   * 从 SkillHub 安装一项技能（zip 整包：下载 → 系统 tar -xf 解压 → 落盘）。
   * SkillHub 内容存于腾讯云 COS 加速节点，国内下载快，规避 GitHub 直连问题。
   * zip 解压失败时回落到 SKILL.md 单文件安装，保证至少可用。
   *
   * 落盘后写入 registry_id=skillhub / remote_id=slug，使 featured 列表的 installed
   * 状态自动正确（复用 enrichWithInstallStatus）。
   */
  async installFromSkillHub(
    slug: string,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<SkillItem> {
    if (!this.userSkillsDir) {
      throw new Error('User skills directory not configured; cannot install')
    }
    const adapter = this.adapters.get('skillhub')
    if (!(adapter instanceof SkillHubAdapter)) {
      throw new Error('SkillHub registry not available')
    }

    // 1. 取详情（版本 + 元数据），失败不阻断安装
    let version = ''
    let metaName = slug
    let marketplaceName: string | undefined
    let metaDesc = ''
    let metaAuthor = 'SkillHub'
    let metaCategory = 'utility'
    let metaTags: string[] = []
    let metaIconUrl: string | undefined
    try {
      const detail = await adapter.fetchDetail(slug)
      version = detail.latestVersion?.version ?? ''
      const s = detail.skill
      if (s) {
        marketplaceName = s.displayName?.trim() || s.name?.trim() || undefined
        metaName = marketplaceName ?? slug
        metaDesc = s.summary_zh || s.summary || s.description_zh || s.description || ''
        metaAuthor = detail.owner?.displayName || s.ownerName || 'SkillHub'
        metaCategory = s.category ?? 'utility'
        metaTags = Array.isArray(s.subCategories)
          ? s.subCategories.map((c) => c.name).filter(Boolean)
          : []
        metaIconUrl = s.iconUrl
      }
    } catch {
      // 详情失败：用 slug 兜底，继续安装
    }

    // 2. 下载 zip + 解压 + 落盘（主路径）；失败回落 SKILL.md 单文件
    let destPath = ''
    let skillMd: string
    try {
      const result = await installFromZip({
        url: adapter.buildDownloadUrl(slug),
        destDirName: slug,
        userSkillsDir: this.userSkillsDir,
        ...(onProgress ? { onProgress } : {}),
      })
      destPath = result.destPath
      skillMd = result.skillMd
    } catch (zipErr) {
      console.warn(
        `[SkillHub] zip install failed for ${slug} (${
          zipErr instanceof Error ? zipErr.message : zipErr
        }); falling back to SKILL.md-only install`,
      )
      const fallbackManifest = await adapter.fetchManifest(
        adapter.buildSkillMdUrl(slug, version || undefined),
      )
      const parsed = safeParseJson(fallbackManifest)
      const body = extractSkillBody(parsed, {
        name: metaName,
        description: metaDesc,
      } as RemoteSkillItem)
      destPath = join(this.userSkillsDir, slug)
      // 与 zip 主路径行为一致：先清掉旧目录，避免上一次成功安装的残留文件与本次 SKILL.md 共存
      if (existsSync(destPath)) rmSync(destPath, { recursive: true, force: true })
      mkdirSync(destPath, { recursive: true })
      writeFileSync(join(destPath, 'SKILL.md'), body, 'utf-8')
      skillMd = body
    }

    // 3. 解析 frontmatter（zip 路径拿到的 SKILL.md 可能带 frontmatter）
    const hasFm = skillMd.startsWith('---')
    const fm = hasFm ? parseSkillFrontmatter(skillMd) : null
    const canonicalName = fm?.name || ''
    const skillName = marketplaceName || canonicalName || metaName
    const skillVersion = fm?.version || version || '0.0.0'
    const description = fm?.description || metaDesc
    const author = fm?.author || metaAuthor
    const category = fm?.category || metaCategory
    const tags = fm?.tags?.length ? fm.tags : metaTags
    const systemPrompt = hasFm ? stripSkillFrontmatter(skillMd).trim() : skillMd.trim()
    const homepageUrl = `https://www.skillhub.cn/skills/${slug}`

    // 4. dedupe by rootPath；id 用稳定 slug 指纹
    const existing = this.skillRepo.list().find((s) => s.root_path === destPath)
    const id = existing?.id ?? `skill:skillhub:${slug}`
    const manifestJson = JSON.stringify({
      desc: description,
      description,
      displayName: skillName,
      canonicalName: canonicalName || skillName,
      source: `SkillHub:${slug}`,
      author,
      category,
      tags,
      systemPrompt,
      homepage: homepageUrl,
      registry: 'skillhub',
      remoteSlug: slug,
      remoteVersion: version,
    })
    const extended = {
      registryId: 'skillhub',
      remoteId: slug,
      author,
      category,
      tagsJson: JSON.stringify(tags),
      homepageUrl,
      ...(metaIconUrl ? { iconUrl: metaIconUrl } : {}),
    }

    if (existing) {
      const row = this.skillRepo.update(existing.id, {
        name: skillName,
        version: skillVersion,
        rootPath: destPath,
        manifestJson,
      })
      this.skillRepo.updateExtendedFields(existing.id, extended)
      return toSkillItem(row!)
    }
    const row = this.skillRepo.create({
      id,
      scope: 'user',
      name: skillName,
      version: skillVersion,
      rootPath: destPath,
      manifestJson,
      enabled: true,
    })
    this.skillRepo.updateExtendedFields(id, extended)
    return toSkillItem(row)
  }

  // ─── 内置可安装技能目录（Installable Catalog） ──────────────────────

  /**
   * 返回内置可安装技能清单，并附上当前是否已安装的状态。
   * 用于技能商店「精选 / 可安装」卡片：新机器开箱即可看到这些卡片（不依赖联网），
   * 点击安装时才从 GitHub 按需下载完整原装技能。
   */
  listInstallableCatalog(): Array<
    InstallableSkillCatalogItem & { installed: boolean; localId?: string }
  > {
    const rows = this.skillRepo.list()
    return INSTALLABLE_SKILL_CATALOG.map((item) => {
      // 只按 root_path 精确等于 <userSkillsDir>/<slug> 来判定「本目录技能是否已安装」，
      // 绝不用 name 兜底——否则会把用户手动导入的同名（但不同来源）技能误判为已安装，
      // 进而在卸载时误删用户的同名技能。
      const match = this.findCatalogInstalledRow(item, rows)
      const base: InstallableSkillCatalogItem & { installed: boolean } = {
        ...item,
        installed: match != null,
      }
      // 仅在匹配到时附加 localId，避免 exactOptionalPropertyTypes 下的 undefined 赋值
      return match ? { ...base, localId: match.id } : base
    })
  }

  /**
   * 在 DB 行中找到「由本 catalog 安装」的那一行。
   * 匹配条件（二者满足其一即可，均按真实磁盘路径判定）：
   *   1. root_path 精确等于 <userSkillsDir>/<slug>；
   *   2. id 为 catalog 安装稳定指纹 `skill:catalog:<fp>`（跨 userSkillsDir 重命名等场景的兜底）。
   */
  private findCatalogInstalledRow(
    item: InstallableSkillCatalogItem,
    rows: ReturnType<SkillRepository['list']>,
  ) {
    const slugDir = this.userSkillsDir ? join(this.userSkillsDir, item.slug) : ''
    const catalogIds = this.catalogInstalledIds(item)
    return rows.find((row) => {
      if (catalogIds.includes(row.id)) return true
      return Boolean(slugDir) && row.root_path === slugDir
    })
  }

  private primaryCatalogId(item: InstallableSkillCatalogItem): string {
    if (item.source.type === 'artifact') {
      return `skill:catalog:${tarballSourceFingerprint(`artifact:${item.source.artifactId}`)}`
    }
    return `skill:catalog:${tarballSourceFingerprint(item.source.repo, item.source.path)}`
  }

  private catalogInstalledIds(item: InstallableSkillCatalogItem): string[] {
    const ids = [this.primaryCatalogId(item)]
    if (item.source.type === 'artifact' && item.source.fallback?.type === 'tarball') {
      ids.push(
        `skill:catalog:${tarballSourceFingerprint(item.source.fallback.repo, item.source.fallback.path)}`,
      )
    }
    return ids
  }

  /**
   * 从内置可安装技能目录安装一项。
   * 根据 source.type 分派到 tarball（整库下载，突破 60 文件限制）或 github（逐文件）路径。
   *
   * @param slug 目录条目的 slug
   * @param onProgress 进度回调（已下载字节数 / 总字节数）
   * @returns 安装后的 SkillItem
   */
  async installFromCatalog(
    slug: string,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<SkillItem> {
    const item = getInstallableSkillBySlug(slug)
    if (!item) throw new Error(`Unknown installable skill slug: ${slug}`)
    if (!this.userSkillsDir) {
      throw new Error('User skills directory not configured; cannot install')
    }

    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined

    if (item.source.type === 'artifact') {
      try {
        return await this.installCatalogArtifact(item, onProgress)
      } catch (err) {
        if (!item.source.fallback) throw err
        console.warn(
          `[catalog] artifact install failed for ${item.slug} (${
            err instanceof Error ? err.message : err
          }); falling back to ${item.source.fallback.type}`,
        )
        return this.installFromCatalogSource(item, item.source.fallback, token, onProgress)
      }
    }
    if (item.source.type === 'tarball') {
      return this.installCatalogTarball({ ...item, source: item.source }, token, onProgress)
    }
    // github 逐文件路径（小技能），复用既有 installFromGithub。
    // 注意：installFromGithub 暂不支持进度回调，故 onProgress 在此路径下被忽略；
    // 当前 catalog 内的两项均走 tarball，未受影响。
    const ghParams: { repo: string; ref?: string; path?: string } = { repo: item.source.repo }
    if (item.source.ref) ghParams.ref = item.source.ref
    if (item.source.path) ghParams.path = item.source.path
    return this.installFromGithub(ghParams)
  }

  private installFromCatalogSource(
    item: InstallableSkillCatalogItem,
    source: Exclude<InstallableSkillCatalogItem['source'], { type: 'artifact' }>,
    token: string | undefined,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<SkillItem> {
    if (source.type === 'tarball') {
      return this.installCatalogTarball({ ...item, source }, token, onProgress)
    }
    const ghParams: { repo: string; ref?: string; path?: string } = { repo: source.repo }
    if (source.ref) ghParams.ref = source.ref
    if (source.path) ghParams.path = source.path
    return this.installFromGithub(ghParams)
  }

  /**
   * 卸载内置可安装技能目录中的一项（按 slug）。
   * 删除磁盘目录与 DB 记录。仅对「从目录安装」的技能生效，不动内置技能。
   */
  uninstallFromCatalog(slug: string): boolean {
    const item = getInstallableSkillBySlug(slug)
    if (!item) return false
    const match = this.findCatalogInstalledRow(item, this.skillRepo.list())
    if (!match) return false
    // 删除磁盘目录
    if (match.root_path && existsSync(match.root_path)) {
      try {
        rmSync(match.root_path, { recursive: true, force: true })
      } catch {
        // 删除失败不阻断 DB 清理
      }
    }
    return this.skillRepo.deleteById(match.id)
  }

  /** tarball 整库安装路径：下载 → 解压 → 取子目录 → 落盘 → 建/更新 DB 记录。 */
  private async installCatalogTarball(
    item: InstallableSkillCatalogItem & {
      source: Extract<InstallableSkillCatalogItem['source'], { type: 'tarball' }>
    },
    token: string | undefined,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<SkillItem> {
    const params: TarballInstallParams = {
      repo: item.source.repo,
      destDirName: item.slug,
      userSkillsDir: this.userSkillsDir!,
    }
    if (item.source.ref) params.ref = item.source.ref
    if (item.source.path) params.path = item.source.path
    if (token) params.token = token
    if (onProgress) params.onProgress = onProgress
    const { destPath, skillMd } = await installFromGithubTarball(params)
    const meta = parseSkillFrontmatter(skillMd)
    const skillName = meta.name || item.name
    const fp = tarballSourceFingerprint(item.source.repo, item.source.path)

    // dedupe by rootPath；id 用稳定的来源指纹，避免重复安装产生多行
    const existing = this.skillRepo.list().find((s) => s.root_path === destPath)
    const id = existing?.id ?? `skill:catalog:${fp}`
    const manifestJson = JSON.stringify({
      desc: meta.description || item.description,
      description: meta.description || item.description,
      source: `Catalog:${item.source.repo}`,
      author: meta.author || item.author,
      category: meta.category || 'utility',
      tags: meta.tags?.length ? meta.tags : item.tags,
      systemPrompt: stripSkillFrontmatter(skillMd).trim(),
      homepage: item.homepageUrl ?? `https://github.com/${item.source.repo}`,
    })
    if (existing) {
      const row = this.skillRepo.update(existing.id, {
        name: skillName,
        version: meta.version || '0.0.0',
        rootPath: destPath,
        manifestJson,
      })
      return toSkillItem(row!)
    }
    const row = this.skillRepo.create({
      id,
      scope: 'user',
      name: skillName,
      version: meta.version || '0.0.0',
      rootPath: destPath,
      manifestJson,
      enabled: true,
    })
    return toSkillItem(row)
  }

  /** Spark 自建 artifact 安装路径：manifest → zip → SHA256 校验 → 落盘 → 建/更新 DB 记录。 */
  private async installCatalogArtifact(
    item: InstallableSkillCatalogItem,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<SkillItem> {
    if (item.source.type !== 'artifact') {
      throw new Error(`Catalog item is not an artifact source: ${item.slug}`)
    }
    const manifest = await fetchSparkInstallManifest(item.source.manifestUrl)
    const artifact = findSparkInstallArtifact(manifest, item.source.artifactId)
    if (artifact.type !== 'skill') {
      throw new Error(`Spark install artifact is not a skill package: ${artifact.id}`)
    }
    const archiveFormat = artifact.archive?.format ?? 'zip'
    if (archiveFormat !== 'zip') {
      throw new Error(`Unsupported skill artifact archive format: ${archiveFormat}`)
    }
    const zipParams: Parameters<typeof installFromZip>[0] = {
      url: resolveArtifactUrl(manifest, artifact),
      destDirName: item.slug,
      userSkillsDir: this.userSkillsDir!,
      ...(onProgress ? { onProgress } : {}),
    }
    if (artifact.fallbackUrls !== undefined) {
      zipParams.fallbackUrls = artifact.fallbackUrls.map((url) =>
        resolveArtifactUrlString(manifest, url),
      )
    }
    if (artifact.sha256 !== undefined) zipParams.sha256 = artifact.sha256
    if (artifact.archive?.skillRoot !== undefined) zipParams.skillRoot = artifact.archive.skillRoot
    const result = await installFromZip(zipParams)
    const meta = parseSkillFrontmatter(result.skillMd)
    const skillName = meta.name || item.name
    const existing = this.skillRepo.list().find((s) => s.root_path === result.destPath)
    const id = existing?.id ?? this.primaryCatalogId(item)
    const manifestJson = JSON.stringify({
      desc: meta.description || item.description,
      description: meta.description || item.description,
      source: `SparkArtifact:${artifact.id}`,
      sourceUrl: resolveArtifactUrl(manifest, artifact),
      author: meta.author || item.author,
      category: meta.category || 'utility',
      tags: meta.tags?.length ? meta.tags : item.tags,
      systemPrompt: stripSkillFrontmatter(result.skillMd).trim(),
      homepage: item.homepageUrl,
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      artifactDependencies: artifact.dependencies ?? [],
    })
    if (existing) {
      const row = this.skillRepo.update(existing.id, {
        name: skillName,
        version: meta.version || artifact.version || '0.0.0',
        rootPath: result.destPath,
        manifestJson,
      })
      return toSkillItem(row!)
    }
    const row = this.skillRepo.create({
      id,
      scope: 'user',
      name: skillName,
      version: meta.version || artifact.version || '0.0.0',
      rootPath: result.destPath,
      manifestJson,
      enabled: true,
    })
    return toSkillItem(row)
  }

  // ─── 通用二进制产物安装（ffmpeg 等非技能包）─────────────────────────

  /**
   * 从 Spark 自建安装源下载并安装一个二进制产物（type: 'binary'）。
   *
   * 与技能安装（installCatalogArtifact）的区别：
   *   - 不要求归档含 SKILL.md
   *   - 落盘到 `<binaryDir>/<artifact.name>/`（而非 skills 目录），避免被技能扫描器误识别
   *   - 返回落盘路径与文件条目（供调用方 chmod / 探测可执行文件）
   *
   * 复用与技能安装相同的下载（含 fallbackUrls 回退）、SHA256 校验、解压流程。
   *
   * @param artifactId manifest 中的产物 id（如 `binary.ffmpeg-7.0.2.darwin-arm64`）
   * @param opts.onProgress 下载进度回调（已下载字节 / 总字节）
   * @returns 落盘信息（destPath 绝对路径 + 解压出的条目列表）
   */
  async installBinaryArtifact(
    artifactId: string,
    opts: { onProgress?: (downloaded: number, total: number) => void } = {},
  ): Promise<{ destPath: string; fileCount: number; entries: string[] }> {
    if (!this.binaryDir) {
      throw new Error('Binary install directory not configured; cannot install binary artifact.')
    }
    const manifest = await fetchSparkInstallManifest()
    const artifact = findSparkInstallArtifact(manifest, artifactId)
    if (artifact.type !== 'binary') {
      throw new Error(`Spark install artifact is not a binary package: ${artifact.id}`)
    }
    const resolvedUrl = resolveArtifactUrl(manifest, artifact)
    const fallbackUrls = artifact.fallbackUrls?.map((u) => resolveArtifactUrlString(manifest, u))

    // 落盘目录：<binaryDir>/<artifact.name>。artifact.name 形如
    // "FFmpeg 7.0.2 (macOS Apple Silicon)"，sanitize 成安全目录名。
    // 安全：artifact.name 来自远程 manifest（不可信），sanitize 后必须确保
    // 不含路径分隔符或 .. 段，否则 join() 会逃出 binaryDir。
    const rawName = artifact.name
      .replace(/[<>:"/\\|?*\p{Cc}]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[()]/g, '')
    if (
      rawName === '.' ||
      rawName === '..' ||
      rawName.includes('/') ||
      rawName.includes('\\') ||
      rawName.includes('..')
    ) {
      throw new Error(`Unsafe artifact name from manifest, refusing to install: ${JSON.stringify(artifact.name)}`)
    }
    const safeName = rawName || artifact.id.replace(/[^a-zA-Z0-9._-]/g, '-')
    const destDir = join(this.binaryDir, safeName)
    // 二次防御：解析后的绝对路径必须在 binaryDir 下
    const resolved = resolve(destDir)
    const resolvedRoot = resolve(this.binaryDir)
    if (!resolved.startsWith(resolvedRoot + sep) && resolved !== resolvedRoot) {
      throw new Error(`Resolved destDir escapes binaryDir: ${resolved}`)
    }

    const result = await installBinaryArchive({
      url: resolvedUrl,
      ...(fallbackUrls?.length ? { fallbackUrls } : {}),
      ...(artifact.sha256 !== undefined ? { sha256: artifact.sha256 } : {}),
      ...(artifact.archive?.format ? { format: artifact.archive.format } : {}),
      ...(artifact.archive?.contentRoot !== undefined
        ? { contentRoot: artifact.archive.contentRoot }
        : {}),
      destDir,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    })

    return { destPath: result.destPath, fileCount: result.fileCount, entries: result.entries }
  }

  /**
   * 拉取 Spark 安装清单（index.json）供外部查询（如按平台选 ffmpeg 包）。
   * 返回原始 manifest 对象，调用方自行过滤 artifacts。
   */
  async fetchSparkManifestForQuery() {
    return fetchSparkInstallManifest()
  }

  // ─── GitHub 安装 ────────────────────────────────────────────────────

  /**
   * 在 GitHub 上搜索技能仓库（含 SKILL.md 的项目）。
   * 无 token 时走匿名接口（限速 60/h），有 token 走 settings.github.token。
   */
  async searchGithub(query: string, limit = 8): Promise<GithubSkillCandidate[]> {
    const q = `${query} skill SKILL.md`.trim()
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${Math.min(Math.max(limit, 1), 20)}`
    let data: { items?: GithubRepoApi[] }
    try {
      data = await fetchJson<{ items?: GithubRepoApi[] }>(url, {
        headers: this.githubHeaders(),
        timeoutMs: 15_000,
        maxRetries: 3,
      })
    } catch (err) {
      if (err instanceof HttpError) {
        throw new Error(`GitHub search failed: ${err.statusCode ?? 'network'} ${err.message}`, {
          cause: err,
        })
      }
      throw err
    }
    return (data.items ?? []).map((r) => ({
      repo: r.full_name,
      name: r.name,
      description: r.description ?? '',
      author: r.owner?.login ?? '',
      stars: r.stargazers_count ?? 0,
      homepageUrl: r.html_url,
      defaultBranch: r.default_branch ?? 'main',
      source: 'GitHub',
    }))
  }

  /**
   * 从 GitHub 安装技能：定位含 SKILL.md 的目录并把该目录子树落盘到 userSkillsDir。
   *
   * @param params.repo 形如 "owner/name"
   * @param params.ref  分支/标签/commit（缺省取默认分支）
   * @param params.path 仓库内技能目录（缺省为根；多技能仓库可指定如 "skills/pdf"）
   */
  async installFromGithub(params: {
    repo: string
    ref?: string
    path?: string
  }): Promise<SkillItem> {
    if (!this.userSkillsDir) throw new Error('User skills directory not configured; cannot install')
    const repo = params.repo
      .replace(/^https?:\/\/github\.com\//, '')
      .replace(/\.git$/, '')
      .trim()
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new Error(`Invalid repo "${params.repo}"; expected "owner/name"`)

    const ref = params.ref?.trim() || (await this.fetchDefaultBranch(repo))
    const basePath = (params.path ?? '').replace(/^\/+|\/+$/g, '')

    // 收集技能目录下的所有文件（含子目录），带文件数/大小上限
    const files = await this.collectGithubFiles(repo, ref, basePath)
    const skillFile = files.find((f) => /(^|\/)SKILL\.md$/i.test(f.relPath))
    if (!skillFile) {
      throw new Error(`No SKILL.md found under ${repo}${basePath ? '/' + basePath : ''}@${ref}`)
    }
    // 技能根 = SKILL.md 所在目录（去掉文件名）
    const skillRootRel = skillFile.relPath.includes('/')
      ? skillFile.relPath.slice(0, skillFile.relPath.lastIndexOf('/'))
      : ''
    const skillFiles = files.filter(
      (f) =>
        f.relPath === skillRootRel || f.relPath.startsWith(skillRootRel ? skillRootRel + '/' : ''),
    )

    // 解析 SKILL.md 元数据
    const skillMd = await fetchText(skillFile.downloadUrl, {
      headers: this.githubHeaders(),
      timeoutMs: 15_000,
      maxRetries: 2,
      retryBackoffMs: 250,
    })
    const meta = parseSkillFrontmatter(skillMd)
    const skillName = meta.name || repo.split('/')[1] || 'github-skill'

    // 落盘
    const dirName = slugifySkillName(skillName)
    const dest = join(this.userSkillsDir, dirName)
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    for (const f of skillFiles) {
      const rel = skillRootRel ? f.relPath.slice(skillRootRel.length + 1) : f.relPath
      const target = join(dest, rel)
      mkdirSync(join(target, '..'), { recursive: true })
      const buf = await this.downloadGithubFile(f.downloadUrl)
      writeFileSync(target, buf)
    }

    // 创建 DB 记录（dedupe by rootPath）
    const existing = this.skillRepo.list().find((s) => s.root_path === dest)
    const id =
      existing?.id ??
      `skill:github:${crypto
        .createHash('sha1')
        .update(repo + '/' + basePath)
        .digest('hex')
        .slice(0, 12)}`
    const manifestJson = JSON.stringify({
      desc: meta.description || `从 GitHub ${repo} 安装`,
      description: meta.description || `从 GitHub ${repo} 安装`,
      source: `GitHub:${repo}`,
      author: meta.author || repo.split('/')[0],
      category: meta.category || 'utility',
      tags: meta.tags,
      systemPrompt: stripSkillFrontmatter(skillMd).trim(),
      homepage: `https://github.com/${repo}`,
    })
    if (existing) {
      const row = this.skillRepo.update(existing.id, {
        name: skillName,
        version: meta.version || '0.0.0',
        rootPath: dest,
        manifestJson,
      })
      return toSkillItem(row!)
    }
    const row = this.skillRepo.create({
      id,
      scope: 'user',
      name: skillName,
      version: meta.version || '0.0.0',
      rootPath: dest,
      manifestJson,
      enabled: true,
    })
    return toSkillItem(row)
  }

  // ─── GitHub helpers ─────────────────────────────────────────────────

  private githubHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Spark-Agent',
    }
    const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    if (envToken) headers.Authorization = `Bearer ${envToken}`
    return headers
  }

  private async fetchDefaultBranch(repo: string): Promise<string> {
    try {
      const data = await fetchJson<{ default_branch?: string }>(
        `https://api.github.com/repos/${repo}`,
        {
          headers: this.githubHeaders(),
          timeoutMs: 15_000,
          maxRetries: 3,
        },
      )
      return data.default_branch || 'main'
    } catch (err) {
      if (err instanceof HttpError) {
        throw new Error(`Failed to resolve repo ${repo}: ${err.statusCode ?? 'network'}`, {
          cause: err,
        })
      }
      throw err
    }
  }

  /** 递归收集目录文件（限 60 个文件，单文件 ≤1MB） */
  private async collectGithubFiles(
    repo: string,
    ref: string,
    path: string,
    acc: GithubFile[] = [],
    depth = 0,
  ): Promise<GithubFile[]> {
    if (depth > 6 || acc.length >= 60) return acc
    const url = `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`
    let data: unknown
    try {
      data = await fetchJson(url, {
        headers: this.githubHeaders(),
        timeoutMs: 15_000,
        maxRetries: 3,
      })
    } catch (err) {
      if (err instanceof HttpError) {
        throw new Error(`Failed to list ${repo}/${path}: ${err.statusCode ?? 'network'}`, {
          cause: err,
        })
      }
      throw err
    }
    const entries: GithubContentApi[] = Array.isArray(data) ? data : [data]
    for (const entry of entries) {
      if (acc.length >= 60) break
      if (entry.type === 'file' && entry.download_url && (entry.size ?? 0) <= 1_000_000) {
        acc.push({ relPath: entry.path, downloadUrl: entry.download_url })
      } else if (entry.type === 'dir') {
        await this.collectGithubFiles(repo, ref, entry.path, acc, depth + 1)
      }
    }
    return acc
  }

  private async downloadGithubFile(downloadUrl: string): Promise<Buffer> {
    try {
      return await fetchJson<Buffer>(downloadUrl, {
        headers: this.githubHeaders(),
        timeoutMs: 20_000,
        binary: true,
        maxRetries: 3,
      })
    } catch (err) {
      if (err instanceof HttpError) {
        throw new Error(`Failed to download ${downloadUrl}: ${err.statusCode ?? 'network'}`, {
          cause: err,
        })
      }
      throw err
    }
  }

  // ─── 团队注册中心（Team Registry）推拉 ───────────────────────────────

  /**
   * 配置保存后调用：按当前配置与 skill_registries 行状态装配/卸下 team adapter。
   * 未配置或行被禁用时移除 adapter，保证「配置好之前不可用但不报错」。
   */
  refreshTeamRegistry(): void {
    if (!this.teamRegistry) return
    const row = this.registryRepo.get(TEAM_REGISTRY_ID)
    if (!row || row.enabled !== 1) {
      this.adapters.delete(TEAM_REGISTRY_ID)
      return
    }
    this.adapters.set(TEAM_REGISTRY_ID, new NacosTeamAdapter(this.teamRegistry))
  }

  /**
   * 团队配置保存时同步 skill_registries 行（市场列表展示用）。
   * 幂等：已存在仅同步地址，不存在才创建（enabled 默认 true）。
   */
  ensureTeamRegistryRow(serverUrl: string): void {
    const existing = this.registryRepo.get(TEAM_REGISTRY_ID)
    if (existing) {
      if (existing.api_base_url !== serverUrl) {
        this.registryRepo.update(TEAM_REGISTRY_ID, { apiBaseUrl: serverUrl })
      }
      return
    }
    this.registryRepo.create({
      id: TEAM_REGISTRY_ID,
      name: '团队源',
      description: '团队 Nacos 注册中心共享的技能（设置 → 团队注册中心 配置）',
      apiBaseUrl: serverUrl,
      type: 'remote',
    })
  }

  /**
   * 从团队源安装/更新一个技能（原生 zip API，M1.5）。
   * 下载最新已发布版本 zip → 解包 → 落盘文件树 →
   * upsert DB 行（registry_id=team）→ 记录 pins 锚点。
   */
  async installFromTeam(slug: string): Promise<SkillItem> {
    if (!slug) throw new Error('团队技能 slug 不能为空')
    if (!this.userSkillsDir) {
      throw new Error('User skills directory not configured; cannot install')
    }
    const team = this.requireTeamRegistry()
    const client = await team.client()
    if (!client) throw new Error('团队注册中心尚未配置，无法安装')
    const detail = await client.getTeamSkill(slug)
    if (!detail) throw new Error('团队源中不存在该技能：' + slug)
    const version = pickLatestTeamVersion(detail.versions)
    if (!version) throw new Error('技能 ' + slug + ' 没有已发布版本，无法安装')
    const zip = await client.downloadTeamSkillVersion(slug, version)
    const files: TeamSkillFile[] = stripZipCommonRoot(readZip(zip))
      .filter((e) => !e.path.endsWith('/'))
      .map((e) => ({ path: e.path, content: e.content.toString('utf-8') }))
    const skillMdFile = files.find((f) => f.path === 'SKILL.md')
    if (!skillMdFile) throw new Error('技能包缺少 SKILL.md，无法安装：' + slug)
    const checksum = computeSkillFilesChecksum(files)

    // 落盘（先清旧目录，保证与包内容严格一致）
    const dest = join(this.userSkillsDir, slug)
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    this.writeTeamSkillFiles(dest, files)

    const skillMd = skillMdFile.content
    const hasFm = skillMd.startsWith('---')
    const fm = hasFm ? parseSkillFrontmatter(skillMd) : null
    const skillName = fm?.name || detail.name || slug
    const skillVersion = fm?.version || version
    const description = fm?.description || detail.description

    // dedupe by rootPath；id 用稳定 slug 指纹（与 skillhub 路径同构）
    const existing = this.skillRepo.list().find((s) => s.root_path === dest)
    const id = existing?.id ?? 'skill:team:' + slug
    const manifestJson = JSON.stringify({
      desc: description,
      description,
      displayName: skillName,
      canonicalName: fm?.name || '',
      source: 'Team:' + slug,
      author: fm?.author || '',
      category: fm?.category || 'team',
      tags: fm?.tags ?? [],
      systemPrompt: hasFm ? stripSkillFrontmatter(skillMd).trim() : skillMd.trim(),
      registry: 'team',
      remoteSlug: slug,
      remoteVersion: version,
      teamChecksum: checksum,
    })
    const extended = {
      registryId: 'team',
      remoteId: slug,
      author: fm?.author || '',
      category: fm?.category || 'team',
      tagsJson: JSON.stringify(fm?.tags ?? []),
    }

    let row
    if (existing) {
      row = this.skillRepo.update(existing.id, {
        name: skillName,
        version: skillVersion,
        rootPath: dest,
        manifestJson,
      })
      this.skillRepo.updateExtendedFields(existing.id, extended)
    } else {
      row = this.skillRepo.create({
        id,
        scope: 'user',
        name: skillName,
        version: skillVersion,
        rootPath: dest,
        manifestJson,
        enabled: true,
      })
      this.skillRepo.updateExtendedFields(id, extended)
    }

    // pins 锚点：installed 版本/checksum 对齐本次安装的包内容
    this.pinsRepo.upsert('skill', slug, {
      installedVersion: version,
      installedChecksum: checksum,
      installedAt: new Date().toISOString(),
    })
    this.registryRepo.update(TEAM_REGISTRY_ID, { lastSyncAt: new Date().toISOString() })

    return toSkillItem(row!)
  }

  /**
   * 发布本地技能到团队源（原生 zip API，M1.5）。
   * 读目录文件树 → frontmatter 写版本 → zip → precheck 校验 → upload →
   * submit → publish → online → scope=PUBLIC → pins 发布锚点。
   * 不再用配置中心信封；配置中心信封保留给工作流/子应用（M3/M4）。
   */
  async publishToTeam(
    localSkillId: string,
    opts: { version?: string } = {},
  ): Promise<TeamSkillPublishResult> {
    const row = this.skillRepo.list().find((s) => s.id === localSkillId)
    if (!row) throw new Error('本地技能不存在：' + localSkillId)
    if (
      !row.root_path ||
      row.root_path.startsWith('builtin://') ||
      row.root_path.startsWith('registry://') ||
      !existsSync(row.root_path)
    ) {
      throw new Error('该技能没有真实落盘目录（内置/虚拟路径技能不能发布到团队源）')
    }
    const team = this.requireTeamRegistry()
    const client = await team.client()
    if (!client) throw new Error('团队注册中心尚未配置，无法发布')

    const warnings: string[] = []
    const { files, skipped } = collectSkillFiles(row.root_path)
    if (files.length === 0) throw new Error('技能目录为空，无法发布')
    const skillMdFile = files.find((f) => f.path === 'SKILL.md')
    if (!skillMdFile) throw new Error('技能目录缺少 SKILL.md，无法发布')

    // slug 以 SKILL.md frontmatter name 为准（服务端从 frontmatter 解析 name/version），
    // 缺失时回退目录名归一化
    const fm = skillMdFile.content.startsWith('---')
      ? parseSkillFrontmatter(skillMdFile.content)
      : null
    const slug = sanitizeTeamSlug(fm?.name || basename(row.root_path))
    const checksum = computeSkillFilesChecksum(files)

    // 远端现状（详情 versions 中最高已发布版本；不存在 → 首发 1.0.0）
    let remoteVersion: string | null = null
    try {
      const detail = await client.getTeamSkill(slug)
      if (detail) remoteVersion = pickLatestTeamVersion(detail.versions)
    } catch (err) {
      console.warn(
        '[team-registry] 读取远端技能失败，按首发处理：' +
          (err instanceof Error ? err.message : String(err)),
      )
    }
    const explicitVersion = opts.version?.trim()
    const version = explicitVersion || bumpPatchVersion(remoteVersion)
    if (remoteVersion && explicitVersion && compareSemver(explicitVersion, remoteVersion) <= 0) {
      throw new Error(
        '指定版本 ' + explicitVersion + ' 不高于远端当前版本 ' + remoteVersion + '；如需覆盖请升版本号',
      )
    }

    // zip（SKILL.md 的 frontmatter 版本号改写为发布版本，服务端按它解析 targetVersion）
    const zip = buildZip(
      files.map((f) => ({
        path: f.path,
        content:
          f.path === 'SKILL.md'
            ? Buffer.from(applyFrontmatterVersion(f.content, version), 'utf-8')
            : Buffer.from(f.content, 'utf-8'),
      })),
    )

    // precheck 防御：服务端解析结果必须与本地意图一致
    const pre = await client.precheckTeamSkillUpload(zip)
    if (!pre || !pre.skillName || pre.precheckCode !== 'READY') {
      const reason = pre ? pre.precheckCode + (pre.reason ? ' ' + pre.reason : '') : '无响应'
      throw new Error('团队注册中心预检未通过：' + reason)
    }
    if (pre.skillName !== slug) {
      throw new Error(
        'SKILL.md frontmatter name（' + pre.skillName + '）与推导 slug（' + slug + '）不一致，' +
          '请统一后再发布',
      )
    }
    const finalVersion = explicitVersion ?? pre.targetVersion ?? version
    if (pre.targetVersion && pre.targetVersion !== finalVersion) {
      throw new Error(
        '服务端解析版本（' + pre.targetVersion + '）与发布版本（' + finalVersion + '）不一致',
      )
    }

    const snapshot = await team.getSnapshot()
    const author = snapshot.username || os.userInfo().username
    await client.uploadTeamSkillZip({
      zip,
      overwrite: pre.exists,
      commitMsg: 'SparkWork 发布 ' + finalVersion + ' by ' + author,
    })
    await client.submitTeamSkillVersion(slug, finalVersion)
    await client.publishTeamSkillVersion(slug, finalVersion)
    await this.onlineSkillTolerantly(client, slug, finalVersion, warnings)
    try {
      await client.setTeamSkillScope(slug, 'PUBLIC')
    } catch (err) {
      warnings.push(
        '技能已发布但共享范围（PUBLIC）设置失败，团队成员可能看不到：' +
          (err instanceof Error ? err.message : String(err)),
      )
    }

    this.pinsRepo.upsert('skill', slug, {
      publishedVersion: finalVersion,
      publishedChecksum: checksum,
      publishedAt: new Date().toISOString(),
    })
    return {
      slug,
      version: finalVersion,
      skillName: slug,
      fileCount: files.length,
      skipped,
      checksum,
      warnings,
      previousRemoteVersion: remoteVersion,
    }
  }

  /** online 步骤：已是终态或服务端拒绝时不阻断发布，降级为 warning */
  private async onlineSkillTolerantly(
    client: NacosClient,
    slug: string,
    version: string,
    warnings: string[],
  ): Promise<void> {
    try {
      await client.onlineTeamSkillVersion(slug, version)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      let status = ''
      try {
        const detail = await client.getTeamSkill(slug)
        status = detail?.versions.find((v) => v.version === version)?.status ?? ''
      } catch {
        // 详情读取失败不影响降级判断
      }
      if (/online|publish/i.test(status)) {
        warnings.push('online 被拒但版本已是终态（' + status + '）')
      } else {
        warnings.push('online 失败（技能已发布但可能未上线）：' + message)
      }
    }
  }

  /**
   * 已安装团队技能 vs 远端原生列表的版本比对（更新徽标数据源）。
   * 未配置团队注册中心时返回空数组（不抛错）。
   */
  async listTeamUpdates(): Promise<TeamSkillUpdateInfo[]> {
    if (!this.teamRegistry) return []
    const client = await this.teamRegistry.client()
    if (!client) return []
    const raw = await client.listTeamSkills()
    const bySlug = new Map<string, { version: string; updatedAt: string }>()
    for (const item of raw) {
      const slug = teamItemString(item, ['skillName', 'name'])
      if (!slug) continue
      const version = teamItemString(item, ['version', 'latestVersion']) ?? ''
      const updatedAt = teamItemString(item, ['updatedAt', 'modifiedTime', 'lastModifiedTime']) ?? ''
      bySlug.set(slug, { version, updatedAt })
    }
    const rows = this
      .skillRepo.list()
      .filter((s) => s.registry_id === TEAM_REGISTRY_ID && s.remote_id)
    const results: TeamSkillUpdateInfo[] = []
    for (const row of rows) {
      const slug = row.remote_id!
      const remote = bySlug.get(slug)
      if (!remote) {
        results.push({
          slug,
          localSkillId: row.id,
          name: row.name,
          localVersion: row.version,
          remoteVersion: '',
          remoteUpdatedAt: '',
          state: 'remote-missing',
        })
        continue
      }
      const pin = this.pinsRepo.get('skill', slug)
      const localChecksum = existsSync(row.root_path)
        ? computeSkillFilesChecksum(collectSkillFiles(row.root_path).files)
        : null
      const state = classifyTeamAssetState({
        localChecksum,
        installedChecksum: pin?.installed_checksum ?? null,
        installedVersion: pin?.installed_version ?? row.version ?? null,
        remoteVersion: remote.version || '0.0.0',
        remoteChecksum: '',
      })
      results.push({
        slug,
        localSkillId: row.id,
        name: row.name,
        localVersion: row.version,
        remoteVersion: remote.version,
        remoteUpdatedAt: remote.updatedAt,
        state,
      })
    }
    return results
  }

  private requireTeamRegistry(): TeamRegistryService {
    if (!this.teamRegistry) {
      throw new Error('团队注册中心服务未装配（TeamRegistryService missing）')
    }
    return this.teamRegistry
  }

  /** 写信封文件树（路径逃逸防御：拒绝绝对路径/../反斜杠，resolve 后必须在 dest 下） */
  private writeTeamSkillFiles(destRoot: string, files: TeamSkillFile[]): void {
    const resolvedRoot = resolve(destRoot)
    for (const file of files) {
      const rel = file.path
      if (!rel || rel.startsWith('/') || rel.includes('..') || rel.includes('\\')) {
        throw new Error(`信封内非法文件路径：${rel}`)
      }
      const target = resolve(join(destRoot, rel))
      if (!target.startsWith(resolvedRoot + sep) && target !== resolvedRoot) {
        throw new Error(`信封文件路径逃逸技能目录：${rel}`)
      }
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, file.content, 'utf-8')
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────────

  /**
   * 把远程技能写到真实磁盘目录：`<userSkillsDir>/<safeName>/{SKILL.md,manifest.json}`。
   * 成功返回真实目录路径；未配置目录或写入失败时返回 null（调用方回落到虚拟路径）。
   */
  private materializeSkill(
    name: string,
    body: string,
    remoteSkill: RemoteSkillItem,
    manifest: Record<string, unknown> | null,
  ): string | null {
    if (!this.userSkillsDir) return null
    const dirName = slugifySkillName(name)
    if (!dirName) return null
    const dest = join(this.userSkillsDir, dirName)
    try {
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), buildSkillMarkdown(name, body, remoteSkill), 'utf-8')
      // 保留来源 manifest，便于后续追溯/重装
      const manifestOut = {
        ...(manifest ?? {}),
        name,
        version: remoteSkill.version,
        category: remoteSkill.category,
        tags: remoteSkill.tags,
        author: remoteSkill.author,
        source: remoteSkill.registryName,
      }
      writeFileSync(join(dest, 'manifest.json'), JSON.stringify(manifestOut, null, 2), 'utf-8')
      return dest
    } catch {
      return null
    }
  }

  private getAdapterOrThrow(registryId: string): SkillRegistryAdapter {
    const adapter = this.adapters.get(registryId)
    if (!adapter) {
      // 列出当前可用 registry，帮助调用方（尤其是 agent / MCP）自我纠正：
      // 常见误传是显示名（"SkillHub"）或内置目录字样（"catalog"），它们都不是 registry Map 的 key。
      const available = Array.from(this.adapters.keys()).join(', ')
      throw new Error(
        `Registry not available: "${registryId}". Available registries: ${available}. ` +
          `(Tip: registryId 必须是上面列出的小写 id；内置精选技能请用 registryId="catalog" 走 installFromCatalog。)`,
      )
    }
    return adapter
  }

  private createAdapter(config: SkillRegistryAdapterConfig): SkillRegistryAdapter {
    // 根据 registryId 分发到对应 Adapter
    switch (config.registryId) {
      case 'skillhub':
        return new SkillHubAdapter(config)
      case 'skillsmp':
        return new SkillsMPAdapter(config)
      case TEAM_REGISTRY_ID:
        if (!this.teamRegistry) {
          throw new Error('Team registry service not wired; cannot create team adapter')
        }
        return new NacosTeamAdapter(this.teamRegistry)
      default:
        throw new Error(`Unsupported skill registry adapter: ${config.registryId}`)
    }
  }

  private buildInstalledMap(): Map<string, string> {
    const map = new Map<string, string>() // remoteId → localId
    for (const row of this.skillRepo.list()) {
      if (row.remote_id) {
        // key 用 registry_id:remote_id 组合
        const key = `${row.registry_id}:${row.remote_id}`
        map.set(key, row.id)
      }
    }
    return map
  }

  private enrichWithInstallStatus(
    skill: RemoteSkillItem,
    installedMap: Map<string, string>,
  ): RemoteSkillItem {
    // catalog 来源的 skill：installed 状态已在 catalogItemToRemoteSkill 里按 rootPath/指纹
    // 探测好，这里不能再用 installedMap 覆盖——catalog 装的 skill 没有 remote_id，
    // installedMap（仅收 remote_id 行）查不到，会把已装误判成未装。
    if (skill.registryId === 'catalog') return skill
    // remote skill 的 id 格式是 "registryId:xxx"
    const localId = installedMap.get(skill.id)
    const enriched: RemoteSkillItem = {
      ...skill,
      installed: localId != null,
    }
    if (localId !== undefined) enriched.localId = localId
    return enriched
  }

  /** 按关键词过滤内置精选目录（空查询返回全部精选）。 */
  private searchCatalog(query: string): InstallableSkillCatalogItem[] {
    const q = query.trim().toLowerCase()
    if (!q) return [...INSTALLABLE_SKILL_CATALOG]
    return INSTALLABLE_SKILL_CATALOG.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.slug.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.tags.some((t) => t.toLowerCase().includes(q)),
    )
  }

  /**
   * 把内置精选目录条目映射成 RemoteSkillItem，registryId 固定为 'catalog'。
   * installed 状态走 catalog 专用探测（findCatalogInstalledRow，按 rootPath/指纹），
   * 而非 enrichWithInstallStatus（后者依赖 remote_id，catalog 没有）。
   */
  private catalogItemToRemoteSkill(
    item: InstallableSkillCatalogItem,
    rows: ReturnType<SkillRepository['list']>,
  ): RemoteSkillItem {
    const installedRow = this.findCatalogInstalledRow(item, rows)
    // manifestUrl 仅展示用（catalog 实际安装按 source.type 分派）。
    // filter(Boolean).join('/') 拼接，避免 source.path 为空时出现 ".../main//SKILL.md" 双斜杠。
    const manifestUrl =
      item.source.type === 'artifact'
        ? (item.source.manifestUrl ?? item.homepageUrl ?? '')
        : [
            'https://raw.githubusercontent.com',
            item.source.repo,
            item.source.ref ?? 'main',
            (item.source.path ?? '').replace(/^\/+|\/+$/g, ''),
            'SKILL.md',
          ]
            .filter(Boolean)
            .join('/')
    const skill: RemoteSkillItem = {
      id: `catalog:${item.slug}`,
      name: item.name,
      description: item.description,
      version: '',
      author: item.author,
      registryId: 'catalog',
      registryName: '内置精选',
      category: 'general',
      tags: item.tags,
      rating: 4.8,
      downloadCount: 10000,
      manifestUrl,
      installed: !!installedRow,
    }
    if (item.homepageUrl !== undefined) skill.homepageUrl = item.homepageUrl
    // 已装时必须带 localId：商店页 handleUninstallRemote 第一行 `if (!skill.localId) return`，
    // 缺了它，已装精选 skill 在商店页点「卸载」会静默失败。通用 uninstall 按 id 清 root_path + DB，
    // 能完整清理 catalog 产物，无需走专用 uninstallFromCatalog。
    if (installedRow) skill.localId = installedRow.id
    return skill
  }
}

// ─── 团队推拉结果类型 ──────────────────────────────────────────────────

export interface TeamSkillPublishResult {
  slug: string
  version: string
  /** 服务端确认的技能名（= slug） */
  skillName: string
  fileCount: number
  /** 发布时被跳过的文件（二进制/超限/忽略规则） */
  skipped: Array<{ path: string; reason: 'binary' | 'too-large' | 'ignored' }>
  checksum: string
  /** 非阻断告警（online 降级 / scope 设置失败等） */
  warnings: string[]
  /** 发布前远端已有版本（null = 首发） */
  previousRemoteVersion: string | null
}

export interface TeamSkillUpdateInfo {
  slug: string
  localSkillId: string
  name: string
  localVersion: string
  remoteVersion: string
  remoteUpdatedAt: string
  state: TeamAssetState | 'remote-missing'
}

// ─── 团队推拉助手 ──────────────────────────────────────────────────────

/**
 * 把 SKILL.md frontmatter 的 version 行改写为发布版本（服务端按 frontmatter
 * 解析 targetVersion）。无 frontmatter 时补最小 frontmatter。
 */
function applyFrontmatterVersion(skillMd: string, version: string): string {
  if (!skillMd.startsWith('---')) {
    return '---\nversion: ' + version + '\n---\n\n' + skillMd
  }
  const end = skillMd.indexOf('\n---', 3)
  const head = end === -1 ? skillMd : skillMd.slice(0, end)
  const tail = end === -1 ? '' : skillMd.slice(end)
  if (/(^|\r?\n)version:\s*\S/.test(head)) {
    return head.replace(/(^|\r?\n)version:\s*[^\r\n]*/i, '$1version: ' + version) + tail
  }
  return head + '\nversion: ' + version + tail
}

/** 团队 slug 归一化：小写 + 非法字符转 '-'（Nacos name 保守约束） */
function sanitizeTeamSlug(raw: string): string {
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  if (!slug || slug === '.' || slug === '..') throw new Error('无法推导团队技能 slug：' + raw)
  return slug
}

/** 团队原生列表条目的字符串字段宽容提取 */
function teamItemString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = record[key]
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return null
}

// ─── Row → Protocol Type Mappers ──────────────────────────────────────

function toSkillRegistry(row: {
  id: string
  name: string
  description: string
  icon_url: string | null
  api_base_url: string
  enabled: number
  type: string
  local_path: string | null
  last_sync_at: string | null
  created_at: string
  updated_at: string
}): SkillRegistry {
  const registry: SkillRegistry = {
    id: row.id,
    name: row.name,
    description: row.description,
    apiBaseUrl: row.api_base_url,
    enabled: row.enabled === 1,
    type: row.type as 'remote' | 'local',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.icon_url !== null) registry.iconUrl = row.icon_url
  if (row.local_path !== null) registry.localPath = row.local_path
  if (row.last_sync_at !== null) registry.lastSyncAt = row.last_sync_at
  return registry
}

function toSkillItem(row: {
  id: string
  scope: string
  name: string
  version: string
  root_path: string
  manifest_json: string
  enabled: number
  created_at: string
  updated_at: string
}): SkillItem {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    version: row.version,
    rootPath: row.root_path,
    manifestJson: row.manifest_json,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed != null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 从市场 manifest 中提取 SKILL.md 正文（不同市场字段不一，做多重兜底） */
function extractSkillBody(
  manifest: Record<string, unknown> | null,
  remoteSkill: RemoteSkillItem,
): string {
  const m = manifest ?? {}
  const candidate =
    (typeof m.content === 'string' && m.content) ||
    (typeof m.systemPrompt === 'string' && m.systemPrompt) ||
    (typeof m.body === 'string' && m.body) ||
    (typeof m.instructions === 'string' && m.instructions) ||
    ''
  const body = candidate.trim()
  if (body.length > 0) return body
  // 实在没有正文时，用描述兜底生成一个最小可用指令
  return remoteSkill.description?.trim() || remoteSkill.name
}

/** 构建带 frontmatter 的 SKILL.md 文本 */
function buildSkillMarkdown(name: string, body: string, remoteSkill: RemoteSkillItem): string {
  // 若 body 本身已是带 frontmatter 的完整 SKILL.md，直接返回
  if (body.startsWith('---')) return body
  const description = (remoteSkill.description ?? '').replace(/\n/g, ' ').trim()
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: "${description.replace(/"/g, "'")}"`,
    `version: ${remoteSkill.version || '0.0.0'}`,
    `author: ${remoteSkill.author || 'Unknown'}`,
    `category: ${remoteSkill.category || 'utility'}`,
    `tags: [${(remoteSkill.tags ?? []).join(', ')}]`,
    '---',
    '',
  ].join('\n')
  return frontmatter + body + '\n'
}

/** 技能名 → 安全目录名 */
function slugifySkillName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// ─── GitHub 安装相关类型与解析 ─────────────────────────────────────────

export interface GithubSkillCandidate {
  repo: string
  name: string
  description: string
  author: string
  stars: number
  homepageUrl: string
  defaultBranch: string
  source: 'GitHub'
}

interface GithubRepoApi {
  full_name: string
  name: string
  description: string | null
  owner?: { login?: string }
  stargazers_count?: number
  html_url: string
  default_branch?: string
}

interface GithubContentApi {
  type: 'file' | 'dir' | string
  path: string
  size?: number
  download_url?: string | null
}

interface GithubFile {
  relPath: string
  downloadUrl: string
}

function stripSkillFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return raw
  return raw.slice(end + 4)
}

function parseSkillFrontmatter(raw: string): {
  name: string
  description: string
  version: string
  author: string
  category: string
  tags: string[]
} {
  const result = {
    name: '',
    description: '',
    version: '',
    author: '',
    category: '',
    tags: [] as string[],
  }
  if (!raw.startsWith('---')) return result
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return result
  const fm = raw.slice(3, end)
  for (const line of fm.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) continue
    const key = match[1]!.toLowerCase()
    const value = match[2]!.trim().replace(/^['"]|['"]$/g, '')
    if (key === 'name') result.name = value
    else if (key === 'description') result.description = value
    else if (key === 'version') result.version = value
    else if (key === 'author') result.author = value
    else if (key === 'category') result.category = value
    else if (key === 'tags') {
      result.tags = value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
    }
  }
  return result
}
