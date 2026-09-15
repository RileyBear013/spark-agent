import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { ancestorDirectories } from '../memory/instructions.js'
import { NULL_RUNTIME_LOGGER, type RuntimeLogger } from '../observability/logger.js'

export type SkillScope = 'user' | 'project'
export type SkillProvider = 'spark' | 'claude' | 'codex' | 'agents'

export interface SkillCatalogEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly scope: SkillScope
  readonly provider: SkillProvider
  readonly rootPath: string
  readonly skillFilePath: string
}

export interface LoadedSkill extends SkillCatalogEntry {
  readonly body: string
}

export type SkillCatalogErrorCode =
  | 'invalid_options'
  | 'not_found'
  | 'invalid_document'
  | 'oversized_document'
  | 'changed_document'

export class SkillCatalogError extends Error {
  readonly code: SkillCatalogErrorCode

  constructor(code: SkillCatalogErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SkillCatalogError'
    this.code = code
  }
}

export interface SkillRoot {
  readonly path: string
  readonly scope: SkillScope
  readonly provider: SkillProvider
}

export interface SkillCatalogOptions {
  readonly cwd: string
  /** User home used for global skill roots; defaults to the OS home. */
  readonly home?: string
  readonly maxSkills?: number
  readonly maxFileBytes?: number
  readonly logger?: RuntimeLogger
}

export interface SkillListOptions {
  readonly query?: string
  readonly limit?: number
}

const SKILL_FILE_NAME = 'SKILL.md'
const DEFAULT_MAX_SKILLS = 200
const DEFAULT_MAX_FILE_BYTES = 256 * 1024
const MAX_METADATA_BYTES = 16 * 1024
const MAX_NAME_CHARS = 128
const MAX_DESCRIPTION_CHARS = 2_000
const ROOT_NAMES: readonly [directory: string, provider: SkillProvider][] = [
  ['.claude/skills', 'claude'],
  ['.codex/skills', 'codex'],
  ['.agents/skills', 'agents'],
  ['.spark/skills', 'spark'],
]

/**
 * Returns the same local skill locations understood by the desktop runtime,
 * plus project-local `.spark/skills`. Later roots have higher precedence.
 * Global roots are visited first, then project ancestors from root to cwd.
 */
export function defaultSkillRoots(cwd: string, home = homedir()): readonly SkillRoot[] {
  const roots: SkillRoot[] = []
  const globalHome = resolve(home)
  for (const [directory, provider] of ROOT_NAMES) {
    roots.push({ path: join(globalHome, directory), scope: 'user', provider })
  }
  for (const directory of ancestorDirectories(cwd)) {
    for (const [relativePath, provider] of ROOT_NAMES) {
      roots.push({ path: join(directory, relativePath), scope: 'project', provider })
    }
  }
  return roots
}

/**
 * Discovers and explicitly loads local SKILL.md documents without executing
 * anything from their directories. The catalog is intentionally uncached so a
 * long-running TUI sees edits made to a skill between turns.
 */
export class LocalSkillCatalog {
  readonly #cwd: string
  readonly #home: string
  readonly #maxSkills: number
  readonly #maxFileBytes: number
  readonly #logger: RuntimeLogger

  constructor(options: SkillCatalogOptions) {
    this.#cwd = resolve(options.cwd)
    this.#home = resolve(options.home ?? homedir())
    this.#maxSkills = positiveBoundedInteger(
      options.maxSkills ?? DEFAULT_MAX_SKILLS,
      1,
      DEFAULT_MAX_SKILLS,
      'maxSkills',
    )
    this.#maxFileBytes = positiveBoundedInteger(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      1,
      4 * 1024 * 1024,
      'maxFileBytes',
    )
    this.#logger = options.logger ?? NULL_RUNTIME_LOGGER
  }

  async list(options: SkillListOptions = {}): Promise<readonly SkillCatalogEntry[]> {
    const limit = positiveBoundedInteger(
      options.limit ?? this.#maxSkills,
      1,
      this.#maxSkills,
      'limit',
    )
    const query = options.query?.trim().toLocaleLowerCase()
    const entries = await this.#collect()
    return entries
      .filter((entry) => {
        if (query === undefined || query.length === 0) return true
        return [entry.id, entry.name, entry.description].some((value) =>
          value.toLocaleLowerCase().includes(query),
        )
      })
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, limit)
  }

  async load(selector: string): Promise<LoadedSkill> {
    const requested = requiredSelector(selector)
    // Loading is explicit, so it must not be restricted to the first page of
    // the compact catalog when a workspace contains more than maxSkills items.
    const entry = (await this.#collect()).find(
      (candidate) =>
        candidate.id === requested || normalizeName(candidate.name) === normalizeName(requested),
    )
    if (entry === undefined) {
      throw new SkillCatalogError('not_found', `Skill not found: ${requested}`)
    }

    let raw: string
    try {
      const fileStat = await stat(entry.skillFilePath)
      if (!fileStat.isFile()) throw new Error('path is not a regular file')
      if (fileStat.size > this.#maxFileBytes) {
        throw new SkillCatalogError(
          'oversized_document',
          `Skill exceeds the ${this.#maxFileBytes}-byte limit: ${entry.skillFilePath}`,
        )
      }
      raw = await readFile(entry.skillFilePath, 'utf8')
    } catch (error) {
      if (error instanceof SkillCatalogError) throw error
      throw new SkillCatalogError(
        'invalid_document',
        `Unable to read skill ${requested}: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    if (Buffer.byteLength(raw, 'utf8') > this.#maxFileBytes) {
      throw new SkillCatalogError(
        'oversized_document',
        `Skill exceeds the ${this.#maxFileBytes}-byte limit: ${entry.skillFilePath}`,
      )
    }

    const parsed = parseSkillDocument(raw, entry.skillFilePath)
    if (normalizeName(parsed.name) !== normalizeName(entry.name)) {
      throw new SkillCatalogError(
        'changed_document',
        `Skill changed while loading; run skills_list again before loading ${requested}.`,
      )
    }
    return {
      ...entry,
      description: truncate(parsed.description, MAX_DESCRIPTION_CHARS),
      body: parsed.body,
    }
  }

  async #collect(): Promise<readonly SkillCatalogEntry[]> {
    const selected = new Map<string, SkillCatalogEntry>()
    for (const root of defaultSkillRoots(this.#cwd, this.#home)) {
      for (const entry of await this.#discoverRoot(root)) {
        // Root order encodes precedence: a project-local or more-specific
        // entry replaces a global entry with the same user-facing name.
        selected.set(normalizeName(entry.name), entry)
      }
    }
    return [...selected.values()]
  }

  async #discoverRoot(root: SkillRoot): Promise<readonly SkillCatalogEntry[]> {
    if (!(await isDirectory(root.path))) return []
    const directories: string[] = [root.path]
    let entries
    try {
      entries = await readdir(root.path, { withFileTypes: true })
    } catch (error) {
      this.#logger.debug(`skills root skipped path=${root.path} reason=${errorMessage(error)}`)
      return []
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = join(root.path, entry.name)
      if (entry.isDirectory() || (entry.isSymbolicLink() && (await isDirectory(candidate)))) {
        directories.push(candidate)
      }
    }

    const candidates: SkillCatalogEntry[] = []
    for (const directory of directories) {
      const skillFilePath = join(directory, SKILL_FILE_NAME)
      if (!(await isFile(skillFilePath))) continue
      try {
        const parsed = await readSkillMetadata(skillFilePath, this.#maxFileBytes)
        candidates.push({
          id: localSkillId(root.scope, root.provider, parsed.name),
          name: parsed.name,
          description: truncate(parsed.description, MAX_DESCRIPTION_CHARS),
          scope: root.scope,
          provider: root.provider,
          rootPath: directory,
          skillFilePath,
        })
      } catch (error) {
        this.#logger.debug(`skill skipped path=${skillFilePath} reason=${errorMessage(error)}`)
      }
    }
    return candidates
  }
}

export function localSkillId(scope: SkillScope, provider: SkillProvider, name: string): string {
  return `local:${scope}:${provider}:${name}`
}

interface ParsedSkillDocument {
  readonly name: string
  readonly description: string
  readonly body: string
}

async function readSkillMetadata(path: string, maxFileBytes: number): Promise<ParsedSkillDocument> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size > maxFileBytes) {
      throw new SkillCatalogError(
        'oversized_document',
        `Skill exceeds the ${maxFileBytes}-byte limit: ${path}`,
      )
    }
    const buffer = Buffer.alloc(Math.min(size, MAX_METADATA_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return parseSkillDocument(buffer.subarray(0, bytesRead).toString('utf8'), path)
  } finally {
    await handle.close()
  }
}

function parseSkillDocument(raw: string, path: string): ParsedSkillDocument {
  const normalized = raw.replace(/^\uFEFF/u, '').replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) {
    throw new SkillCatalogError('invalid_document', `Skill is missing YAML frontmatter: ${path}`)
  }
  const closingMatch = /^---[ \t]*$/mu.exec(normalized.slice(4))
  if (closingMatch === null) {
    throw new SkillCatalogError(
      'invalid_document',
      `Skill frontmatter is not terminated with \`---\`: ${path}`,
    )
  }
  const frontmatterEnd = 4 + closingMatch.index
  const bodyStart = frontmatterEnd + closingMatch[0].length
  const fields = parseFrontmatter(normalized.slice(4, frontmatterEnd), path)
  const body = normalized.slice(bodyStart).replace(/^\n/u, '').trim()
  if (body.includes('\0')) {
    throw new SkillCatalogError('invalid_document', `Skill body contains NUL bytes: ${path}`)
  }
  return { name: fields.name, description: fields.description, body }
}

function parseFrontmatter(source: string, path: string): { name: string; description: string } {
  const lines = source.split('\n')
  const fields = new Map<string, string>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/u.exec(line)
    if (match === null) continue
    const key = match[1]
    if (key === undefined) continue
    const rawValue = match[2]?.trim() ?? ''
    if (
      rawValue === '|' ||
      rawValue === '>' ||
      /^\|[-+]?$/u.test(rawValue) ||
      /^>[-+]?$/u.test(rawValue)
    ) {
      const continuation: string[] = []
      let next = index + 1
      while (next < lines.length) {
        const continuationLine = lines[next] ?? ''
        if (continuationLine.trim().length === 0) {
          continuation.push('')
          next += 1
          continue
        }
        if (!/^\s+/u.test(continuationLine)) break
        continuation.push(continuationLine.trim())
        next += 1
      }
      fields.set(key, rawValue.startsWith('>') ? continuation.join(' ') : continuation.join('\n'))
      index = next - 1
      continue
    }
    fields.set(key, unquoteYamlScalar(rawValue))
  }
  const name = requiredFrontmatterString(fields.get('name'), 'name', path)
  const description = requiredFrontmatterString(fields.get('description'), 'description', path)
  return { name, description }
}

function requiredFrontmatterString(value: string | undefined, key: string, path: string): string {
  const normalized = value?.trim() ?? ''
  if (normalized.length === 0) {
    throw new SkillCatalogError(
      'invalid_document',
      `Skill frontmatter requires a non-empty ${key}: ${path}`,
    )
  }
  if (normalized.includes('\0')) {
    throw new SkillCatalogError('invalid_document', `Skill frontmatter contains NUL bytes: ${path}`)
  }
  if (key === 'name' && normalized.length > MAX_NAME_CHARS) {
    throw new SkillCatalogError(
      'invalid_document',
      `Skill name exceeds the ${MAX_NAME_CHARS}-character limit: ${path}`,
    )
  }
  return normalized
}

function unquoteYamlScalar(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === 'string' ? parsed : value.slice(1, -1)
    } catch {
      return value.slice(1, -1)
    }
  }
  return value
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function requiredSelector(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SkillCatalogError('invalid_options', 'Skill id or name must be a non-empty string')
  }
  return value.trim()
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function positiveBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SkillCatalogError(
      'invalid_options',
      `${name} must be an integer from ${minimum} to ${maximum}`,
    )
  }
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
