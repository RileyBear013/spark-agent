import type { ToolCallContext, ToolExecutor } from '../../seams.js'
import type { ResolvedToolCall, ToolDefinition, ToolOutcome } from '../contract.js'
import {
  TODO_PRIORITIES,
  TODO_STATUSES,
  type TodoPriority,
  type TodoStore,
  type TodoStatus,
} from './store.js'

const idSchema = { type: 'string', minLength: 1, maxLength: 128 } as const

export const todoToolDefinitions: readonly ToolDefinition[] = [
  {
    name: 'todo_list',
    description:
      'List the current project task list. Use this before planning or updating tasks so existing work is preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...TODO_STATUSES] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
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
  },
  {
    name: 'todo_update',
    description:
      'Add, update, complete, or remove one project task. Keep titles short, preserve useful notes, and mark work in_progress before starting it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'complete', 'remove'] },
        id: idSchema,
        title: { type: 'string', minLength: 1, maxLength: 240 },
        status: { type: 'string', enum: [...TODO_STATUSES] },
        priority: { type: 'string', enum: [...TODO_PRIORITIES] },
        notes: { type: 'string', maxLength: 20_000 },
      },
      required: ['action'],
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

export class TodoToolExecutor implements ToolExecutor {
  constructor(private readonly store: TodoStore) {}

  hasTool(name: string): boolean {
    return todoToolDefinitions.some((definition) => definition.name === name)
  }

  async execute(call: ResolvedToolCall, context: ToolCallContext): Promise<ToolOutcome> {
    context.signal.throwIfAborted()
    const args = asRecord(call.args)
    if (args === undefined) return { ok: false, content: 'Todo tool arguments must be an object' }
    try {
      if (call.name === 'todo_list') return await this.#list(args)
      if (call.name === 'todo_update') return await this.#update(args, context.signal)
      return { ok: false, content: `Unknown todo tool: ${call.name}` }
    } catch (error) {
      return { ok: false, content: errorMessage(error) }
    }
  }

  async #list(args: Record<string, unknown>): Promise<ToolOutcome> {
    const status = optionalStatus(args.status)
    const limit = args.limit === undefined ? 50 : positiveLimit(args.limit)
    const items = (await this.store.list())
      .filter((item) => status === undefined || item.status === status)
      .slice(0, limit)
    if (items.length === 0) return { ok: true, content: 'No project todos.' }
    return { ok: true, content: renderTodos(items) }
  }

  async #update(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    signal.throwIfAborted()
    const action = requiredAction(args.action)
    if (action === 'add') {
      const item = await this.store.add({
        title: requiredString(args.title, 'title'),
        ...(args.priority === undefined ? {} : { priority: requiredPriority(args.priority) }),
        ...(args.notes === undefined ? {} : { notes: requiredNotes(args.notes) }),
      })
      return { ok: true, content: `Added todo ${item.id}: ${item.title}` }
    }
    const id = requiredString(args.id, 'id')
    if (action === 'complete') {
      const item = await this.store.update({ id, status: 'completed' })
      return { ok: true, content: `Completed todo ${item.id}: ${item.title}` }
    }
    if (action === 'remove') {
      const item = await this.store.remove(id)
      return { ok: true, content: `Removed todo ${item.id}: ${item.title}` }
    }
    if (
      args.title === undefined &&
      args.status === undefined &&
      args.priority === undefined &&
      args.notes === undefined
    ) {
      throw new Error('todo update requires title, status, priority, or notes')
    }
    const item = await this.store.update({
      id,
      ...(args.title === undefined ? {} : { title: requiredString(args.title, 'title') }),
      ...(args.status === undefined ? {} : { status: requiredStatus(args.status) }),
      ...(args.priority === undefined ? {} : { priority: requiredPriority(args.priority) }),
      ...(args.notes === undefined ? {} : { notes: requiredNotes(args.notes) }),
    })
    return { ok: true, content: `Updated todo ${item.id}: ${item.title}` }
  }
}

function renderTodos(items: readonly Awaited<ReturnType<TodoStore['list']>>[number][]): string {
  return items
    .map((item) => {
      const notes = item.notes.length === 0 ? '' : `\n  ${item.notes}`
      return `[${item.id}] ${item.status} (${item.priority}) ${item.title}${notes}`
    })
    .join('\n')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function requiredAction(value: unknown): 'add' | 'update' | 'complete' | 'remove' {
  if (value === 'add' || value === 'update' || value === 'complete' || value === 'remove')
    return value
  throw new Error('action must be add, update, complete, or remove')
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function requiredNotes(value: unknown): string {
  if (typeof value !== 'string') throw new Error('notes must be a string')
  return value
}

function optionalStatus(value: unknown): TodoStatus | undefined {
  return value === undefined ? undefined : requiredStatus(value)
}

function requiredStatus(value: unknown): TodoStatus {
  if ((TODO_STATUSES as readonly unknown[]).includes(value)) return value as TodoStatus
  throw new Error('status must be pending, in_progress, completed, or cancelled')
}

function requiredPriority(value: unknown): TodoPriority {
  if ((TODO_PRIORITIES as readonly unknown[]).includes(value)) return value as TodoPriority
  throw new Error('priority must be low, normal, or high')
}

function positiveLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error('limit must be an integer from 1 to 100')
  }
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
