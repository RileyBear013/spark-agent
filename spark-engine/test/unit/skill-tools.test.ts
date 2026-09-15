import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createDefaultEnv } from '../../src/env.js'
import { FakeModel } from '../../src/llm/fake/model.js'
import { text } from '../../src/llm/fake/reply-dsl.js'
import { LocalSkillCatalog } from '../../src/skills/catalog.js'
import {
  SkillToolExecutor,
  skillToolDefinitions,
  skillsListToolDefinition,
  skillsLoadToolDefinition,
} from '../../src/skills/tools.js'
import type { ResolvedToolCall } from '../../src/tools/contract.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('skill tools', () => {
  it('returns a compact catalog and loads the full body only on request', async () => {
    const root = await workspace()
    await writeSkill(
      root,
      'review',
      'Review',
      'Review code carefully',
      '# Review\n\nCheck the diff.',
    )
    const executor = new SkillToolExecutor(
      new LocalSkillCatalog({ cwd: root, home: join(root, 'empty-home') }),
    )
    const list = await execute(executor, 'skills_list', {})
    expect(list).toMatchObject({ ok: true })
    expect(list.content).toContain('Review code carefully')
    expect(list.content).not.toContain('Check the diff.')

    const loaded = await execute(executor, 'skills_load', { id: 'Review' })
    expect(loaded).toMatchObject({ ok: true })
    expect(loaded.content).toContain('# Review\n\nCheck the diff.')
  })

  it('uses read-only no-approval metadata for both progressive disclosure tools', () => {
    expect(skillToolDefinitions.map((definition) => definition.name)).toEqual([
      'skills_list',
      'skills_load',
    ])
    for (const definition of [skillsListToolDefinition, skillsLoadToolDefinition]) {
      expect(definition).toMatchObject({
        readonly: true,
        permissionClass: 'read',
        approval: 'never',
      })
    }
  })

  it('registers skill tools only when explicitly enabled by an embedding host', async () => {
    const root = await workspace()
    const withoutSkills = createDefaultEnv({ cwd: root, llm: new FakeModel([text('ok')]) })
    expect(withoutSkills.tools.registry.get('skills_list')).toBeUndefined()

    const withSkills = createDefaultEnv({
      cwd: root,
      llm: new FakeModel([text('ok')]),
      skillsEnabled: true,
    })
    expect(withSkills.tools.registry.get('skills_list')).toBeDefined()
    expect(withSkills.tools.registry.get('skills_load')).toBeDefined()
  })
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'spark-skill-tools-'))
  roots.push(root)
  return root
}

async function writeSkill(
  root: string,
  nameDirectory: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const directory = join(root, '.agents', 'skills', nameDirectory)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    'utf8',
  )
}

async function execute(
  executor: SkillToolExecutor,
  name: string,
  args: unknown,
): Promise<{ readonly ok: boolean; readonly content: string }> {
  const definition = skillToolDefinitions.find((candidate) => candidate.name === name)!
  const call: ResolvedToolCall = { callId: 'test-call', name, args, definition }
  return executor.execute(call, {
    signal: new AbortController().signal,
    timeoutMs: definition.timeoutMs,
  })
}
