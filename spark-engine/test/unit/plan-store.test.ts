import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PlanStore, PlanStoreError } from '../../src/tools/plan/store.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('PlanStore', () => {
  it('writes, reads, appends, and clears a session-owned Markdown plan', async () => {
    const root = await workspace()
    const store = new PlanStore({ cwd: root })

    expect(await store.read('session-one')).toBeUndefined()
    expect(await store.clear('session-one')).toBe(false)

    await store.write('session-one', '# Plan\n\n1. Inspect the current code.')
    await store.append('session-one', '2. Add focused tests.')

    expect(await store.read('session-one')).toBe(
      '# Plan\n\n1. Inspect the current code.\n\n2. Add focused tests.',
    )
    expect(await readFile(resolve(root, '.spark/plans/session-one.md'), 'utf8')).toBe(
      '# Plan\n\n1. Inspect the current code.\n\n2. Add focused tests.\n',
    )
    expect(await store.clear('session-one')).toBe(true)
    expect(await store.read('session-one')).toBeUndefined()
  })

  it('rejects unsafe session ids and oversized plans', async () => {
    const store = new PlanStore({ cwd: await workspace() })

    expect(() => store.filePath('../outside')).toThrow('Invalid session id')
    await expect(store.write('session-one', 'x'.repeat(256 * 1024 + 1))).rejects.toBeInstanceOf(
      PlanStoreError,
    )
  })
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'spark-plan-store-'))
  roots.push(root)
  return root
}
