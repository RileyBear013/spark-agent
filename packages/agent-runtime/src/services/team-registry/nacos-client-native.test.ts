import { describe, expect, it } from 'vitest'
import { NacosClient } from './nacos-client.js'

// ─── mock fetch 设施 ─────────────────────────────────────────────────────

interface MockCall {
  url: string
  method: string
  contentType?: string
  bodyText: string
  authHeader?: string
}

interface MockHandler {
  match: (url: string, method: string, call: MockCall) => boolean
  respond: (call: MockCall) => { status: number; body?: string; buffer?: Buffer }
}

function makeMockFetch(handlers: MockHandler[], calls: MockCall[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url)
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const rawBody = init?.body
    const bodyText =
      typeof rawBody === 'string'
        ? rawBody
        : rawBody == null
          ? ''
          : Buffer.from(rawBody as Uint8Array).toString('utf-8')
    const call: MockCall = {
      url: urlStr,
      method,
      bodyText,
      ...(headers['Content-Type'] ? { contentType: headers['Content-Type'] } : {}),
      ...(headers.Authorization ? { authHeader: headers.Authorization } : {}),
    }
    calls.push(call)
    for (const h of handlers) {
      if (!h.match(urlStr, method, call)) continue
      const res = h.respond(call)
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        text: async () => res.body ?? '',
        arrayBuffer: async () =>
          res.buffer != null
            ? res.buffer.buffer.slice(
                res.buffer.byteOffset,
                res.buffer.byteOffset + res.buffer.byteLength,
              )
            : new ArrayBuffer(0),
      } as unknown as Response
    }
    return { ok: false, status: 404, text: async () => 'not found' } as unknown as Response
  }) as unknown as typeof fetch
}

function loginHandler(token = 'tk-1'): MockHandler {
  return {
    match: (url) => url.endsWith('/v3/auth/user/login'),
    respond: () => ({
      status: 200,
      body: JSON.stringify({ code: 0, data: { accessToken: token, tokenTtl: 1_000_000 } }),
    }),
  }
}

const baseOpts = {
  serverUrl: 'http://nacos.test:8080',
  namespace: 'public',
  username: 'nacos',
  password: 'pass',
}

// ─── 原生 Skill API ─────────────────────────────────────────────────────

describe('NacosClient 原生 Skill API（mock）', () => {
  it('precheck/upload 走 multipart（file+namespaceId 字段齐备），upload 附 overwrite/commitMsg', async () => {
    const calls: MockCall[] = []
    const zip = Buffer.from('fake-zip-bytes')
    const fetchImpl = makeMockFetch(
      [
        loginHandler(),
        {
          match: (url) => url.endsWith('/v3/console/ai/skills/upload/precheck'),
          respond: () => ({
            status: 200,
            body: JSON.stringify({
              code: 0,
              data: [
                {
                  skillName: 'demo',
                  targetVersion: '1.0.1',
                  parsedVersion: '1.0.1',
                  precheckCode: 'READY',
                  reason: null,
                  exists: true,
                  maxPublishedVersion: '1.0.0',
                  editingVersion: null,
                  reviewingVersion: null,
                  entryPath: '',
                  owner: null,
                },
              ],
            }),
          }),
        },
        {
          match: (url) => url.endsWith('/v3/console/ai/skills/upload'),
          respond: () => ({ status: 200, body: JSON.stringify({ code: 0, data: 'demo' }) }),
        },
      ],
      calls,
    )
    const client = new NacosClient({ ...baseOpts, fetchImpl })
    const pre = await client.precheckTeamSkillUpload(zip)
    expect(pre?.precheckCode).toBe('READY')
    expect(pre?.exists).toBe(true)
    await client.uploadTeamSkillZip({ zip, overwrite: true, commitMsg: 'msg-1' })

    const preCall = calls.find((c) => c.url.endsWith('/upload/precheck'))!
    expect(preCall.method).toBe('POST')
    expect(preCall.contentType).toContain('multipart/form-data; boundary=')
    expect(preCall.bodyText).toContain('name="file"')
    expect(preCall.bodyText).toContain('name="namespaceId"')
    expect(preCall.bodyText).toContain('public')
    expect(preCall.authHeader).toBe('Bearer tk-1')

    const upCall = calls.find((c) => c.url.endsWith('/skills/upload'))!
    expect(upCall.bodyText).toContain('name="overwrite"')
    expect(upCall.bodyText).toContain('true')
    expect(upCall.bodyText).toContain('msg-1')
  })

  it('submit/publish/online/scope 走 form 编码，字段正确', async () => {
    const calls: MockCall[] = []
    const fetchImpl = makeMockFetch(
      [
        loginHandler(),
        {
          match: (url, method) => url.includes('/ai/skills/') && method === 'POST',
          respond: () => ({ status: 200, body: JSON.stringify({ code: 0, data: null }) }),
        },
        {
          match: (url, method) => url.includes('/ai/skills/scope') && method === 'PUT',
          respond: () => ({ status: 200, body: JSON.stringify({ code: 0, data: null }) }),
        },
      ],
      calls,
    )
    const client = new NacosClient({ ...baseOpts, fetchImpl })
    await client.submitTeamSkillVersion('demo', '1.0.0')
    await client.publishTeamSkillVersion('demo', '1.0.0')
    await client.onlineTeamSkillVersion('demo', '1.0.0')
    await client.setTeamSkillScope('demo', 'PUBLIC')

    const sub = calls.find((c) => c.url.endsWith('/skills/submit'))!
    expect(sub.contentType).toBe('application/x-www-form-urlencoded')
    expect(sub.bodyText).toContain('skillName=demo')
    expect(sub.bodyText).toContain('version=1.0.0')
    expect(sub.bodyText).toContain('namespaceId=public')
    expect(calls.some((c) => c.url.endsWith('/skills/publish'))).toBe(true)
    expect(calls.some((c) => c.url.endsWith('/skills/online'))).toBe(true)
    const scope = calls.find((c) => c.url.endsWith('/skills/scope'))!
    expect(scope.method).toBe('PUT')
    expect(scope.bodyText).toContain('scope=PUBLIC')
  })

  it('getTeamSkill 解析 versions/scope；业务 skill not exist → null', async () => {
    const calls: MockCall[] = []
    const fetchImpl = makeMockFetch(
      [
        loginHandler(),
        {
          match: (url) => url.includes('/v3/console/ai/skills?') && url.includes('skillName=ok'),
          respond: () => ({
            status: 200,
            body: JSON.stringify({
              code: 0,
              data: {
                skillName: 'ok',
                name: 'Demo',
                scope: 'PUBLIC',
                description: 'd',
                versions: [
                  { version: '1.0.0', status: 'online' },
                  { version: '0.9.0', status: 'draft' },
                ],
              },
            }),
          }),
        },
        {
          match: (url) => url.includes('/v3/console/ai/skills?') && url.includes('skillName=gone'),
          respond: () => ({
            status: 200,
            body: JSON.stringify({ code: 404, message: 'skill not exist' }),
          }),
        },
      ],
      calls,
    )
    const client = new NacosClient({ ...baseOpts, fetchImpl })
    const detail = await client.getTeamSkill('ok')
    expect(detail?.skillName).toBe('ok')
    expect(detail?.scope).toBe('PUBLIC')
    expect(detail?.versions).toEqual([
      { version: '1.0.0', status: 'online' },
      { version: '0.9.0', status: 'draft' },
    ])
    await expect(client.getTeamSkill('gone')).resolves.toBeNull()
  })

  it('downloadTeamSkillVersion 返回二进制 Buffer', async () => {
    const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
    const calls: MockCall[] = []
    const fetchImpl = makeMockFetch(
      [
        loginHandler(),
        {
          match: (url) => url.includes('/skills/version/download'),
          respond: () => ({ status: 200, buffer: zipBytes }),
        },
      ],
      calls,
    )
    const client = new NacosClient({ ...baseOpts, fetchImpl })
    const buf = await client.downloadTeamSkillVersion('demo', '1.0.0')
    expect(Buffer.compare(buf, zipBytes)).toBe(0)
    const dl = calls.find((c) => c.url.includes('/skills/version/download'))!
    expect(dl.url).toContain('skillName=demo')
    expect(dl.url).toContain('version=1.0.0')
  })
})

// ─── 原生 MCP API ───────────────────────────────────────────────────────

describe('NacosClient 原生 MCP API（mock）', () => {
  it('listTeamMcpServers 必带 search 参数', async () => {
    const calls: MockCall[] = []
    const fetchImpl = makeMockFetch(
      [
        loginHandler(),
        {
          match: (url) => url.includes('/v3/console/ai/mcp/list'),
          respond: () => ({
            status: 200,
            body: JSON.stringify({
              code: 0,
              data: {
                pageItems: [{ mcpName: 'svc-a', name: 'Svc A', version: '1.0.0', description: 'x' }],
              },
            }),
          }),
        },
      ],
      calls,
    )
    const client = new NacosClient({ ...baseOpts, fetchImpl })
    const items = await client.listTeamMcpServers()
    expect(items).toHaveLength(1)
    const call = calls.find((c) => c.url.includes('/mcp/list'))!
    expect(call.url).toContain('search=blur')
  })

  it('createTeamMcpDraft 走 form，字段含 serverSpecification；delete 走 DELETE', async () => {
    const calls: MockCall[] = []
    const fetchImpl = makeMockFetch(
      [
        loginHandler(),
        {
          match: (url, method) => url.endsWith('/v3/console/ai/mcp/draft') && method === 'POST',
          respond: () => ({ status: 200, body: JSON.stringify({ code: 0, data: null }) }),
        },
        {
          match: (url, method) => url.includes('/v3/console/ai/mcp?') && method === 'DELETE',
          respond: () => ({ status: 200, body: JSON.stringify({ code: 0, data: true }) }),
        },
      ],
      calls,
    )
    const client = new NacosClient({ ...baseOpts, fetchImpl })
    await client.createTeamMcpDraft({
      namespaceId: 'public',
      mcpName: 'svc-a',
      version: '1.0.0',
      serverSpecification: '{"protocol":"stdio"}',
    })
    const draft = calls.find((c) => c.url.endsWith('/mcp/draft'))!
    expect(draft.contentType).toBe('application/x-www-form-urlencoded')
    expect(draft.bodyText).toContain('mcpName=svc-a')
    expect(draft.bodyText).toContain('serverSpecification=')
    await client.deleteTeamMcpServer('svc-a')
    const del = calls.find((c) => c.method === 'DELETE')!
    expect(del.url).toContain('mcpName=svc-a')
  })

  it('getTeamMcpServer 解析 spec 与 versions', async () => {
    const fetchImpl = makeMockFetch(
      [
        loginHandler(),
        {
          match: (url) => url.includes('/v3/console/ai/mcp?') && url.includes('mcpName=svc-a'),
          respond: () => ({
            status: 200,
            body: JSON.stringify({
              code: 0,
              data: {
                mcpName: 'svc-a',
                description: 'd',
                versions: [{ version: '1.0.0', status: 'online' }],
                serverSpecification: { protocol: 'stdio', localServerConfig: { command: 'npx' } },
              },
            }),
          }),
        },
      ],
      [],
    )
    const client = new NacosClient({ ...baseOpts, fetchImpl })
    const detail = await client.getTeamMcpServer('svc-a')
    expect(detail?.serverSpecification).toEqual({
      protocol: 'stdio',
      localServerConfig: { command: 'npx' },
    })
    expect(detail?.versions).toEqual([{ version: '1.0.0', status: 'online' }])
  })

  it('401 自动重登后重试一轮（写端点）', async () => {
    const calls: MockCall[] = []
    let submitCalls = 0
    const fetchImpl = makeMockFetch(
      [
        loginHandler('tk-fresh'),
        {
          match: (url, method) => url.endsWith('/ai/mcp/submit') && method === 'POST',
          respond: () => {
            submitCalls += 1
            if (submitCalls === 1) return { status: 401, body: 'token expired' }
            return { status: 200, body: JSON.stringify({ code: 0, data: null }) }
          },
        },
      ],
      calls,
    )
    const client = new NacosClient({ ...baseOpts, fetchImpl })
    await client.submitTeamMcpVersion('svc-a', '1.0.0')
    expect(submitCalls).toBe(2)
  })
})
