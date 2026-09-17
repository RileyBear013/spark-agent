import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { FetchLike } from '../../src/llm/http/client.js'
import { isOpenableUrl } from '../../src/platform/browser.js'
import type { PlatformSession } from '../../src/platform/credentials.js'
import {
  EduServerClient,
  PlatformApiError,
  PlatformAuthExpiredError,
  PlatformUnavailableError,
} from '../../src/platform/edu-server-client.js'
import { PlatformLoginError, runPlatformLogin } from '../../src/platform/login-flow.js'

interface RecordedCall {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

interface TestInit {
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string
  readonly signal?: AbortSignal
}

/** The client only ever calls fetch with a string url and a plain init object. */
function readInit(init: unknown): TestInit {
  return typeof init === 'object' && init !== null ? init : {}
}

function fakeFetch(handler: (call: RecordedCall) => Response | Promise<Response>): {
  readonly fetch: FetchLike
  readonly calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (input: unknown, init: unknown) => {
    if (typeof input !== 'string') throw new Error('fetch stub expects a string url')
    const rawInit = readInit(init)
    const call: RecordedCall = {
      url: input,
      method: rawInit.method ?? 'GET',
      headers: { ...(rawInit.headers ?? {}) },
      body: rawInit.body === undefined ? undefined : (JSON.parse(rawInit.body) as unknown),
    }
    calls.push(call)
    return await handler(call)
  }
  return { fetch: fetchImpl, calls }
}

function envelope(
  data: unknown,
  init: { readonly status?: number; readonly code?: number; readonly message?: string } = {},
): Response {
  const payload: Record<string, unknown> = { code: init.code ?? 0, data }
  if (init.message !== undefined) payload.message = init.message
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

const SESSION: PlatformSession = { token: 'access-1', refreshToken: 'refresh-1', userId: '42' }

describe('EduServerClient', () => {
  it('reads the public client config and tolerates a missing web login url', async () => {
    const { fetch, calls } = fakeFetch((call) => {
      if (call.url.endsWith('/client-config'))
        return envelope({ webLoginUrl: 'https://web.example.com/login' })
      return envelope({})
    })
    const client = new EduServerClient({ baseUrl: 'https://spark.example.com/', fetch: fetch })
    expect(await client.getClientConfig()).toEqual({ webLoginUrl: 'https://web.example.com/login' })
    expect(calls[0]?.url).toBe('https://spark.example.com/api/v1/client-config')

    const empty = new EduServerClient({
      baseUrl: 'https://spark.example.com/',
      fetch: fakeFetch(() => envelope({})).fetch,
    })
    expect(await empty.getClientConfig()).toEqual({})
  })

  it('maps business envelope failures and non-JSON responses to PlatformApiError', async () => {
    const business = new EduServerClient({
      baseUrl: 'https://spark.example.com/',
      fetch: fakeFetch(() => envelope(null, { code: 1001, message: 'captcha required' })).fetch,
    })
    await expect(business.getClientConfig()).rejects.toThrow('captcha required')

    const html = new EduServerClient({
      baseUrl: 'https://spark.example.com/',
      fetch: fakeFetch(() => new Response('<html>nope</html>', { status: 502 })).fetch,
    })
    await expect(html.getClientConfig()).rejects.toThrow(PlatformApiError)
  })

  it('polls the desktop login binding and rejects unknown statuses', async () => {
    const pending = new EduServerClient({
      baseUrl: 'https://spark.example.com/',
      fetch: fakeFetch(() => envelope({ status: 'pending' })).fetch,
    })
    expect(await pending.pollDesktopLogin('abc')).toBe('pending')

    const broken = new EduServerClient({
      baseUrl: 'https://spark.example.com/',
      fetch: fakeFetch(() => envelope({ status: 'wat' })).fetch,
    })
    await expect(broken.pollDesktopLogin('abc')).rejects.toThrow(
      /Unexpected desktop login poll status/u,
    )
  })

  it('unwraps the account profile from /me', async () => {
    const { fetch, calls } = fakeFetch(() =>
      envelope({
        id: 7,
        account: 'cli@example.com',
        nickname: 'CLI User',
        role: 'user',
        avatarUrl: 'https://a/b.png',
      }),
    )
    const client = new EduServerClient({
      baseUrl: 'https://spark.example.com/',
      fetch: fetch,
      session: SESSION,
    })
    expect(await client.getMe()).toEqual({
      id: 7,
      account: 'cli@example.com',
      nickname: 'CLI User',
      role: 'user',
    })
    expect(calls[0]?.headers.Authorization).toBe('Bearer access-1')
  })

  it('refreshes once on 401, replays the request, and reports the rotated session', async () => {
    const refreshed: PlatformSession[] = []
    const { fetch, calls } = fakeFetch((call) => {
      if (call.url.endsWith('/auth/refresh'))
        return envelope({ token: 'access-2', refreshToken: 'refresh-2' })
      if (call.headers.Authorization === 'Bearer access-2') {
        return envelope({ id: 7, account: 'cli@example.com', nickname: 'CLI User', role: 'user' })
      }
      return envelope(null, { status: 401, message: 'token expired' })
    })
    const client = new EduServerClient({
      baseUrl: 'https://spark.example.com/',
      fetch: fetch,
      session: SESSION,
      onSessionRefreshed: (session) => {
        refreshed.push(session)
      },
    })

    expect(await client.getMe()).toMatchObject({ id: 7 })
    expect(calls.map((call) => call.url)).toEqual([
      'https://spark.example.com/api/v1/me',
      'https://spark.example.com/api/v1/auth/refresh',
      'https://spark.example.com/api/v1/me',
    ])
    // The server omitted userId; the previous identity must survive the rotation.
    expect(refreshed).toEqual([{ token: 'access-2', refreshToken: 'refresh-2', userId: '42' }])
    expect(client.session?.token).toBe('access-2')
  })

  it('fails closed when the refresh itself is rejected', async () => {
    const { fetch } = fakeFetch((call) => {
      if (call.url.endsWith('/auth/refresh')) {
        return envelope(null, { code: 401, message: 'refresh token revoked' })
      }
      return envelope(null, { status: 401 })
    })
    const client = new EduServerClient({
      baseUrl: 'https://spark.example.com/',
      fetch: fetch,
      session: SESSION,
    })

    await expect(client.getMe()).rejects.toBeInstanceOf(PlatformAuthExpiredError)
    expect(client.session).toBeNull()
  })

  it('keeps a valid session when the refresh fails on transport instead of auth', async () => {
    const refreshed: PlatformSession[] = []
    const { fetch } = fakeFetch((call) => {
      if (call.url.endsWith('/auth/refresh')) throw new Error('ECONNRESET')
      return envelope(null, { status: 401 })
    })
    const client = new EduServerClient({
      baseUrl: 'https://spark.example.com/',
      fetch: fetch,
      session: SESSION,
      onSessionRefreshed: (session) => {
        refreshed.push(session)
      },
    })

    await expect(client.getMe()).rejects.toBeInstanceOf(PlatformUnavailableError)
    // A network blip must not delete a working credential.
    expect(client.session).toEqual(SESSION)
    expect(refreshed).toEqual([])
  })

  it('surfaces transport failures and timeouts as PlatformUnavailableError', async () => {
    const offline = new EduServerClient({
      baseUrl: 'https://spark.example.com/',
      fetch: () => Promise.reject(new Error('ENOTFOUND')),
    })
    await expect(offline.getClientConfig()).rejects.toThrow(PlatformUnavailableError)

    const hanging = new EduServerClient({
      baseUrl: 'https://spark.example.com/',
      timeoutMs: 10,
      fetch: (_input: unknown, init: unknown) =>
        new Promise<Response>((_resolve, reject) => {
          readInit(init).signal?.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        }),
    })
    await expect(hanging.getClientConfig()).rejects.toThrow(/timed out after 10ms/u)
  })
})

interface LoginClientStub {
  readonly statuses: readonly ('pending' | 'bound' | 'expired')[]
  readonly pollError?: Error
  readonly exchange?: (input: {
    readonly state: string
    readonly codeVerifier: string
  }) => PlatformSession
  readonly clientConfig?: { readonly webLoginUrl?: string }
  readonly clientConfigError?: Error
}

function loginClient(stub: LoginClientStub): {
  readonly client: Parameters<typeof runPlatformLogin>[0]['client']
  readonly polls: string[]
  readonly exchanges: { readonly state: string; readonly codeVerifier: string }[]
} {
  const polls: string[] = []
  const exchanges: { readonly state: string; readonly codeVerifier: string }[] = []
  let index = 0
  return {
    polls,
    exchanges,
    client: {
      getClientConfig: async () => {
        if (stub.clientConfigError !== undefined) throw stub.clientConfigError
        return stub.clientConfig ?? {}
      },
      pollDesktopLogin: async (state: string) => {
        polls.push(state)
        if (stub.pollError !== undefined && polls.length === 1) throw stub.pollError
        const status = stub.statuses[Math.min(index, stub.statuses.length - 1)] ?? 'pending'
        index += 1
        return status
      },
      exchangeDesktopLogin: async (input: {
        readonly state: string
        readonly codeVerifier: string
      }) => {
        exchanges.push(input)
        return stub.exchange?.(input) ?? SESSION
      },
    },
  }
}

describe('runPlatformLogin', () => {
  it('opens the login page with a PKCE challenge and exchanges the bound state once', async () => {
    const { client, polls, exchanges } = loginClient({ statuses: ['pending', 'bound'] })
    const opened: string[] = []
    const sleeps: number[] = []
    let clock = 0

    const result = await runPlatformLogin({
      client,
      webLoginUrl: 'https://web.example.com/login',
      openExternal: async (url) => {
        opened.push(url)
        return true
      },
      pollIntervalMs: 25,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
    })

    expect(result.opened).toBe(true)
    expect(result.session).toEqual(SESSION)
    expect(polls).toHaveLength(2)
    expect(sleeps).toEqual([25])

    const url = new URL(opened[0] ?? '')
    expect(url.origin + url.pathname).toBe('https://web.example.com/login')
    expect(url.searchParams.get('desktop')).toBe('1')
    expect(url.searchParams.get('state')).toBe(exchanges[0]?.state)
    expect(url.searchParams.get('challenge')).toBe(
      createHash('sha256')
        .update(exchanges[0]?.codeVerifier ?? '')
        .digest('hex'),
    )
  })

  it('reports the login url before waiting for the browser', async () => {
    const { client } = loginClient({ statuses: ['bound'] })
    const events: string[] = []
    const result = await runPlatformLogin({
      client,
      webLoginUrl: 'https://web.example.com/login',
      openExternal: async () => true,
      onProgress: ({ loginUrl, opened }) => {
        events.push(`progress:${String(opened)}:${loginUrl}`)
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toContain('progress:true:https://web.example.com/login?desktop=1')
    expect(result.opened).toBe(true)
  })

  it('falls back to the built-in web login page when the server config is unavailable', async () => {
    const { client } = loginClient({
      statuses: ['bound'],
      clientConfigError: new Error('offline'),
    })
    const opened: string[] = []
    const result = await runPlatformLogin({
      client,
      openExternal: async (url) => {
        opened.push(url)
        return true
      },
    })
    expect(new URL(opened[0] ?? '').origin).toBe('https://www.yiqibyte.com')
    expect(result.session).toEqual(SESSION)
  })

  it('prints the url without launching a browser when --no-browser is set', async () => {
    const { client } = loginClient({ statuses: ['bound'] })
    let opens = 0
    const result = await runPlatformLogin({
      client,
      openBrowser: false,
      openExternal: async () => {
        opens += 1
        return true
      },
    })
    expect(opens).toBe(0)
    expect(result.opened).toBe(false)
  })

  it('keeps polling after a transient poll failure', async () => {
    const { client, polls } = loginClient({
      statuses: ['bound'],
      pollError: new Error('socket hang up'),
    })
    const result = await runPlatformLogin({
      client,
      openBrowser: false,
      sleep: async () => undefined,
      pollIntervalMs: 1,
    })
    expect(polls).toHaveLength(2)
    expect(result.session).toEqual(SESSION)
  })

  it('stops with reason-specific errors on expiry, timeout, and unsafe urls', async () => {
    const expired = loginClient({ statuses: ['expired'] })
    await expect(
      runPlatformLogin({ client: expired.client, openBrowser: false }),
    ).rejects.toMatchObject({ reason: 'expired' })

    const pending = loginClient({ statuses: ['pending'] })
    let clock = 0
    await expect(
      runPlatformLogin({
        client: pending.client,
        openBrowser: false,
        timeoutMs: 30,
        pollIntervalMs: 10,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms
        },
      }),
    ).rejects.toMatchObject({ reason: 'timeout' })

    const unsafe = loginClient({ statuses: ['bound'] })
    await expect(
      runPlatformLogin({
        client: unsafe.client,
        webLoginUrl: 'http://evil.example.com/login',
        openBrowser: false,
      }),
    ).rejects.toBeInstanceOf(PlatformLoginError)
  })

  it('wraps a failed exchange with the exchange_failed reason', async () => {
    const { client } = loginClient({
      statuses: ['bound'],
      exchange: () => {
        throw new PlatformApiError('state already consumed')
      },
    })
    await expect(runPlatformLogin({ client, openBrowser: false })).rejects.toMatchObject({
      reason: 'exchange_failed',
      message: expect.stringContaining('state already consumed') as unknown as string,
    })
  })

  it('reports a launch failure without aborting the login window', async () => {
    const { client } = loginClient({ statuses: ['bound'] })
    const result = await runPlatformLogin({
      client,
      openExternal: async () => false,
      sleep: async () => undefined,
    })
    expect(result.opened).toBe(false)
  })
})

describe('openExternalUrl', () => {
  it('rejects non-https urls outside loopback before spawning a launcher', () => {
    expect(isOpenableUrl('https://web.example.com/login')).toBe(true)
    expect(isOpenableUrl('http://127.0.0.1:8080/login')).toBe(true)
    expect(isOpenableUrl('http://localhost:8080/login')).toBe(true)
    expect(isOpenableUrl('http://evil.example.com/login')).toBe(false)
    expect(isOpenableUrl('file:///etc/passwd')).toBe(false)
    expect(isOpenableUrl('javascript:alert(1)')).toBe(false)
  })
})
