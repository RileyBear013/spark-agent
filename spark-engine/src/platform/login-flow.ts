import { createHash, randomBytes } from 'node:crypto'

import { errorMessage } from '../config/config-file.js'
import { NULL_RUNTIME_LOGGER, type RuntimeLogger } from '../observability/logger.js'

import { isOpenableUrl, openExternalUrl, type ExternalUrlOpener } from './browser.js'
import type { PlatformSession } from './credentials.js'
import type { DesktopLoginPollStatus, EduServerClient } from './edu-server-client.js'

/**
 * Browser login orchestration for the standalone CLI.
 *
 * Protocol parity with the desktop (`DesktopBrowserLogin`): the CLI generates
 * `state` + a PKCE verifier, hands only `state` + `sha256(verifier)` to the web
 * login page, then polls for the binding and consumes it once with the verifier.
 * state + verifier live in process memory only, so nothing reusable is written
 * to disk before the exchange succeeds.
 */
export const DEFAULT_LOGIN_TIMEOUT_MS = 300_000
export const DEFAULT_LOGIN_POLL_INTERVAL_MS = 2_000
export const DEFAULT_WEB_LOGIN_PAGE = 'https://www.yiqibyte.com/login'

export type PlatformLoginFailure = 'timeout' | 'expired' | 'invalid_url' | 'exchange_failed'

export class PlatformLoginError extends Error {
  readonly reason: PlatformLoginFailure

  constructor(
    reason: PlatformLoginFailure,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'PlatformLoginError'
    this.reason = reason
  }
}

export type PlatformLoginClient = Pick<
  EduServerClient,
  'getClientConfig' | 'pollDesktopLogin' | 'exchangeDesktopLogin'
>

export interface PlatformLoginOptions {
  readonly client: PlatformLoginClient
  /** Explicit web login page; otherwise the server's `/client-config` decides. */
  readonly webLoginUrl?: string
  /** false keeps the URL printed only, for headless or SSH sessions. */
  readonly openBrowser?: boolean
  readonly openExternal?: ExternalUrlOpener
  readonly pollIntervalMs?: number
  readonly timeoutMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  /** Called once the authorization window is open, before the first poll. */
  readonly onProgress?: (event: { readonly loginUrl: string; readonly opened: boolean }) => void
  readonly logger?: RuntimeLogger
}

export interface PlatformLoginResult {
  readonly session: PlatformSession
  /** The exact page opened, including `desktop/state/challenge` parameters. */
  readonly loginUrl: string
  readonly opened: boolean
}

export async function runPlatformLogin(
  options: PlatformLoginOptions,
): Promise<PlatformLoginResult> {
  const logger = options.logger ?? NULL_RUNTIME_LOGGER
  const now = options.now ?? (() => Date.now())
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_LOGIN_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS

  const webLoginUrl = await resolveWebLoginUrl(options, logger)
  const state = randomBytes(32).toString('hex')
  const codeVerifier = randomBytes(32).toString('hex')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('hex')
  const loginUrl = buildLoginUrl(webLoginUrl, state, codeChallenge)

  const opened =
    options.openBrowser === false
      ? false
      : await openSafely(loginUrl, options.openExternal ?? openExternalUrl, logger)
  // Report the url before polling: printing it afterwards would hide the link
  // from exactly the user who needs it, and misreport a finished wait as pending.
  options.onProgress?.({ loginUrl, opened })

  const deadline = now() + timeoutMs
  for (;;) {
    if (now() >= deadline) {
      throw new PlatformLoginError('timeout', 'Browser login timed out; run `spark login` again')
    }
    // A single dropped poll must not kill a five-minute authorization window;
    // the deadline below still guarantees the loop terminates.
    const status = await pollDesktopLogin(options.client, state, logger)
    if (status === 'bound') break
    if (status === 'expired') {
      throw new PlatformLoginError('expired', 'Login request expired; run `spark login` again')
    }
    const remaining = deadline - now()
    await sleep(Math.max(0, Math.min(pollIntervalMs, remaining)))
  }

  try {
    const session = await options.client.exchangeDesktopLogin({ state, codeVerifier })
    logger.info(`platform login succeeded for user=${session.userId}`)
    return { session, loginUrl, opened }
  } catch (error) {
    throw new PlatformLoginError(
      'exchange_failed',
      `Cannot complete the browser login: ${errorMessage(error)}`,
      { cause: error },
    )
  }
}

async function pollDesktopLogin(
  client: PlatformLoginClient,
  state: string,
  logger: RuntimeLogger,
): Promise<DesktopLoginPollStatus> {
  try {
    return await client.pollDesktopLogin(state)
  } catch (error) {
    logger.warn(`desktop login poll failed: ${errorMessage(error)}`)
    return 'pending'
  }
}

async function resolveWebLoginUrl(
  options: PlatformLoginOptions,
  logger: RuntimeLogger,
): Promise<string> {
  if (options.webLoginUrl !== undefined && options.webLoginUrl.trim() !== '') {
    return options.webLoginUrl.trim()
  }
  try {
    const config = await options.client.getClientConfig()
    if (config.webLoginUrl !== undefined && config.webLoginUrl.trim() !== '') {
      return config.webLoginUrl.trim()
    }
  } catch (error) {
    logger.warn(`cannot read the server web login url: ${errorMessage(error)}`)
  }
  return DEFAULT_WEB_LOGIN_PAGE
}

function buildLoginUrl(webLoginUrl: string, state: string, codeChallenge: string): string {
  let target: URL
  try {
    target = new URL(webLoginUrl)
  } catch (error) {
    throw new PlatformLoginError('invalid_url', `Invalid web login url: ${webLoginUrl}`, {
      cause: error,
    })
  }
  if (!isOpenableUrl(target.toString())) {
    throw new PlatformLoginError(
      'invalid_url',
      `Web login url must use https (http is only allowed on loopback): ${webLoginUrl}`,
    )
  }
  target.searchParams.set('desktop', '1')
  target.searchParams.set('state', state)
  target.searchParams.set('challenge', codeChallenge)
  return target.toString()
}

async function openSafely(
  url: string,
  open: ExternalUrlOpener,
  logger: RuntimeLogger,
): Promise<boolean> {
  try {
    return await open(url)
  } catch (error) {
    logger.warn(`cannot open the system browser: ${errorMessage(error)}`)
    return false
  }
}
