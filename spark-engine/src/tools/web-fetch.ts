import { NULL_RUNTIME_LOGGER, type RuntimeLogger } from '../observability/logger.js'
import type { ToolCallContext, ToolExecutor } from '../seams.js'
import type { ResolvedToolCall, ToolDefinition, ToolOutcome } from './contract.js'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_CHARS = 30_000
const MAX_REDIRECTS = 5
const MAX_BYTES_HARD_CAP = 8 * 1024 * 1024
const MAX_CHARS_HARD_CAP = 100_000

export const webFetchToolDefinition: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch an HTTPS web page and return bounded readable text. HTTP is allowed only for localhost development; requests require external-tool approval and never send caller-supplied credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1, maxLength: 8_192 },
      timeout_ms: { type: 'integer', minimum: 1_000, maximum: 30_000 },
      max_bytes: { type: 'integer', minimum: 1_024, maximum: MAX_BYTES_HARD_CAP },
      max_chars: { type: 'integer', minimum: 1_000, maximum: MAX_CHARS_HARD_CAP },
    },
    required: ['url'],
    additionalProperties: false,
  },
  readonly: false,
  permissionClass: 'external',
  approval: 'always',
  concurrency: 'parallel',
  timeoutMs: 30_000,
  interruptible: true,
  costClass: 'network',
}

export interface WebFetchResult {
  readonly finalUrl: string
  readonly status: number
  readonly contentType: string
  readonly text: string
  readonly truncated: boolean
}

export interface WebFetchRequest {
  readonly url: string
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly maxChars?: number
  readonly signal?: AbortSignal
}

export class WebFetchError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WebFetchError'
  }
}

export class WebFetchToolExecutor implements ToolExecutor {
  readonly #logger: RuntimeLogger

  constructor(logger: RuntimeLogger = NULL_RUNTIME_LOGGER) {
    this.#logger = logger
  }

  hasTool(name: string): boolean {
    return name === webFetchToolDefinition.name
  }

  async execute(call: ResolvedToolCall, context: ToolCallContext): Promise<ToolOutcome> {
    context.signal.throwIfAborted()
    const args = asRecord(call.args)
    if (args === undefined) return { ok: false, content: 'web_fetch arguments must be an object' }

    const rawUrl = typeof args.url === 'string' ? args.url : ''
    try {
      const request = parseRequest(args, context.signal)
      this.#logger.info(`web_fetch started url=${logSafeUrl(request.url)}`)
      const result = await fetchWebPage(request)
      this.#logger.info(
        `web_fetch completed url=${logSafeUrl(result.finalUrl)} status=${result.status} bytes=${Buffer.byteLength(result.text)}`,
      )
      return { ok: true, content: renderResult(result) }
    } catch (error) {
      if (context.signal.aborted) throw error
      const message = errorMessage(error)
      this.#logger.warn(`web_fetch failed url=${logSafeUrl(rawUrl)} reason=${message}`)
      return { ok: false, content: message }
    }
  }
}

export async function fetchWebPage(request: WebFetchRequest): Promise<WebFetchResult> {
  const target = validateUrl(request.url)
  const timeoutMs = boundedInteger(
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    1_000,
    30_000,
    'timeoutMs',
  )
  const maxBytes = boundedInteger(
    request.maxBytes ?? DEFAULT_MAX_BYTES,
    1_024,
    MAX_BYTES_HARD_CAP,
    'maxBytes',
  )
  const maxChars = boundedInteger(
    request.maxChars ?? DEFAULT_MAX_CHARS,
    1_000,
    MAX_CHARS_HARD_CAP,
    'maxChars',
  )
  const parentSignal = request.signal ?? new AbortController().signal
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([parentSignal, timeoutSignal])

  let current = target
  for (let hop = 0; ; hop += 1) {
    let response: Response
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal,
        headers: { 'user-agent': 'spark-cli-web-fetch' },
      })
    } catch (error) {
      throw classifyFetchError(error, parentSignal, timeoutSignal, current)
    }

    if (isRedirect(response.status)) {
      await response.body?.cancel().catch(() => undefined)
      if (hop >= MAX_REDIRECTS) {
        throw new WebFetchError(`Web fetch exceeded ${MAX_REDIRECTS} redirects`)
      }
      const location = response.headers.get('location')
      if (location === null) throw new WebFetchError('Web fetch redirect did not include Location')
      try {
        current = validateUrl(new URL(location, current).href)
      } catch (error) {
        throw new WebFetchError(`Web fetch redirect is invalid: ${errorMessage(error)}`, {
          cause: error,
        })
      }
      continue
    }

    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined)
      throw new WebFetchError(`Web fetch returned HTTP ${response.status} for ${logSafeUrl(current)}`)
    }

    const contentType = response.headers.get('content-type') ?? 'unknown'
    if (!isTextualContentType(contentType)) {
      await response.body?.cancel().catch(() => undefined)
      return {
        finalUrl: current,
        status: response.status,
        contentType,
        text: '[Response body is not a textual document; content was not rendered.]',
        truncated: false,
      }
    }

    const bytes = await readBody(response, current, maxBytes, signal, parentSignal, timeoutSignal)
    const decoded = decodeUtf8(bytes, current)
    const readable = isHtmlContentType(contentType) ? htmlToText(decoded) : decoded.trim()
    const truncated = readable.length > maxChars
    return {
      finalUrl: current,
      status: response.status,
      contentType,
      text: truncated
        ? `${readable.slice(0, maxChars)}\n[… output truncated at ${maxChars} characters]`
        : readable,
      truncated,
    }
  }
}

async function readBody(
  response: Response,
  url: string,
  maxBytes: number,
  signal: AbortSignal,
  parentSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new WebFetchError(`Web fetch response exceeds ${maxBytes} bytes`)
    }
  }
  if (response.body === null) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      if (parentSignal.aborted) parentSignal.throwIfAborted()
      if (timeoutSignal.aborted) throw new WebFetchError('Web fetch timed out while reading the response')
      const read = await reader.read()
      if (read.done) break
      const chunk = Uint8Array.from(read.value as Uint8Array)
      total += chunk.byteLength
      if (total > maxBytes) throw new WebFetchError(`Web fetch response exceeds ${maxBytes} bytes`)
      chunks.push(chunk)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (parentSignal.aborted) throw error
    if (timeoutSignal.aborted) {
      throw new WebFetchError('Web fetch timed out while reading the response', { cause: error })
    }
    throw classifyFetchError(error, parentSignal, timeoutSignal, url)
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

function parseRequest(args: Record<string, unknown>, signal: AbortSignal): WebFetchRequest {
  const url = stringArg(args.url, 'url')
  return {
    url,
    ...(args.timeout_ms === undefined ? {} : { timeoutMs: integerArg(args.timeout_ms, 'timeout_ms') }),
    ...(args.max_bytes === undefined ? {} : { maxBytes: integerArg(args.max_bytes, 'max_bytes') }),
    ...(args.max_chars === undefined ? {} : { maxChars: integerArg(args.max_chars, 'max_chars') }),
    signal,
  }
}

function validateUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new WebFetchError('web_fetch requires a valid URL')
  }
  if (parsed.username || parsed.password) {
    throw new WebFetchError('web_fetch rejects embedded URL credentials')
  }
  if (parsed.protocol === 'https:') return parsed.href
  if (parsed.protocol === 'http:' && isLoopback(parsed.hostname)) return parsed.href
  throw new WebFetchError('web_fetch allows https URLs; http is limited to localhost')
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  )
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function isTextualContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase()
  return (
    normalized === 'unknown' ||
    normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('javascript') ||
    normalized.includes('css')
  )
}

function isHtmlContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes('html')
}

function decodeUtf8(bytes: Buffer, url: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new WebFetchError(`Web fetch response is not valid UTF-8: ${logSafeUrl(url)}`, {
      cause: error,
    })
  }
}

function htmlToText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<!--(?:.|\n|\r)*?-->/gu, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, '')
      .replace(
        /<\/?(?:address|article|aside|blockquote|br|dd|div|dl|dt|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/giu,
        '\n',
      )
      .replace(/<[^>]*>/gu, '')
      .replace(/[ \t]+/gu, ' ')
      .replace(/\n[ \t]+/gu, '\n')
      .replace(/[ \t]+\n/gu, '\n')
      .replace(/\n{3,}/gu, '\n\n')
      .trim(),
  )
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&#(x[\da-f]+|\d+);/giu, (_match, raw: string) => {
      const codePoint = raw.toLowerCase().startsWith('x')
        ? Number.parseInt(raw.slice(1), 16)
        : Number.parseInt(raw, 10)
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : ''
    })
}

function renderResult(result: WebFetchResult): string {
  return `URL: ${result.finalUrl}\nHTTP: ${result.status}\nContent-Type: ${result.contentType}\n\n${result.text}`
}

function classifyFetchError(
  error: unknown,
  parentSignal: AbortSignal,
  timeoutSignal: AbortSignal,
  url: string,
): unknown {
  if (parentSignal.aborted) return error
  if (timeoutSignal.aborted) {
    return new WebFetchError(`Web fetch timed out while requesting ${logSafeUrl(url)}`, {
      cause: error,
    })
  }
  if (error instanceof WebFetchError) return error
  return new WebFetchError(`Web fetch failed for ${logSafeUrl(url)}: ${errorMessage(error)}`, {
    cause: error,
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WebFetchError(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function integerArg(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new WebFetchError(`${name} must be an integer`)
  }
  return value
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WebFetchError(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function logSafeUrl(raw: string): string {
  try {
    const parsed = new URL(raw)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return '<invalid-url>'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
