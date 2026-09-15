import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DefaultPromptComposer } from '../../src/events/projector.js'
import { FileMemoryStore } from '../../src/memory/store.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('FileMemoryStore', () => {
  it('writes desktop-compatible Markdown in all three scopes and lists it back', async () => {
    const root = await workspace()
    const home = join(root, 'spark-agent-home')
    const store = new FileMemoryStore({ cwd: root, homeDir: home, agentId: 'reviewer' })

    const user = await store.save({
      scope: 'user',
      name: 'UI preference',
      description: 'Prefer a flat and concise interface',
      body: 'Use a flat layout with clear separators.',
      type: 'feedback',
    })
    const project = await store.save({
      scope: 'project',
      name: 'Project language',
      description: 'Use strict TypeScript in this repository',
      body: 'New code must preserve strict typing and existing boundaries.',
    })
    const agent = await store.save({
      scope: 'agent',
      name: 'Review style',
      description: 'Review from source before proposing a fix',
      body: 'Confirm the suspected defect in code and tests first.',
    })

    expect([user.id, project.id, agent.id]).toEqual([
      expect.stringMatching(/^usr_/u),
      expect.stringMatching(/^prj_/u),
      expect.stringMatching(/^agt_/u),
    ])
    const entries = await store.list()
    expect(entries.map((entry) => entry.scope).sort()).toEqual(['agent', 'project', 'user'])
    expect(await readFile(user.filePath, 'utf8')).toContain('scope: user')
    expect(await readFile(user.filePath, 'utf8')).toContain('Use a flat layout')
    expect(await readFile(join(home, 'memory', 'user', 'MEMORY.md'), 'utf8')).toContain(
      'UI preference',
    )
    expect(await readFile(join(root, '.spark-agent', 'memory', 'MEMORY.md'), 'utf8')).toContain(
      'Project language',
    )
  })

  it('reads existing desktop frontmatter, searches CJK and bumps hit count on recall', async () => {
    const root = await workspace()
    const home = join(root, 'home')
    const directory = join(home, 'memory', 'user')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'usr_existing.md'),
      [
        '---',
        'id: usr_existing',
        'scope: user',
        'scope_ref: null',
        'type: feedback',
        'name: 界面偏好',
        'description: 用户偏好扁平简洁设计',
        'confidence: 0.9',
        'created_at: 2026-09-01T00:00:00.000Z',
        'updated_at: 2026-09-02T00:00:00.000Z',
        'hit_count: 2',
        'last_hit_at: null',
        'source_session_id: null',
        'links: []',
        'archived: false',
        '---',
        '',
        '页面需要保持简单、扁平，不要复杂装饰。',
        '',
      ].join('\n'),
    )
    const store = new FileMemoryStore({ cwd: root, homeDir: home })

    const hits = await store.search('扁平设计')
    expect(hits[0]?.id).toBe('usr_existing')
    const recalled = await store.recall('usr_existing')
    expect(recalled.entry?.hitCount).toBe(3)
    expect((await store.recall('usr_missing')).error).toContain('Memory not found')
  })

  it('does not treat the global memory directory as the current project scope', async () => {
    const root = await workspace()
    const home = join(root, 'user-home', '.spark-agent')
    const cwd = join(root, 'user-home', 'project')
    await mkdir(join(home, 'memory', 'user'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    const store = new FileMemoryStore({ cwd, homeDir: home })

    await store.save({
      scope: 'project',
      name: 'Project-only',
      description: 'Stored in the project directory',
      body: 'This must not be written into the global memory directory.',
    })

    expect(await readFile(join(cwd, '.spark-agent', 'memory', 'MEMORY.md'), 'utf8')).toContain(
      'Project-only',
    )
    await expect(readFile(join(home, 'memory', 'MEMORY.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('injects summaries by type priority and respects the token budget', async () => {
    const root = await workspace()
    const store = new FileMemoryStore({ cwd: root, homeDir: join(root, 'home'), maxInjectTokens: 100 })
    await store.save({
      scope: 'project',
      name: 'Project fact',
      description: 'A project detail',
      body: 'project body',
      type: 'project',
    })
    await store.save({
      scope: 'user',
      name: 'User feedback',
      description: 'A durable preference',
      body: 'user body',
      type: 'feedback',
    })
    const injection = await store.injection()
    expect(injection.block).toContain('<user-memory>')
    expect(injection.block).toContain('User feedback')
    expect(injection.block).toContain('需要详情时使用')

    const composer = new DefaultPromptComposer({ memory: store })
    const sections = await composer.compose(
      { sessionId: 'session-1', cwd: root },
      { cwd: root },
    )
    expect(sections.find((section) => section.id === 'long-term-memory')?.content).toContain(
      'User feedback',
    )
  })

  it('updates an existing entry by name instead of creating duplicates', async () => {
    const root = await workspace()
    const store = new FileMemoryStore({ cwd: root, homeDir: join(root, 'home') })
    const first = await store.save({
      scope: 'user',
      name: 'Stable name',
      description: 'Old summary',
      body: 'old body',
    })
    const second = await store.save({
      scope: 'user',
      name: 'Stable name',
      description: 'New summary',
      body: 'new body',
    })
    expect(second.id).toBe(first.id)
    expect((await store.list()).filter((entry) => entry.name === 'Stable name')).toHaveLength(1)
    expect(await readFile(second.filePath, 'utf8')).toContain('new body')
  })
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'spark-memory-'))
  roots.push(root)
  return root
}
