/**
 * composer-commit-references — Git 提交引用的输入框状态。
 *
 * 与 composer-code-references / composer-browser-references 完全同构：组件内按 draft
 * bucket（= 会话路由）分桶存储，实现会话隔离——切换会话时引用互不串扰，随会话草稿一起清空。
 * 发送时由 ComposerV2 把引用序列化为 `[Git 提交] 短hash 标题` 文本行，模型配合 git 工具
 * 可直接回查该提交的改动。
 */
import { useCallback, useState } from 'react'
import type { SetStateAction } from 'react'
import type { CommitReference } from '../../components/code-viewer/composerInsert'

export type { CommitReference }

export type ComposerCommitReferenceMap = Record<string, CommitReference[]>

/** 去重键：完整 hash（同一条提交无论从提交列表还是文件历史加入都只保留一份）。 */
export function commitRefKey(ref: CommitReference): string {
  return ref.hash
}

/**
 * 合并提交引用：按 hash 去重并保留先加入的展示信息（短 hash / 标题按首次加入的快照）。
 * 返回追加条数，供调用方决定是否提示。
 */
export function mergeCommitReferences(
  current: CommitReference[],
  incoming: readonly CommitReference[],
): { next: CommitReference[]; added: number } {
  if (incoming.length === 0) return { next: current, added: 0 }
  const byKey = new Map(current.map((ref) => [commitRefKey(ref), ref]))
  let added = 0
  for (const ref of incoming) {
    const key = commitRefKey(ref)
    if (byKey.has(key)) continue
    byKey.set(key, ref)
    added += 1
  }
  return added === 0 ? { next: current, added } : { next: Array.from(byKey.values()), added }
}

export function updateComposerCommitReferenceBucket(
  current: ComposerCommitReferenceMap,
  bucket: string,
  next: SetStateAction<CommitReference[]>,
): ComposerCommitReferenceMap {
  const base = current[bucket] ?? []
  const resolved = typeof next === 'function' ? next(base) : next
  if (resolved === base) return current
  if (resolved.length === 0) {
    if (!(bucket in current)) return current
    const nextByBucket = { ...current }
    delete nextByBucket[bucket]
    return nextByBucket
  }
  return { ...current, [bucket]: resolved }
}

/** 跨桶清理：草稿桶被回收 / 发送后清空时同步清掉这些桶的提交引用（与代码位置引用一致）。 */
export function clearCommitReferenceBuckets(
  current: ComposerCommitReferenceMap,
  buckets: readonly (string | null | undefined)[],
): ComposerCommitReferenceMap {
  const uniqueBuckets = new Set(
    buckets.filter((bucket): bucket is string => bucket != null && bucket !== ''),
  )
  if (uniqueBuckets.size === 0) return current

  let changed = false
  const next = { ...current }
  for (const bucket of uniqueBuckets) {
    if (!(bucket in next)) continue
    delete next[bucket]
    changed = true
  }
  return changed ? next : current
}

export function useComposerCommitReferences(bucket: string): {
  commitReferences: CommitReference[]
  setCommitReferences: (next: SetStateAction<CommitReference[]>) => void
  clearCommitReferenceBuckets: (buckets: readonly (string | null | undefined)[]) => void
} {
  const [referencesByBucket, setReferencesByBucket] = useState<ComposerCommitReferenceMap>({})
  const commitReferences = referencesByBucket[bucket] ?? []
  const setCommitReferences = useCallback(
    (next: SetStateAction<CommitReference[]>) => {
      setReferencesByBucket((current) => updateComposerCommitReferenceBucket(current, bucket, next))
    },
    [bucket],
  )
  const clearBuckets = useCallback((buckets: readonly (string | null | undefined)[]) => {
    setReferencesByBucket((current) => clearCommitReferenceBuckets(current, buckets))
  }, [])

  return {
    commitReferences,
    setCommitReferences,
    clearCommitReferenceBuckets: clearBuckets,
  }
}
