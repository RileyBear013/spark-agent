import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { executeMemoryCommand } from '../../src/cli/memory-command.js'
import { createDefaultEnv } from '../../src/env.js'
import { FileMemoryStore } from '../../src/memory/store.js'
import { Agent } from '../../src/sdk/agent.js'
import { FakeModel } from '../../src/llm/fake/model.js'
import { text, toolCall } from '../../src/llm/fake/reply-dsl.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('memory tools and CLI', () => {
  it('exposes memory tools and persists a model-requested save through the normal turn runner', async () => {
    const root = await workspace()
    const memoryHome = join(root, 'memory-home')
    const model = new FakeModel([
      toolCall('save-1', 'save_memory', {
        scope: 'user',
        name: 'Preferred language',
        description: 'Reply in the language used by the user',
        body: 'Keep the response language aligned with the latest user message.',
        type: 'feedback',
      }),
      text('saved'),
    ])
    const env = createDefaultEnv({
      cwd: root,
      dataRoot: join(root, 'data'),
      memoryRoot: memoryHome,
      llm: model,
    })
    expect(env.tools.registry.list().map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['search_memory', 'recall_memory', 'save_memory']),
    )

    const session = await Agent.open({ cwd: root, env }).newSession({ permissionMode: 'auto' })
    const result = await session.turn('Remember this preference')
    expect(result.terminal.type).toBe('turn.completed')
    const entries = await new FileMemoryStore({ cwd: root, homeDir: memoryHome }).list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: 'Preferred language', type: 'feedback' })
  })

  it('supports save, search, list, and recall from the standalone CLI command surface', async () => {
    const root = await workspace()
    const memoryHome = join(root, 'memory-home')
    const configHome = join(root, 'spark-home')
    const output: string[] = []
    const errors: string[] = []
    const base = {
      cwd: root,
      sparkHome: configHome,
      json: false,
      stdout: (value: string) => output.push(value),
      stderr: (value: string) => errors.push(value),
    }
    const previous = process.env.SPARK_AGENT_HOME
    process.env.SPARK_AGENT_HOME = memoryHome
    try {
      expect(
        await executeMemoryCommand({
          ...base,
          subcommand: 'save',
          args: [],
          scope: 'project',
          name: 'Build command',
          description: 'Use the repository validation command',
          body: 'Run npm run verify before delivery.',
        }),
      ).toBe(0)
      expect(
        await executeMemoryCommand({
          ...base,
          subcommand: 'search',
          args: ['验证'],
        }),
      ).toBe(0)
      expect(output.join('')).toContain('Build command')
      expect(
        await executeMemoryCommand({
          ...base,
          subcommand: 'list',
          args: [],
          scope: 'project',
        }),
      ).toBe(0)
      expect(output.join('')).toContain('project/project  Build command')
      const entry = await new FileMemoryStore({ cwd: root, homeDir: memoryHome }).list({ scope: 'project' })
      expect(entry).toHaveLength(1)
      expect(
        await executeMemoryCommand({
          ...base,
          subcommand: 'recall',
          args: [entry[0]!.id],
        }),
      ).toBe(0)
      expect(output.join('')).toContain('npm run verify')
      expect(errors).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.SPARK_AGENT_HOME
      else process.env.SPARK_AGENT_HOME = previous
    }
  })
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'spark-memory-tools-'))
  roots.push(root)
  return root
}
