import { createDefaultEnvWithMcp } from '../env.js'
import { errorMessage } from '../config/config-file.js'
import {
  loadSparkSettings,
  removeSetting,
  resolveMcpSettings,
  writeSetting,
  SparkSettingsError,
  type SettingsScope,
  type SparkSettingsOptions,
} from '../config/settings.js'
import type { LlmService } from '../seams.js'
import type { SparkMcpServerConfig } from '../mcp/types.js'

/**
 * `spark mcp` — inspect, configure, and probe the `[mcp.servers.*]` section.
 *
 * Configuration edits reuse the same validated write path as `spark config`;
 * `status` is the only subcommand that starts real server processes.
 */
export interface McpAddInput {
  readonly command?: string
  readonly url?: string
  readonly args: readonly string[]
  readonly env: readonly string[]
  readonly headers: readonly string[]
}

export interface McpCommandOptions extends SparkSettingsOptions {
  readonly subcommand: string
  readonly args: readonly string[]
  readonly json: boolean
  readonly scope?: SettingsScope
  readonly add?: McpAddInput
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

/** Status probing never runs a model turn; a stub keeps the fake model out of the CLI path. */
const IDLE_MODEL: LlmService = {
  // eslint-disable-next-line require-yield
  async *stream() {
    return
  },
}

const STATUS_TIMEOUT_MS = 15_000
const MCP_SERVER_NAME = /^[A-Za-z0-9._:-]{1,96}$/u

export async function executeMcpCommand(options: McpCommandOptions): Promise<number> {
  try {
    switch (options.subcommand) {
      case '':
      case 'list':
        return await listServers(options)
      case 'add':
        return await addServer(options)
      case 'remove':
        return await removeServer(options)
      case 'status':
        return await serverStatus(options)
      default:
        options.stderr(
          `Unknown \`spark mcp\` subcommand: ${options.subcommand} (list | add | remove | status)\n`,
        )
        return 2
    }
  } catch (error) {
    options.stderr(`${errorMessage(error)}\n`)
    return 2
  }
}

async function listServers(options: McpCommandOptions): Promise<number> {
  const settings = await loadSparkSettings(options)
  const configured = settings.config.mcp?.servers ?? {}
  if (options.json) {
    options.stdout(
      `${JSON.stringify(
        {
          servers: Object.entries(configured).map(([name, server]) => ({
            name,
            scope: scopeOf(settings, name),
            enabled: server.enabled,
            transport: server.url === undefined ? 'stdio' : 'http',
            ...(server.command === undefined ? {} : { command: server.command }),
            ...(server.args.length === 0 ? {} : { args: server.args }),
            ...(server.url === undefined ? {} : { url: server.url }),
            ...(Object.keys(server.env).length === 0 ? {} : { envKeys: Object.keys(server.env) }),
            ...(Object.keys(server.headers).length === 0
              ? {}
              : { headerKeys: Object.keys(server.headers) }),
          })),
        },
        null,
        2,
      )}\n`,
    )
    return 0
  }
  const entries = Object.entries(configured)
  if (entries.length === 0) {
    options.stdout(
      'No MCP servers configured. Add one with:\n' +
        '  spark mcp add filesystem --command npx --arg -y --arg @modelcontextprotocol/server-filesystem --arg /tmp\n',
    )
    return 0
  }
  for (const [name, server] of entries) {
    const transport = server.url === undefined ? `stdio ${server.command ?? ''}` : `http ${server.url}`
    options.stdout(
      `${server.enabled ? ' ' : '✗'} ${name.padEnd(20)} ${transport}  [${scopeOf(settings, name)}]\n`,
    )
  }
  return 0
}

async function addServer(options: McpCommandOptions): Promise<number> {
  const input = options.add
  const name = options.args[0]
  if (input === undefined || name === undefined || options.args.length > 1) {
    options.stderr(
      'Usage: spark mcp add <name> --command <cmd> [--arg <value>]... [--env KEY=VALUE]...\n' +
        '   or: spark mcp add <name> --url <endpoint> [--header KEY=VALUE]...\n',
    )
    return 2
  }
  if (!MCP_SERVER_NAME.test(name)) {
    options.stderr(
      `Invalid server name ${name}: use letters, digits, and . _ : - (at most 96 characters)\n`,
    )
    return 2
  }
  const hasCommand = input.command !== undefined
  const hasUrl = input.url !== undefined
  if (hasCommand === hasUrl) {
    options.stderr('Provide exactly one of --command (stdio) or --url (http).\n')
    return 2
  }
  const server: Record<string, unknown> = hasUrl
    ? { url: input.url }
    : { command: input.command }
  if (input.args.length > 0) server.args = [...input.args]
  if (input.env.length > 0) server.env = parseKeyValues(input.env, '--env')
  if (input.headers.length > 0) server.headers = parseKeyValues(input.headers, '--header')

  const result = await writeSetting({
    ...options,
    key: `mcp.servers.${name}`,
    value: server,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  })
  if (options.json) {
    options.stdout(`${JSON.stringify({ name, server, ...result }, null, 2)}\n`)
    return 0
  }
  options.stdout(
    `Added MCP server ${name} to ${result.path}. Verify with \`spark mcp status\`.\n`,
  )
  return 0
}

async function removeServer(options: McpCommandOptions): Promise<number> {
  const name = options.args[0]
  if (name === undefined || options.args.length > 1) {
    options.stderr('Usage: spark mcp remove <name> [--global|--project]\n')
    return 2
  }
  const settings = await loadSparkSettings(options)
  if (settings.config.mcp?.servers[name] === undefined) {
    options.stderr(`No MCP server named ${name} is configured.\n`)
    return 1
  }
  const target = options.scope ?? scopeOf(settings, name)
  // The project layer overrides the user layer, so removal targets whichever
  // layer currently supplies the definition; pruning keeps the file tidy.
  const result = await removeSetting({
    ...options,
    key: `mcp.servers.${name}`,
    scope: target === 'default' ? 'global' : target,
  })
  const remaining = await loadSparkSettings(options)
  const stillConfigured = remaining.config.mcp?.servers[name] !== undefined
  if (options.json) {
    options.stdout(
      `${JSON.stringify({ name, scope: result.scope, remaining: stillConfigured }, null, 2)}\n`,
    )
    return 0
  }
  options.stdout(
    stillConfigured
      ? `Removed ${name} from ${result.path}; another layer still defines it.\n`
      : `Removed MCP server ${name} from ${result.path}.\n`,
  )
  return 0
}

async function serverStatus(options: McpCommandOptions): Promise<number> {
  const settings = await loadSparkSettings(options)
  const resolved = resolveMcpSettings(settings)
  const names = Object.keys(resolved.servers)
  if (names.length === 0) {
    options.stdout('No enabled MCP servers to probe.\n')
    return 0
  }
  const results: {
    name: string
    ok: boolean
    tools?: string[]
    error?: string
  }[] = []
  for (const name of names) {
    const server = resolved.servers[name]
    if (server === undefined) continue
    try {
      const managed = await createDefaultEnvWithMcp({
        cwd: options.cwd,
        llm: IDLE_MODEL,
        mcpServers: { [name]: server } satisfies Record<string, SparkMcpServerConfig>,
        mcpStartupTimeoutMs: STATUS_TIMEOUT_MS,
      })
      try {
        const tools = managed.env.tools.registry
          .list()
          .map((tool) => tool.name)
          .filter((toolName) => toolName.startsWith(`mcp__${name}__`))
        results.push({ name, ok: true, tools })
      } finally {
        await managed.close()
      }
    } catch (error) {
      results.push({ name, ok: false, error: errorMessage(error) })
    }
  }
  if (options.json) {
    options.stdout(`${JSON.stringify({ servers: results }, null, 2)}\n`)
  } else {
    for (const result of results) {
      options.stdout(
        result.ok
          ? `✓ ${result.name}: ${String(result.tools?.length ?? 0)} tool(s)${
              result.tools && result.tools.length > 0 ? ` — ${result.tools.join(', ')}` : ''
            }\n`
          : `✗ ${result.name}: ${result.error ?? 'failed'}\n`,
      )
    }
  }
  return results.every((result) => result.ok) ? 0 : 1
}

function scopeOf(
  settings: Awaited<ReturnType<typeof loadSparkSettings>>,
  name: string,
): SettingsScope | 'default' {
  if (settings.project.layer.mcp !== undefined) {
    const servers = (settings.project.layer.mcp as Record<string, unknown>).servers
    if (typeof servers === 'object' && servers !== null && name in servers) return 'project'
  }
  if (settings.global.layer.mcp !== undefined) {
    const servers = (settings.global.layer.mcp as Record<string, unknown>).servers
    if (typeof servers === 'object' && servers !== null && name in servers) return 'global'
  }
  return 'default'
}

function parseKeyValues(values: readonly string[], flag: string): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const value of values) {
    const separator = value.indexOf('=')
    if (separator <= 0) {
      throw new SparkSettingsError(`${flag} expects KEY=VALUE, received ${value}`)
    }
    parsed[value.slice(0, separator)] = value.slice(separator + 1)
  }
  return parsed
}
