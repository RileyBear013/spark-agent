/**
 * team-bundle 聚焦单测：自包含捆绑的收集（发布方）与物化（接收方）。
 * 收集侧用真实临时目录验证 utf8/base64 保真与 sha256；物化侧用内存假仓库 +
 * 真实临时目录验证幂等落位、密钥保留、替换语义与完整性校验。
 */
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { hashDirectoryEntries } from '../workflow-bundle/bundle-fs.js'
import { rewriteGraphReferences } from '../workflow-bundle/graph-deps.js'
import {
  collectTeamBundle,
  isBundleEmpty,
  TeamBundleInstaller,
  type TeamBundleCollectorDeps,
  type TeamBundleInstallDeps,
} from './team-bundle.js'
import type { TeamAgentEntryLike, TeamBundleSkill, TeamBundleSpec } from './types.js'

const tmpDirs: string[] = []
async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'team-bundle-test-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

// ─── 假仓库（结构对齐 Pick 面） ─────────────────────────────────────────

function fakeSkills() {
  const rows = new Map<string, Record<string, unknown>>()
  return {
    rows,
    get: (id: string) => rows.get(id),
    list: () => [...rows.values()],
    create: (p: { id: string; scope: string; name: string; version: string; rootPath: string; manifestJson: string; enabled?: boolean }) => {
      const row = {
        id: p.id,
        scope: p.scope,
        name: p.name,
        version: p.version,
        root_path: p.rootPath,
        manifest_json: p.manifestJson,
        enabled: p.enabled === false ? 0 : 1,
      }
      rows.set(p.id, row)
      return row
    },
    update: (id: string, f: Partial<{ name: string; version: string; rootPath: string; manifestJson: string; enabled: boolean }>) => {
      const row = rows.get(id)
      if (!row) return undefined
      if (f.name !== undefined) row.name = f.name
      if (f.rootPath !== undefined) row.root_path = f.rootPath
      if (f.manifestJson !== undefined) row.manifest_json = f.manifestJson
      if (f.enabled !== undefined) row.enabled = f.enabled ? 1 : 0
      return row
    },
    deleteById: (id: string) => rows.delete(id),
  }
}

function fakeMcps() {
  const rows = new Map<string, Record<string, unknown>>()
  const toRow = (p: { id?: string; scope: string; name: string; configJson: string; enabled?: boolean; bundleId?: string }) => ({
    id: p.id ?? `mcp-${rows.size + 1}`,
    scope: p.scope,
    name: p.name,
    config_json: p.configJson,
    enabled: p.enabled === false ? 0 : 1,
    bundle_id: p.bundleId ?? null,
  })
  return {
    rows,
    get: (id: string) => rows.get(id),
    listAll: () => [...rows.values()],
    findByBundleId: (bundleId: string) => [...rows.values()].filter((r) => r.bundle_id === bundleId),
    create: (p: { id?: string; scope: string; name: string; configJson: string; enabled?: boolean; bundleId?: string }) => {
      const row = toRow(p)
      rows.set(row.id as string, row)
      return row
    },
    update: (id: string, f: Partial<{ name: string; configJson: string; enabled: boolean }>) => {
      const row = rows.get(id)
      if (!row) return undefined
      if (f.name !== undefined) row.name = f.name
      if (f.configJson !== undefined) row.config_json = f.configJson
      if (f.enabled !== undefined) row.enabled = f.enabled ? 1 : 0
      return row
    },
    deleteById: (id: string) => rows.delete(id),
  }
}

function fakeAgents() {
  const rows = new Map<string, Record<string, unknown>>()
  return {
    rows,
    get: (id: string) => rows.get(id),
    create: (p: Record<string, unknown> & { id: string }) => {
      const row = { ...p }
      rows.set(p.id, row)
      return row
    },
    update: (id: string, f: Record<string, unknown>) => {
      const row = rows.get(id)
      if (!row) return undefined
      Object.assign(row, f)
      return row
    },
    delete: (id: string) => rows.delete(id),
  }
}

function fakeBundles() {
  const rows = new Map<string, Record<string, unknown>>()
  return {
    rows,
    get: (id: string) => rows.get(id),
    create: (p: { id: string; name: string; version?: string; author?: string | null; description?: string | null; manifestJson: string; source?: string | null; verificationStatus?: string }) => {
      const row = { ...p, created_at: 't', updated_at: 't' }
      rows.set(p.id, row)
      return row
    },
    update: (id: string, f: Record<string, unknown>) => {
      const row = rows.get(id)
      if (!row) return undefined
      Object.assign(row, f)
      return row
    },
    delete: (id: string) => rows.delete(id),
  }
}

function makeInstallDeps(userSkillsDir: string): TeamBundleInstallDeps & {
  skills: ReturnType<typeof fakeSkills>
  mcps: ReturnType<typeof fakeMcps>
  agents: ReturnType<typeof fakeAgents>
  bundles: ReturnType<typeof fakeBundles>
} {
  const skills = fakeSkills()
  const mcps = fakeMcps()
  const agents = fakeAgents()
  const bundles = fakeBundles()
  return {
    skills,
    mcps,
    agents,
    bundles,
    userSkillsDir,
  } as unknown as TeamBundleInstallDeps & {
    skills: ReturnType<typeof fakeSkills>
    mcps: ReturnType<typeof fakeMcps>
    agents: ReturnType<typeof fakeAgents>
    bundles: ReturnType<typeof fakeBundles>
  }
}

// ─── collectTeamBundle ──────────────────────────────────────────────────

async function seedSkillDir(dir: string, name: string): Promise<string> {
  const root = join(dir, name)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'SKILL.md'), `---\nname: ${name}\n---\n\n# ${name}\n`, 'utf-8')
  // 二进制文件：含 NUL 与高位字节，保证 utf8 strict 解码失败走 base64
  const binary = Buffer.from([0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01, 0x02])
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'assets', 'logo.bin'), binary)
  return root
}

function collectorWith(skillDirs: Map<string, string>): {
  deps: TeamBundleCollectorDeps
  agents: Map<string, TeamAgentEntryLike>
} {
  const agents = new Map<string, TeamAgentEntryLike>()
  const deps: TeamBundleCollectorDeps = {
    getSkill: (id) => {
      const root = skillDirs.get(id)
      if (!root) return null
      return { id, name: id, root_path: root, manifest_json: '{"entrypoints":["SKILL.md"]}' }
    },
    getMcp: (id) =>
      id === 'mcp-1'
        ? {
            id,
            name: 'hq-static-db',
            config_json: JSON.stringify({ command: 'node', server: 'x', env: { TOKEN: 'real-secret' } }),
          }
        : null,
    getAgent: (id) => agents.get(id) ?? null,
    listMcpNames: () => [{ id: 'mcp-1', name: 'hq-static-db' }],
  }
  return { deps, agents }
}

describe('collectTeamBundle（发布方收集）', () => {
  it('内联技能文件：utf8 文本 + 二进制 base64 保真 + sha256 指纹', async () => {
    const dir = await makeTmp()
    const skillRoot = await seedSkillDir(dir, 'demo-skill')
    const { deps } = collectorWith(new Map([['skill-1', skillRoot]]))
    const spec = await collectTeamBundle({ deps, skillOriginIds: ['skill-1'] })
    expect(spec.skills).toHaveLength(1)
    const skill = spec.skills[0]!
    expect(skill.name).toBe('skill-1')
    expect(skill.manifestJson).toBe('{"entrypoints":["SKILL.md"]}')
    const md = skill.files.find((f) => f.path === 'SKILL.md')
    const bin = skill.files.find((f) => f.path === 'assets/logo.bin')
    expect(md?.encoding).toBe('utf8')
    expect(bin?.encoding).toBe('base64')
    // 二进制字节级保真
    const binBytes = Buffer.from(bin!.content, 'base64')
    expect([...binBytes]).toEqual([0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01, 0x02])
    // sha256 与 hashDirectoryEntries 同规则（含 .spark-skill-manifest.json）
    const entries = new Map<string, Uint8Array>()
    for (const f of skill.files) {
      entries.set(
        f.path,
        f.encoding === 'base64' ? new Uint8Array(Buffer.from(f.content, 'base64')) : new Uint8Array(Buffer.from(f.content, 'utf-8')),
      )
    }
    expect(skill.sha256).toBe(hashDirectoryEntries(entries))
    expect(skill.totalBytes).toBeGreaterThan(0)
  })

  it('内建技能静默跳过；缺失技能转 unresolved；空捆绑判定', async () => {
    const { deps } = collectorWith(new Map())
    const spec = await collectTeamBundle({ deps, skillOriginIds: ['builtin:platform-manager', 'skill-gone'] })
    expect(spec.skills).toHaveLength(0)
    expect(spec.unresolved).toHaveLength(1)
    expect(spec.unresolved[0]!.type).toBe('skill')
    expect(isBundleEmpty(spec)).toBe(true)
  })

  it('MCP 密钥脱敏为占位符并登记 requiredSecrets', async () => {
    const { deps } = collectorWith(new Map())
    const spec = await collectTeamBundle({ deps, mcpOriginIds: ['mcp-1'] })
    expect(spec.mcps).toHaveLength(1)
    const mcp = spec.mcps[0]!
    expect(mcp.transport).toBe('stdio')
    expect((mcp.config as { env: { TOKEN: string } }).env.TOKEN).toContain('{{secret:')
    expect(mcp.requiredSecrets.map((s) => s.path)).toContain('env.TOKEN')
    expect((mcp.config as { command: string }).command).toBe('node')
  })

  it('Agent 级联：Agent 引用的技能/MCP 一并收集', async () => {
    const dir = await makeTmp()
    const skillRoot = await seedSkillDir(dir, 'agent-skill')
    const { deps, agents } = collectorWith(new Map([['skill-a', skillRoot]]))
    agents.set('agent-1', {
      id: 'agent-1',
      name: 'Java 专家',
      description: '',
      agentAdapter: 'claude-sdk',
      permissionMode: 'default',
      reasoningEffort: 'medium',
      prompt: 'p',
      skillIds: ['skill-a'],
      disabledSkillIds: [],
      mcpServerIds: ['mcp-1'],
      ruleIds: [],
      hookConfig: {},
      workflowId: null,
      metadata: {},
    })
    const spec = await collectTeamBundle({ deps, agentOriginIds: ['agent-1'] })
    expect(spec.agents).toHaveLength(1)
    expect(spec.agents[0]!.originAgentId).toBe('agent-1')
    expect(spec.skills.map((s) => s.originSkillId)).toContain('skill-a')
    expect(spec.mcps.map((m) => m.originServerId)).toContain('mcp-1')
    expect(isBundleEmpty(spec)).toBe(false)
  })

  it('单文件超过上限的技能降级为 unresolved（发布可完成，不整体失败）', async () => {
    const dir = await makeTmp()
    const root = join(dir, 'big-skill')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'SKILL.md'), '# big', 'utf-8')
    await writeFile(join(root, 'huge.bin'), Buffer.alloc(5 * 1024 * 1024, 1)) // > 4MB
    const { deps } = collectorWith(new Map([['skill-big', root]]))
    const spec = await collectTeamBundle({ deps, skillOriginIds: ['skill-big'] })
    expect(spec.skills).toHaveLength(0)
    expect(spec.unresolved).toHaveLength(1)
    expect(spec.unresolved[0]!.type).toBe('skill')
    expect(spec.unresolved[0]!.hint).toContain('团队源')
  })
})

// ─── TeamBundleInstaller.materialize ────────────────────────────────────

async function makeSpec(): Promise<{ spec: TeamBundleSpec; skillBytes: Uint8Array }> {
  const dir = await makeTmp()
  const skillRoot = await seedSkillDir(dir, 'demo-skill')
  const { deps } = collectorWith(new Map([['skill-1', skillRoot]]))
  const spec = await collectTeamBundle({
    deps,
    skillOriginIds: ['skill-1'],
    mcpOriginIds: ['mcp-1'],
  })
  const first = spec.skills[0] as TeamBundleSkill
  const bin = first.files.find((f) => f.encoding === 'base64')!
  return { spec, skillBytes: new Uint8Array(Buffer.from(bin.content, 'base64')) }
}

describe('TeamBundleInstaller（接收方物化）', () => {
  const meta = {
    bundleId: 'team-workflow-wf-x',
    assetType: 'workflow' as const,
    slug: 'wf-x',
    assetName: '演示工作流',
    version: '0.0.3',
    author: 'alice',
  }

  it('技能/MCP/Agent 幂等落位 + 引用映射 + workflow_bundles 登记', async () => {
    const userDir = await makeTmp()
    const deps = makeInstallDeps(userDir)
    const { spec, skillBytes } = await makeSpec()
    const specWithAgent: TeamBundleSpec = {
      ...spec,
      agents: [
        {
          originAgentId: 'agent-1',
          config: {
            name: 'Java 专家',
            skillIds: ['skill-1'],
            disabledSkillIds: [],
            mcpServerIds: ['mcp-1'],
          },
        },
      ],
    }
    const installer = new TeamBundleInstaller(deps)
    const result = await installer.materialize(specWithAgent, meta)

    // 技能：确定性 id（slug 来自技能行名）+ 目录落盘 + 启用
    const skillId = 'bundle:team-workflow-wf-x:skill-1'
    const skillRow = deps.skills.get(skillId)
    expect(skillRow).toBeTruthy()
    expect(skillRow!.enabled).toBe(1)
    expect(result.skillIdMap.get('skill-1')).toBe(skillId)
    const onDisk = await readFile(join(userDir, '_bundles', meta.bundleId, 'skill-1', 'assets', 'logo.bin'))
    expect([...onDisk]).toEqual([...skillBytes])
    // MCP：禁用 + bundle 标记 + 占位符保留
    const mcpRows = deps.mcps.findByBundleId(meta.bundleId)
    expect(mcpRows).toHaveLength(1)
    expect(mcpRows[0]!.enabled).toBe(0)
    expect(result.mcpIdMap.get('mcp-1')).toBe(mcpRows[0]!.id)
    expect(String(mcpRows[0]!.config_json)).toContain('{{secret:')
    // Agent：确定性 id + 停用态 + 引用已改写
    const agentRow = [...deps.agents.rows.values()][0]!
    expect(String(agentRow.id)).toMatch(/^team-agent-team-workflow-wf-x-[0-9a-f]{8}$/)
    expect(agentRow.enabled).toBe(false)
    expect(agentRow.skillIds).toEqual([skillId])
    expect(agentRow.mcpServerIds).toEqual([result.mcpIdMap.get('mcp-1')])
    expect(result.createdAgentIds).toHaveLength(1)
    // 登记 + warning
    expect(deps.bundles.get(meta.bundleId)).toBeTruthy()
    expect(result.warnings.some((w) => w.includes('密钥待补'))).toBe(true)
    // 幂等：再次物化为更新（无新建 Agent）
    const second = await installer.materialize(specWithAgent, meta)
    expect(second.createdAgentIds).toHaveLength(0)
    expect([...deps.agents.rows.values()]).toHaveLength(1)
    expect(deps.skills.list().filter((r) => String(r.id).startsWith('bundle:team-workflow-wf-x:'))).toHaveLength(1)
  })

  it('更新保留接收方已补齐的 MCP 密钥', async () => {
    const userDir = await makeTmp()
    const deps = makeInstallDeps(userDir)
    const { spec } = await makeSpec()
    const installer = new TeamBundleInstaller(deps)
    await installer.materialize(spec, meta)
    // 接收方激活并补齐密钥
    const mcpRow = deps.mcps.findByBundleId(meta.bundleId)[0]!
    deps.mcps.update(String(mcpRow.id), {
      configJson: JSON.stringify({ command: 'node', server: 'x', env: { TOKEN: 'receiver-secret' } }),
      enabled: true,
    })
    // 新版本到来（仍是占位符）
    await installer.materialize(spec, { ...meta, version: '0.0.4' })
    const after = deps.mcps.findByBundleId(meta.bundleId)[0]!
    expect(String(after.config_json)).toContain('receiver-secret')
    expect(after.enabled).toBe(1) // 运行状态保留
  })

  it('替换语义：新版本不再携带的技能行与目录被清理', async () => {
    const userDir = await makeTmp()
    const deps = makeInstallDeps(userDir)
    const { spec } = await makeSpec()
    const installer = new TeamBundleInstaller(deps)
    const withExtra: TeamBundleSpec = {
      ...spec,
      skills: [
        ...spec.skills,
        {
          slug: 'old-skill',
          name: 'old',
          originSkillId: 'skill-old',
          sha256: hashDirectoryEntries(new Map([['SKILL.md', new Uint8Array(Buffer.from('# old'))]])),
          manifestJson: '{}',
          files: [{ path: 'SKILL.md', encoding: 'utf8', content: '# old' }],
          totalBytes: 5,
        },
      ],
    }
    await installer.materialize(withExtra, meta)
    expect(deps.skills.list()).toHaveLength(2)
    await installer.materialize(spec, meta) // 新版本只带 demo-skill
    expect(deps.skills.list()).toHaveLength(1)
    await expect(stat(join(userDir, '_bundles', meta.bundleId, 'old-skill'))).rejects.toThrow()
  })

  it('校验和不匹配直接抛错（传输损坏防护）', async () => {
    const userDir = await makeTmp()
    const deps = makeInstallDeps(userDir)
    const { spec } = await makeSpec()
    const tampered: TeamBundleSpec = {
      ...spec,
      skills: [
        {
          ...spec.skills[0]!,
          files: [{ path: 'SKILL.md', encoding: 'utf8', content: '# 篡改' }, ...spec.skills[0]!.files.filter((f) => f.path !== 'SKILL.md')],
        },
      ],
    }
    const installer = new TeamBundleInstaller(deps)
    await expect(installer.materialize(tampered, meta)).rejects.toThrow('校验和不匹配')
  })

  it('rewriteGraphReferences 按 agentIdMap 改写节点引用（含 loop.body）', () => {
    const graph = {
      nodes: [
        { id: 'n1', config: { agentId: 'agent-1', skillIds: ['skill-1'], mcpServerIds: ['mcp-1'] } },
        { id: 'n2', config: { body: { nodes: [{ id: 'n3', config: { agentId: 'agent-1' } }], edges: [] } } },
      ],
      edges: [],
    }
    const out = rewriteGraphReferences(
      graph as unknown as Parameters<typeof rewriteGraphReferences>[0],
      {
        skillIdMap: new Map([['skill-1', 'bundle:b:s']]),
        mcpServerIdMap: new Map([['mcp-1', 'mcp-new']]),
        agentIdMap: new Map([['agent-1', 'team-agent-b-aaaa']]),
      },
    ) as unknown as typeof graph
    expect((out.nodes[0]!.config as { agentId: string }).agentId).toBe('team-agent-b-aaaa')
    expect((out.nodes[0]!.config as { skillIds: string[] }).skillIds).toEqual(['bundle:b:s'])
    expect((out.nodes[0]!.config as { mcpServerIds: string[] }).mcpServerIds).toEqual(['mcp-new'])
    const body = (out.nodes[1]!.config as { body: { nodes: Array<{ config: { agentId: string } }> } }).body
    expect(body.nodes[0]!.config.agentId).toBe('team-agent-b-aaaa')
  })
})
