import type { ToolCallContext, ToolExecutor } from '../../seams.js'
import type { ResolvedToolCall, ToolDefinition, ToolOutcome } from '../contract.js'
import type { PlanStore } from './store.js'

export const planToolDefinition: ToolDefinition = {
  name: 'plan',
  description:
    'Read the current session execution plan as Markdown. Use this for the steps and decisions of the active task; use todo_list for durable project tasks shared across sessions.',
  inputSchema: {
    type: 'object',
    properties: {},
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

export const planUpdateToolDefinition: ToolDefinition = {
  name: 'plan_update',
  description:
    'Set, append to, or clear the current session execution plan as Markdown. Use this for active-task steps and decisions; use todo_update for durable project tasks shared across sessions.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['set', 'append', 'clear'] },
      content: { type: 'string', minLength: 1, maxLength: 262_144 },
    },
    required: ['operation'],
    additionalProperties: false,
  },
  readonly: false,
  permissionClass: 'workspace-write',
  approval: 'session',
  concurrency: 'serial',
  timeoutMs: 30_000,
  interruptible: true,
  costClass: 'io',
}

export const planToolDefinitions: readonly ToolDefinition[] = [
  planToolDefinition,
  planUpdateToolDefinition,
]

export class PlanToolExecutor implements ToolExecutor {
  constructor(private readonly store: PlanStore) {}

  hasTool(name: string): boolean {
    return name === planToolDefinition.name || name === planUpdateToolDefinition.name
  }

  async execute(call: ResolvedToolCall, context: ToolCallContext): Promise<ToolOutcome> {
    context.signal.throwIfAborted()
    const sessionId = context.owner?.sessionId
    if (sessionId === undefined) {
      return { ok: false, content: 'Plan tool requires an owning session.' }
    }
    if (call.name !== planToolDefinition.name && call.name !== planUpdateToolDefinition.name) {
      return { ok: false, content: `Unknown plan tool: ${call.name}` }
    }
    const args = asRecord(call.args)
    if (args === undefined) return { ok: false, content: 'Plan arguments must be an object' }
    try {
      if (call.name === planToolDefinition.name) return await this.#read(sessionId)
      const operation = requiredOperation(args.operation)
      if (operation === 'clear') {
        const removed = await this.store.clear(sessionId)
        return {
          ok: true,
          content: removed
            ? `Cleared plan for session ${sessionId}.`
            : `No plan exists for session ${sessionId}.`,
        }
      }
      const content = requiredContent(args.content)
      if (operation === 'set') await this.store.write(sessionId, content)
      else await this.store.append(sessionId, content)
      return {
        ok: true,
        content: `${operation === 'set' ? 'Set' : 'Appended to'} plan for session ${sessionId}.\npath: ${this.store.filePath(sessionId)}`,
      }
    } catch (error) {
      return { ok: false, content: errorMessage(error) }
    }
  }

  async #read(sessionId: string): Promise<ToolOutcome> {
    const body = await this.store.read(sessionId)
    if (body === undefined) {
      return { ok: true, content: `No plan exists for session ${sessionId}.` }
    }
    return {
      ok: true,
      content: `Plan for session ${sessionId}\npath: ${this.store.filePath(sessionId)}\n---\n${body}`,
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function requiredOperation(value: unknown): 'set' | 'append' | 'clear' {
  if (value === 'set' || value === 'append' || value === 'clear') return value
  throw new Error('operation must be set, append, or clear')
}

function requiredContent(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('content must be a non-empty string')
  }
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
