import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MediaArtifactService } from '../../../services/media/media-artifact.service.js'
import { sameOriginAuthHeaders } from '../../../services/media/media-artifact.service.js'

describe('MediaArtifactService interface timeout', () => {
  let outputDir: string | undefined

  afterEach(async () => {
    if (outputDir) await rm(outputDir, { recursive: true, force: true })
  })

  it('aborts an image download using the configured interface timeout', async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), 'spark-media-timeout-'))
    const fetchImpl = ((_: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'))
        })
        setTimeout(() => reject(new Error('fallback timeout')), 20)
      })) as typeof fetch

    await expect(
      new MediaArtifactService().writeImage(
        { kind: 'url', value: 'https://media.example/image.png' },
        outputDir,
        'image',
        fetchImpl,
        5,
      ),
    ).rejects.toThrow('Download timed out after 5ms')
  })

  it('retries a transient image download failure without regenerating the artifact', async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), 'spark-media-retry-'))
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls === 1) {
        throw new TypeError('fetch failed', { cause: new Error('read ECONNRESET') })
      }
      return new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    }) as typeof fetch

    const asset = await new MediaArtifactService({ retryDelayMs: 1 }).writeImage(
      { kind: 'url', value: 'https://media.example/signed-image.png?token=secret' },
      outputDir,
      'image',
      fetchImpl,
      5_000,
    )

    expect(calls).toBe(2)
    expect(asset.filePath).toBeDefined()
    await expect(readFile(asset.filePath!)).resolves.toEqual(Buffer.from([1, 2, 3]))
  })

  it('does not retry a deterministic HTTP 404 artifact response', async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), 'spark-media-no-retry-'))
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response('Not Found', { status: 404 })
    }) as typeof fetch

    await expect(
      new MediaArtifactService({ retryDelayMs: 1 }).writeImage(
        { kind: 'url', value: 'https://media.example/missing.png?token=secret' },
        outputDir,
        'image',
        fetchImpl,
        5_000,
      ),
    ).rejects.toMatchObject({ code: 'artifact_download_failed', statusCode: 404 })

    expect(calls).toBe(1)
  })
})

describe('MediaArtifactService same-origin download auth', () => {
  let outputDir: string | undefined

  afterEach(async () => {
    if (outputDir) await rm(outputDir, { recursive: true, force: true })
  })

  const AUTH = { apiKey: 'sk-test-key', apiEndpoint: 'http://gateway.local:13005/v1' }

  const pngResponse = () =>
    new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })

  it('attaches a Bearer header when the artifact url shares origin with the endpoint', async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), 'spark-media-auth-'))
    let seenInit: RequestInit | undefined
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenInit = init
      return pngResponse()
    }) as typeof fetch

    await new MediaArtifactService().writeImage(
      { kind: 'url', value: 'http://gateway.local:13005/view?filename=image.png' },
      outputDir,
      'image',
      fetchImpl,
      5_000,
      AUTH,
    )

    const headers = new Headers(seenInit?.headers)
    expect(headers.get('authorization')).toBe('Bearer sk-test-key')
  })

  it('does not attach auth to cross-origin presigned urls', async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), 'spark-media-no-auth-'))
    let seenInit: RequestInit | undefined
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenInit = init
      return pngResponse()
    }) as typeof fetch

    await new MediaArtifactService().writeImage(
      {
        kind: 'url',
        value: 'https://oss.example.com/signed-image.png?UCloudPublicKey=token&Signature=sig',
      },
      outputDir,
      'image',
      fetchImpl,
      5_000,
      AUTH,
    )

    const headers = new Headers(seenInit?.headers)
    expect(headers.get('authorization')).toBeNull()
  })

  it('keeps downloads unauthenticated when no auth context is provided', () => {
    expect(
      sameOriginAuthHeaders('http://gateway.local:13005/view?filename=a.png', undefined),
    ).toBeUndefined()
    expect(
      sameOriginAuthHeaders('http://gateway.local:13005/view?filename=a.png', {
        apiKey: '',
        apiEndpoint: 'http://gateway.local:13005/v1',
      }),
    ).toBeUndefined()
  })

  it('treats endpoints with identical host but different port as cross-origin', () => {
    expect(
      sameOriginAuthHeaders('http://gateway.local:13006/view?a=1', {
        apiKey: 'sk-test-key',
        apiEndpoint: 'http://gateway.local:13005/v1',
      }),
    ).toBeUndefined()
  })
})
