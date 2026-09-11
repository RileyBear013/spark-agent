/**
 * 真机集成探针（默认跳过）——v2 自包含捆绑全链路
 *
 * 运行方式（测试环境专用，探针数据用后即删）：
 *   TEAM_REGISTRY_LIVE=1 npx vitest run src/services/team-registry/team-bundle-live.test.ts
 *
 * 验证：发布方真实收集（文本+二进制技能、脱敏 MCP、级联 Agent）→ 真机 zip
 * 上传/生命周期/PUBLIC → 回读 checksum 一致 → 「空机器」（无任何技能/MCP/Agent）
 * 安装：技能字节级落盘、图引用全部改写、MCP 禁用待激活、Agent 停用落位 →
 * 版本更新：替换语义 + 接收方密钥保留 → 大包探针（~2.7MB 载荷回读完整性）→ 清理。
 * 捆绑物化侧用轻量假仓库（SQLite 归单测），文件落盘为真实文件系统。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TeamAssetService, slugifyAssetName, type TeamAssetPort } from './asset-service.js'
import {
  TeamBundleInstaller,
  bundlePublishWarnings,
  collectTeamBundle,
  isBundleEmpty,
  type TeamBundleCollectorDeps,
  type TeamBundleInstallDeps,
} from './team-bundle.js'
import { collectGraphDependencies, rewriteGraphReferences } from '../workflow-bundle/graph-deps.js'
import { agentSpecNameFor, envelopeFromAgentSpecVersion } from './agentspec.js'
import { NacosClient } from './nacos-client.js'
import { TeamRegistryConfigStore } from './team-registry-config.js'
import type { TeamAssetPinsRepository } from '@spark/storage'
import type { TeamAgentEntryLike, TeamBundleSpec, TeamBundleUnresolved } from './types.js'
import { computeNormalizedPayloadChecksum, computePayloadChecksum, type TeamAssetEnvelope } from './types.js'

const LIVE = process.env.TEAM_REGISTRY_LIVE === '1'
const URL_ = process.env.TEAM_REGISTRY_URL ?? 'http://192.168.163.174:8080'
const USER = process.env.TEAM_REGISTRY_USER ?? 'nacos'
const PASS = process.env.TEAM_REGISTRY_PASS ?? 'nacos'

const WF_NAME = '捆绑探针工作流'
const BIG_NAME = '捆绑大包探针技能'

const tmpDirs: string[] = []
async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'team-bundle-live-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe.skipIf(!LIVE)('自包含捆绑真机探针（TEAM_REGISTRY_LIVE=1）', () => {
  const client = new NacosClient({ serverUrl: URL_, namespace: 'public', username: USER, password: PASS })
  const configStore = {
    buildClient: async () => client,
    getSnapshot: async () => ({ configured: true, serverUrl: URL_, namespace: 'public', username: USER, hasPassword: true }),
    readNamespace: () => 'public',
  } as unknown as TeamRegistryConfigStore

  const wfSlug = slugifyAssetName(WF_NAME, 'wf')
  const bigSlug = slugifyAssetName(BIG_NAME, 'wf')
  const probeNames = [agentSpecNameFor('workflow', wfSlug), agentSpecNameFor('workflow', bigSlug)]

  async function cleanup(): Promise<void> {
    for (const name of probeNames) await client.deleteTeamAgentSpec(name).catch(() => {})
  }

  /** 轻量假仓库行（与真实仓库行形状对齐的最小字段） */
  type SkillRow = { id: string; name: string; root_path: string; manifest_json: string }
  type McpRow = { id: string; name: string; config_json: string; bundle_id: string | null }
  type AgentRow = Record<string, unknown> & { id: string }

  /** 「机器」：内存实体 + 真实捆绑收集/物化（与 desktop 端口同构的最小实现） */
  async function makeMachine(prefix: string) {
    const skills = new Map<string, SkillRow>()
    const mcps = new Map<string, McpRow>()
    const agents = new Map<string, TeamAgentEntryLike>()
    const bundleAgents = new Map<string, AgentRow>()
    const bundles = new Map<string, Record<string, unknown>>()
    const workflows = new Map<string, { id: string; name: string; graph: Record<string, unknown> }>()
    const userSkillsDir = await makeTmp()

    const collector: TeamBundleCollectorDeps = {
      getSkill: (id) => skills.get(id) ?? null,
      getMcp: (id) => mcps.get(id) ?? null,
      // 接收方重算时捆绑 Agent 以本地确定性 id 命中（与 desktop 行为一致）
      getAgent: (id) => agents.get(id) ?? (bundleAgents.get(id) as unknown as TeamAgentEntryLike | undefined) ?? null,
      listMcpNames: () => [...mcps.values()].map((m) => ({ id: m.id, name: m.name })),
    }

    // 假仓库行形状与真实仓库最小对齐；整体一次断言注入（类型细节归单测）
    const installerDeps = {
      skills: {
        get: (id: string) => skills.get(id),
        list: () => [...skills.values()],
        create: (p: { id: string; name: string; rootPath: string; manifestJson: string }) => {
          const row: SkillRow = { id: p.id, name: p.name, root_path: p.rootPath, manifest_json: p.manifestJson }
          skills.set(p.id, row)
          return row
        },
        update: (id: string, f: { rootPath?: string; manifestJson?: string }) => {
          const row = skills.get(id)
          if (!row) return undefined
          if (f.rootPath !== undefined) row.root_path = f.rootPath
          if (f.manifestJson !== undefined) row.manifest_json = f.manifestJson
          return row
        },
        deleteById: (id: string) => skills.delete(id),
      },
      mcps: {
        get: (id: string) => mcps.get(id),
        listAll: () => [...mcps.values()],
        findByBundleId: (bundleId: string) => [...mcps.values()].filter((m) => m.bundle_id === bundleId),
        create: (p: { name: string; configJson: string; bundleId?: string }) => {
          const row: McpRow = { id: `mcp-new-${mcps.size + 1}`, name: p.name, config_json: p.configJson, bundle_id: p.bundleId ?? null }
          mcps.set(row.id, row)
          return row
        },
        update: (id: string, f: { configJson?: string }) => {
          const row = mcps.get(id)
          if (!row) return undefined
          if (f.configJson !== undefined) row.config_json = f.configJson
          return row
        },
        deleteById: (id: string) => mcps.delete(id),
      },
      agents: {
        get: (id: string) => bundleAgents.get(id),
        create: (p: { id: string } & Record<string, unknown>) => {
          const row = { ...(p as Record<string, unknown>), id: p.id } as AgentRow
          bundleAgents.set(p.id, row)
          return row
        },
        update: (id: string, f: Record<string, unknown>) => {
          const row = bundleAgents.get(id)
          if (!row) return undefined
          Object.assign(row, f)
          return row
        },
        delete: (id: string) => bundleAgents.delete(id),
      },
      bundles: {
        get: (id: string) => bundles.get(id),
        create: (p: { id: string } & Record<string, unknown>) => {
          bundles.set(p.id, { ...p })
          return { id: p.id }
        },
        update: (id: string, f: Record<string, unknown>) => {
          const row = bundles.get(id)
          if (!row) return undefined
          Object.assign(row, f)
          return row
        },
        delete: (id: string) => bundles.delete(id),
      },
      userSkillsDir,
    } as unknown as TeamBundleInstallDeps
    const installer = new TeamBundleInstaller(installerDeps)

    const port: TeamAssetPort = {
      async buildPayload(localId) {
        const wf = workflows.get(localId)
        if (!wf) return null
        const graphDeps = collectGraphDependencies(wf.graph as unknown as Parameters<typeof collectGraphDependencies>[0])
        const unresolved: TeamBundleUnresolved[] = []
        const bundle = await collectTeamBundle({
          deps: collector,
          skillOriginIds: graphDeps.skillIds,
          mcpOriginIds: graphDeps.mcpServerIds,
          agentOriginIds: graphDeps.agentIds,
          extraUnresolved: unresolved,
        })
        return { name: wf.name, description: 'live probe', payload: { kind: 'workflow', graph: wf.graph, bundle }, warnings: bundlePublishWarnings(bundle) }
      },
      findInstalledLocalId(slug) {
        for (const wf of workflows.values()) if (slugifyAssetName(wf.name, 'wf') === slug) return wf.id
        return null
      },
      async installFromPayload(envelope: TeamAssetEnvelope, existingLocalId: string | null) {
        const payload = envelope.payload as TeamBundleSpec extends never ? never : import('./types.js').TeamWorkflowPayload
        let graph = payload.graph
        let createdAgentIds: string[] = []
        let warnings: string[] = []
        if (payload.bundle && !isBundleEmpty(payload.bundle)) {
          const mat = await installer.materialize(payload.bundle, {
            bundleId: `team-workflow-${envelope.slug}`,
            assetType: 'workflow',
            slug: envelope.slug,
            assetName: envelope.name,
            version: envelope.version,
            ...(envelope.author ? { author: envelope.author } : {}),
            ...(envelope.description ? { description: envelope.description } : {}),
          })
          graph = rewriteGraphReferences(graph as unknown as Parameters<typeof rewriteGraphReferences>[0], {
            skillIdMap: mat.skillIdMap,
            mcpServerIdMap: mat.mcpIdMap,
            agentIdMap: mat.agentIdMap,
          }) as unknown as Record<string, unknown>
          createdAgentIds = mat.createdAgentIds
          warnings = mat.warnings
        }
        const effects = {
          ...(createdAgentIds.length ? { createdAgentIds } : {}),
          ...(warnings.length ? { warnings } : {}),
        }
        if (existingLocalId != null) {
          const wf = workflows.get(existingLocalId)
          if (wf) wf.graph = graph
          return {
            localId: existingLocalId,
            updatedExisting: true,
            installedLocalChecksum: computeNormalizedPayloadChecksum({ kind: 'workflow', graph, bundle: payload.bundle }),
            ...effects,
          }
        }
        const id = `installed-${workflows.size + 1}`
        workflows.set(id, { id, name: envelope.name, graph })
        return {
          localId: id,
          updatedExisting: false,
          // pins 记本地基准（图引用已改写，与远端信封 checksum 不可比）
          installedLocalChecksum: computeNormalizedPayloadChecksum({ kind: 'workflow', graph, bundle: payload.bundle }),
          ...effects,
        }
      },
    }
    return { port, workflows, skills, mcps, agents, bundleAgents, userSkillsDir }
  }

  function makePins(): TeamAssetPinsRepository {
    const rows = new Map<string, Record<string, string | null>>()
    return {
      upsert(assetType: string, slug: string, fields: Record<string, string | null>) {
        rows.set(`${assetType}:${slug}`, { ...(rows.get(`${assetType}:${slug}`) ?? {}), ...fields })
      },
      listByType: (assetType: string) =>
        [...rows.entries()]
          .filter(([k]) => k.startsWith(`${assetType}:`))
          .map(([k, v]) => ({
            slug: k.slice(assetType.length + 1),
            installed_version: v.installedVersion ?? null,
            installed_checksum: v.installedChecksum ?? null,
          })),
    } as unknown as TeamAssetPinsRepository
  }

  it('自包含捆绑：发布 → 空机器安装（字节保真+引用改写）→ 更新密钥保留 → 大包探针 → 清理', async () => {
    await cleanup()
    tmpDirs.push(await makeTmp()) // 0 号位：各机器 skills 根的父目录
    try {
      const health = await client.testRoundTrip()
      expect(health.healthy, health.error).toBe(true)

      // ── 发布方「机器」：技能（文本+二进制）+ MCP（密钥）+ Agent + 工作流 ──
      const publisher = await makeMachine('pub')
      const skillDir = await makeTmp()
      const skillRoot = join(skillDir, 'probe-skill')
      await mkdir(join(skillRoot, 'assets'), { recursive: true })
      await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: probe-skill\n---\n\n# 探针技能\n', 'utf-8')
      const binaryBytes = Buffer.from([0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x7f, 0x01, 0x02, 0x03])
      await writeFile(join(skillRoot, 'assets', 'logo.bin'), binaryBytes)
      publisher.skills.set('skill-1', { id: 'skill-1', name: 'probe-skill', root_path: skillRoot, manifest_json: '{"entrypoints":["SKILL.md"]}' })
      publisher.mcps.set('mcp-1', {
        id: 'mcp-1',
        name: 'probe-mcp',
        config_json: JSON.stringify({ command: 'node', server: 'x', env: { TOKEN: 'publisher-secret' } }),
        bundle_id: null,
      })
      publisher.agents.set('agent-1', {
        id: 'agent-1',
        name: '探针Agent',
        description: '',
        agentAdapter: 'claude-sdk',
        permissionMode: 'default',
        reasoningEffort: 'medium',
        prompt: 'probe-prompt',
        skillIds: ['skill-1'],
        disabledSkillIds: [],
        mcpServerIds: ['mcp-1'],
        ruleIds: [],
        hookConfig: {},
        workflowId: null,
        metadata: {},
      })
      publisher.workflows.set('w1', {
        id: 'w1',
        name: WF_NAME,
        graph: { nodes: [{ id: 'n1', config: { agentId: 'agent-1', skillIds: ['skill-1'], mcpServerIds: ['mcp-1'] } }], edges: [] },
      })

      const service = new TeamAssetService(configStore, { workflow: publisher.port, agent: publisher.port, app: publisher.port }, makePins())
      const pub = await service.publishToTeam('workflow', 'w1')
      expect(pub.version).toBe('0.0.1')
      expect(pub.warnings.join('\n')).toContain('随包捆绑')

      // ── 远端条目 PUBLIC + 信封 checksum 自洽 ──
      const name = agentSpecNameFor('workflow', pub.slug)
      const detail = await client.getTeamAgentSpec(name)
      expect(detail?.scope).toBe('PUBLIC')
      const vDetail = await client.getTeamAgentSpecVersion(name, pub.version)
      expect(vDetail).toBeTruthy()
      const env = envelopeFromAgentSpecVersion(vDetail!, 'workflow')
      expect(env?.checksum).toBe(computePayloadChecksum(env!.payload))

      // ── 空机器（无任何技能/MCP/Agent）安装 ──
      const empty = await makeMachine('empty')
      const serviceOther = new TeamAssetService(configStore, { workflow: empty.port, agent: empty.port, app: empty.port }, makePins())
      const installed = await serviceOther.installFromTeam('workflow', pub.slug)
      expect(installed.updatedExisting).toBe(false)
      expect((installed.warnings ?? []).join('\n')).toContain('停用态')

      // 技能字节级保真（经真实服务端 roundtrip）
      const bundleId = `team-workflow-${pub.slug}`
      const skillId = `bundle:${bundleId}:probe-skill`
      const landedSkill = empty.skills.get(skillId)
      expect(landedSkill, '捆绑技能应落位').toBeTruthy()
      const landedBin = await readFile(join(empty.userSkillsDir, '_bundles', bundleId, 'probe-skill', 'assets', 'logo.bin'))
      expect([...landedBin]).toEqual([...binaryBytes])
      // 图引用全部改写
      const wf = [...empty.workflows.values()][0]!
      const node = (wf.graph.nodes as Array<{ config: Record<string, unknown> }>)[0]!
      expect(node.config.agentId).toMatch(new RegExp(`^team-agent-${bundleId}-[0-9a-f]{8}$`))
      expect(node.config.skillIds).toEqual([skillId])
      expect(String((node.config.mcpServerIds as string[] | undefined)?.[0])).toMatch(/^mcp-new-/)
      // MCP 禁用 + 占位符；Agent 停用
      const landedMcp = [...empty.mcps.values()][0]!
      expect(landedMcp.bundle_id).toBe(bundleId)
      expect(landedMcp.config_json).toContain('{{secret:')
      const landedAgent = [...empty.bundleAgents.values()][0]!
      expect(landedAgent.enabled).toBe(false)
      expect(landedAgent.skillIds).toEqual([skillId])

      // 安装后 up-to-date
      const updates = await serviceOther.listTeamUpdates('workflow')
      expect(updates.find((u) => u.slug === pub.slug)?.state).toBe('up-to-date')

      // ── 版本更新：技能内容变化 → 替换；接收方补的 MCP 密钥保留 ──
      await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: probe-skill\n---\n\n# 探针技能 v2\n', 'utf-8')
      // 接收方激活并补密钥
      empty.mcps.set(landedMcp.id, { ...landedMcp, config_json: JSON.stringify({ command: 'node', server: 'x', env: { TOKEN: 'receiver-secret' } }) })
      const pub2 = await service.publishToTeam('workflow', 'w1')
      expect(pub2.version).toBe('0.0.2')
      const install2 = await serviceOther.installFromTeam('workflow', pub.slug)
      expect(install2.updatedExisting).toBe(true)
      const landedMd = await readFile(join(empty.userSkillsDir, '_bundles', bundleId, 'probe-skill', 'SKILL.md'), 'utf-8')
      expect(landedMd).toContain('v2')
      const mcpAfter = empty.mcps.get(landedMcp.id)!
      expect(mcpAfter.config_json).toContain('receiver-secret')

      // ── 大包探针：~2.7MB base64 载荷的上传与回读完整性 ──
      const bigDir = await makeTmp()
      const bigSkillRoot = join(bigDir, 'big-skill')
      await mkdir(join(bigSkillRoot, 'data'), { recursive: true })
      await writeFile(join(bigSkillRoot, 'SKILL.md'), '# big', 'utf-8')
      await writeFile(join(bigSkillRoot, 'data', 'model.bin'), Buffer.alloc(2 * 1024 * 1024, 0xab))
      const big = await makeMachine('big')
      big.skills.set('skill-big', { id: 'skill-big', name: BIG_NAME, root_path: bigSkillRoot, manifest_json: '{}' })
      big.workflows.set('w-big', {
        id: 'w-big',
        name: BIG_NAME,
        graph: { nodes: [{ id: 'n1', config: { skillIds: ['skill-big'] } }], edges: [] },
      })
      const serviceBig = new TeamAssetService(configStore, { workflow: big.port, agent: big.port, app: big.port }, makePins())
      const bigPub = await serviceBig.publishToTeam('workflow', 'w-big')
      const bigDetail = await client.getTeamAgentSpecVersion(agentSpecNameFor('workflow', bigPub.slug), bigPub.version)
      expect(bigDetail).toBeTruthy()
      const bigEnv = envelopeFromAgentSpecVersion(bigDetail!, 'workflow')
      expect(bigEnv?.checksum).toBe(computePayloadChecksum(bigEnv!.payload))
    } finally {
      await cleanup()
      const items = await client.listTeamAgentSpecs()
      expect(items.filter((i) => probeNames.includes(String(i.name))).map((i) => i.name)).toEqual([])
    }
  })
})
