/**
 * 真机集成探针（默认跳过）——TeamAssetService 资产（workflow/agent/app）
 * AgentSpec 原生承载全链路
 *
 * 运行方式（测试环境专用，探针数据用后即删）：
 *   TEAM_REGISTRY_LIVE=1 npx vitest run src/services/team-registry/asset-service-live.test.ts
 *
 * 验证：中文 slug 回退 → 发布（原生 zip 上传 + 生命周期 + PUBLIC）→ 回读校验 →
 * 版本防回退 → patch+1 → 第二「机器」安装/更新 → 六态比对 → 清理。
 * 端口与 pins 用内存桩（探针验证传输与服务编排，SQLite 归单测覆盖）。
 */
import { describe, expect, it } from 'vitest'

import {
  TeamAssetService,
  slugifyAssetName,
  type TeamAssetPort,
  type TeamAssetBuildResult,
} from './asset-service.js'
import { agentSpecNameFor, envelopeFromAgentSpecVersion } from './agentspec.js'
import { TeamMcpService, listInstallableTeamVersions } from './index.js'
import { NacosClient } from './nacos-client.js'
import { TeamRegistryConfigStore } from './team-registry-config.js'
import type { McpServerRepository, TeamAssetPinsRepository } from '@spark/storage'
import { computePayloadChecksum, type TeamAssetEnvelope } from './types.js'

const LIVE = process.env.TEAM_REGISTRY_LIVE === '1'
const URL_ = process.env.TEAM_REGISTRY_URL ?? 'http://192.168.163.174:8080'
const USER = process.env.TEAM_REGISTRY_USER ?? 'nacos'
const PASS = process.env.TEAM_REGISTRY_PASS ?? 'nacos'

const WF_NAME = '团队探针工作流'
const AGENT_NAME = '团队探针Agent'
const APP_NAME = '团队探针应用'

/** 内存实体仓库端口（可造多「机器」实例模拟推拉两端） */
function makePort(seed: Array<{ id: string; name: string; content: Record<string, unknown> }>) {
  const items = new Map(seed.map((s) => [s.id, { ...s }]))
  const port: TeamAssetPort = {
    async buildPayload(localId) {
      const item = items.get(localId)
      if (!item) return null
      const payload: TeamAssetBuildResult['payload'] =
        item.content.kind === 'workflow'
          ? { kind: 'workflow', graph: item.content.graph as Record<string, unknown> }
          : item.content.kind === 'agent-config'
            ? { kind: 'agent-config', config: item.content.config as Record<string, unknown> }
            : {
                kind: 'app-release',
                files: [{ path: 'index.html', content: item.content.source as string }],
                entry: 'index.html',
              }
      return { name: item.name, description: 'live probe', payload }
    },
    findInstalledLocalId(slug) {
      for (const item of items.values()) {
        if (slugifyAssetName(item.name, 'wf') === slug) return item.id
      }
      return null
    },
    async installFromPayload(envelope: TeamAssetEnvelope, existingLocalId: string | null) {
      const content =
        envelope.payload.kind === 'workflow'
          ? { kind: 'workflow', graph: envelope.payload.graph }
          : envelope.payload.kind === 'agent-config'
            ? { kind: 'agent-config', config: envelope.payload.config }
            : { kind: 'app', source: 'installed' }
      if (existingLocalId != null) {
        const item = items.get(existingLocalId)
        if (item) item.content = content
        return { localId: existingLocalId, updatedExisting: true }
      }
      const id = `installed-${items.size + 1}`
      items.set(id, { id, name: envelope.name, content })
      return { localId: id, updatedExisting: false }
    },
  }
  return { port, items }
}

function makePinsStub() {
  const rows = new Map<string, Record<string, string | null>>()
  return {
    upsert(assetType: string, slug: string, fields: Record<string, string | null>) {
      const prev = rows.get(`${assetType}:${slug}`) ?? {}
      rows.set(`${assetType}:${slug}`, { ...prev, ...fields })
    },
    listByType: (assetType: string) => {
      const out: Array<{ slug: string; installed_version: string | null; installed_checksum: string | null }> = []
      for (const [key, val] of rows) {
        if (key.startsWith(`${assetType}:`)) {
          out.push({
            slug: key.slice(assetType.length + 1),
            installed_version: val.installedVersion ?? null,
            installed_checksum: val.installedChecksum ?? null,
          })
        }
      }
      return out
    },
  } as unknown as TeamAssetPinsRepository
}

describe.skipIf(!LIVE)('TeamAssetService 真机探针（TEAM_REGISTRY_LIVE=1）', () => {
  const client = new NacosClient({ serverUrl: URL_, namespace: 'public', username: USER, password: PASS })
  const configStore = {
    buildClient: async () => client,
    getSnapshot: async () => ({
      configured: true,
      serverUrl: URL_,
      namespace: 'public',
      username: USER,
      hasPassword: true,
    }),
    readNamespace: () => 'public',
  } as unknown as TeamRegistryConfigStore

  const probeSlugs = [
    ['workflow', slugifyAssetName(WF_NAME, 'wf')],
    ['agent', slugifyAssetName(AGENT_NAME, 'agent')],
    ['app', slugifyAssetName(APP_NAME, 'app')],
  ] as const

  async function cleanup(): Promise<void> {
    for (const [type, slug] of probeSlugs) {
      await client.deleteTeamAgentSpec(agentSpecNameFor(type, slug)).catch(() => {})
    }
  }

  it('三类资产 AgentSpec 承载：发布 → 回读 → 防回退 → 安装/更新 → 六态 → 清理', async () => {
    await cleanup()
    try {
      const health = await client.testRoundTrip()
      expect(health.healthy, health.error).toBe(true)

      const wf = makePort([{ id: 'w1', name: WF_NAME, content: { kind: 'workflow', graph: { nodes: [{ id: 'n1' }], edges: [] } } }])
      const wfOther = makePort([]) // 模拟另一台机器
      const agent = makePort([{ id: 'a1', name: AGENT_NAME, content: { kind: 'agent-config', config: { prompt: 'probe' } } }])
      const app = makePort([{ id: 'p1', name: APP_NAME, content: { kind: 'app', source: '<html>probe</html>' } }])
      const pins = makePinsStub()
      const service = new TeamAssetService(
        configStore,
        { workflow: wf.port, agent: agent.port, app: app.port },
        pins,
      )

      // ── 发布三类 ──
      const wfPub = await service.publishToTeam('workflow', 'w1')
      expect(wfPub.version).toBe('0.0.1')
      expect(wfPub.slug, '中文 slug 回退').toMatch(/^wf-[0-9a-f]{8}$/)
      const agentPub = await service.publishToTeam('agent', 'a1')
      const appPub = await service.publishToTeam('app', 'p1')
      expect(Array.isArray(agentPub.warnings)).toBe(true)

      // ── 远端回读：原生条目 scope=PUBLIC + 信封 checksum ──
      for (const [type, slug, pub] of [
        ['workflow', wfPub.slug, wfPub],
        ['agent', agentPub.slug, agentPub],
        ['app', appPub.slug, appPub],
      ] as const) {
        const name = agentSpecNameFor(type, slug)
        const detail = await client.getTeamAgentSpec(name)
        expect(detail, `${name} 应在原生 AgentSpec 列表可见`).toBeTruthy()
        expect(detail!.scope, `${name} 应为 PUBLIC`).toBe('PUBLIC')
        const vDetail = await client.getTeamAgentSpecVersion(name, pub.version)
        expect(vDetail, `${name}@${pub.version} 版本详情可读`).toBeTruthy()
        const env = envelopeFromAgentSpecVersion(vDetail!, type)
        expect(env?.payload.kind).toBeTruthy()
        expect(env!.checksum).toBe(computePayloadChecksum(env!.payload))
      }

      // ── 浏览列表可见 ──
      const list = await service.listTeamAssets('workflow')
      expect(list.map((i) => i.slug)).toContain(wfPub.slug)

      // ── 版本语义：指定版本不生效（服务端自分配 0.0.N 递增），发布自动 +1 ──
      const explicit = await service.publishToTeam('workflow', 'w1', { version: '0.9.0' })
      expect(explicit.version).toBe('0.0.2')
      expect(explicit.warnings.some((w) => w.includes('不生效'))).toBe(true)
      const bump = await service.publishToTeam('workflow', 'w1')
      expect(bump.version).toBe('0.0.3')

      // ── 另一台机器（独立 service + 独立 pins）安装 → 更新 ──
      const serviceOther = new TeamAssetService(
        configStore,
        { workflow: wfOther.port, agent: agent.port, app: app.port },
        makePinsStub(),
      )
      const install1 = await serviceOther.installFromTeam('workflow', wfPub.slug)
      expect(wfOther.items.size).toBe(1)
      expect(install1.updatedExisting).toBe(false)
      const install2 = await serviceOther.installFromTeam('workflow', wfPub.slug)
      expect(install2.updatedExisting).toBe(true)
      expect(install2.localId).toBe(install1.localId)

      // ── 六态（升版前内容一致 → up-to-date；升版后 → remote-newer；本地改 → local-modified）──
      const updates0 = await serviceOther.listTeamUpdates('workflow')
      expect(updates0.find((u) => u.slug === wfPub.slug)?.state).toBe('up-to-date')
      const publisher = [...wf.items.values()].find((i) => i.id === 'w1')
      if (publisher && publisher.content.kind === 'workflow') {
        publisher.content = { kind: 'workflow', graph: { nodes: [{ id: 'v2-node' }], edges: [] } }
      }
      await service.publishToTeam('workflow', 'w1')
      const updates1 = await serviceOther.listTeamUpdates('workflow')
      expect(updates1.find((u) => u.slug === wfPub.slug)?.state).toBe('remote-newer')
      const item = [...wfOther.items.values()][0]
      if (item && item.content.kind === 'workflow') {
        item.content = { kind: 'workflow', graph: { nodes: [{ id: 'local-edit' }], edges: [] } }
      }
      const updates2 = await serviceOther.listTeamUpdates('workflow')
      expect(updates2.find((u) => u.slug === wfPub.slug)?.state).toBe('local-modified')

      // ── 版本化安装/回滚（此时远端 0.0.4 内容与 0.0.1 不同，规则 2 不误判）──
      const installOld = await serviceOther.installFromTeam('workflow', wfPub.slug, {
        version: '0.0.1',
      })
      expect(installOld.version).toBe('0.0.1')
      expect(installOld.updatedExisting).toBe(true)
      const updatesRolled = await serviceOther.listTeamUpdates('workflow')
      expect(updatesRolled.find((u) => u.slug === wfPub.slug)?.state).toBe('remote-newer')
      await expect(
        serviceOther.installFromTeam('workflow', wfPub.slug, { version: '9.9.9' }),
      ).rejects.toThrow(/不存在可安装的版本/)
      const versions = await serviceOther.listTeamAssetVersions('workflow', wfPub.slug)
      expect(versions.map((v) => v.version)).toEqual(['0.0.4', '0.0.3', '0.0.2', '0.0.1'])
      await serviceOther.installFromTeam('workflow', wfPub.slug) // 重装最新
      const updatesRestored = await serviceOther.listTeamUpdates('workflow')
      expect(updatesRestored.find((u) => u.slug === wfPub.slug)?.state).toBe('up-to-date')

      // ── 三类都在远端可见 ──
      expect((await service.listTeamAssets('agent')).map((i) => i.slug)).toContain(agentPub.slug)
      expect((await service.listTeamAssets('app')).map((i) => i.slug)).toContain(appPub.slug)
    } finally {
      await cleanup()
      // 注册中心还原为空校验（原生 AgentSpec 维度）
      const items = await client.listTeamAgentSpecs()
      const ours = probeSlugs.map(([type, slug]) => agentSpecNameFor(type, slug))
      expect(items.filter((i) => ours.includes(String(i.name))).map((i) => i.name)).toEqual([])
    }
  })

  it('MCP 版本化安装：发布两版 → 版本列表 → 指定 0.0.1 安装（回滚语义）→ 清理', async () => {
    const slug = 'probe-mcp-versions'
    try {
      const health = await client.testRoundTrip()
      expect(health.healthy, health.error).toBe(true)
      await client.deleteTeamMcpServer(slug).catch(() => {})

      const rows: Array<Record<string, unknown>> = []
      let seq = 0
      const repoStub = {
        get: (id: string) => rows.find((r) => r.id === id) ?? null,
        listAll: () => rows,
        update: (id: string, patch: Record<string, unknown>) => {
          const row = rows.find((r) => r.id === id)
          if (row) Object.assign(row, patch)
          return row ?? null
        },
        create: (fields: Record<string, unknown>) => {
          const row = { id: `row-${++seq}`, ...fields }
          rows.push(row)
          return row
        },
      } as unknown as McpServerRepository
      const pins = makePinsStub()
      const mcpService = new TeamMcpService(configStore, repoStub, pins)
      const row = repoStub.create({
        scope: 'user',
        name: slug,
        config_json: '{"command":"echo","args":["probe"],"env":{}}',
        enabled: false,
      })

      const pub1 = await mcpService.publishToTeam(String(row.id), { version: '0.0.1' })
      expect(pub1.version).toBe('0.0.1')
      const pub2 = await mcpService.publishToTeam(String(row.id), { version: '0.0.2' })
      expect(pub2.version).toBe('0.0.2')

      // 版本列表（已发布终态、semver 降序）
      const detail = await client.getTeamMcpServer(slug)
      expect(detail, 'MCP 详情可读').toBeTruthy()
      expect(listInstallableTeamVersions(detail!.versions).map((v) => v.version)).toEqual([
        '0.0.2',
        '0.0.1',
      ])

      // 版本级详情端点（真机路由核实；顶层详情恒为最新发布）
      const versionRaw = await client.getTeamMcpVersion(slug, '0.0.1')
      expect(versionRaw, 'MCP 版本详情应可读').toBeTruthy()

      // 指定 0.0.1 安装（回滚）→ pins 记 0.0.1；非法版本拒绝
      const install = await mcpService.installFromTeam(slug, { version: '0.0.1' })
      expect(install.version).toBe('0.0.1')
      expect(pins.listByType('mcp')[0]?.installed_version).toBe('0.0.1')
      await expect(mcpService.installFromTeam(slug, { version: '9.9.9' })).rejects.toThrow(
        /不存在可安装的版本/,
      )
    } finally {
      await client.deleteTeamMcpServer(slug).catch(() => {})
    }
  })
})
