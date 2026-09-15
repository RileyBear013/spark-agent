import { FileMemoryStore, MEMORY_SCOPES, MEMORY_TYPES, type MemoryScope, type MemoryType } from '../memory/store.js'
import { loadSparkSettings, resolveMemorySettings, type SparkSettingsOptions } from '../config/settings.js'

export interface MemoryCommandOptions extends SparkSettingsOptions {
  readonly subcommand: string
  readonly args: readonly string[]
  readonly json: boolean
  readonly scope?: string
  readonly limit?: string
  readonly name?: string
  readonly description?: string
  readonly body?: string
  readonly type?: string
  readonly confidence?: string
  readonly agentId?: string
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

export async function executeMemoryCommand(options: MemoryCommandOptions): Promise<number> {
  try {
    const settings = await loadSparkSettings(options)
    const resolved = resolveMemorySettings(settings)
    const store = new FileMemoryStore({
      cwd: options.cwd,
      agentId: options.agentId ?? resolved.agentId,
      maxInjectTokens: resolved.maxInjectTokens,
      enabled: resolved.enabled,
    })
    switch (options.subcommand) {
      case '':
      case 'list':
        return await listMemories(store, options)
      case 'search':
        return await searchMemories(store, options)
      case 'recall':
        return await recallMemory(store, options)
      case 'save':
      case 'add':
        return await saveMemory(store, options)
      default:
        options.stderr(
          `Unknown \`spark memory\` subcommand: ${options.subcommand} (list | search | recall | save)\n`,
        )
        return 2
    }
  } catch (error) {
    options.stderr(`${errorMessage(error)}\n`)
    return 2
  }
}

async function listMemories(store: FileMemoryStore, options: MemoryCommandOptions): Promise<number> {
  const entries = await store.list({
    ...(options.scope === undefined ? {} : { scope: requiredScope(options.scope) }),
    ...(options.limit === undefined ? {} : { limit: parseLimit(options.limit) }),
  })
  if (options.json) {
    options.stdout(
      `${JSON.stringify(
        { memories: entries.map(memoryView), agentId: store.agentId },
        null,
        2,
      )}\n`,
    )
    return 0
  }
  if (entries.length === 0) {
    options.stdout('No long-term memories found. Save one with `spark memory save`.\n')
    return 0
  }
  for (const entry of entries) {
    options.stdout(
      `[${entry.id}] ${entry.scope}/${entry.type}  ${entry.name}\n` +
        `  ${entry.description}\n`,
    )
  }
  return 0
}

async function searchMemories(store: FileMemoryStore, options: MemoryCommandOptions): Promise<number> {
  const query = options.args.join(' ').trim()
  if (query.length === 0) {
    options.stderr('Usage: spark memory search <query> [--scope user|project|agent] [--limit n]\n')
    return 2
  }
  const entries = await store.search(query, {
    ...(options.scope === undefined ? {} : { scope: requiredScope(options.scope) }),
    ...(options.limit === undefined ? {} : { limit: parseLimit(options.limit) }),
  })
  if (options.json) {
    options.stdout(
      `${JSON.stringify(
        { query, memories: entries.map(memoryView) },
        null,
        2,
      )}\n`,
    )
    return 0
  }
  if (entries.length === 0) {
    options.stdout(`No memories matched: ${query}\n`)
    return 0
  }
  for (const entry of entries) {
    options.stdout(`[${entry.id}] ${entry.scope}/${entry.type}  ${entry.name}\n${entry.description}\n\n`)
  }
  return 0
}

async function recallMemory(store: FileMemoryStore, options: MemoryCommandOptions): Promise<number> {
  const id = options.args[0]
  if (id === undefined || options.args.length > 1) {
    options.stderr('Usage: spark memory recall <id>\n')
    return 2
  }
  const result = await store.recall(id)
  if (result.entry === undefined) {
    options.stderr(`${result.error ?? `Memory not found: ${id}`}\n`)
    return 1
  }
  if (options.json) {
    options.stdout(`${JSON.stringify(result.entry, null, 2)}\n`)
    return 0
  }
  options.stdout(
    `[${result.entry.id}] ${result.entry.name}\n` +
      `Scope: ${result.entry.scope}\nType: ${result.entry.type}\n` +
      `Hits: ${result.entry.hitCount}\n\n${result.entry.body}\n`,
  )
  return 0
}

async function saveMemory(store: FileMemoryStore, options: MemoryCommandOptions): Promise<number> {
  const scope = options.scope === undefined ? undefined : requiredScope(options.scope)
  if (
    scope === undefined ||
    options.name === undefined ||
    options.description === undefined ||
    options.body === undefined
  ) {
    options.stderr(
      'Usage: spark memory save --scope user|project|agent --name <name> ' +
        '--description <summary> --body <markdown> [--type user|feedback|project|reference] ' +
        '[--confidence 0..1]\n',
    )
    return 2
  }
  const entry = await store.save({
    scope,
    name: options.name,
    description: options.description,
    body: options.body,
    ...(options.type === undefined ? {} : { type: requiredType(options.type) }),
    ...(options.confidence === undefined ? {} : { confidence: parseConfidence(options.confidence) }),
  })
  if (options.json) {
    options.stdout(`${JSON.stringify(entry, null, 2)}\n`)
    return 0
  }
  options.stdout(`Saved memory ${entry.id} (${entry.scope}): ${entry.name}\n${entry.filePath}\n`)
  return 0
}

function requiredScope(value: string): MemoryScope {
  if ((MEMORY_SCOPES as readonly string[]).includes(value)) return value as MemoryScope
  throw new Error(`Invalid memory scope: ${value} (user | project | agent)`)
}

function requiredType(value: string): MemoryType {
  if ((MEMORY_TYPES as readonly string[]).includes(value)) return value as MemoryType
  throw new Error(`Invalid memory type: ${value} (user | feedback | project | reference)`)
}

function parseLimit(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('Memory limit must be an integer from 1 to 100')
  }
  return parsed
}

function parseConfidence(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error('Memory confidence must be a number from 0 to 1')
  }
  return parsed
}

function memoryView(entry: Awaited<ReturnType<FileMemoryStore['list']>>[number]): object {
  return {
    id: entry.id,
    scope: entry.scope,
    scopeRef: entry.scopeRef,
    type: entry.type,
    name: entry.name,
    description: entry.description,
    filePath: entry.filePath,
    confidence: entry.confidence,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    hitCount: entry.hitCount,
    lastHitAt: entry.lastHitAt,
    sourceSessionId: entry.sourceSessionId,
    links: entry.links,
    archived: entry.archived,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
