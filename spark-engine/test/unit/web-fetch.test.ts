import { createServer, type RequestListener, type Server } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import {
  fetchWebPage,
  WebFetchToolExecutor,
  webFetchToolDefinition,
} from '../../src/tools/web-fetch.js'
import type { ToolCallContext } from '../../src/seams.js'
import type { ResolvedToolCall } from '../../src/tools/contract.js'

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) => {
      server.close(() => {
        resolveClose()
      })
    })
  }
})

describe('web_fetch tool', () => {
  it('fetches localhost HTML and returns readable bounded text', async () => {
    const url = await serve((request, response) => {
      expect(request.headers['user-agent']).toBe('spark-cli-web-fetch')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<html><head><style>hidden</style></head><body><h1>Hello</h1><p>A &amp; B</p><script>bad()</script></body></html>',
      )
    })

    const result = await fetchWebPage({ url })

    expect(result).toMatchObject({ status: 200, contentType: 'text/html; charset=utf-8' })
    expect(result.text).toBe('Hello\n\nA & B')
    expect(result.truncated).toBe(false)
  })

  it('rejects credential-bearing and non-HTTPS public URLs', async () => {
    await expect(fetchWebPage({ url: 'https://user:pass@example.com/docs' })).rejects.toThrow(
      'embedded URL credentials',
    )
    await expect(fetchWebPage({ url: 'http://example.com/docs' })).rejects.toThrow(
      'http is limited to localhost',
    )
  })

  it('enforces response byte and output character bounds', async () => {
    const url = await serve((_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': '2048',
      })
      response.end('x'.repeat(2048))
    })

    await expect(fetchWebPage({ url, maxBytes: 1_024 })).rejects.toThrow('exceeds 1024 bytes')

    const bounded = await fetchWebPage({ url, maxBytes: 4_096, maxChars: 1_000 })
    expect(bounded.truncated).toBe(true)
    expect(bounded.text).toContain('output truncated at 1000 characters')
  })

  it('requires external-tool approval metadata and reports malformed calls', async () => {
    expect(webFetchToolDefinition).toMatchObject({
      permissionClass: 'external',
      approval: 'always',
      concurrency: 'parallel',
    })
    const executor = new WebFetchToolExecutor()
    const call: ResolvedToolCall = {
      callId: 'call-web-fetch',
      name: 'web_fetch',
      args: { url: 'not a url' },
      definition: webFetchToolDefinition,
    }
    const context: ToolCallContext = {
      signal: new AbortController().signal,
      timeoutMs: webFetchToolDefinition.timeoutMs,
    }

    await expect(executor.execute(call, context)).resolves.toMatchObject({
      ok: false,
      content: 'web_fetch requires a valid URL',
    })
  })
})

async function serve(
  handler: RequestListener,
): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Test server has no address')
  return `http://127.0.0.1:${address.port}/page`
}
