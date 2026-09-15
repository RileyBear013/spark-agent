// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionLabelMenu } from './SessionLabelMenu'

vi.mock('./i18n', () => ({
  useI18n: () => ({
    lang: 'zh',
    t: (key: string) =>
      ({
        'sidebar.label.suspended': '挂起',
        'sidebar.label.notStarted': '未开始',
        'sidebar.label.pendingReview': '待审查',
        'sidebar.label.pendingAdvance': '待推进',
        'sidebar.label.undelivered': '未交付',
        'sidebar.session.label.clear': '取消标记',
      })[key] ?? key,
  }),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function buttonsOf(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.session-label-menu-item'))
}

describe('SessionLabelMenu', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('列出全部标记并回传选中的标记', async () => {
    const onSelect = vi.fn()
    act(() => {
      root.render(<SessionLabelMenu current={null} onSelect={onSelect} />)
    })

    const labels = buttonsOf(container).map((button) => button.textContent?.trim())
    // 未标记时不显示「取消标记」
    expect(labels).toEqual(['挂起', '未开始', '待审查', '待推进', '未交付'])

    const pendingReview = buttonsOf(container)[2]
    if (pendingReview == null) throw new Error('Missing pending-review label item')
    await act(async () => pendingReview.click())
    expect(onSelect).toHaveBeenCalledWith('pending-review')
  })

  it('当前标记高亮并额外提供「取消标记」回传 null', async () => {
    const onSelect = vi.fn()
    act(() => {
      root.render(<SessionLabelMenu current="suspended" onSelect={onSelect} />)
    })

    const items = buttonsOf(container)
    expect(items).toHaveLength(6)
    expect(items[0]?.className).toContain('is-active')
    expect(items[0]?.querySelector('.session-label-menu-check')).not.toBeNull()

    const clear = items[5]
    if (clear == null) throw new Error('Missing clear-label item')
    expect(clear.textContent?.trim()).toBe('取消标记')
    await act(async () => clear.click())
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('每个标记色点带独立的配色 class', () => {
    act(() => {
      root.render(<SessionLabelMenu current={null} onSelect={() => undefined} />)
    })

    const dotClasses = Array.from(container.querySelectorAll('.session-label-dot')).map(
      (dot) => dot.className,
    )
    expect(dotClasses).toEqual([
      'session-label-dot label-suspended',
      'session-label-dot label-not-started',
      'session-label-dot label-pending-review',
      'session-label-dot label-pending-advance',
      'session-label-dot label-undelivered',
    ])
  })
})
