/**
 * TeamAssetService 聚焦单测：mock 配置存储/NacosClient/pins/端口，
 * 覆盖发布（版本递增/防回退/中文 slug 回退）、安装（校验/锚点）、更新比对六态。
 */
import { describe, it, expect } from 'vitest'

import {
  TeamAssetService,
  slugifyAssetName,
  type TeamAssetPort,
  type TeamAssetBuildResult,
} from './asset-service.js'
import type { TeamRegistryConfigStore } from './team-registry-config.js'
import type { NacosClient } from './nacos-client.js'
import type { TeamAssetPinsRepository, TeamAssetPinRow } from '@spark/storage'
import { computePayloadChecksum, type TeamAssetEnvelope } from './types.js'

// ─── 测试设施 ───────────────────────────────────────────────────────────

/** 内存配置中心：dataId → 信封文本 */
function makeConfigCenter() {
  const store = new Map<string, string>()
  return {
    store,
    client: {
      async listConfigs(opts: { dataIdPrefix?: string }) {
        return [...store.keys()]
          .filter((dataId) => !opts.dataIdPrefix || dataId.startsWith(opts.dataIdPrefix))
          .map((dataId) => ({ dataId }))
      },
      async getConfig(dataId: string) {
        const content = store.get(dataId)
        return content != null ? { content } : null
      },
      async publishConfig(input: { dataId: string; content: string }) {
        store.set(input.dataId, input.content)
        return true
      },
      async deleteConfig(dataId: string) {
        return store.delete(dataId)
      },
    } as unknown as NacosClient,
  }
}

function makeConfigStore(center: ReturnType<typeof makeConfigCenter>, configured = true) {
  return {
    async buildClient() {
      return configured ? center.client : null
    },
    async getSnapshot() {
      return {
        configured,
        serverUrl: configured ? 'http://nacos.test' : '',
        namespace: 'public',
        username: 'tester',
        hasPassword: configured,
      }
    },
    readNamespace: () => 'public',
  } as unknown as TeamRegistryConfigStore
}

function makePinsRepo() {
  const rows = new Map<string, TeamAssetPinRow>()
  return {
    rows,
    upsert(assetType: string, slug: string, fields: Record<string, string | null>) {
      const id = `${assetType}:${slug}`
      const prev = rows.get(id)
      rows.set(id, {
        id,
        asset_type: assetType,
        slug,
        installed_version: fields.installedVersion !== undefined ? fields.installedVersion : prev?.installed_version ?? null,
        installed_checksum: fields.installedChecksum !== undefined ? fields.installedChecksum : prev?.installed_checksum ?? null,
        installed_at: fields.installedAt !== undefined ? fields.installedAt : prev?.installed_at ?? null,
        published_version: fields.publishedVersion !== undefined ? fields.publishedVersion : prev?.published_version ?? null,
        published_checksum: fields.publishedChecksum !== undefined ? fields.publishedChecksum : prev?.published_checksum ?? null,
        published_at: fields.publishedAt !== undefined ? fields.publishedAt : prev?.published_at ?? null,
        created_at: prev?.created_at ?? '2026-09-11T00:00:00.000Z',
        updated_at: '2026-09-11T00:00:00.000Z',
      })
      return rows.get(id)!
    },
    listByType: (assetType: string) =>
      [...rows.values()].filter((r) => r.asset_type === assetType),
    get: (assetType: string, slug: string) => rows.get(`${assetType}:${slug}`),
  } as unknown as TeamAssetPinsRepository & { rows: Map<string, TeamAssetPinRow> }
}

/** 内存工作流端口：graph 载荷 */
function makeWorkflowPort(seed: Array<{ id: string; name: string; graph?: Record<string, unknown> }> = []) {
  const items = new Map(seed.map((w) => [w.id, { ...w, graph: w.graph ?? { nodes: [], edges: [] } }]))
  let validateCalls = 0
  const port: TeamAssetPort = {
    buildPayload(localId: string): TeamAssetBuildResult | null {
      const item = items.get(localId)
      if (!item) return null
      return {
        name: item.name,
        description: '',
        payload: { kind: 'workflow', graph: item.graph },
        warnings: [],
      }
    },
    findInstalledLocalId(slug: string) {
      for (const item of items.values()) {
        if (slugifyAssetName(item.name, 'wf') === slug) return item.id
      }
      return null
    },
    installFromPayload(envelope: TeamAssetEnvelope, existingLocalId: string | null) {
      if (existingLocalId != null) {
        const item = items.get(existingLocalId)
        if (item && envelope.payload.kind === 'workflow') item.graph = envelope.payload.graph
        return { localId: existingLocalId, updatedExisting: true }
      }
      if (envelope.payload.kind !== 'workflow') throw new Error('bad payload kind')
      const id = `new-${items.size + 1}`
      items.set(id, { id, name: envelope.name, graph: envelope.payload.graph })
      return { localId: id, updatedExisting: false }
    },
    validatePayload() {
      validateCalls += 1
    },
  }
  return { port, items, validateCallsGetter: () => validateCalls }
}

/** agent/app 用不到的通用桩端口（类型满足 Record） */
function stubPort(): TeamAssetPort {
  return {
    buildPayload: () => null,
    findInstalledLocalId: () => null,
    installFromPayload: () => {
      throw new Error("stub port 不支持安装")
    },
  }
}

function makeService(center = makeConfigCenter(), port = makeWorkflowPort().port) {
  const pins = makePinsRepo()
  const service = new TeamAssetService(makeConfigStore(center), { workflow: port, agent: stubPort(), app: stubPort() }, pins)
  return { service, pins }
}

function envelopeFor(slug: string, version: string, graph: Record<string, unknown>): TeamAssetEnvelope {
  const payload = { kind: 'workflow' as const, graph }
  return {
    schema: 'spark.team.asset.v1',
    assetType: 'workflow',
    slug,
    name: '流程',
    version,
    author: 'a',
    description: '',
    updatedAt: '2026-09-11T00:00:00.000Z',
    checksum: computePayloadChecksum(payload),
    payload,
  }
}

// ─── slugifyAssetName ───────────────────────────────────────────────────

describe('slugifyAssetName', () => {
  it('ASCII 名称归一；中文回退 prefix-hash 且确定', () => {
    expect(slugifyAssetName('Daily Report', 'wf')).toBe('daily-report')
    const a = slugifyAssetName('数据质量开发流', 'wf')
    const b = slugifyAssetName('数据质量开发流', 'wf')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}$|^[a-z0-9._-]+-[0-9a-f]{8}$/)
    // 「XX agent」类命名不塌缩到同一 slug
    expect(slugifyAssetName('数据分析Agent', 'agent')).not.toBe(
      slugifyAssetName('报表Agent', 'agent'),
    )
  })
})

// ─── 发布 ───────────────────────────────────────────────────────────────

describe('TeamAssetService.publishToTeam', () => {
  it('首发 1.0.0 并写 pins 发布锚点', async () => {
    const center = makeConfigCenter()
    const { port } = makeWorkflowPort([{ id: 'w1', name: 'Daily Report' }])
    const { service, pins } = makeService(center, port)
    const result = await service.publishToTeam('workflow', 'w1')
    expect(result.version).toBe('1.0.0')
    expect(result.slug).toBe('daily-report')
    const raw = center.store.get('workflow:daily-report')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!) as TeamAssetEnvelope
    expect(parsed.assetType).toBe('workflow')
    expect(parsed.author).toBe('tester')
    expect(pins.get('workflow', 'daily-report')?.published_version).toBe('1.0.0')
  })

  it('再发布默认 patch+1；显式低版本被拒', async () => {
    const center = makeConfigCenter()
    const { port } = makeWorkflowPort([{ id: 'w1', name: 'flow' }])
    const { service } = makeService(center, port)
    await service.publishToTeam('workflow', 'w1')
    const second = await service.publishToTeam('workflow', 'w1')
    expect(second.version).toBe('1.0.1')
    expect(second.previousRemoteVersion).toBe('1.0.0')
    await expect(service.publishToTeam('workflow', 'w1', { version: '1.0.0' })).rejects.toThrow(
      /不高于远端当前版本/,
    )
  })
})

// ─── 安装 ───────────────────────────────────────────────────────────────

describe('TeamAssetService.installFromTeam', () => {
  it('安装走端口落地并写 pins 安装锚点；validatePayload 生效', async () => {
    const center = makeConfigCenter()
    const wf = makeWorkflowPort()
    center.store.set('workflow:flow-x', JSON.stringify(envelopeFor('flow-x', '2.1.0', { nodes: [1] })))
    const { service, pins } = makeService(center, wf.port)
    const result = await service.installFromTeam('workflow', 'flow-x')
    expect(result.updatedExisting).toBe(false)
    expect(result.version).toBe('2.1.0')
    expect(wf.items.get(result.localId)?.graph).toEqual({ nodes: [1] })
    expect(pins.get('workflow', 'flow-x')?.installed_version).toBe('2.1.0')
    expect(wf.validateCallsGetter()).toBe(1)
  })

  it('远端不存在报错；非法 slug 报错', async () => {
    const { service } = makeService()
    await expect(service.installFromTeam('workflow', 'nope')).rejects.toThrow(/不存在/)
    await expect(service.installFromTeam('workflow', '../etc')).rejects.toThrow(/非法的资产 slug/)
  })

  it('同名已装实体 → 更新（updatedExisting=true）', async () => {
    const center = makeConfigCenter()
    const wf = makeWorkflowPort([{ id: 'w1', name: 'flow-x' }])
    center.store.set('workflow:flow-x', JSON.stringify(envelopeFor('flow-x', '1.1.0', { nodes: [9] })))
    const { service } = makeService(center, wf.port)
    const result = await service.installFromTeam('workflow', 'flow-x')
    expect(result.updatedExisting).toBe(true)
    expect(result.localId).toBe('w1')
    expect(wf.items.get('w1')?.graph).toEqual({ nodes: [9] })
  })
})

// ─── 更新比对 ───────────────────────────────────────────────────────────

describe('TeamAssetService.listTeamUpdates', () => {
  it('remote-newer / up-to-date / local-modified / remote-missing', async () => {
    const center = makeConfigCenter()
    const wf = makeWorkflowPort([
      { id: 'w-old', name: 'flow-old', graph: { nodes: [] } },
      { id: 'w-same', name: 'flow-same', graph: { nodes: ['a'] } },
      { id: 'w-mod', name: 'flow-mod', graph: { nodes: ['changed'] } },
      { id: 'w-gone', name: 'flow-gone', graph: { nodes: [] } },
    ])
    center.store.set('workflow:flow-old', JSON.stringify(envelopeFor('flow-old', '2.0.0', { nodes: ['v2'] })))
    center.store.set('workflow:flow-same', JSON.stringify(envelopeFor('flow-same', '1.0.0', { nodes: ['a'] })))
    center.store.set('workflow:flow-mod', JSON.stringify(envelopeFor('flow-mod', '1.0.0', { nodes: ['original'] })))
    const { service, pins } = makeService(center, wf.port)
    // 锚点：installed 都记 1.0.0；checksum 按安装时的远端内容（w-mod 本地后来改过）
    pins.upsert('workflow', 'flow-old', { installedVersion: '1.0.0', installedChecksum: computePayloadChecksum({ kind: 'workflow', graph: { nodes: [] } }) })
    pins.upsert('workflow', 'flow-same', { installedVersion: '1.0.0', installedChecksum: computePayloadChecksum({ kind: 'workflow', graph: { nodes: ['a'] } }) })
    pins.upsert('workflow', 'flow-mod', { installedVersion: '1.0.0', installedChecksum: computePayloadChecksum({ kind: 'workflow', graph: { nodes: ['original'] } }) })
    pins.upsert('workflow', 'flow-gone', { installedVersion: '1.0.0', installedChecksum: 'x' })

    const updates = await service.listTeamUpdates('workflow')
    const bySlug = new Map(updates.map((u) => [u.slug, u]))
    expect(bySlug.get('flow-old')?.state).toBe('remote-newer')
    expect(bySlug.get('flow-same')?.state).toBe('up-to-date')
    expect(bySlug.get('flow-mod')?.state).toBe('local-modified')
    expect(bySlug.get('flow-gone')?.state).toBe('remote-missing')
  })

  it('未配置注册中心 → 空数组', async () => {
    const { service } = makeService(makeConfigCenter(), makeWorkflowPort().port)
    const cfg = makeConfigStore(makeConfigCenter(), false)
    const bare = new TeamAssetService(cfg, { workflow: makeWorkflowPort().port, agent: stubPort(), app: stubPort() }, makePinsRepo())
    expect(await bare.listTeamUpdates('workflow')).toEqual([])
    expect(await service.listTeamAssets('workflow')).toEqual([])
  })
})
