import { describe, expect, it } from 'vitest'
import type { Profiler } from 'node:inspector'

import { aggregateTopFramesInWindow } from './event-loop-monitor.js'

/** 构造最小 cpuprofile：3 个节点成链 root ← mid ← leafX / leafIdle */
function buildProfile(): Profiler.Profile {
  const nodes: Profiler.ProfileNode[] = [
    {
      id: 1,
      callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
      hitCount: 0,
      children: [2],
    },
    {
      id: 2,
      callFrame: {
        functionName: 'heavyCaller',
        scriptId: '1',
        url: 'file:///app/dist/services/Big.service.js',
        lineNumber: 41, // 0-based → 显示为 :42
        columnNumber: 0,
      },
      hitCount: 0,
      children: [3, 4],
    },
    {
      id: 3,
      callFrame: {
        functionName: 'syncQuery',
        scriptId: '1',
        url: 'file:///app/dist/db.js',
        lineNumber: 9,
        columnNumber: 0,
      },
      hitCount: 0,
      children: [],
    },
    {
      id: 4,
      callFrame: { functionName: '(idle)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 },
      hitCount: 0,
      children: [],
    },
  ]
  // 采样时间轴（毫秒偏移）：10,20,30,40,50,60,70,80
  const samples = [4, 4, 3, 3, 3, 3, 2, 4]
  const timeDeltas = [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000]
  return { nodes, samples, timeDeltas, startTime: 0, endTime: 80_000 }
}

describe('aggregateTopFramesInWindow', () => {
  it('聚合阻塞窗口内命中最多的自帧，并带调用链', () => {
    // 窗口 [25, 75]：命中 leaf3(syncQuery)×4、mid2(heavyCaller)×1；idle 全部落在窗口外
    const top = aggregateTopFramesInWindow(buildProfile(), 25, 75)
    expect(top).toHaveLength(2)
    expect(top[0]).toMatchObject({ hits: 4 })
    expect(top[0]!.label).toContain('syncQuery (db.js:10)')
    expect(top[0]!.label).toContain('← heavyCaller')
    expect(top[1]).toMatchObject({ hits: 1 })
    expect(top[1]!.label).toContain('heavyCaller')
  })

  it('过滤 (idle)/(program) 帧，保留 GC 帧', () => {
    const profile = buildProfile()
    // 窗口 [0, 25]：只有 idle 命中 → 全部被过滤，结果为空
    expect(aggregateTopFramesInWindow(profile, 0, 25)).toEqual([])

    const gcProfile = buildProfile()
    gcProfile.nodes.push({
      id: 5,
      callFrame: {
        functionName: '',
        scriptId: '0',
        url: 'native garbage collector',
        lineNumber: 0,
        columnNumber: 0,
      },
      hitCount: 0,
      children: [],
    })
    gcProfile.samples = [5, 5, 5]
    gcProfile.timeDeltas = [10_000, 10_000, 10_000]
    const top = aggregateTopFramesInWindow(gcProfile, 0, 100)
    expect(top).toHaveLength(1)
    expect(top[0]!.label).toContain('garbage collector')
  })

  it('窗口晚于全部采样时返回空；limit 生效', () => {
    expect(aggregateTopFramesInWindow(buildProfile(), 1_000, 2_000)).toEqual([])
    const top = aggregateTopFramesInWindow(buildProfile(), 0, 80, 1)
    expect(top).toHaveLength(1)
  })
})
