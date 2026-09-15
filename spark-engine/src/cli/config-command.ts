import {
  describeSettings,
  loadSparkSettings,
  readSetting,
  removeSetting,
  resolveSparkSettingsPaths,
  writeSetting,
  type SettingEntry,
  type SettingsScope,
} from '../config/settings.js'
import { errorMessage, parseSettingValue } from '../config/config-file.js'

/**
 * `spark config` — read and write the layered TOML configuration.
 *
 * Every mutation goes through the same validate-then-atomic-write path, so a
 * rejected edit never leaves a half-written file behind.
 */
export interface ConfigCommandOptions {
  readonly subcommand: string
  readonly args: readonly string[]
  readonly json: boolean
  readonly scope?: SettingsScope
  readonly cwd: string
  readonly sparkHome?: string
  readonly env?: NodeJS.ProcessEnv
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

export async function executeConfigCommand(options: ConfigCommandOptions): Promise<number> {
  try {
    switch (options.subcommand) {
      case '':
      case 'list':
        return await listSettings(options)
      case 'get':
        return await getSetting(options)
      case 'set':
        return await setSetting(options)
      case 'unset':
        return await unsetSetting(options)
      case 'path':
        return await showPaths(options)
      default:
        options.stderr(
          `Unknown \`spark config\` subcommand: ${options.subcommand} (list | get | set | unset | path)\n`,
        )
        return 2
    }
  } catch (error) {
    options.stderr(`${errorMessage(error)}\n`)
    return 2
  }
}

async function listSettings(options: ConfigCommandOptions): Promise<number> {
  const settings = await loadSparkSettings(settingsOptions(options))
  const entries = describeSettings(settings)
  if (options.json) {
    options.stdout(`${JSON.stringify({ paths: pathsView(settings), settings: entries }, null, 2)}\n`)
    return 0
  }
  if (entries.length === 0) {
    options.stdout(
      `No configuration yet. Write one with \`spark config set <key> <value>\` or \`spark init\`.\n` +
        `Global:  ${settings.paths.globalPath}\nProject: ${settings.paths.projectPath}\n`,
    )
    return 0
  }
  const width = Math.max(...entries.map((entry) => entry.key.length))
  for (const item of entries) {
    options.stdout(
      `${item.key.padEnd(width)} = ${renderValue(item.value)}  [${item.scope}]\n`,
    )
  }
  return 0
}

async function getSetting(options: ConfigCommandOptions): Promise<number> {
  const key = options.args[0]
  if (key === undefined || options.args.length > 1) {
    options.stderr('Usage: spark config get <key> [--global|--project]\n')
    return 2
  }
  const found = await readSetting({ ...settingsOptions(options), key, ...scopeOption(options) })
  if (found.value === undefined) {
    options.stderr(`${key} is not set (${found.sourcePath})\n`)
    return 1
  }
  if (options.json) {
    options.stdout(`${JSON.stringify(found, null, 2)}\n`)
    return 0
  }
  options.stdout(`${renderValue(found.value)}\n`)
  return 0
}

async function setSetting(options: ConfigCommandOptions): Promise<number> {
  const [key, rawValue] = options.args
  if (key === undefined || rawValue === undefined || options.args.length > 2) {
    options.stderr(
      'Usage: spark config set <key> <value> [--global|--project]\n' +
        'Values: true/false, numbers, plain strings, or JSON for arrays/objects.\n',
    )
    return 2
  }
  const value = parseSettingValue(rawValue)
  const result = await writeSetting({
    ...settingsOptions(options),
    key,
    value,
    ...scopeOption(options),
  })
  if (options.json) {
    options.stdout(`${JSON.stringify({ key, value, ...result }, null, 2)}\n`)
    return 0
  }
  options.stdout(`Set ${key} = ${renderValue(value)} in ${result.path}\n`)
  return 0
}

async function unsetSetting(options: ConfigCommandOptions): Promise<number> {
  const key = options.args[0]
  if (key === undefined || options.args.length > 1) {
    options.stderr('Usage: spark config unset <key> [--global|--project]\n')
    return 2
  }
  const result = await removeSetting({ ...settingsOptions(options), key, ...scopeOption(options) })
  if (options.json) {
    options.stdout(`${JSON.stringify({ key, ...result }, null, 2)}\n`)
    return 0
  }
  options.stdout(`Unset ${key} in ${result.path}\n`)
  return 0
}

async function showPaths(options: ConfigCommandOptions): Promise<number> {
  const settings = await loadSparkSettings(settingsOptions(options))
  const view = pathsView(settings)
  if (options.json) {
    options.stdout(`${JSON.stringify(view, null, 2)}\n`)
    return 0
  }
  options.stdout(
    `global  ${view.global.path}${view.global.exists ? '' : ' (not created)'}\n` +
      `project ${view.project.path}${view.project.exists ? '' : ' (not created)'}\n`,
  )
  return 0
}

function pathsView(settings: Awaited<ReturnType<typeof loadSparkSettings>>): {
  readonly sparkHome: string
  readonly global: { readonly path: string; readonly exists: boolean }
  readonly project: { readonly path: string; readonly exists: boolean }
} {
  return {
    sparkHome: settings.paths.sparkHome,
    global: { path: settings.paths.globalPath, exists: settings.global.exists },
    project: { path: settings.paths.projectPath, exists: settings.project.exists },
  }
}

function settingsOptions(options: ConfigCommandOptions): {
  cwd: string
  sparkHome?: string
  env?: NodeJS.ProcessEnv
} {
  return {
    cwd: options.cwd,
    ...(options.sparkHome === undefined ? {} : { sparkHome: options.sparkHome }),
    ...(options.env === undefined ? {} : { env: options.env }),
  }
}

function scopeOption(options: ConfigCommandOptions): { scope?: SettingsScope } {
  return options.scope === undefined ? {} : { scope: options.scope }
}

export function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'unset'
  return JSON.stringify(value)
}

export function configPathsHint(input: {
  readonly cwd: string
  readonly sparkHome?: string
  readonly env?: NodeJS.ProcessEnv
}): { readonly globalPath: string; readonly projectPath: string } {
  const paths = resolveSparkSettingsPaths(input)
  return { globalPath: paths.globalPath, projectPath: paths.projectPath }
}

export type { SettingEntry }
