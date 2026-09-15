import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TodoStore, TodoStoreError } from '../../src/tools/todo/store.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('TodoStore', () => {
  it('persists, sorts, updates, and reloads project todos atomically', async () => {
    const root = await workspace()
    const store = new TodoStore({ cwd: root })
    const low = await store.add({ title: 'Document the command', priority: 'low' })
    const urgent = await store.add({ title: 'Fix the failing build', priority: 'high' })

    expect((await store.list()).map((item) => item.id)).toEqual([urgent.id, low.id])
    const updated = await store.update({
      id: low.id,
      status: 'in_progress',
      notes: 'Include the JSON examples.',
    })
    expect(updated.status).toBe('in_progress')
    expect((await new TodoStore({ cwd: root }).list())[0]).toMatchObject({
      id: low.id,
      status: 'in_progress',
      notes: 'Include the JSON examples.',
    })
    expect(await readFile(join(root, '.spark', 'todos.json'), 'utf8')).toContain('"version": 1')
  })

  it('clears completed items by default and all items only when requested', async () => {
    const root = await workspace()
    const store = new TodoStore({ cwd: root })
    const completed = await store.add({ title: 'Already done' })
    await store.update({ id: completed.id, status: 'completed' })
    await store.add({ title: 'Still pending' })

    expect(await store.clear()).toBe(1)
    expect((await store.list()).map((item) => item.title)).toEqual(['Still pending'])
    expect(await store.clear({ all: true })).toBe(1)
    expect(await store.list()).toEqual([])
  })

  it('fails closed on corrupt data and invalid mutations', async () => {
    const root = await workspace()
    await mkdir(join(root, '.spark'), { recursive: true })
    await writeFile(join(root, '.spark', 'todos.json'), '{"version": 2,"items":[]}')
    const store = new TodoStore({ cwd: root })

    await expect(store.list()).rejects.toBeInstanceOf(TodoStoreError)
    await expect(store.add({ title: 'x', priority: 'urgent' as never })).rejects.toThrow(
      'Todo priority must be low, normal, or high',
    )
  })
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'spark-todo-'))
  roots.push(root)
  return root
}
