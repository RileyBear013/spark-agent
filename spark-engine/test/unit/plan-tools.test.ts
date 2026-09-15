import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createDefaultEnv } from '../../src/env.js'
import { FakeModel } from '../../src/llm/fake/model.js'
import type { ToolCallContext } from '../../src/seams.js'
import type { ResolvedToolCall } from '../../src/tools/contract.js'
import {
  planToolDefinition,
  planToolDefinitions,
  planUpdateToolDefinition,
  PlanToolExecutor,
} from '../../src/tools/plan/tools.js'
import { PlanStore } from '../../src/tools/plan/store.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('PlanToolExecutor', () => {
  it('keeps plan state scoped to the owning session', async () => {
    const root = await workspace()
    const executor = new PlanToolExecutor(new PlanStore({ cwd: root }))

    expect(
      await execute(executor, 'set', { content: '# One', owner: { sessionId: 'session-one' } }),
    ).toMatchObject({ ok: true, content: expect.stringContaining('session-one') })
    expect(
      await execute(executor, 'read', { owner: { sessionId: 'session-two' } }),
    ).toMatchObject({ ok: true, content: expect.stringContaining('No plan exists') })
    expect(
      await execute(executor, 'append', {
        content: 'Two',
        owner: { sessionId: 'session-one' },
      }),
    ).toMatchObject({ ok: true })
    expect(
      await execute(executor, 'read', { owner: { sessionId: 'session-one' } }),
    ).toMatchObject({ ok: true, content: expect.stringContaining('# One\n\nTwo') })
    expect(
      await execute(executor, 'clear', { owner: { sessionId: 'session-one' } }),
    ).toMatchObject({ ok: true, content: expect.stringContaining('Cleared plan') })
  })

  it('fails closed without an owner and rejects malformed operations', async () => {
    const root = await workspace()
    const executor = new PlanToolExecutor(new PlanStore({ cwd: root }))

    expect(await execute(executor, 'read', {})).toEqual({
      ok: false,
      content: 'Plan tool requires an owning session.',
    })
    expect(
      await execute(executor, 'set', { content: 'x', owner: { sessionId: 'session-one' } }),
    ).toMatchObject({ ok: true })
    const malformed = await executeRaw(executor, { operation: 'replace' }, 'session-one', true)
    expect(malformed).toEqual({
      ok: false,
      content: 'operation must be set, append, or clear',
    })
  })

  it('exposes read and write definitions with matching permissions', () => {
    expect(planToolDefinitions.map((definition) => definition.name)).toEqual(['plan', 'plan_update'])
    expect(planToolDefinition.readonly).toBe(true)
    expect(planUpdateToolDefinition.readonly).toBe(false)
  })

  it('registers both plan tools in the default environment', async () => {
    const root = await workspace()
    const env = createDefaultEnv({
      cwd: root,
      dataRoot: join(root, 'data'),
      llm: new FakeModel([]),
    })

    expect(env.tools.registry.list().map((definition) => definition.name)).toEqual(
      expect.arrayContaining(['plan', 'plan_update']),
    )
  })
})

async function execute(
  executor: PlanToolExecutor,
  operation: 'read' | 'set' | 'append' | 'clear',
  options: { readonly content?: string; readonly owner?: { readonly sessionId: string } },
) {
  return executeRaw(
    executor,
    { operation, ...(options.content === undefined ? {} : { content: options.content }) },
    options.owner?.sessionId,
    operation !== 'read',
  )
}

async function executeRaw(
  executor: PlanToolExecutor,
  args: unknown,
  sessionId?: string,
  update = false,
) {
  const definition = update ? planUpdateToolDefinition : planToolDefinition
  const call: ResolvedToolCall = {
    callId: 'call-plan',
    name: definition.name,
    args,
    definition,
  }
  const context: ToolCallContext = {
    signal: new AbortController().signal,
    timeoutMs: definition.timeoutMs,
    ...(sessionId === undefined ? {} : { owner: { sessionId, turnId: 'turn-one' } }),
  }
  return executor.execute(call, context)
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'spark-plan-tools-'))
  roots.push(root)
  return root
}
