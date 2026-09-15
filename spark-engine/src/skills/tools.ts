import type { ToolCallContext, ToolExecutor } from '../seams.js'
import type { ResolvedToolCall, ToolDefinition, ToolOutcome } from '../tools/contract.js'
import type { LocalSkillCatalog } from './catalog.js'

const skillIdSchema = { type: 'string', minLength: 1, maxLength: 512 } as const

export const skillsListToolDefinition: ToolDefinition = {
  name: 'skills_list',
  description:
    'List locally available skills by name and description. This catalog is intentionally compact; use skills_load with an id or name to read one skill instruction document.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', maxLength: 2_000 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
  },
  readonly: true,
  permissionClass: 'read',
  approval: 'never',
  concurrency: 'parallel',
  timeoutMs: 10_000,
  interruptible: true,
  costClass: 'io',
}

export const skillsLoadToolDefinition: ToolDefinition = {
  name: 'skills_load',
  description:
    'Load the complete instructions for one locally available skill. Only call this after skills_list identifies a relevant skill; the returned Markdown is not automatically injected into the system prompt.',
  inputSchema: {
    type: 'object',
    properties: { id: skillIdSchema },
    required: ['id'],
    additionalProperties: false,
  },
  readonly: true,
  permissionClass: 'read',
  approval: 'never',
  concurrency: 'parallel',
  timeoutMs: 30_000,
  interruptible: true,
  costClass: 'io',
}

export const skillToolDefinitions: readonly ToolDefinition[] = [
  skillsListToolDefinition,
  skillsLoadToolDefinition,
]

export class SkillToolExecutor implements ToolExecutor {
  constructor(private readonly catalog: LocalSkillCatalog) {}

  hasTool(name: string): boolean {
    return skillToolDefinitions.some((definition) => definition.name === name)
  }

  async execute(call: ResolvedToolCall, context: ToolCallContext): Promise<ToolOutcome> {
    context.signal.throwIfAborted()
    const args = asRecord(call.args)
    if (args === undefined) return { ok: false, content: 'Skill tool arguments must be an object' }
    try {
      if (call.name === skillsListToolDefinition.name) return await this.#list(args)
      if (call.name === skillsLoadToolDefinition.name) return await this.#load(args, context.signal)
      return { ok: false, content: `Unknown skill tool: ${call.name}` }
    } catch (error) {
      return { ok: false, content: errorMessage(error) }
    }
  }

  async #list(args: Record<string, unknown>): Promise<ToolOutcome> {
    const query = optionalString(args.query, 'query')
    const limit = args.limit === undefined ? undefined : positiveLimit(args.limit)
    const entries = await this.catalog.list({
      ...(query === undefined ? {} : { query }),
      ...(limit === undefined ? {} : { limit }),
    })
    if (entries.length === 0) return { ok: true, content: 'No local skills found.' }
    return {
      ok: true,
      content: entries
        .map(
          (entry) =>
            `[${entry.id}] ${entry.name} (${entry.scope}/${entry.provider})\n${entry.description}`,
        )
        .join('\n\n'),
    }
  }

  async #load(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    signal.throwIfAborted()
    const id = requiredString(args.id, 'id')
    const skill = await this.catalog.load(id)
    signal.throwIfAborted()
    if (skill.body.length === 0) {
      return { ok: false, content: `Skill "${skill.name}" has no instructions to load.` }
    }
    return {
      ok: true,
      content: `Skill: ${skill.name}\nID: ${skill.id}\nSource: ${skill.scope}/${skill.provider}\nPath: ${skill.skillFilePath}\n---\n${skill.body}`,
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  const normalized = value.trim()
  return normalized.length === 0 ? undefined : normalized
}

function positiveLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new Error('limit must be an integer from 1 to 200')
  }
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
