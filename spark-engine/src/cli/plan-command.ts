import { JsonlSessionStore } from '../events/ledger.js'
import { createRuntimeLogger } from '../observability/logger.js'
import { PlanStore, PlanStoreError } from '../tools/plan/store.js'

export interface PlanCommandOptions {
  readonly cwd: string
  readonly dataRoot: string
  readonly subcommand: string
  readonly args: readonly string[]
  readonly json: boolean
  readonly body?: string
  readonly sessionId?: string
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

export async function executePlanCommand(options: PlanCommandOptions): Promise<number> {
  const store = new PlanStore({ cwd: options.cwd, logger: createRuntimeLogger('cli') })
  try {
    if (!['', 'show', 'read', 'set', 'write', 'append', 'clear'].includes(options.subcommand)) {
      options.stderr(
        `Unknown \`spark plan\` subcommand: ${options.subcommand} (show | set | append | clear)\n`,
      )
      return 2
    }
    const sessionId = await resolveSessionId(options)
    switch (options.subcommand) {
      case '':
      case 'show':
      case 'read':
        return await showPlan(store, sessionId, options)
      case 'set':
      case 'write':
        return await setPlan(store, sessionId, options)
      case 'append':
        return await appendPlan(store, sessionId, options)
      case 'clear':
        return await clearPlan(store, sessionId, options)
      default:
        return 2
    }
  } catch (error) {
    options.stderr(`${errorMessage(error)}\n`)
    return error instanceof PlanStoreError ? 1 : 2
  }
}

async function resolveSessionId(options: PlanCommandOptions): Promise<string> {
  if (options.args.length > 1) {
    throw new Error('Usage: spark plan <show|set|append|clear> [session_id]')
  }
  if (options.sessionId !== undefined && options.args.length > 0) {
    throw new Error('Provide the session id either positionally or with --session, not both.')
  }
  const explicit = options.sessionId ?? options.args[0]
  if (explicit !== undefined) return explicit
  const sessions = await new JsonlSessionStore({
    dataRoot: options.dataRoot,
    projectDir: options.cwd,
  }).list(options.cwd)
  const latest = sessions[0]
  if (latest === undefined) {
    throw new Error('No sessions recorded here yet; provide a session_id explicitly.')
  }
  return latest.sessionId
}

async function showPlan(
  store: PlanStore,
  sessionId: string,
  options: PlanCommandOptions,
): Promise<number> {
  const plan = await store.read(sessionId)
  if (options.json) {
    options.stdout(`${JSON.stringify({ sessionId, filePath: store.filePath(sessionId), plan: plan ?? null }, null, 2)}\n`)
    return 0
  }
  if (plan === undefined) {
    options.stdout(`No plan exists for session ${sessionId}.\n`)
    return 0
  }
  options.stdout(`Plan for session ${sessionId}\n${store.filePath(sessionId)}\n\n${plan}\n`)
  return 0
}

async function setPlan(
  store: PlanStore,
  sessionId: string,
  options: PlanCommandOptions,
): Promise<number> {
  const body = requiredBody(options.body, 'set')
  await store.write(sessionId, body)
  return writePlanResult(store, sessionId, body, 'Set', options)
}

async function appendPlan(
  store: PlanStore,
  sessionId: string,
  options: PlanCommandOptions,
): Promise<number> {
  const body = requiredBody(options.body, 'append')
  await store.append(sessionId, body)
  const plan = await store.read(sessionId)
  return writePlanResult(store, sessionId, plan ?? body, 'Appended to', options)
}

async function clearPlan(
  store: PlanStore,
  sessionId: string,
  options: PlanCommandOptions,
): Promise<number> {
  const removed = await store.clear(sessionId)
  if (options.json) {
    options.stdout(
      `${JSON.stringify({ sessionId, filePath: store.filePath(sessionId), removed }, null, 2)}\n`,
    )
  } else {
    options.stdout(
      removed
        ? `Cleared plan for session ${sessionId}.\n`
        : `No plan exists for session ${sessionId}.\n`,
    )
  }
  return 0
}

function writePlanResult(
  store: PlanStore,
  sessionId: string,
  plan: string,
  action: 'Set' | 'Appended to',
  options: PlanCommandOptions,
): number {
  if (options.json) {
    options.stdout(
      `${JSON.stringify({ sessionId, filePath: store.filePath(sessionId), plan }, null, 2)}\n`,
    )
  } else {
    options.stdout(`${action} plan for session ${sessionId}.\n${store.filePath(sessionId)}\n`)
  }
  return 0
}

function requiredBody(value: string | undefined, operation: 'set' | 'append'): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Usage: spark plan ${operation} [session_id] --body <markdown>`)
  }
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
