/**
 * 真机集成探针（默认跳过）——TeamAssetService 信封资产（workflow/agent/app）全链路
 *
 * 运行方式（测试环境专用，探针数据用后即删）：
 *   TEAM_REGISTRY_LIVE=1 npx vitest run src/services/team-registry/asset-service-live.test.ts
 *
 * 验证：中文 slug 回退 → 发布（信封写配置中心 + checksum）→ 回读校验 →
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
import { NacosClient } from './nacos-client.js'
import { TeamRegistryConfigStore } from './team-registry-config.js'
import type { TeamAssetPinsRepository } from '@spark/storage'
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
    buildPayload(localId) {
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
    installFromPayload(envelope: TeamAssetEnvelope, existingLocalId: string | null) {
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

  async function cleanup(): Promise<void> {
    for (const [type, slug] of [
      ['workflow', slugifyAssetName(WF_NAME, 'wf')],
      ['agent', slugifyAssetName(AGENT_NAME, 'agent')],
      ['app', slugifyAssetName(APP_NAME, 'app')],
    ] as const) {
      await client.deleteConfig(`${type}:${slug}`).catch(() => {})
    }
  }

  it('三类信封资产：发布 → 回读 → 防回退 → 安装/更新 → 六态 → 清理', async () => {
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
      expect(wfPub.version).toBe('1.0.0')
      expect(wfPub.slug, '中文 slug 回退').toMatch(/^wf-[0-9a-f]{8}$/)
      const agentPub = await service.publishToTeam('agent', 'a1')
      const appPub = await service.publishToTeam('app', 'p1')
      expect(Array.isArray(agentPub.warnings)).toBe(true) // warnings 是真实 Agent 端口的提示，stub 为空数组

      // ── 远端回读：信封结构与 checksum ──
      const list = await service.listTeamAssets('workflow')
      expect(list.map((i) => i.slug)).toContain(wfPub.slug)
      const env = await new (await import('./index.js')).TeamRegistryService(configStore).getEnvelope('workflow', wfPub.slug)
      expect(env?.payload.kind).toBe('workflow')
      expect(env?.checksum).toBe(computePayloadChecksum(env?.payload))

      // ── 防回退 + patch+1 ──
      await expect(service.publishToTeam('workflow', 'w1', { version: '0.9.0' })).rejects.toThrow(/不高于远端当前版本/)
      const bump = await service.publishToTeam('workflow', 'w1')
      expect(bump.version).toBe('1.0.1')

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
      await service.publishToTeam('workflow', 'w1', { version: '2.0.0' })
      const updates1 = await serviceOther.listTeamUpdates('workflow')
      expect(updates1.find((u) => u.slug === wfPub.slug)?.state).toBe('remote-newer')
      const item = [...wfOther.items.values()][0]
      if (item && item.content.kind === 'workflow') {
        item.content = { kind: 'workflow', graph: { nodes: [{ id: 'local-edit' }], edges: [] } }
      }
      const updates2 = await serviceOther.listTeamUpdates('workflow')
      expect(updates2.find((u) => u.slug === wfPub.slug)?.state).toBe('local-modified')

      // ── 三类都在远端可见 ──
      expect((await service.listTeamAssets('agent')).map((i) => i.slug)).toContain(agentPub.slug)
      expect((await service.listTeamAssets('app')).map((i) => i.slug)).toContain(appPub.slug)
    } finally {
      await cleanup()
      // 注册中心还原为空校验
      const rest = await client.listConfigs({ dataIdPrefix: '' })
      const ours = [slugifyAssetName(WF_NAME, 'wf'), slugifyAssetName(AGENT_NAME, 'agent'), slugifyAssetName(APP_NAME, 'app')]
      expect(rest.filter((c) => ours.some((slug) => c.dataId.endsWith('/' + slug))).map((c) => c.dataId)).toEqual([])
    }
  })
})
