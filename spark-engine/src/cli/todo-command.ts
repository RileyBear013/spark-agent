import {
  TODO_PRIORITIES,
  TODO_STATUSES,
  TodoStore,
  TodoStoreError,
  type TodoItem,
  type TodoPriority,
  type TodoStatus,
} from '../tools/todo/store.js'

export interface TodoCommandOptions {
  readonly cwd: string
  readonly subcommand: string
  readonly args: readonly string[]
  readonly json: boolean
  readonly title?: string
  readonly status?: string
  readonly priority?: string
  readonly notes?: string
  readonly limit?: string
  readonly all: boolean
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

export async function executeTodoCommand(options: TodoCommandOptions): Promise<number> {
  const store = new TodoStore({ cwd: options.cwd })
  try {
    switch (options.subcommand) {
      case '':
      case 'list':
        return await listTodos(store, options)
      case 'add':
        return await addTodo(store, options)
      case 'update':
        return await updateTodo(store, options)
      case 'remove':
      case 'delete':
        return await removeTodo(store, options)
      case 'clear':
        return await clearTodos(store, options)
      default:
        options.stderr(
          `Unknown \`spark todo\` subcommand: ${options.subcommand} (list | add | update | remove | clear)\n`,
        )
        return 2
    }
  } catch (error) {
    options.stderr(`${errorMessage(error)}\n`)
    return error instanceof TodoStoreError && error.message.startsWith('Todo not found:') ? 1 : 2
  }
}

async function listTodos(store: TodoStore, options: TodoCommandOptions): Promise<number> {
  if (options.args.length > 0) {
    options.stderr(
      'Usage: spark todo list [--status pending|in_progress|completed|cancelled] [--limit n]\n',
    )
    return 2
  }
  const status = options.status === undefined ? undefined : requiredStatus(options.status)
  const limit = options.limit === undefined ? undefined : parseLimit(options.limit)
  const todos = (await store.list())
    .filter((item) => status === undefined || item.status === status)
    .slice(0, limit)
  if (options.json) {
    options.stdout(
      `${JSON.stringify({ filePath: store.filePath, todos: todos.map(todoView) }, null, 2)}\n`,
    )
    return 0
  }
  if (todos.length === 0) {
    options.stdout('No project todos. Add one with `spark todo add "title"`.\n')
    return 0
  }
  for (const item of todos) {
    options.stdout(
      `[${item.id}] ${item.status} (${item.priority}) ${item.title}` +
        (item.notes.length === 0 ? '\n' : `\n  ${item.notes}\n`),
    )
  }
  return 0
}

async function addTodo(store: TodoStore, options: TodoCommandOptions): Promise<number> {
  if (options.title !== undefined && options.args.length > 0) {
    options.stderr('Usage: spark todo add <title> [--priority low|normal|high] [--notes text]\n')
    return 2
  }
  const title = options.title ?? options.args.join(' ').trim()
  if (title.length === 0) {
    options.stderr('Usage: spark todo add <title> [--priority low|normal|high] [--notes text]\n')
    return 2
  }
  const item = await store.add({
    title,
    ...(options.priority === undefined ? {} : { priority: requiredPriority(options.priority) }),
    ...(options.notes === undefined ? {} : { notes: options.notes }),
  })
  return writeResult(options, { message: `Added todo ${item.id}: ${item.title}`, todo: item })
}

async function updateTodo(store: TodoStore, options: TodoCommandOptions): Promise<number> {
  const id = options.args[0]
  if (id === undefined || options.args.length > 1) {
    options.stderr(
      'Usage: spark todo update <id> [--title text] [--status status] [--priority priority] [--notes text]\n',
    )
    return 2
  }
  if (
    options.title === undefined &&
    options.status === undefined &&
    options.priority === undefined &&
    options.notes === undefined
  ) {
    options.stderr(
      'Todo update requires at least one of --title, --status, --priority, or --notes.\n',
    )
    return 2
  }
  const item = await store.update({
    id,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.status === undefined ? {} : { status: requiredStatus(options.status) }),
    ...(options.priority === undefined ? {} : { priority: requiredPriority(options.priority) }),
    ...(options.notes === undefined ? {} : { notes: options.notes }),
  })
  return writeResult(options, { message: `Updated todo ${item.id}: ${item.title}`, todo: item })
}

async function removeTodo(store: TodoStore, options: TodoCommandOptions): Promise<number> {
  const id = options.args[0]
  if (id === undefined || options.args.length > 1) {
    options.stderr('Usage: spark todo remove <id>\n')
    return 2
  }
  const item = await store.remove(id)
  return writeResult(options, { message: `Removed todo ${item.id}: ${item.title}`, todo: item })
}

async function clearTodos(store: TodoStore, options: TodoCommandOptions): Promise<number> {
  if (options.args.length > 0) {
    options.stderr('Usage: spark todo clear [--all]\n')
    return 2
  }
  const count = await store.clear({ all: options.all })
  if (options.json) {
    options.stdout(`${JSON.stringify({ removed: count, all: options.all }, null, 2)}\n`)
  } else {
    options.stdout(
      options.all
        ? `Cleared ${count} todos.\n`
        : `Cleared ${count} completed/cancelled todos. Use --all to clear everything.\n`,
    )
  }
  return 0
}

function writeResult(
  options: TodoCommandOptions,
  result: { readonly message: string; readonly todo: TodoItem },
): number {
  if (options.json) options.stdout(`${JSON.stringify(todoView(result.todo), null, 2)}\n`)
  else options.stdout(`${result.message}\n`)
  return 0
}

function todoView(item: TodoItem): object {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    priority: item.priority,
    notes: item.notes,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

function requiredStatus(value: string): TodoStatus {
  if ((TODO_STATUSES as readonly string[]).includes(value)) return value as TodoStatus
  throw new Error(`Invalid todo status: ${value} (pending | in_progress | completed | cancelled)`)
}

function requiredPriority(value: string): TodoPriority {
  if ((TODO_PRIORITIES as readonly string[]).includes(value)) return value as TodoPriority
  throw new Error(`Invalid todo priority: ${value} (low | normal | high)`)
}

function parseLimit(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('Todo limit must be an integer from 1 to 100')
  }
  return parsed
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
