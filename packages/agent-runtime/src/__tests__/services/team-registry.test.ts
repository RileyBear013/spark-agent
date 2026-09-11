import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TEAM_ASSET_SCHEMA,
  canonicalJson,
  computePayloadChecksum,
  computeSkillFilesChecksum,
  parseTeamAssetEnvelope,
  compareSemver,
  classifyTeamAssetState,
  bumpPatchVersion,
} from '../../services/team-registry/types.js'
import { collectSkillFiles, emptySkillDirError } from '../../services/team-registry/index.js'
import { NacosClient } from '../../services/team-registry/nacos-client.js'
import {
  NacosTeamAdapter,
  teamManifestUrl,
  slugFromTeamManifestUrl,
} from '../../services/skill-registry/nacos-team-adapter.js'
import type { TeamRegistryService } from '../../services/team-registry/index.js'

// ─── 信封与 checksum ────────────────────────────────────────────────────

describe('team-registry types', () => {
  it('canonicalJson 与键序无关（两侧机器序列化一致）', () => {
    const a = { b: 1, a: { d: [3, 2], c: 'x' } }
    const b = { a: { c: 'x', d: [3, 2] }, b: 1 }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(computePayloadChecksum(a)).toBe(computePayloadChecksum(b))
  })

  it('checksum 对内容敏感', () => {
    expect(computePayloadChecksum({ x: 1 })).not.toBe(computePayloadChecksum({ x: 2 }))
  })

  it('parseTeamAssetEnvelope：合法信封往返', () => {
    const payload = { kind: 'skill-files', files: [{ path: 'SKILL.md', content: 'hi' }] }
    const envelope = {
      schema: TEAM_ASSET_SCHEMA,
      assetType: 'skill',
      slug: 'demo',
      name: 'Demo',
      version: '1.0.0',
      author: 'u',
      description: 'd',
      updatedAt: '2026-09-10T00:00:00.000Z',
      checksum: computePayloadChecksum(payload),
      payload,
    }
    const parsed = parseTeamAssetEnvelope(JSON.stringify(envelope))
    expect(parsed?.slug).toBe('demo')
    expect(parsed?.payload.files[0]?.path).toBe('SKILL.md')
  })

  it('parseTeamAssetEnvelope：损坏/篡改/缺字段 → null', () => {
    const payload = { kind: 'skill-files', files: [] }
    const base = {
      schema: TEAM_ASSET_SCHEMA,
      assetType: 'skill',
      slug: 'demo',
      version: '1.0.0',
      checksum: computePayloadChecksum(payload),
      payload,
    }
    expect(parseTeamAssetEnvelope('not-json')).toBeNull()
    // checksum 被篡改
    expect(
      parseTeamAssetEnvelope(JSON.stringify({ ...base, checksum: 'deadbeef' })),
    ).toBeNull()
    // payload 被篡改（checksum 不匹配）
    expect(
      parseTeamAssetEnvelope(JSON.stringify({ ...base, payload: { kind: 'skill-files', files: [{ path: 'x', content: 'y' }] } })),
    ).toBeNull()
    // 缺 schema
    expect(parseTeamAssetEnvelope(JSON.stringify({ ...base, schema: 'other' }))).toBeNull()
  })

  it('compareSemver：宽松解析 + 回退', () => {
    expect(compareSemver('1.2.3', '1.2.10')).toBe(-1)
    expect(compareSemver('1.2', '1.2.0')).toBe(0)
    expect(compareSemver('v2', '1.9.9')).toBe(1)
    expect(compareSemver('abc', 'abd')).toBe(-1) // 非法 → 字符串回退
  })

  it('classifyTeamAssetState：六态判定顺序', () => {
    const base = {
      localChecksum: 'aaa',
      installedChecksum: 'aaa',
      installedVersion: '1.0.0',
      remoteVersion: '1.0.1',
      remoteChecksum: 'bbb',
    }
    // 未安装
    expect(
      classifyTeamAssetState({ ...base, installedVersion: null, installedChecksum: null }),
    ).toBe('not-installed')
    // 本地 == 远端（即便版本号写着不一致）→ up-to-date
    expect(classifyTeamAssetState({ ...base, localChecksum: 'bbb' })).toBe('up-to-date')
    // 本地已改 → local-modified 优先于 remote-newer
    expect(classifyTeamAssetState({ ...base, localChecksum: 'ccc' })).toBe('local-modified')
    // 远端更高
    expect(classifyTeamAssetState({ ...base })).toBe('remote-newer')
    // 本地更高
    expect(classifyTeamAssetState({ ...base, remoteVersion: '0.9.0' })).toBe('local-newer')
    // 版本同、内容异
    expect(classifyTeamAssetState({ ...base, remoteVersion: '1.0.0' })).toBe(
      'version-equal-content-differs',
    )
  })

  it('bumpPatchVersion', () => {
    expect(bumpPatchVersion(null)).toBe('1.0.0')
    expect(bumpPatchVersion('')).toBe('1.0.0')
    expect(bumpPatchVersion('1.2.3')).toBe('1.2.4')
    expect(bumpPatchVersion('1.2')).toBe('1.2.1')
    expect(bumpPatchVersion('v1')).toBe('1.0.1')
    expect(bumpPatchVersion('xxx')).toBe('1.0.0')
  })

  it('computeSkillFilesChecksum 与 canonical 规则一致', () => {
    const files = [{ path: 'SKILL.md', content: 'a' }, { path: 'b/c.md', content: 'd' }]
    expect(computeSkillFilesChecksum(files)).toBe(
      computePayloadChecksum({ kind: 'skill-files', files }),
    )
  })
})

// ─── collectSkillFiles（本地目录 → 文件树） ─────────────────────────────

describe('collectSkillFiles', () => {
  it('收集文本文件，跳过二进制 / .git / .tmp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-skill-'))
    try {
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo\n---\nbody', 'utf-8')
      mkdirSync(join(dir, 'scripts'))
      writeFileSync(join(dir, 'scripts', 'run.md'), 'docs', 'utf-8')
      mkdirSync(join(dir, '.git'))
      writeFileSync(join(dir, '.git', 'config'), 'should-ignore', 'utf-8')
      writeFileSync(join(dir, 'scratch.tmp'), 'temp', 'utf-8')
      // 含 NUL 的二进制文件
      writeFileSync(join(dir, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]))

      const { files, skipped } = collectSkillFiles(dir)
      const paths = files.map((f) => f.path).sort()
      expect(paths).toEqual(['SKILL.md', 'scripts/run.md'])
      const reasons = Object.fromEntries(skipped.map((x) => [x.path, x.reason]))
      // .git 目录整体被跳过（不再深入子文件），记录的是目录本身
      expect(reasons['.git']).toBe('ignored')
      expect(reasons['scratch.tmp']).toBe('ignored')
      expect(reasons['icon.png']).toBe('binary')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── emptySkillDirError（空目录诊断） ──────────────────────────────────

describe('emptySkillDirError', () => {
  it('目录真空：给出重装/白名单指引', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-skill-empty-'))
    try {
      const err = emptySkillDirError(dir, [])
      expect(err.message).toContain('内容为空')
      expect(err.message).toContain('重新安装')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目录不可读（已被删除）：按真空处理', () => {
    const missing = join(tmpdir(), 'team-skill-gone-' + Date.now())
    const err = emptySkillDirError(missing, [])
    expect(err.message).toContain('内容为空')
  })

  it('全部被过滤：错误里带跳过统计', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-skill-bin-'))
    try {
      writeFileSync(join(dir, 'icon.png'), Buffer.from([0x00, 0x01]))
      const { skipped } = collectSkillFiles(dir)
      expect(skipped.length).toBeGreaterThan(0)
      const err = emptySkillDirError(dir, skipped)
      expect(err.message).toContain('全部被跳过')
      expect(err.message).toContain('binary=1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── NacosClient（mock fetch） ──────────────────────────────────────────

interface MockCall {
  url: string
  method: string
  body?: string
  authHeader?: string
}

function makeMockFetch(
  handlers: Array<{ match: (url: string, method: string) => boolean; respond: () => { status: number; body: string } }>,
  calls: MockCall[],
) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url)
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call: MockCall = {
      url: urlStr,
      method,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      ...(headers.Authorization ? { authHeader: headers.Authorization } : {}),
    }
    calls.push(call)
    for (const h of handlers) {
      if (!h.match(urlStr, method)) continue
      const res = h.respond()
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        text: async () => res.body,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response
    }
    return { ok: false, status: 404, text: async () => 'not found' } as unknown as Response
  }) as unknown as typeof fetch
}

describe('NacosClient', () => {
  const baseOpts = {
    serverUrl: 'http://nacos.test:8080',
    namespace: 'public',
    username: 'nacos',
    password: 'pass',
  }

  it('登录换 token，后续请求带 Bearer；token 缓存不重复登录', async () => {
    const calls: MockCall[] = []
    let loginCount = 0
    const fetchImpl = makeMockFetch(
      [
        {
          match: (url, method) => url.endsWith('/v3/auth/user/login') && method === 'POST',
          respond: () => {
            loginCount += 1
            return {
              status: 200,
              body: JSON.stringify({ code: 0, data: { accessToken: 'tk-1', tokenTtlMs: 600000 } }),
            }
          },
        },
        {
          match: (url) => url.includes('/v3/console/cs/config/list'),
          respond: () => ({
            status: 200,
            body: JSON.stringify({
              code: 0,
              data: { pageItems: [{ dataId: 'skill/demo', groupName: 'SPARK_TEAM' }] },
            }),
          }),
        },
      ],
      calls,
    )
    const client = new NacosClient({ ...baseOpts, fetchImpl })
    const items = await client.listConfigs({ pageSize: 10 })
    expect(items.map((i) => i.dataId)).toEqual(['skill/demo'])
    await client.listConfigs({ pageSize: 10 })
    expect(loginCount).toBe(1) // 第二次复用缓存 token
    const listCall = calls.find((c) => c.url.includes('config/list'))
    expect(listCall?.authHeader).toBe('Bearer tk-1')
  })

  it('getConfig：业务 code config not exist → null；其他业务错误 → 抛错并带服务端消息', async () => {
    const calls: MockCall[] = []
    const fetchImpl = makeMockFetch(
      [
        {
          match: (url) => url.endsWith('/v3/auth/user/login'),
          respond: () => ({
            status: 200,
            body: JSON.stringify({ code: 0, data: { accessToken: 'tk' } }),
          }),
        },
        {
          match: (url) => url.includes('/v3/console/cs/config?') && url.includes('dataId=gone'),
          respond: () => ({
            status: 200,
            body: JSON.stringify({ code: 30000, message: 'config not exist' }),
          }),
        },
        {
          match: (url) => url.includes('/v3/console/cs/config?') && url.includes('dataId=boom'),
          respond: () => ({
            status: 200,
            body: JSON.stringify({ code: 500, message: 'namespace not found' }),
          }),
        },
        {
          match: (url) => url.includes('/v3/console/cs/config?'),
          respond: () => ({
            status: 200,
            body: JSON.stringify({
              code: 0,
              data: { content: '{"schema":"x"}', md5: 'm', type: 'JSON' },
            }),
          }),
        },
      ],
      calls,
    )
    const client = new NacosClient({ ...baseOpts, fetchImpl })
    await expect(client.getConfig('gone')).resolves.toBeNull()
    await expect(client.getConfig('boom')).rejects.toThrow(/namespace not found/)
    const ok = await client.getConfig('other')
    expect(ok?.content).toBe('{"schema":"x"}')
  })

  it('publishConfig：POST JSON，body 含 dataId/groupName/content', async () => {
    const calls: MockCall[] = []
    const fetchImpl = makeMockFetch(
      [
        {
          match: (url) => url.endsWith('/v3/auth/user/login'),
          respond: () => ({
            status: 200,
            body: JSON.stringify({ code: 0, data: { accessToken: 'tk' } }),
          }),
        },
        {
          match: (url, method) => url.endsWith('/v3/console/cs/config') && method === 'POST',
          respond: () => ({ status: 200, body: JSON.stringify({ code: 0, data: true }) }),
        },
      ],
      calls,
    )
    const client = new NacosClient({ ...baseOpts, fetchImpl })
    await client.publishConfig({ dataId: 'skill/demo', content: '{}' })
    const publishCall = calls.find((c) => c.method === 'POST' && c.url.includes('/cs/config'))
    expect(publishCall).toBeDefined()
    const body = JSON.parse(publishCall!.body!) as Record<string, string>
    expect(body.dataId).toBe('skill/demo')
    expect(body.groupName).toBe('SPARK_TEAM')
    expect(body.namespaceId).toBe('public')
    expect(body.content).toBe('{}')
  })

  it('401 后自动重登重试一轮', async () => {
    const calls: MockCall[] = []
    let listCalls = 0
    const fetchImpl = makeMockFetch(
      [
        {
          match: (url) => url.endsWith('/v3/auth/user/login'),
          respond: () => ({
            status: 200,
            body: JSON.stringify({ code: 0, data: { accessToken: 'tk-fresh' } }),
          }),
        },
        {
          match: (url) => url.includes('/v3/console/server/state'),
          respond: () => ({ status: 200, body: JSON.stringify({ code: 0 }) }),
        },
        {
          match: (url) => url.includes('config/list'),
          respond: () => {
            listCalls += 1
            if (listCalls === 1) return { status: 401, body: 'Unauthorized' }
            return {
              status: 200,
              body: JSON.stringify({ code: 0, data: { pageItems: [] } }),
            }
          },
        },
      ],
      calls,
    )
    const client = new NacosClient({ ...baseOpts, fetchImpl })
    await client.ensureToken() // 先登录一次（tk-fresh #1）
    const items = await client.listConfigs()
    expect(items).toEqual([])
    expect(listCalls).toBe(2) // 401 后重试成功
  })
})

// ─── NacosTeamAdapter（未配置降级） ─────────────────────────────────────

describe('NacosTeamAdapter', () => {
  it('未配置：healthCheck 不健康且带提示；search 返回空不抛错', async () => {
    const stub = {
      client: async () => null,
      listEnvelopes: async () => {
        throw new Error('should not reach here')
      },
    } as unknown as TeamRegistryService
    const adapter = new NacosTeamAdapter(stub)
    const health = await adapter.healthCheck()
    expect(health.healthy).toBe(false)
    expect(health.error).toContain('未配置')
    const result = await adapter.search('demo')
    expect(result).toEqual({ skills: [], total: 0 })
  })

  it('manifestUrl 编解码往返', () => {
    const url = teamManifestUrl('release-inspection')
    expect(url).toBe('team://skill/release-inspection')
    expect(slugFromTeamManifestUrl(url)).toBe('release-inspection')
    expect(slugFromTeamManifestUrl('https://other')).toBeNull()
  })
})
