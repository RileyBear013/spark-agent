import { describe, expect, it } from 'vitest'
import type { SessionId, SessionLabelKey } from '@spark/protocol'
import {
  SESSION_LABELS,
  SIDEBAR_LABEL_FILTER_OPTIONS,
  getSessionLabelMeta,
  getSessionPinTime,
  getSidebarLabelFilterColorClass,
  getSidebarLabelFilterLabelKey,
  isSessionPinnedZone,
  matchesSidebarLabelFilter,
  type SidebarLabelsFilter,
} from './session-labels'
import type { SessionSummary } from './sidebar-session-sort'

function session(opts: {
  pinnedAt?: string | null
  sessionLabel?: SessionLabelKey | null
  labeledAt?: string | null
}): SessionSummary {
  return {
    id: 'session-x' as SessionId,
    title: 'session-x',
    updatedAt: '2026-07-01T00:00:00.000Z',
    pinnedAt: opts.pinnedAt ?? null,
    workspaceIds: [],
    sessionLabel: opts.sessionLabel ?? null,
    labeledAt: opts.labeledAt ?? null,
  } as unknown as SessionSummary
}

describe('isSessionPinnedZone', () => {
  it('手动置顶或已标记都算置顶区，两者都无则不算', () => {
    expect(isSessionPinnedZone(session({}))).toBe(false)
    expect(isSessionPinnedZone(session({ pinnedAt: '2026-07-02T00:00:00.000Z' }))).toBe(true)
    expect(isSessionPinnedZone(session({ sessionLabel: 'pending-review', labeledAt: null }))).toBe(
      true,
    )
    expect(
      isSessionPinnedZone(
        session({ pinnedAt: '2026-07-02T00:00:00.000Z', sessionLabel: 'suspended' }),
      ),
    ).toBe(true)
  })
})

describe('getSessionPinTime', () => {
  it('手动置顶时间优先，其次打标时间，都没有时为 null', () => {
    expect(getSessionPinTime(session({}))).toBeNull()
    expect(
      getSessionPinTime(
        session({ sessionLabel: 'undelivered', labeledAt: '2026-07-03T00:00:00.000Z' }),
      ),
    ).toBe('2026-07-03T00:00:00.000Z')
    expect(
      getSessionPinTime(
        session({
          pinnedAt: '2026-07-02T00:00:00.000Z',
          sessionLabel: 'undelivered',
          labeledAt: '2026-07-09T00:00:00.000Z',
        }),
      ),
    ).toBe('2026-07-02T00:00:00.000Z')
  })
})

describe('matchesSidebarLabelFilter', () => {
  const labeled = session({ sessionLabel: 'pending-advance' })
  const unlabeled = session({})

  it('全部 / 已标记 / 未标记', () => {
    expect(matchesSidebarLabelFilter(labeled, 'all')).toBe(true)
    expect(matchesSidebarLabelFilter(unlabeled, 'all')).toBe(true)
    expect(matchesSidebarLabelFilter(labeled, 'labeled')).toBe(true)
    expect(matchesSidebarLabelFilter(unlabeled, 'labeled')).toBe(false)
    expect(matchesSidebarLabelFilter(labeled, 'unlabeled')).toBe(false)
    expect(matchesSidebarLabelFilter(unlabeled, 'unlabeled')).toBe(true)
  })

  it('按具体标记精确匹配', () => {
    expect(matchesSidebarLabelFilter(labeled, 'pending-advance')).toBe(true)
    expect(matchesSidebarLabelFilter(labeled, 'suspended')).toBe(false)
    expect(matchesSidebarLabelFilter(unlabeled, 'pending-advance')).toBe(false)
  })
})

describe('标记筛选选项', () => {
  it('覆盖全部 5 个标记 + 全部/已标记/未标记，且顺序与标记定义一致', () => {
    expect(SIDEBAR_LABEL_FILTER_OPTIONS.map((option) => option.value)).toEqual([
      'all',
      'labeled',
      'unlabeled',
      ...SESSION_LABELS.map((meta) => meta.key),
    ])
  })

  it('具体标记带色点 class，概况项不带', () => {
    expect(getSidebarLabelFilterColorClass('suspended')).toBe('label-suspended')
    expect(getSidebarLabelFilterColorClass('all')).toBeUndefined()
    expect(getSidebarLabelFilterColorClass('labeled')).toBeUndefined()
    expect(getSidebarLabelFilterColorClass('unlabeled')).toBeUndefined()
  })

  it('每个筛选值都有行值文案，未知值回落到「全部」', () => {
    for (const option of SIDEBAR_LABEL_FILTER_OPTIONS) {
      expect(getSidebarLabelFilterLabelKey(option.value)).toBe(option.labelKey)
    }
    expect(getSidebarLabelFilterLabelKey('nope' as SidebarLabelsFilter)).toBe('sidebar.filter.all')
  })

  it('标记定义与筛选选项共用同一份名称', () => {
    expect(getSessionLabelMeta('not-started')?.labelKey).toBe('sidebar.label.notStarted')
    expect(SESSION_LABELS).toHaveLength(5)
  })
})
