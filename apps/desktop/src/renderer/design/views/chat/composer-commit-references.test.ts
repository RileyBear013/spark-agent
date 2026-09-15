import { describe, expect, it } from 'vitest'
import {
  clearCommitReferenceBuckets,
  commitRefKey,
  mergeCommitReferences,
  updateComposerCommitReferenceBucket,
  type ComposerCommitReferenceMap,
} from './composer-commit-references'
import type { CommitReference } from '../../components/code-viewer/composerInsert'

function reference(hash: string, subject = 'update'): CommitReference {
  return { hash, shortHash: hash.slice(0, 7), subject }
}

describe('composer 提交引用分桶', () => {
  it('按草稿桶隔离，不同会话互不串扰', () => {
    let state: ComposerCommitReferenceMap = {}
    state = updateComposerCommitReferenceBucket(state, 'session-a', [reference('a'.repeat(40))])
    state = updateComposerCommitReferenceBucket(state, 'session-b', [reference('b'.repeat(40))])
    expect(state['session-a']).toHaveLength(1)
    expect(state['session-b']).toHaveLength(1)
  })

  it('清空某桶后该桶被移除', () => {
    const state = updateComposerCommitReferenceBucket({}, 'session-a', [reference('a'.repeat(40))])
    const next = updateComposerCommitReferenceBucket(state, 'session-a', [])
    expect('session-a' in next).toBe(false)
  })

  it('跨桶清理只清指定桶', () => {
    const state: ComposerCommitReferenceMap = {
      'session-a': [reference('a'.repeat(40))],
      'session-b': [reference('b'.repeat(40))],
    }
    const next = clearCommitReferenceBuckets(state, ['session-b'])
    expect('session-b' in next).toBe(false)
    expect(next['session-a']).toHaveLength(1)
  })
})

describe('mergeCommitReferences', () => {
  it('按提交 hash 去重并统计追加条数', () => {
    const existing = [reference('a'.repeat(40))]
    const merged = mergeCommitReferences(existing, [
      reference('a'.repeat(40)),
      reference('c'.repeat(40)),
    ])
    expect(merged.added).toBe(1)
    expect(merged.next.map(commitRefKey)).toEqual(['a'.repeat(40), 'c'.repeat(40)])
  })

  it('全部重复时保持原引用数组引用不变（避免无谓重渲染）', () => {
    const existing = [reference('a'.repeat(40))]
    const merged = mergeCommitReferences(existing, [reference('a'.repeat(40))])
    expect(merged.added).toBe(0)
    expect(merged.next).toBe(existing)
  })

  it('空输入不改动原数组', () => {
    const existing = [reference('a'.repeat(40))]
    expect(mergeCommitReferences(existing, []).next).toBe(existing)
  })
})
