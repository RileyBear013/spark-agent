/**
 * @module skill-registry/nacos-team-adapter
 *
 * 团队源 Adapter — 把团队 Nacos 注册中心的原生 AI Skill 接入 Skill 市场统一接口
 *
 * M1.5 起拉侧完全走原生 API：列表 = /ai/skills/list，详情 = /ai/skills，
 * 包体 = /ai/skills/version/download（zip）。配置中心信封不再是技能数据源。
 *
 * 拉侧只读；安装/更新的实际落盘走 SkillRegistryService.installFromTeam
 * （zip 解包保真 + checksum 校验 + pins 锚点），通用 install() 对 team 源
 * 也会委托到 installFromTeam。
 *
 * 未配置团队注册中心时：healthCheck 返回 unhealthy（带提示），search/featured
 * 返回空列表——不抛错，保证「配置好之前不可用但不报错」。
 */

import type { RemoteSkillItem, SkillHubShowcaseSection } from '@spark/protocol'
import type { SkillRegistryAdapter } from './adapter.js'
import { createRemoteSkillItem } from './adapter.js'
import type { TeamRegistryService, TeamSkillDetail } from '../team-registry/index.js'
import { pickLatestTeamVersion } from '../team-registry/index.js'

export const TEAM_REGISTRY_ID = 'team'

/** team 源的 manifestUrl 协议（仅作寻址标识） */
export function teamManifestUrl(slug: string): string {
  return `team://skill/${slug}`
}

export function slugFromTeamManifestUrl(url: string): string | null {
  const m = /^team:\/\/skill\/([^/?#]+)$/.exec(url)
  return m ? m[1]! : null
}

interface TeamSkillListItemView {
  slug: string
  name: string
  description: string
  version: string
  scope: string
}

export class NacosTeamAdapter implements SkillRegistryAdapter {
  readonly registryId = TEAM_REGISTRY_ID
  readonly registryName = '团队源'

  constructor(private readonly teamRegistry: TeamRegistryService) {}

  async search(
    query: string,
    options?: { category?: string; limit?: number; offset?: number },
  ): Promise<{ skills: RemoteSkillItem[]; total: number }> {
    const items = await this.safeListItems()
    const q = query.trim().toLowerCase()
    const matched = q ? items.filter((it) => this.matchesQuery(it, q)) : items
    const total = matched.length
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? 20
    const page = matched.slice(offset, offset + limit)
    // 详情补全（描述等列表字段缺失时）；单条失败不拖垮整页
    const hydrated = await Promise.all(page.map((it) => this.hydrate(it)))
    return { skills: hydrated.map((it) => this.toRemoteSkillItem(it)), total }
  }

  async featured(
    limit?: number,
    _section?: SkillHubShowcaseSection,
    _category?: string,
  ): Promise<RemoteSkillItem[]> {
    const items = await this.safeListItems()
    const page = items.slice(0, limit ?? 12)
    const hydrated = await Promise.all(page.map((it) => this.hydrate(it)))
    return hydrated.map((it) => this.toRemoteSkillItem(it))
  }

  async categories(): Promise<Array<{ key: string; name: string }>> {
    return [{ key: 'all', name: '全部' }]
  }

  /**
   * 返回 JSON 字符串形态的 manifest（与其它市场的 manifest 语义对齐）。
   * body 取最新已发布版本 zip 里的 SKILL.md 正文，保证通用安装路径至少可用
   * （team 源的标准安装走 installFromTeam 多文件保真路径）。
   */
  async fetchManifest(manifestUrl: string): Promise<string> {
    const slug = slugFromTeamManifestUrl(manifestUrl)
    if (!slug) throw new Error(`无法解析的 team manifestUrl：${manifestUrl}`)
    const manifest = await this.buildManifestFromZip(slug)
    return JSON.stringify(manifest)
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs?: number; error?: string }> {
    const client = await this.teamRegistry.client()
    if (!client) {
      return {
        healthy: false,
        error: '团队注册中心未配置（设置 → 团队注册中心）',
      }
    }
    const result = await client.testRoundTrip()
    if (!result.healthy && result.error) return result
    return result
  }

  // ─── 内部 ───────────────────────────────────────────────────────────

  /** 未配置/网络失败时返回空列表并 console.warn（搜索聚合路径不能被单源拖死） */
  private async safeListItems(): Promise<TeamSkillListItemView[]> {
    const client = await this.teamRegistry.client()
    if (!client) return []
    try {
      const raw = (await client.listTeamSkills()).items
      return raw
        .map((item) => {
          const slug = pickStr(item, ['skillName', 'name'])
          if (!slug) return null
          return {
            slug,
            name: pickStr(item, ['displayName', 'name']) ?? slug,
            description: pickStr(item, ['description']) ?? '',
            version: pickStr(item, ['version', 'latestVersion']) ?? '',
            scope: pickStr(item, ['scope']) ?? 'PRIVATE',
          }
        })
        .filter((x): x is TeamSkillListItemView => x != null)
    } catch (err) {
      console.warn(
        `[team-registry] 拉取团队技能列表失败：${err instanceof Error ? err.message : err}`,
      )
      return []
    }
  }

  /** 列表字段缺失时用详情补全（单条失败保留列表值） */
  private async hydrate(item: TeamSkillListItemView): Promise<TeamSkillListItemView> {
    if (item.description) return item
    try {
      const client = await this.teamRegistry.client()
      if (!client) return item
      const detail = await client.getTeamSkill(item.slug)
      if (!detail) return item
      return {
        ...item,
        name: item.name !== item.slug ? item.name : detail.name || item.name,
        description: detail.description || item.description,
        version: item.version || pickLatestTeamVersion(detail.versions) || '',
      }
    } catch {
      return item
    }
  }

  private matchesQuery(item: TeamSkillListItemView, q: string): boolean {
    return (
      item.slug.toLowerCase().includes(q) ||
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q)
    )
  }

  private toRemoteSkillItem(item: TeamSkillListItemView): RemoteSkillItem {
    return createRemoteSkillItem({
      id: `${TEAM_REGISTRY_ID}:${item.slug}`,
      name: item.name,
      description: item.description || item.name,
      version: item.version,
      author: 'team',
      registryId: TEAM_REGISTRY_ID,
      registryName: this.registryName,
      category: 'team',
      tags: [],
      rating: 4.5,
      downloadCount: 0,
      manifestUrl: teamManifestUrl(item.slug),
    })
  }

  /** 下载最新已发布版本 zip 并抽出 SKILL.md 组 manifest（详情弹窗/通用安装路径用） */
  private async buildManifestFromZip(slug: string): Promise<{
    name: string
    description: string
    version: string
    author: string
    content: string
    source: string
    category: string
  }> {
    const client = await this.teamRegistry.client()
    if (!client) throw new Error('团队注册中心未配置')
    const detail = await client.getTeamSkill(slug)
    if (!detail) throw new Error(`团队源中不存在技能：${slug}`)
    const version = pickLatestTeamVersion(detail.versions)
    if (!version) throw new Error(`技能 ${slug} 没有可用版本`)
    const zip = await client.downloadTeamSkillVersion(slug, version)
    const { readZip, stripZipCommonRoot } = await import('../team-registry/zip.js')
    const entries = stripZipCommonRoot(readZip(zip))
    const skillMd = entries.find((e) => e.path === 'SKILL.md')?.content.toString('utf-8') ?? ''
    const body = skillMd.startsWith('---') ? stripFrontmatter(skillMd) : skillMd
    const meta = parseFrontmatter(skillMd)
    return {
      name: meta.name || detail.name || slug,
      description: meta.description || detail.description,
      version: meta.version || version,
      author: meta.author || 'team',
      content: body,
      source: `Team:${slug}`,
      category: 'team',
    }
  }
}

/** 从 zip 内 SKILL.md 提取 frontmatter 元数据（列表卡片展示用） */
function parseFrontmatter(skillMd: string): {
  name: string
  description: string
  version: string
  author: string
} {
  const result = { name: '', description: '', version: '', author: '' }
  if (!skillMd.startsWith('---')) return result
  const end = skillMd.indexOf('\n---', 3)
  if (end === -1) return result
  for (const line of skillMd.slice(3, end).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    const value = m[2]!.trim().replace(/^['"]|['"]$/g, '')
    if (key === 'name') result.name = value
    else if (key === 'description') result.description = value
    else if (key === 'version') result.version = value
    else if (key === 'author') result.author = value
  }
  return result
}

function stripFrontmatter(raw: string): string {
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return raw
  return raw.slice(end + 4)
}

function pickStr(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = record[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}
