import { readFile, stat, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { NULL_RUNTIME_LOGGER, type RuntimeLogger } from '../../observability/logger.js'
import { atomicWriteFile } from '../workspace/atomic-write.js'
import { WorkspacePathGuard } from '../workspace/path-guard.js'

const PLAN_DIRECTORY = '.spark/plans'
const MAX_PLAN_BYTES = 256 * 1024
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/u

export class PlanStoreError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'PlanStoreError'
  }
}

/** Session-owned Markdown plans kept separate from the project-wide Todo list. */
export class PlanStore {
  readonly #cwd: string
  readonly #guard: WorkspacePathGuard
  readonly #logger: RuntimeLogger

  constructor(options: { readonly cwd: string; readonly logger?: RuntimeLogger }) {
    this.#cwd = resolve(options.cwd)
    this.#guard = new WorkspacePathGuard(this.#cwd)
    this.#logger = options.logger ?? NULL_RUNTIME_LOGGER
  }

  filePath(sessionId: string): string {
    return this.#pathFor(sessionId)
  }

  async read(sessionId: string): Promise<string | undefined> {
    const relativePath = this.#relativePathFor(sessionId)
    const location = await this.#guard.writable(relativePath)
    let size: number
    try {
      size = (await stat(location.target)).size
    } catch (error) {
      if (isMissing(error)) return undefined
      throw new PlanStoreError(`Unable to inspect plan ${this.#pathFor(sessionId)}`, { cause: error })
    }
    if (size > MAX_PLAN_BYTES) {
      throw new PlanStoreError(
        `Plan exceeds the ${MAX_PLAN_BYTES}-byte limit: ${this.#pathFor(sessionId)}`,
      )
    }
    let source: string
    try {
      source = await readFile(location.target, 'utf8')
    } catch (error) {
      if (isMissing(error)) return undefined
      throw new PlanStoreError(`Unable to read plan ${this.#pathFor(sessionId)}`, { cause: error })
    }
    if (Buffer.byteLength(source, 'utf8') > MAX_PLAN_BYTES) {
      throw new PlanStoreError(
        `Plan exceeds the ${MAX_PLAN_BYTES}-byte limit: ${this.#pathFor(sessionId)}`,
      )
    }
    const body = source.trim()
    return body.length === 0 ? undefined : body
  }

  async write(sessionId: string, body: string): Promise<void> {
    const normalized = requiredBody(body)
    const location = await this.#guard.writable(this.#relativePathFor(sessionId))
    await atomicWriteFile(location.target, `${normalized}\n`, async () => {
      await this.#guard.existing(dirname(location.target))
    })
    this.#logger.info(`plan written session=${sessionId} bytes=${Buffer.byteLength(normalized, 'utf8')}`)
  }

  async append(sessionId: string, body: string): Promise<void> {
    const addition = requiredBody(body)
    const current = await this.read(sessionId)
    const combined = current === undefined ? addition : `${current}\n\n${addition}`
    await this.write(sessionId, combined)
    this.#logger.info(`plan appended session=${sessionId}`)
  }

  async clear(sessionId: string): Promise<boolean> {
    const relativePath = this.#relativePathFor(sessionId)
    const location = await this.#guard.writable(relativePath)
    try {
      await unlink(location.target)
    } catch (error) {
      if (isMissing(error)) return false
      throw new PlanStoreError(`Unable to clear plan ${this.#pathFor(sessionId)}`, { cause: error })
    }
    this.#logger.info(`plan cleared session=${sessionId}`)
    return true
  }

  #pathFor(sessionId: string): string {
    return resolve(this.#cwd, this.#relativePathFor(sessionId))
  }

  #relativePathFor(sessionId: string): string {
    const normalized = requiredSessionId(sessionId)
    return `${PLAN_DIRECTORY}/${normalized}.md`
  }
}

function requiredSessionId(value: string): string {
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    !SESSION_ID_PATTERN.test(normalized) ||
    normalized.includes('..')
  ) {
    throw new PlanStoreError(`Invalid session id: ${value}`)
  }
  return normalized
}

function requiredBody(value: string): string {
  if (typeof value !== 'string') throw new PlanStoreError('Plan body must be a string')
  const normalized = value.trim()
  if (normalized.length === 0) throw new PlanStoreError('Plan body must not be empty')
  if (normalized.includes('\0')) throw new PlanStoreError('Plan body must not contain NUL bytes')
  if (Buffer.byteLength(normalized, 'utf8') > MAX_PLAN_BYTES) {
    throw new PlanStoreError(`Plan exceeds the ${MAX_PLAN_BYTES}-byte limit`)
  }
  return normalized
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  )
}
