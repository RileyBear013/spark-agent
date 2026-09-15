// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionLabelTag } from './SessionLabelTag'
import type { SessionLabelKey } from './session-labels'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
      })[key] ?? key,
  }),
}))

describe('SessionLabelTag', () => {
  let container: HTMLDivElement
  let root: Root

  const render = (labelKey?: SessionLabelKey | null) => {
    act(() => root.render(<SessionLabelTag labelKey={labelKey} />))
    return container.querySelector<HTMLSpanElement>('.session-label-tag')
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('渲染标记名称与同色色点', () => {
    const tag = render('pending-review')

    expect(tag?.textContent).toBe('待审查')
    expect(tag?.classList.contains('label-pending-review')).toBe(true)
    // 色点带同一标记配色类，保证标签整体是一个色相
    expect(tag?.querySelector('.session-label-dot.label-pending-review')).not.toBeNull()
  })

  it('五个标记都有名称与独立配色 class', () => {
    const cases: Array<[SessionLabelKey, string]> = [
      ['suspended', '挂起'],
      ['not-started', '未开始'],
      ['pending-review', '待审查'],
      ['pending-advance', '待推进'],
      ['undelivered', '未交付'],
    ]
    const classes = new Set<string>()
    for (const [key, text] of cases) {
      const tag = render(key)
      expect(tag?.textContent).toBe(text)
      expect(tag?.classList.contains(`label-${key}`)).toBe(true)
      classes.add(`label-${key}`)
    }
    expect(classes.size).toBe(cases.length)
  })

  it('未标记或未知标记时不渲染', () => {
    expect(render(null)).toBeNull()
    expect(render()).toBeNull()
    expect(render('unknown-label' as SessionLabelKey)).toBeNull()
  })
})
