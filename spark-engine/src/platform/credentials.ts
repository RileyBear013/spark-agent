import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

import { z } from 'zod'

import { errorMessage } from '../config/config-file.js'
import { NULL_RUNTIME_LOGGER, type RuntimeLogger } from '../observability/logger.js'

/**
 * Local credential file for the standalone CLI (`~/.spark/credentials.json`).
 *
 * Tokens live here instead of `config.toml` for two reasons: the TOML layers are
 * meant to be read, shared and version-controlled, and the account session is
 * per-machine state rather than configuration. The file is written 0600 with an
 * atomic replace so a failed write can never truncate a working session.
 */
const CREDENTIALS_FILENAME = 'credentials.json'
const CREDENTIALS_VERSION = 1
const MAX_TOKEN_CHARS = 8_192

const PlatformSessionSchema = z
  .object({
    token: z.string().min(1).max(MAX_TOKEN_CHARS),
    refreshToken: z.string().min(1).max(MAX_TOKEN_CHARS),
    userId: z.string().min(1).max(200),
  })
  .strict()

const PlatformAccountSchema = z
  .object({
    id: z.number().int(),
    account: z.string().max(500),
    nickname: z.string().max(500),
    role: z.string().max(200).default(''),
  })
  .strict()

const StoredCredentialsSchema = z
  .object({
    version: z.literal(CREDENTIALS_VERSION),
    serverUrl: z.url().max(2_000),
    session: PlatformSessionSchema,
    account: PlatformAccountSchema.optional(),
    updatedAt: z.string().min(1).max(64),
  })
  .strict()

export type PlatformSession = z.output<typeof PlatformSessionSchema>
export type PlatformAccount = z.output<typeof PlatformAccountSchema>
export type StoredPlatformCredentials = z.output<typeof StoredCredentialsSchema>

export class PlatformCredentialError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'PlatformCredentialError'
  }
}

export interface PlatformCredentialStoreOptions {
  readonly sparkHome: string
  readonly logger?: RuntimeLogger
}

export class PlatformCredentialStore {
  readonly #path: string
  readonly #logger: RuntimeLogger

  constructor(options: PlatformCredentialStoreOptions) {
    this.#path = resolve(options.sparkHome, CREDENTIALS_FILENAME)
    this.#logger = options.logger ?? NULL_RUNTIME_LOGGER
  }

  get path(): string {
    return this.#path
  }

  /**
   * Reads the stored session. Returns null when nothing was saved yet, and
   * throws when a file exists but cannot be trusted — a corrupt credential file
   * must surface as "re-login required" instead of a silent logged-out state.
   */
  async load(): Promise<StoredPlatformCredentials | null> {
    let raw: string
    try {
      raw = await readFile(this.#path, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null
      throw new PlatformCredentialError(
        `Cannot read platform credentials at ${this.#path}: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new PlatformCredentialError(
        `Platform credentials at ${this.#path} are not valid JSON; run \`spark login\` again`,
        { cause: error },
      )
    }
    const result = StoredCredentialsSchema.safeParse(parsed)
    if (!result.success) {
      throw new PlatformCredentialError(
        `Platform credentials at ${this.#path} are unreadable; run \`spark login\` again`,
      )
    }
    await this.#hardenPermissions()
    return result.data
  }

  /** Best-effort repair when the file predates the 0600 write mode or was copied. */
  async #hardenPermissions(): Promise<void> {
    const stats = await stat(this.#path).catch(() => null)
    if (stats === null || (stats.mode & 0o077) === 0) return
    this.#logger.warn(
      `platform credentials at ${this.#path} were group/world readable; tightening to 0600`,
    )
    await chmod(this.#path, 0o600).catch((error: unknown) => {
      this.#logger.warn(`cannot tighten permissions on ${this.#path}: ${errorMessage(error)}`)
    })
  }

  async save(input: {
    readonly serverUrl: string
    readonly session: PlatformSession
    readonly account?: PlatformAccount
  }): Promise<StoredPlatformCredentials> {
    const credentials: StoredPlatformCredentials = {
      version: CREDENTIALS_VERSION,
      serverUrl: input.serverUrl,
      session: input.session,
      ...(input.account === undefined ? {} : { account: input.account }),
      updatedAt: new Date().toISOString(),
    }
    const directory = dirname(this.#path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = resolve(directory, `.${basename(this.#path)}.${process.pid}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await rename(temporary, this.#path)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new PlatformCredentialError(
        `Cannot write platform credentials at ${this.#path}: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    this.#logger.info(`platform credentials saved for user=${credentials.session.userId}`)
    return credentials
  }

  /** Removes the stored session. Returns true when a file was actually deleted. */
  async clear(): Promise<boolean> {
    try {
      await rm(this.#path)
      this.#logger.info('platform credentials cleared')
      return true
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      throw new PlatformCredentialError(
        `Cannot remove platform credentials at ${this.#path}: ${errorMessage(error)}`,
        { cause: error },
      )
    }
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined
}
