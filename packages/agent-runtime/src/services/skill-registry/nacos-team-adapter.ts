/**
 * @module skill-registry/nacos-team-adapter
 *
 * 团队源 Adapter — 把团队 Nacos 注册中心的技能信封接入 Skill 市场统一接口
 *
 * 拉侧只读；安装/更新的实际落盘走 SkillRegistryService.installFromTeam
 * （多文件保真 + checksum 校验 + pins 锚点），通用 install() 对 team 源
 * 也会委托到 installFromTeam。
 *
 * 未配置团队注册中心时：healthCheck 返回 unhealthy（带提示），search/featured
 * 返回空列表——不抛错，保证「配置好之前不可用但不报错」。
 */

import type { RemoteSkillItem, SkillHubShowcaseSection } from '@spark/protocol'
import type { SkillRegistryAdapter } from './adapter.js'
import { createRemoteSkillItem } from './adapter.js'
import type { TeamRegistryService, TeamAssetEnvelope } from '../team-registry/index.js'

export const TEAM_REGISTRY_ID = 'team'

/** team 源的 manifestUrl 协议（仅作寻址标识） */
export function teamManifestUrl(slug: string): string {
  return `team://skill/${slug}`
}

export function slugFromTeamManifestUrl(url: string): string | null {
  const m = /^team:\/\/skill\/([^/?#]+)$/.exec(url)
  return m ? m[1]! : null
}

export class NacosTeamAdapter implements SkillRegistryAdapter {
  readonly registryId = TEAM_REGISTRY_ID
  readonly registryName = '团队源'

  constructor(private readonly teamRegistry: TeamRegistryService) {}

  async search(
    query: string,
    options?: { category?: string; limit?: number; offset?: number },
  ): Promise<{ skills: RemoteSkillItem[]; total: number }> {
    const envelopes = await this.safeListEnvelopes()
    const q = query.trim().toLowerCase()
    const matched = q
      ? envelopes.filter((env) => this.matchesQuery(env, q))
      : envelopes
    const total = matched.length
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? 20
    return {
      skills: matched.slice(offset, offset + limit).map((env) => this.toRemoteSkillItem(env)),
      total,
    }
  }

  async featured(
    limit?: number,
    _section?: SkillHubShowcaseSection,
    _category?: string,
  ): Promise<RemoteSkillItem[]> {
    const envelopes = await this.safeListEnvelopes()
    const sorted = [...envelopes].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    return sorted.slice(0, limit ?? 12).map((env) => this.toRemoteSkillItem(env))
  }

  async categories(): Promise<Array<{ key: string; name: string }>> {
    return [{ key: 'all', name: '全部' }]
  }

  /**
   * 返回 JSON 字符串形态的 manifest（与其它市场的 manifest 语义对齐）。
   * body 取信封 payload 里的 SKILL.md 正文，保证通用安装路径至少可用
   * （虽然 team 源的标准安装走 installFromTeam 多文件路径）。
   */
  async fetchManifest(manifestUrl: string): Promise<string> {
    const slug = slugFromTeamManifestUrl(manifestUrl)
    if (!slug) throw new Error(`无法解析的 team manifestUrl：${manifestUrl}`)
    const envelope = await this.teamRegistry.getEnvelope('skill', slug)
    if (!envelope) throw new Error(`团队源中不存在技能：${slug}`)
    return JSON.stringify(this.envelopeToManifest(envelope))
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
  private async safeListEnvelopes(): Promise<TeamAssetEnvelope[]> {
    const client = await this.teamRegistry.client()
    if (!client) return []
    try {
      return await this.teamRegistry.listEnvelopes('skill')
    } catch (err) {
      console.warn(
        `[team-registry] 拉取团队技能列表失败：${err instanceof Error ? err.message : err}`,
      )
      return []
    }
  }

  private matchesQuery(env: TeamAssetEnvelope, q: string): boolean {
    return (
      env.slug.toLowerCase().includes(q) ||
      env.name.toLowerCase().includes(q) ||
      env.description.toLowerCase().includes(q)
    )
  }

  private toRemoteSkillItem(env: TeamAssetEnvelope): RemoteSkillItem {
    const meta = extractFrontmatterMeta(env)
    return createRemoteSkillItem({
      id: `${TEAM_REGISTRY_ID}:${env.slug}`,
      name: env.name,
      description: env.description || meta.description,
      version: env.version,
      author: env.author || meta.author || 'team',
      registryId: TEAM_REGISTRY_ID,
      registryName: this.registryName,
      category: meta.category || 'team',
      tags: meta.tags,
      rating: 4.5,
      downloadCount: 0,
      manifestUrl: teamManifestUrl(env.slug),
    })
  }

  private envelopeToManifest(env: TeamAssetEnvelope): Record<string, unknown> {
    const payload = env.payload as { files?: Array<{ path: string; content: string }> }
    const skillMd = payload.files?.find((f) => f.path === 'SKILL.md')?.content ?? ''
    const body = skillMd.startsWith('---') ? stripFrontmatter(skillMd) : skillMd
    return {
      name: env.name,
      description: env.description,
      version: env.version,
      author: env.author,
      content: body,
      source: `Team:${env.slug}`,
      category: 'team',
    }
  }
}

/** 从信封 payload 的 SKILL.md 提取 frontmatter 元数据（列表卡片展示用） */
function extractFrontmatterMeta(env: TeamAssetEnvelope): {
  description: string
  author: string
  category: string
  tags: string[]
} {
  const payload = env.payload as { files?: Array<{ path: string; content: string }> }
  const skillMd = payload.files?.find((f) => f.path === 'SKILL.md')?.content ?? ''
  const result = { description: '', author: '', category: '', tags: [] as string[] }
  if (!skillMd.startsWith('---')) return result
  const end = skillMd.indexOf('\n---', 3)
  if (end === -1) return result
  for (const line of skillMd.slice(3, end).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    const value = m[2]!.trim().replace(/^['"]|['"]$/g, '')
    if (key === 'description') result.description = value
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

function stripFrontmatter(raw: string): string {
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return raw
  return raw.slice(end + 4)
}
