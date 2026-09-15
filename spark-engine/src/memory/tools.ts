import type { ToolCallContext, ToolExecutor } from '../seams.js'
import type { ResolvedToolCall, ToolDefinition, ToolOutcome } from '../tools/contract.js'
import {
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type FileMemoryStore,
  type MemoryScope,
  type MemoryType,
} from './store.js'

const scopeSchema = { type: 'string', enum: [...MEMORY_SCOPES] } as const

export const memoryToolDefinitions: readonly ToolDefinition[] = [
  {
    name: 'search_memory',
    description:
      'Search long-term memory summaries across user, current project, and current agent scopes. Use this when the injected summary does not contain enough context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2_000 },
        scope: scopeSchema,
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    readonly: true,
    permissionClass: 'read',
    approval: 'never',
    concurrency: 'parallel',
    timeoutMs: 10_000,
    interruptible: true,
    costClass: 'cpu',
  },
  {
    name: 'recall_memory',
    description:
      'Read the complete body of one long-term memory entry by its id. The result may include history that is not in the compact injected summary.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
      required: ['id'],
      additionalProperties: false,
    },
    readonly: true,
    permissionClass: 'read',
    approval: 'never',
    concurrency: 'parallel',
    timeoutMs: 10_000,
    interruptible: true,
    costClass: 'io',
  },
  {
    name: 'save_memory',
    description:
      'Persist a durable fact or preference in long-term memory. Use only for information the user wants remembered; choose user for general preferences, project for repository-specific facts, or agent for this agent profile.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: scopeSchema,
        name: { type: 'string', minLength: 1, maxLength: 240 },
        description: { type: 'string', minLength: 1, maxLength: 2_000 },
        body: { type: 'string', minLength: 1, maxLength: 100_000 },
        type: { type: 'string', enum: [...MEMORY_TYPES] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['scope', 'name', 'description', 'body'],
      additionalProperties: false,
    },
    readonly: false,
    permissionClass: 'workspace-write',
    approval: 'session',
    concurrency: 'serial',
    timeoutMs: 30_000,
    interruptible: true,
    costClass: 'io',
  },
]

export class MemoryToolExecutor implements ToolExecutor {
  constructor(private readonly store: FileMemoryStore) {}

  hasTool(name: string): boolean {
    return memoryToolDefinitions.some((definition) => definition.name === name)
  }

  async execute(call: ResolvedToolCall, context: ToolCallContext): Promise<ToolOutcome> {
    context.signal.throwIfAborted()
    const args = asRecord(call.args)
    if (args === undefined) return { ok: false, content: 'Memory tool arguments must be an object' }
    try {
      switch (call.name) {
        case 'search_memory':
          return await this.#search(args)
        case 'recall_memory':
          return await this.#recall(args)
        case 'save_memory':
          return await this.#save(args, context.signal)
        default:
          return { ok: false, content: `Unknown memory tool: ${call.name}` }
      }
    } catch (error) {
      return { ok: false, content: errorMessage(error) }
    }
  }

  async #search(args: Record<string, unknown>): Promise<ToolOutcome> {
    const query = stringArg(args.query, 'query')
    const scope = optionalScope(args.scope)
    const entries = await this.store.search(query, {
      ...(scope === undefined ? {} : { scope }),
      limit: args.limit === undefined ? 10 : numberArg(args.limit, 'limit'),
    })
    if (entries.length === 0) return { ok: true, content: 'No matching long-term memories.' }
    return {
      ok: true,
      content: entries
        .map(
          (entry) =>
            `[${entry.id}] ${entry.name} (${entry.scope}/${entry.type})\n${entry.description}`,
        )
        .join('\n\n'),
    }
  }

  async #recall(args: Record<string, unknown>): Promise<ToolOutcome> {
    const id = stringArg(args.id, 'id')
    const result = await this.store.recall(id)
    if (result.entry === undefined) return { ok: false, content: result.error ?? `Memory not found: ${id}` }
    return {
      ok: true,
      content: `[${result.entry.id}] ${result.entry.name}\nScope: ${result.entry.scope}\nType: ${result.entry.type}\n\n${result.entry.body}`,
    }
  }

  async #save(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    signal.throwIfAborted()
    const scope = requiredScope(args.scope)
    const entry = await this.store.save({
      scope,
      name: stringArg(args.name, 'name'),
      description: stringArg(args.description, 'description'),
      body: stringArg(args.body, 'body'),
      ...(args.type === undefined ? {} : { type: requiredType(args.type) }),
      ...(args.confidence === undefined ? {} : { confidence: numberArg(args.confidence, 'confidence') }),
    })
    return { ok: true, content: `Saved memory ${entry.id} (${entry.scope}): ${entry.name}` }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function numberArg(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a number`)
  return value
}

function optionalScope(value: unknown): MemoryScope | undefined {
  if (value === undefined) return undefined
  return requiredScope(value)
}

function requiredScope(value: unknown): MemoryScope {
  if (value === 'user' || value === 'project' || value === 'agent') return value
  throw new Error('scope must be user, project, or agent')
}

function requiredType(value: unknown): MemoryType {
  if (value === 'user' || value === 'feedback' || value === 'project' || value === 'reference') return value
  throw new Error('type must be user, feedback, project, or reference')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
