import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TodoToolExecutor, todoToolDefinitions } from '../../src/tools/todo/tools.js'
import { TodoStore } from '../../src/tools/todo/store.js'
import type { ToolCallContext } from '../../src/seams.js'
import type { ResolvedToolCall } from '../../src/tools/contract.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('TodoToolExecutor', () => {
  it('uses the model-facing list and update contract', async () => {
    const root = await workspace()
    const executor = new TodoToolExecutor(new TodoStore({ cwd: root }))

    const added = await execute(executor, 'todo_update', {
      action: 'add',
      title: 'Implement the next CLI slice',
      priority: 'high',
      notes: 'Keep the change project-local.',
    })
    expect(added).toMatchObject({ ok: true, content: expect.stringContaining('Added todo todo_') })
    const id = (await new TodoStore({ cwd: root }).list())[0]?.id
    expect(id).toBeDefined()

    const listed = await execute(executor, 'todo_list', {})
    expect(listed.content).toContain('Implement the next CLI slice')
    const completed = await execute(executor, 'todo_update', { action: 'complete', id })
    expect(completed.content).toContain('Completed todo')
  })

  it('returns a tool error for malformed actions without changing the file', async () => {
    const root = await workspace()
    const executor = new TodoToolExecutor(new TodoStore({ cwd: root }))
    const result = await execute(executor, 'todo_update', { action: 'update', id: 'todo_missing' })

    expect(result).toEqual({
      ok: false,
      content: 'todo update requires title, status, priority, or notes',
    })
    expect(await new TodoStore({ cwd: root }).list()).toEqual([])
  })
})

async function execute(
  executor: TodoToolExecutor,
  name: 'todo_list' | 'todo_update',
  args: Record<string, unknown>,
) {
  const definition = todoToolDefinitions.find((candidate) => candidate.name === name)
  if (definition === undefined) throw new Error(`Missing definition: ${name}`)
  const call: ResolvedToolCall = { callId: `call-${name}`, name, args, definition }
  const context: ToolCallContext = {
    signal: new AbortController().signal,
    timeoutMs: definition.timeoutMs,
  }
  return executor.execute(call, context)
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'spark-todo-tools-'))
  roots.push(root)
  return root
}
