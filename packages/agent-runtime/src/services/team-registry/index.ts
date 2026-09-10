/**
 * @module team-registry/service
 *
 * TeamRegistryService — 团队 Nacos 注册中心的配置与资产信封运输层
 *
 * 职责边界：
 *   - 配置 CRUD / 连接测试（TeamRegistryConfigStore）
 *   - 信封在配置中心的读写（dataId = `<assetType>/<slug>`，group = SPARK_TEAM）
 *   - 本地技能目录 → 信封文件树的收集与校验（发布前置）
 * 技能的落盘安装/DB 记录/pins 锚点归 SkillRegistryService（installFromTeam /
 * publishToTeam / listTeamUpdates），本服务不碰 skills 表。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { NacosClient } from './nacos-client.js'
import { TeamRegistryConfigStore } from './team-registry-config.js'
import {
  TEAM_ASSET_LIMITS,
  computeSkillFilesChecksum,
  parseTeamAssetEnvelope,
  type TeamAssetEnvelope,
  type TeamSkillFile,
} from './types.js'

export { NacosClient, TEAM_NACOS_GROUP } from './nacos-client.js'
export { TeamRegistryConfigStore } from './team-registry-config.js'
export type { TeamRegistryConfigInput, TeamRegistryConfigSnapshot } from './team-registry-config.js'
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

  /**
   * 发布信封到配置中心；并 best-effort 同步一条 AI Skill 元数据条目
   * （供其他消费 Nacos AI 注册中心的系统发现）。AI 写入失败仅 console.warn，
   * 不阻断——配置中心信封才是权威数据源。
   */
  async publishEnvelope(envelope: TeamAssetEnvelope): Promise<{ dataId: string }> {
    const serialized = JSON.stringify(envelope)
    if (serialized.length > TEAM_ASSET_LIMITS.maxEnvelopeBytes) {
      throw new Error(
        `信封序列化后 ${serialized.length} 字节，超过上限 ${TEAM_ASSET_LIMITS.maxEnvelopeBytes}；请精简技能文件`,
      )
    }
    const client = await this.requireClient()
    const dataId = TeamRegistryService.dataIdFor(envelope.assetType, envelope.slug)
    await client.publishConfig({ dataId, content: serialized, type: 'JSON' })
    if (envelope.assetType === 'skill') {
      try {
        await this.upsertAiSkillMetadata(client, envelope)
      } catch (err) {
        console.warn(
          `[team-registry] AI Skill 元数据写入失败（不影响信封发布）：${
            err instanceof Error ? err.message : err
          }`,
        )
      }
    }
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

  /**
   * AI Skill 元数据条目（发现层）。字段结构按 v3 控制台惯例拼装，
   * 服务端校验失败会抛 NacosClientError，由调用方降级。
   */
  private async upsertAiSkillMetadata(
    client: NacosClient,
    envelope: TeamAssetEnvelope,
  ): Promise<void> {
    const payload = envelope.payload as { files?: TeamSkillFile[] }
    const skillMd = payload.files?.find((f) => f.path === 'SKILL.md')?.content ?? ''
    await client.publishAiSkill({
      skillName: envelope.slug,
      version: envelope.version,
      name: envelope.name,
      description: envelope.description || envelope.name,
      author: envelope.author,
      skillMd: skillMd.slice(0, 20000),
    })
  }

  /** 本地技能文件树 checksum（供 SkillRegistryService 做 local-modified 判定） */
  static checksumForFiles(files: TeamSkillFile[]): string {
    return computeSkillFilesChecksum(files)
  }
}
