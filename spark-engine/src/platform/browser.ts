import { spawn } from 'node:child_process'

/** Opens a validated URL in the user's default browser. Returns false when it could not launch. */
export type ExternalUrlOpener = (url: string) => Promise<boolean>

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * Opens `url` with the platform browser launcher.
 *
 * The URL is validated first (https only, or http on a loopback host for local
 * integration servers) and passed as a direct argv entry — never through a
 * shell — so a hostile config value cannot smuggle shell metacharacters into
 * the launcher command.
 */
export async function openExternalUrl(
  url: string,
  options: { readonly platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  if (!isOpenableUrl(url)) return false
  const platform = options.platform ?? process.platform
  const launcher = launcherFor(platform, url)
  if (launcher === null) return false
  return await spawnDetached(launcher.command, launcher.args)
}

export function isOpenableUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)
}

function launcherFor(
  platform: NodeJS.Platform,
  url: string,
): { readonly command: string; readonly args: readonly string[] } | null {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') {
    // rundll32 takes the URL as a plain argument; `cmd /c start` would re-parse
    // it through the shell and break on `&` in query strings.
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    return { command: 'xdg-open', args: [url] }
  }
  return null
}

async function spawnDetached(command: string, args: readonly string[]): Promise<boolean> {
  return await new Promise<boolean>((resolveLaunch) => {
    let settled = false
    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      resolveLaunch(value)
    }
    try {
      const child = spawn(command, [...args], { detached: true, stdio: 'ignore' })
      child.once('error', () => {
        settle(false)
      })
      child.once('spawn', () => {
        child.unref()
        settle(true)
      })
    } catch {
      settle(false)
    }
  })
}
