import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

import { parse, stringify } from 'smol-toml'

/**
 * Shared TOML layer plumbing for every Spark CLI config file
 * (`~/.spark/config.toml`, `<cwd>/.spark/config.toml`).
 *
 * Feature modules keep their own schema and error class; this module only owns
 * reading, merging, dot-path mutation, and the atomic 0600 write so the model
 * channel config and the CLI settings sections cannot drift apart.
 */
export interface TomlLayer {
  readonly layer: Record<string, unknown>
  readonly exists: boolean
}

export class ConfigFileError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ConfigFileError'
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function isMissingFileError(error: unknown): boolean {
  return asRecord(error)?.code === 'ENOENT'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Lower precedence first: values in `upper` win, objects merge recursively, and
 * every non-object (including arrays) replaces the lower value wholesale so a
 * project list is never silently concatenated with the user-level one.
 */
export function deepMergeLayers(
  lower: Readonly<Record<string, unknown>>,
  upper: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = structuredClone(lower)
  for (const [key, value] of Object.entries(upper)) {
    const previous = asRecord(result[key])
    const next = asRecord(value)
    result[key] = previous && next ? deepMergeLayers(previous, next) : structuredClone(value)
  }
  return result
}

export async function readTomlLayer(path: string): Promise<TomlLayer> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) return { layer: {}, exists: false }
    throw new ConfigFileError(`Unable to read Spark config ${path}`, { cause: error })
  }
  try {
    const value: unknown = parse(source)
    return { layer: asRecord(value) ?? {}, exists: true }
  } catch (error) {
    throw new ConfigFileError(`Invalid TOML in ${path}: ${errorMessage(error)}`, { cause: error })
  }
}

/**
 * Read-merge-validate-atomically-write: the temp file lives in the target
 * directory so the rename never crosses filesystems, and the file is written
 * 0600 because these layers can hold provider endpoints and MCP headers.
 */
export async function writeTomlLayerAtomic(
  path: string,
  layer: Readonly<Record<string, unknown>>,
): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = resolve(directory, `.${basename(path)}.${process.pid}.tmp`)
  await writeFile(temporary, `${stringify(structuredClone(layer))}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporary, path)
}

/** Splits `mcp.servers.github.command` into its path segments. */
export function parseSettingPath(key: string): string[] {
  const segments = key.split('.').map((segment) => segment.trim())
  if (segments.length === 0 || segments.some((segment) => segment === '')) {
    throw new ConfigFileError(`Invalid configuration key "${key}": expected dotted.path form`)
  }
  return segments
}

export function getValueAtPath(
  root: Readonly<Record<string, unknown>>,
  path: readonly string[],
): unknown {
  let current: unknown = root
  for (const segment of path) {
    const record = asRecord(current)
    if (!record || !(segment in record)) return undefined
    current = record[segment]
  }
  return current
}

/** Creates missing tables along the way; refuses to overwrite a scalar node. */
export function setValueAtPath(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let current = root
  for (const segment of path.slice(0, -1)) {
    const existing = current[segment]
    if (existing === undefined) {
      const created: Record<string, unknown> = {}
      current[segment] = created
      current = created
      continue
    }
    const record = asRecord(existing)
    if (!record) {
      throw new ConfigFileError(
        `Cannot set ${path.join('.')}: ${segment} is already a value, not a section`,
      )
    }
    current = record
  }
  const leaf = path[path.length - 1]
  if (leaf === undefined) throw new ConfigFileError('A configuration key is required')
  current[leaf] = structuredClone(value)
}

/** Removes the leaf and prunes sections it leaves empty; returns false if absent. */
export function deleteValueAtPath(root: Record<string, unknown>, path: readonly string[]): boolean {
  const parents: Record<string, unknown>[] = []
  let current = root
  for (const segment of path.slice(0, -1)) {
    const record = asRecord(current[segment])
    if (!record) return false
    parents.push(current)
    current = record
  }
  const leaf = path[path.length - 1]
  if (leaf === undefined || !(leaf in current)) return false
  Reflect.deleteProperty(current, leaf)
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const parent = parents[index]
    const segment = path[index]
    if (!parent || segment === undefined) continue
    const child = asRecord(parent[segment])
    if (child && Object.keys(child).length === 0) Reflect.deleteProperty(parent, segment)
  }
  return true
}

/**
 * Typed values for `spark config set`: arrays/objects come from JSON, `true` /
 * `false` and bare numbers become TOML scalars, and anything else stays a
 * string so model ids and tool names never need quoting.
 */
export function parseSettingValue(raw: string): string | number | boolean | unknown[] | object {
  const trimmed = raw.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.map((entry: unknown) => entry)
      const record = asRecord(parsed)
      if (record === undefined) throw new Error('not a container')
      return record
    } catch (error) {
      throw new ConfigFileError(
        `Invalid JSON value ${trimmed}: expected an array or object (${errorMessage(error)})`,
        { cause: error },
      )
    }
  }
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (/^-?\d+$/u.test(trimmed)) return Number.parseInt(trimmed, 10)
  if (/^-?\d*\.\d+$/u.test(trimmed)) return Number.parseFloat(trimmed)
  if (trimmed === '') {
    throw new ConfigFileError('An empty value is not allowed; pass a value or use `spark config unset`')
  }
  const quoted = /^"(.*)"$/u.exec(trimmed) ?? /^'(.*)'$/u.exec(trimmed)
  return quoted?.[1] ?? raw
}
