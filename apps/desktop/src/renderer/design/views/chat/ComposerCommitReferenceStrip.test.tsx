// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerCommitReferenceStrip } from './ComposerCommitReferenceStrip'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hash = 'a'.repeat(40)

describe('ComposerCommitReferenceStrip', () => {
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

  it('双行展示短 hash 与提交标题', async () => {
    await act(async () => {
      root.render(
        <ComposerCommitReferenceStrip
          references={[{ hash, shortHash: 'aaaaaaa', subject: 'feat: 新增提交引用' }]}
          onRemove={vi.fn()}
        />,
      )
    })
    expect(container.querySelector('.composer-commit-ref-strip')).not.toBeNull()
    expect(container.querySelector('.composer-commit-ref-hash')?.textContent).toBe('aaaaaaa')
    expect(container.querySelector('.composer-commit-ref-subject')?.textContent).toBe(
      'feat: 新增提交引用',
    )
  })

  it('点击移除按钮回传提交 hash', async () => {
    const onRemove = vi.fn()
    await act(async () => {
      root.render(
        <ComposerCommitReferenceStrip
          references={[{ hash, shortHash: 'aaaaaaa', subject: 'feat: 新增提交引用' }]}
          onRemove={onRemove}
        />,
      )
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.composer-commit-ref-chip button')?.click()
    })
    expect(onRemove).toHaveBeenCalledWith(hash)
  })

  it('没有引用时不渲染条带', async () => {
    await act(async () => {
      root.render(<ComposerCommitReferenceStrip references={[]} onRemove={vi.fn()} />)
    })
    expect(container.querySelector('.composer-commit-ref-strip')).toBeNull()
  })
})
