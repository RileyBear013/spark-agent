/**
 * TeamAssetService 聚焦单测：伪造 AgentSpec 服务端（真实 buildZip/readZip/编解码
 * roundtrip，含服务端资源键转义仿真）+ mock 配置存储/pins/端口，覆盖发布
 * （版本递增/防回退/中文 slug 回退）、安装（校验/锚点）、更新比对六态、
 * 他人条目过滤。
 */
import { describe, it, expect } from 'vitest'

import {
  TeamAssetService,
  slugifyAssetName,
  type TeamAssetPort,
  type TeamAssetBuildResult,
} from './asset-service.js'
import { agentSpecNameFor, buildAgentSpecPackage } from './agentspec.js'
import { readZip } from './zip.js'
import type { TeamRegistryConfigStore } from './team-registry-config.js'
import type { NacosClient, TeamAgentSpecDetail, TeamAgentSpecVersionDetail } from './nacos-client.js'
import type { TeamAssetPinsRepository, TeamAssetPinRow } from '@spark/storage'
import { computePayloadChecksum, type TeamAssetEnvelope } from './types.js'

// ─── 伪造 AgentSpec 服务端（内存实现 + 服务端键转义仿真） ─────────────────

interface FakeVersion {
  status: string
  manifestRaw: string
  resources: Array<{ path: string; content: string }>
}

function makeAgentSpecServer() {
  const specs = new Map<
    string,
    { scope: string; versions: Map<string, FakeVersion> }
  >()
  const mustVersion = (name: string, version: string): FakeVersion => {
    const v = specs.get(name)?.versions.get(version)
    if (!v) throw new Error(`fake server: ${name}@${version} 不存在`)
    return v
  }

  const client = {
    async listTeamAgentSpecs() {
      return [...specs.entries()].map(([name, spec]) => {
        const online = [...spec.versions.keys()].filter(
          (v) => spec.versions.get(v)!.status === 'online',
        )
        const latest = online.sort((a, b) => b.localeCompare(a))[0] ?? null
        return {
          name,
          description: '',
          scope: spec.scope,
          labels: latest ? { latest } : {},
          onlineCnt: online.length,
        }
      })
    },
    async getTeamAgentSpec(name: string): Promise<TeamAgentSpecDetail | null> {
      const spec = specs.get(name)
      if (!spec) return null
      return {
        name,
        description: '',
        scope: spec.scope,
        latestPublished: null,
        editingVersion:
          [...spec.versions.entries()].find(([, v]) => v.status === 'draft' || v.status === 'review')?.[0] ??
          null,
        versions: [...spec.versions.entries()].map(([version, v]) => ({
          version,
          status: v.status,
          author: 'tester',
        })),
        raw: {},
      }
    },
    async getTeamAgentSpecVersion(
      name: string,
      version: string,
    ): Promise<TeamAgentSpecVersionDetail | null> {
      const v = specs.get(name)?.versions.get(version)
      if (!v) return null
      // 仿服务端：资源键转义（/ → _，. → __），identifier/name 保留原文
      const resource: Record<string, Record<string, string>> = {}
      for (const r of v.resources) {
        resource[r.path.split('/').join('_').split('.').join('__')] = {
          content: r.content,
          name: r.path.split('/').pop() ?? r.path,
          resourceIdentifier: r.path.includes('/') ? `res::${r.path}` : r.path,
        }
      }
      // 仿真实客户端 normalizer：从 identifier/name 还原相对路径
      const resources = Object.entries(resource).map(([key, entry]): { path: string; content: string } => {
        const identifier: string = entry.resourceIdentifier ?? ''
        const path = identifier.includes('::')
          ? identifier.slice(identifier.indexOf('::') + 2)
          : (entry.name ?? key)
        return { path, content: entry.content ?? '' }
      })
      return { name, version, manifestRaw: v.manifestRaw, resources, raw: {} }
    },
    async uploadTeamAgentSpecZip(args: { zip: Buffer }): Promise<string> {
      const entries = readZip(args.zip) // 真实解析器，验证 buildZip 产物
      const manifestEntry = entries.find((e) => e.path === 'manifest.json')
      if (!manifestEntry) throw new Error('fake server: zip 缺 manifest.json')
      const manifest = JSON.parse(manifestEntry.content.toString('utf-8')) as {
        name: string
        version: string
      }
      let spec = specs.get(manifest.name)
      if (!spec) {
        spec = { scope: 'PRIVATE', versions: new Map() }
        specs.set(manifest.name, spec)
      }
      // 仿服务端：版本号自分配（0.0.N 递增，manifest.version 不生效）；
      // 存在 editing/reviewing 版本时拒绝上传（code 20005 语义）
      const working = [...spec.versions.values()].some(
        (v) => v.status === 'draft' || v.status === 'review',
      )
      if (working) {
        throw new Error('fake server: There is already a working version (editing/reviewing), cannot upload')
      }
      let maxPatch = 0
      for (const v of spec.versions.keys()) {
        const m = /^0\.0\.(\d+)$/.exec(v)
        if (m) maxPatch = Math.max(maxPatch, Number(m[1] ?? 0))
      }
      const assigned = `0.0.${maxPatch + 1}`
      spec.versions.set(assigned, {
        status: 'draft',
        manifestRaw: manifestEntry.content.toString('utf-8'),
        resources: entries
          .filter((e) => e.path !== 'manifest.json')
          .map((e) => ({ path: e.path, content: e.content.toString('utf-8') })),
      })
      return manifest.name
    },
    async submitTeamAgentSpecVersion(name: string, version: string) {
      mustVersion(name, version).status = 'review'
    },
    async publishTeamAgentSpecVersion(name: string, version: string) {
      mustVersion(name, version).status = 'published'
    },
    async onlineTeamAgentSpecVersion(name: string, version: string) {
      mustVersion(name, version).status = 'online'
    },
    async setTeamAgentSpecScope(name: string, scope: 'PRIVATE' | 'PUBLIC') {
      const spec = specs.get(name)
      if (!spec) throw new Error('fake server: agentspec 不存在')
      spec.scope = scope
    },
    async deleteTeamAgentSpec(name: string) {
      return specs.delete(name)
    },
  } as unknown as NacosClient

  return { client, specs }
}

function makeConfigStore(client: NacosClient, configured = true) {
  return {
    async buildClient() {
      return configured ? client : null
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
    async buildPayload(localId: string): Promise<TeamAssetBuildResult | null> {
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
    async installFromPayload(envelope: TeamAssetEnvelope, existingLocalId: string | null) {
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
    buildPayload: async () => null,
    findInstalledLocalId: () => null,
    installFromPayload: async () => {
      throw new Error('stub port 不支持安装')
    },
  }
}

function makeService(
  server = makeAgentSpecServer(),
  port = makeWorkflowPort().port,
) {
  const pins = makePinsRepo()
  const service = new TeamAssetService(
    makeConfigStore(server.client),
    { workflow: port, agent: stubPort(), app: stubPort() },
    pins,
  )
  return { service, pins, server }
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

/** 直接把一个信封「上传」进伪造服务端（模拟另一台机器的发布） */
async function seedRemote(server: ReturnType<typeof makeAgentSpecServer>, envelope: TeamAssetEnvelope) {
  const pkg = buildAgentSpecPackage(envelope)
  const client = server.client as unknown as {
    uploadTeamAgentSpecZip(a: { zip: Buffer }): Promise<string>
    submitTeamAgentSpecVersion(n: string, v: string): Promise<void>
    publishTeamAgentSpecVersion(n: string, v: string): Promise<void>
    onlineTeamAgentSpecVersion(n: string, v: string): Promise<void>
  }
  const name = await client.uploadTeamAgentSpecZip({ zip: pkg.zip })
  // 服务端自分配版本：回读 editingVersion 再走生命周期
  const detail = await (
    server.client as unknown as {
      getTeamAgentSpec(n: string): Promise<{ editingVersion: string | null } | null>
    }
  ).getTeamAgentSpec(name)
  const assigned = detail?.editingVersion
  if (!assigned) throw new Error('fake server: 上传后无编辑版本')
  await client.submitTeamAgentSpecVersion(name, assigned)
  await client.publishTeamAgentSpecVersion(name, assigned)
  await client.onlineTeamAgentSpecVersion(name, assigned)
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
  it('首发：服务端分配 0.0.1，原生条目带 x-spark 元数据，写 pins 发布锚点', async () => {
    const { service, pins, server } = makeService(undefined, makeWorkflowPort([{ id: 'w1', name: 'Daily Report' }]).port)
    const result = await service.publishToTeam('workflow', 'w1')
    expect(result.version).toBe('0.0.1')
    expect(result.slug).toBe('daily-report')
    expect(result.warnings).toEqual([])

    const name = agentSpecNameFor('workflow', 'daily-report')
    const spec = server.specs.get(name)
    expect(spec, '服务端应有原生 AgentSpec 条目').toBeTruthy()
    const manifest = JSON.parse(spec!.versions.get('0.0.1')!.manifestRaw) as Record<string, unknown>
    expect(manifest.version).toBe('1.0.0')
    const x = manifest['x-spark'] as Record<string, unknown>
    expect(x.assetType).toBe('workflow')
    expect(x.slug).toBe('daily-report')
    expect(x.author).toBe('tester')
    expect(pins.get('workflow', 'daily-report')?.published_version).toBe('0.0.1')
  })

  it('再发布自动分配下一版本（0.0.2）；指定版本号不生效仅回显 warning', async () => {
    const { service, server } = makeService(undefined, makeWorkflowPort([{ id: 'w1', name: 'flow' }]).port)
    await service.publishToTeam('workflow', 'w1')
    const second = await service.publishToTeam('workflow', 'w1')
    expect(second.version).toBe('0.0.2')
    expect(second.previousRemoteVersion).toBe('0.0.1')
    const explicit = await service.publishToTeam('workflow', 'w1', { version: '9.9.9' })
    expect(explicit.version).toBe('0.0.3')
    expect(explicit.warnings.some((w) => w.includes('不生效'))).toBe(true)
    const spec = server.specs.get(agentSpecNameFor('workflow', 'flow'))
    expect(spec?.versions.get('0.0.1')?.status).toBe('online')
    expect(spec?.versions.get('0.0.2')?.status).toBe('online')
    expect(spec?.versions.get('0.0.3')?.status).toBe('online')
  })
})

// ─── 安装 ───────────────────────────────────────────────────────────────

describe('TeamAssetService.installFromTeam', () => {
  it('安装走端口落地并写 pins 安装锚点；validatePayload 生效（真 zip roundtrip）', async () => {
    const server = makeAgentSpecServer()
    await seedRemote(server, envelopeFor('flow-x', '2.1.0', { nodes: [1] }))
    const wf = makeWorkflowPort()
    const { service, pins } = makeService(server, wf.port)
    const result = await service.installFromTeam('workflow', 'flow-x')
    expect(result.updatedExisting).toBe(false)
    expect(result.version).toBe('0.0.1')
    expect(wf.items.get(result.localId)?.graph).toEqual({ nodes: [1] })
    expect(pins.get('workflow', 'flow-x')?.installed_version).toBe('0.0.1')
    expect(wf.validateCallsGetter()).toBe(1)
  })

  it('远端不存在报错；非法 slug 报错', async () => {
    const { service } = makeService()
    await expect(service.installFromTeam('workflow', 'nope')).rejects.toThrow(/不存在/)
    await expect(service.installFromTeam('workflow', '../etc')).rejects.toThrow(/非法的资产 slug/)
  })

  it('同名已装实体 → 更新（updatedExisting=true）', async () => {
    const server = makeAgentSpecServer()
    await seedRemote(server, envelopeFor('flow-x', '1.1.0', { nodes: [9] }))
    const wf = makeWorkflowPort([{ id: 'w1', name: 'flow-x' }])
    const { service } = makeService(server, wf.port)
    const result = await service.installFromTeam('workflow', 'flow-x')
    expect(result.updatedExisting).toBe(true)
    expect(result.localId).toBe('w1')
    expect(wf.items.get('w1')?.graph).toEqual({ nodes: [9] })
  })
})

// ─── 浏览列表 ───────────────────────────────────────────────────────────

describe('TeamAssetService.listTeamAssets', () => {
  it('他人条目（无 x-spark / 非 spark- 前缀）被过滤；未发布版本不展示', async () => {
    const server = makeAgentSpecServer()
    const client = server.client as unknown as {
      uploadTeamAgentSpecZip(a: { zip: Buffer }): Promise<string>
    }
    // 我们的资产
    await seedRemote(server, envelopeFor('flow-a', '1.0.0', { nodes: [] }))
    // 他人条目：manifest 无 x-spark
    await client.uploadTeamAgentSpecZip({
      zip: buildAgentSpecPackage(envelopeFor('flow-b', '1.0.0', { nodes: [] })).zip,
    })
    const raw = server.specs.get('spark-workflow-flow-b')!
    const fakeVer = [...raw.versions.keys()][0]!
    const manifest = JSON.parse(raw.versions.get(fakeVer)!.manifestRaw) as Record<string, unknown>
    delete manifest['x-spark']
    raw.versions.set(fakeVer, {
      status: 'online',
      manifestRaw: JSON.stringify(manifest),
      resources: [{ path: 'payload.json', content: '{}' }],
    })
    // 无发布版本的 spark 条目
    await client.uploadTeamAgentSpecZip({
      zip: buildAgentSpecPackage(envelopeFor('flow-c', '0.0.1', { nodes: [] })).zip,
    })

    const { service } = makeService(server, makeWorkflowPort().port)
    const list = await service.listTeamAssets('workflow')
    expect(list.map((i) => i.slug)).toEqual(['flow-a'])
  })
})

// ─── 更新比对 ───────────────────────────────────────────────────────────

describe('TeamAssetService.listTeamUpdates', () => {
  it('remote-newer / up-to-date / local-modified / remote-missing', async () => {
    const server = makeAgentSpecServer()
    const wf = makeWorkflowPort([
      { id: 'w-old', name: 'flow-old', graph: { nodes: [] } },
      { id: 'w-same', name: 'flow-same', graph: { nodes: ['a'] } },
      { id: 'w-mod', name: 'flow-mod', graph: { nodes: ['changed'] } },
      { id: 'w-gone', name: 'flow-gone', graph: { nodes: [] } },
    ])
    await seedRemote(server, envelopeFor('flow-old', '2.0.0', { nodes: ['v2'] }))
    await seedRemote(server, envelopeFor('flow-same', '1.0.0', { nodes: ['a'] }))
    await seedRemote(server, envelopeFor('flow-mod', '1.0.0', { nodes: ['original'] }))
    const { service, pins } = makeService(server, wf.port)
    // 锚点：installed 都记 1.0.0；checksum 按安装时的远端内容（w-mod 本地后来改过）
    pins.upsert('workflow', 'flow-old', { installedVersion: '0.0.0', installedChecksum: computePayloadChecksum({ kind: 'workflow', graph: { nodes: [] } }) })
    pins.upsert('workflow', 'flow-same', { installedVersion: '0.0.0', installedChecksum: computePayloadChecksum({ kind: 'workflow', graph: { nodes: ['a'] } }) })
    pins.upsert('workflow', 'flow-mod', { installedVersion: '0.0.0', installedChecksum: computePayloadChecksum({ kind: 'workflow', graph: { nodes: ['original'] } }) })
    pins.upsert('workflow', 'flow-gone', { installedVersion: '0.0.0', installedChecksum: 'x' })

    const updates = await service.listTeamUpdates('workflow')
    const bySlug = new Map(updates.map((u) => [u.slug, u]))
    expect(bySlug.get('flow-old')?.state).toBe('remote-newer')
    expect(bySlug.get('flow-same')?.state).toBe('up-to-date')
    expect(bySlug.get('flow-mod')?.state).toBe('local-modified')
    expect(bySlug.get('flow-gone')?.state).toBe('remote-missing')
  })

  it('未配置注册中心 → 空数组', async () => {
    const server = makeAgentSpecServer()
    const bare = new TeamAssetService(
      makeConfigStore(server.client, false),
      { workflow: makeWorkflowPort().port, agent: stubPort(), app: stubPort() },
      makePinsRepo(),
    )
    expect(await bare.listTeamUpdates('workflow')).toEqual([])
    expect(await bare.listTeamAssets('workflow')).toEqual([])
  })
})


// ─── 版本管理：可安装版本列表 + 指定版本安装/回滚 ────────────────────────

describe('TeamAssetService 版本管理', () => {
  function setup() {
    const bundle = makeWorkflowPort([{ id: 'wf1', name: '流程' }])
    const { service, pins, server } = makeService(undefined, bundle.port)
    return { service, pins, server, items: bundle.items }
  }

  it('listTeamAssetVersions 只返回已发布版本并按 semver 降序', async () => {
    const { service, server } = setup()
    await service.publishToTeam('workflow', 'wf1', {})
    await service.publishToTeam('workflow', 'wf1', {})
    const slug = slugifyAssetName('流程', 'wf')
    const spec = server.specs.get(agentSpecNameFor('workflow', slug))
    // 手工塞一个 draft 版本——非发布态不应出现在可安装列表
    spec?.versions.set('0.0.3', { status: 'draft', manifestRaw: '{}', resources: [] })
    const versions = await service.listTeamAssetVersions('workflow', slug)
    expect(versions.map((v) => v.version)).toEqual(['0.0.2', '0.0.1'])
    expect(versions[0]?.author).toBe('tester')
  })

  it('installFromTeam 指定历史版本 → 安装该版本并记录 pins（回滚后显示可更新）', async () => {
    const { service, pins, items } = setup()
    await service.publishToTeam('workflow', 'wf1', {})
    // 第二版改内容——同内容升版按规则 2 判 up-to-date（内容一致优先于版本号）
    const item = items.get('wf1')
    if (item) item.graph = { nodes: [{ id: 'n2' }], edges: [] }
    await service.publishToTeam('workflow', 'wf1', {})
    const slug = slugifyAssetName('流程', 'wf')
    const res = await service.installFromTeam('workflow', slug, { version: '0.0.1' })
    expect(res.version).toBe('0.0.1')
    expect(res.updatedExisting).toBe(true) // 本地同名 wf1 → 更新（回滚语义）
    expect(pins.get('workflow', slug)?.installed_version).toBe('0.0.1')
    const updates = await service.listTeamUpdates('workflow')
    expect(updates.find((u) => u.slug === slug)?.state).toBe('remote-newer')
  })

  it('installFromTeam 指定 draft / 不存在版本 → 拒绝', async () => {
    const { service, server } = setup()
    await service.publishToTeam('workflow', 'wf1', {})
    const slug = slugifyAssetName('流程', 'wf')
    const spec = server.specs.get(agentSpecNameFor('workflow', slug))
    spec?.versions.set('0.0.2', { status: 'draft', manifestRaw: '{}', resources: [] })
    await expect(
      service.installFromTeam('workflow', slug, { version: '0.0.2' }),
    ).rejects.toThrow(/仅已发布版本/)
    await expect(
      service.installFromTeam('workflow', slug, { version: '9.9.9' }),
    ).rejects.toThrow(/不存在可安装的版本/)
  })
})
