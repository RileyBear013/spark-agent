/**
 * Team Registry IPC（技能 / MCP 推拉，M1/M2）。
 *
 * 从 ipc/index.ts 抽出（该文件超 3000 行红线，不再内联加码）：
 * 团队 Nacos 注册中心的配置管理与技能/MCP 发布、安装、版本、更新通道。
 * 信封资产（工作流/Agent/子应用）见 registerTeamAssetIpc.ts。
 *
 * 服务层抛的是面向用户的业务 Error（如「技能目录内容为空，无法发布」），
 * 但 typed-ipc 公共错误处理只识别 SparkError，普通 Error 会被掩码成
 * 「操作未完成」固定文案。统一经 runTeamRegistryTask 捕获转 SparkError
 * 透传真实消息（对齐 registerProviderFilesIpc.runFilesTask 的做法）。
 */
import { createLogger, SparkError } from '@spark/shared'
import {
  listInstallableTeamVersions,
  TeamRegistryConfigStore,
  TeamRegistryService,
  toVersionInfos,
  type SkillRegistryService,
  type TeamMcpService,
} from '@spark/agent-runtime'

import { getDatabase } from '../db.js'
import { typedIpcHandle } from './typed-ipc.js'

const log = createLogger('team-registry-ipc')

export interface TeamRegistryIpcDeps {
  getTeamRegistryService: () => TeamRegistryService
  getSkillRegistryService: () => SkillRegistryService
  getTeamMcpService: () => TeamMcpService
}

export function registerTeamRegistryIpc(deps: TeamRegistryIpcDeps): void {
  /**
   * team-registry 服务层抛的是面向用户的业务 Error（如「技能目录内容为空，无法发布」），
   * 但 typed-ipc 公共错误处理只识别 SparkError，普通 Error 会被掩码成「操作未完成」固定文案，
   * 真实原因只进主进程日志无从排查。统一捕获转 SparkError 透传真实消息
   * （对齐 registerProviderFilesIpc.runFilesTask 的做法）。
   */
  async function runTeamRegistryTask<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task()
    } catch (err) {
      if (err instanceof SparkError) throw err
      throw new SparkError('UNKNOWN', err instanceof Error ? err.message : String(err))
    }
  }
  // ─── Team Registry Handlers（团队 Nacos 注册中心） ───────────────────

  typedIpcHandle('team-registry:config-get', async () => runTeamRegistryTask(async () => {
    const snapshot = await deps.getTeamRegistryService().getSnapshot()
    return { snapshot }
  }))

  typedIpcHandle('team-registry:config-save', async (req) => runTeamRegistryTask(async () => {
    log.info(
      `team-registry:config-save requested, serverUrl=${req.serverUrl}, namespace=${req.namespace}, username=${req.username}, password=${req.password === undefined ? 'keep' : req.password === '' ? 'clear' : 'updated'}`,
    )
    const store = new TeamRegistryConfigStore(getDatabase())
    const snapshot = await store.save({
      serverUrl: req.serverUrl,
      namespace: req.namespace,
      username: req.username,
      ...(req.password !== undefined ? { password: req.password } : {}),
    })
    // 配置变化同步技能市场源行 + 重建 team adapter
    deps.getSkillRegistryService().ensureTeamRegistryRow(snapshot.serverUrl)
    deps.getSkillRegistryService().refreshTeamRegistry()
    const healthCheck = await store.testSavedConnection()
    return { snapshot, healthCheck }
  }))

  typedIpcHandle('team-registry:test-connection', async (req) => runTeamRegistryTask(async () => {
    log.info(
      `team-registry:test-connection requested, serverUrl=${req.serverUrl}, namespace=${req.namespace}`,
    )
    const store = new TeamRegistryConfigStore(getDatabase())
    const health = await store.testConnectionWith({
      serverUrl: req.serverUrl,
      namespace: req.namespace,
      username: req.username,
      password: req.password,
    })
    return { health }
  }))

  typedIpcHandle('team-registry:publish-skill', async (req) => runTeamRegistryTask(async () => {
    log.info(
      `team-registry:publish-skill requested, localSkillId=${req.localSkillId}, version=${req.version ?? 'auto-bump'}`,
    )
    const result = await deps.getSkillRegistryService().publishToTeam(req.localSkillId, {
      ...(req.version !== undefined ? { version: req.version } : {}),
    })
    return {
      slug: result.slug,
      version: result.version,
      skillName: result.skillName,
      fileCount: result.fileCount,
      checksum: result.checksum,
      previousRemoteVersion: result.previousRemoteVersion,
      warnings: result.warnings,
      skipped: result.skipped.map((item) => ({ path: item.path, reason: item.reason })),
    }
  }))

  typedIpcHandle('team-registry:install-skill', async (req) => runTeamRegistryTask(async () => {
    log.info(`team-registry:install-skill requested, slug=${req.slug}, version=${req.version ?? 'latest'}`)
    const skill = await deps.getSkillRegistryService().installFromTeam(req.slug, {
      ...(req.version !== undefined ? { version: req.version } : {}),
    })
    return { skill }
  }))

  typedIpcHandle('team-registry:list-updates', async () => runTeamRegistryTask(async () => {
    const updates = await deps.getSkillRegistryService().listTeamUpdates()
    return { updates }
  }))
  typedIpcHandle('team-registry:list-skill-versions', async (req) => runTeamRegistryTask(async () => {
    const client = await deps.getTeamRegistryService().client()
    if (!client) return { versions: [] }
    const detail = await client.getTeamSkill(req.slug)
    return { versions: listInstallableTeamVersions(toVersionInfos(detail?.versions ?? [])).map((v) => ({ ...v, author: null })) }
  }))

  typedIpcHandle('team-registry:list-mcp', async (req) => runTeamRegistryTask(async () => {
    const { items, total } = await deps.getTeamMcpService().listTeamServers({
      ...(req.page !== undefined ? { page: req.page } : {}),
      ...(req.pageSize !== undefined ? { pageSize: req.pageSize } : {}),
      ...(req.query !== undefined ? { query: req.query } : {}),
    })
    return { servers: items, total }
  }))

  typedIpcHandle('team-registry:publish-mcp', async (req) => runTeamRegistryTask(async () => {
    log.info(
      `team-registry:publish-mcp requested, mcpServerId=${req.mcpServerId}, version=${req.version ?? 'auto-bump'}`,
    )
    const result = await deps.getTeamMcpService().publishToTeam(req.mcpServerId, {
      ...(req.version !== undefined ? { version: req.version } : {}),
    })
    return {
      slug: result.slug,
      version: result.version,
      sensitiveKeys: result.sensitiveKeys,
      previousRemoteVersion: result.previousRemoteVersion,
    }
  }))

  typedIpcHandle('team-registry:install-mcp', async (req) => runTeamRegistryTask(async () => {
    log.info(`team-registry:install-mcp requested, slug=${req.slug}, version=${req.version ?? 'latest'}`)
    const result = await deps.getTeamMcpService().installFromTeam(req.slug, {
      ...(req.version !== undefined ? { version: req.version } : {}),
    })
    return result
  }))

  typedIpcHandle('team-registry:list-mcp-updates', async () => runTeamRegistryTask(async () => {
    const updates = await deps.getTeamMcpService().listTeamUpdates()
    return { updates }
  }))
  typedIpcHandle('team-registry:list-mcp-versions', async (req) => runTeamRegistryTask(async () => {
    const client = await deps.getTeamRegistryService().client()
    if (!client) return { versions: [] }
    const detail = await client.getTeamMcpServer(req.slug)
    return { versions: detail ? listInstallableTeamVersions(detail.versions).map((v) => ({ ...v, author: null })) : [] }
  }))

  typedIpcHandle('team-registry:config-history', async (req) => runTeamRegistryTask(async () => {
    log.info(`team-registry:config-history requested, slug=${req.slug}`)
    const client = await deps.getTeamRegistryService().client()
    if (!client) return { history: [] }
    const raw = await client.listConfigHistory(`skill:${req.slug}`)
    return {
      history: raw.map((item) => ({
        ...(item.modifyTimestamp !== undefined ? { modifiedAt: item.modifyTimestamp } : {}),
        ...(item.md5 !== undefined ? { md5: item.md5 } : {}),
      })),
    }
  }))
}
