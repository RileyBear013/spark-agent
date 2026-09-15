import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { z } from 'zod'

import { NULL_RUNTIME_LOGGER, type RuntimeLogger } from '../../observability/logger.js'
import { atomicWriteFile } from '../workspace/atomic-write.js'
import { WorkspacePathGuard } from '../workspace/path-guard.js'

export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

export const TODO_PRIORITIES = ['low', 'normal', 'high'] as const
export type TodoPriority = (typeof TODO_PRIORITIES)[number]

export interface TodoItem {
  readonly id: string
  readonly title: string
  readonly status: TodoStatus
  readonly priority: TodoPriority
  readonly notes: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface TodoStoreOptions {
  readonly cwd: string
  readonly logger?: RuntimeLogger
}

export interface TodoUpdateInput {
  readonly id: string
  readonly title?: string
  readonly status?: TodoStatus
  readonly priority?: TodoPriority
  readonly notes?: string
}

export class TodoStoreError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'TodoStoreError'
  }
}

const TodoItemSchema = z
  .object({
    id: z.string().regex(/^todo_[A-Za-z0-9-]+$/u),
    title: z.string().min(1).max(240),
    status: z.enum(TODO_STATUSES),
    priority: z.enum(TODO_PRIORITIES),
    notes: z.string().max(20_000),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()

const TodoFileSchema = z
  .object({ version: z.literal(1), items: z.array(TodoItemSchema).max(1_000) })
  .strict()

const TODO_FILE = '.spark/todos.json'
const TODO_ID_PATTERN = /^todo_[A-Za-z0-9-]+$/u

/** Project-local, dependency-free task list persisted as an atomic JSON file. */
export class TodoStore {
  readonly #cwd: string
  readonly #path: string
  readonly #guard: WorkspacePathGuard
  readonly #logger: RuntimeLogger

  constructor(options: TodoStoreOptions) {
    this.#cwd = resolve(options.cwd)
    this.#path = resolve(this.#cwd, TODO_FILE)
    this.#guard = new WorkspacePathGuard(this.#cwd)
    this.#logger = options.logger ?? NULL_RUNTIME_LOGGER
  }

  get filePath(): string {
    return this.#path
  }

  async list(): Promise<readonly TodoItem[]> {
    const items = await this.#read()
    return [...items].sort(compareTodos)
  }

  async add(input: {
    readonly title: string
    readonly priority?: TodoPriority
    readonly notes?: string
  }): Promise<TodoItem> {
    const now = Date.now()
    const item: TodoItem = {
      id: `todo_${randomUUID()}`,
      title: requiredSingleLine(input.title, 'title'),
      status: 'pending',
      priority: input.priority === undefined ? 'normal' : requiredPriority(input.priority),
      notes: normalizeNotes(input.notes ?? ''),
      createdAt: now,
      updatedAt: now,
    }
    const items = await this.#read()
    await this.#write([...items, item])
    this.#logger.info(`todo added id=${item.id} status=${item.status}`)
    return item
  }

  async update(input: TodoUpdateInput): Promise<TodoItem> {
    const id = requiredId(input.id)
    const items = await this.#read()
    const index = items.findIndex((item) => item.id === id)
    if (index < 0) throw new TodoStoreError(`Todo not found: ${id}`)
    const previous = items[index]
    if (previous === undefined) throw new TodoStoreError(`Todo not found: ${id}`)
    const next: TodoItem = {
      ...previous,
      ...(input.title === undefined ? {} : { title: requiredSingleLine(input.title, 'title') }),
      ...(input.status === undefined ? {} : { status: requiredStatus(input.status) }),
      ...(input.priority === undefined ? {} : { priority: requiredPriority(input.priority) }),
      ...(input.notes === undefined ? {} : { notes: normalizeNotes(input.notes) }),
      updatedAt: Date.now(),
    }
    const updated = [...items]
    updated[index] = next
    await this.#write(updated)
    this.#logger.info(`todo updated id=${next.id} status=${next.status}`)
    return next
  }

  async remove(id: string): Promise<TodoItem> {
    const normalized = requiredId(id)
    const items = await this.#read()
    const item = items.find((candidate) => candidate.id === normalized)
    if (item === undefined) throw new TodoStoreError(`Todo not found: ${normalized}`)
    await this.#write(items.filter((candidate) => candidate.id !== normalized))
    this.#logger.info(`todo removed id=${normalized}`)
    return item
  }

  /** Clears completed/cancelled items by default; `all` is explicit and destructive. */
  async clear(options: { readonly all?: boolean } = {}): Promise<number> {
    const items = await this.#read()
    const retained = options.all
      ? []
      : items.filter((item) => item.status !== 'completed' && item.status !== 'cancelled')
    const removed = items.length - retained.length
    if (removed > 0) await this.#write(retained)
    this.#logger.info(`todo cleared count=${removed} all=${options.all === true}`)
    return removed
  }

  async #read(): Promise<TodoItem[]> {
    const location = await this.#guard.writable(TODO_FILE)
    let source: string
    try {
      source = await readFile(location.target, 'utf8')
    } catch (error) {
      if (isMissing(error)) return []
      throw new TodoStoreError(`Unable to read todo list ${this.#path}`, { cause: error })
    }
    let value: unknown
    try {
      value = JSON.parse(source) as unknown
    } catch (error) {
      throw new TodoStoreError(`Invalid todo JSON in ${this.#path}`, { cause: error })
    }
    const parsed = TodoFileSchema.safeParse(value)
    if (!parsed.success) {
      throw new TodoStoreError(`Invalid todo data in ${this.#path}: ${parsed.error.message}`)
    }
    return parsed.data.items.map((item) => ({ ...item }))
  }

  async #write(items: readonly TodoItem[]): Promise<void> {
    const location = await this.#guard.writable(TODO_FILE)
    const content = `${JSON.stringify({ version: 1, items }, null, 2)}\n`
    await atomicWriteFile(location.target, content, async () => {
      await this.#guard.existing(dirname(location.target))
    })
  }
}

function compareTodos(left: TodoItem, right: TodoItem): number {
  const status = statusRank(left.status) - statusRank(right.status)
  if (status !== 0) return status
  const priority = priorityRank(right.priority) - priorityRank(left.priority)
  if (priority !== 0) return priority
  return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
}

function statusRank(status: TodoStatus): number {
  return status === 'in_progress' ? 0 : status === 'pending' ? 1 : status === 'completed' ? 2 : 3
}

function priorityRank(priority: TodoPriority): number {
  return priority === 'high' ? 2 : priority === 'normal' ? 1 : 0
}

function requiredId(value: string): string {
  const normalized = value.trim()
  if (!TODO_ID_PATTERN.test(normalized)) throw new TodoStoreError(`Invalid todo id: ${value}`)
  return normalized
}

function requiredSingleLine(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new TodoStoreError(`Todo ${name} must not be empty`)
  if (normalized.includes('\n') || normalized.includes('\r')) {
    throw new TodoStoreError(`Todo ${name} must be a single line`)
  }
  if (normalized.length > 240)
    throw new TodoStoreError(`Todo ${name} must be at most 240 characters`)
  return normalized
}

function normalizeNotes(value: string): string {
  if (typeof value !== 'string') throw new TodoStoreError('Todo notes must be a string')
  const normalized = value.trim()
  if (normalized.length > 20_000)
    throw new TodoStoreError('Todo notes must be at most 20000 characters')
  return normalized
}

function requiredStatus(value: unknown): TodoStatus {
  if ((TODO_STATUSES as readonly unknown[]).includes(value)) return value as TodoStatus
  throw new TodoStoreError('Todo status must be pending, in_progress, completed, or cancelled')
}

function requiredPriority(value: unknown): TodoPriority {
  if ((TODO_PRIORITIES as readonly unknown[]).includes(value)) return value as TodoPriority
  throw new TodoStoreError('Todo priority must be low, normal, or high')
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  )
}
