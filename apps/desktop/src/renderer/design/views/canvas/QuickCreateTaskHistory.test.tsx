// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickCreateTaskHistory } from './QuickCreateTaskHistory'
import type { QuickCreateTaskRecord } from './quickCreateTaskStore'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../components/Toast', () => ({
  useToast: () => ({
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  }),
}))

const IMAGE_TASK: QuickCreateTaskRecord = {
  id: 'task-image',
  mode: 'image',
  operation: 'text_to_image',
  prompt: '清晨窗边的静物',
  inputFiles: [],
  modelParams: {},
  status: 'succeeded',
  assets: [
    { type: 'image', filePath: '/tmp/output-a.png' },
    { type: 'image', filePath: '/tmp/output-b.png' },
  ],
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
}

const VIDEO_TASK: QuickCreateTaskRecord = {
  ...IMAGE_TASK,
  id: 'task-video',
  mode: 'video',
  operation: 'text_to_video',
  prompt: '雨夜街头镜头推进',
  assets: [{ type: 'video', filePath: '/tmp/output.mp4' }],
}

const RUNNING_TASK: QuickCreateTaskRecord = {
  ...IMAGE_TASK,
  id: 'task-running',
  status: 'running',
  assets: [],
  progress: 30,
}

function renderHistory(root: Root, props: Partial<Parameters<typeof QuickCreateTaskHistory>[0]>) {
  act(() =>
    root.render(
      <QuickCreateTaskHistory
        tasks={[IMAGE_TASK, VIDEO_TASK, RUNNING_TASK]}
        expandedTaskId={null}
        onRowActivate={vi.fn()}
        onFocusTask={vi.fn()}
        onReuse={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onDelete={vi.fn()}
        onOpenOutput={vi.fn()}
        {...props}
      />,
    ),
  )
}

describe('QuickCreateTaskHistory', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    window.localStorage.clear()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('min-width'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
  })

  it('默认列表展示全部记录，切换卡片视图后瀑布流只显示有产物图片的任务', () => {
    renderHistory(root, {})

    expect(document.querySelector('.quick-create-card-grid')).toBeNull()
    expect(document.querySelectorAll('.quick-create-task').length).toBe(3)

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="卡片视图"]')?.click())

    const cards = document.querySelectorAll('.quick-create-card')
    expect(cards.length).toBe(1)
    const coverSrc = document
      .querySelector<HTMLImageElement>('.quick-create-card-media img')
      ?.getAttribute('src')
    expect(coverSrc).toContain('safe-file://')
    expect(document.body.textContent).toContain('2 图')

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="列表视图"]')?.click())
    expect(document.querySelector('.quick-create-card-grid')).toBeNull()
    expect(document.querySelectorAll('.quick-create-task').length).toBe(3)
  })

  it('点击卡片打开详情弹层，弹层内点击图片进入统一大图预览', () => {
    renderHistory(root, {})

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="卡片视图"]')?.click())
    act(() => document.querySelector<HTMLButtonElement>('.quick-create-card-media')?.click())

    const modal = document.querySelector('.quick-create-task-detail-modal')
    expect(modal).not.toBeNull()
    expect(document.body.textContent).toContain('清晨窗边的静物')
    expect(document.querySelector('.image-lightbox-backdrop')).toBeNull()

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="查看大图"]')?.click())
    const lightbox = document.querySelector('.image-lightbox-backdrop')
    expect(lightbox).not.toBeNull()
    expect(document.querySelector('.image-lightbox-img')?.getAttribute('src')).toContain(
      'safe-file://',
    )

    act(() => document.querySelector<HTMLButtonElement>('[title="关闭 (Esc)"]')?.click())
    expect(document.querySelector('.image-lightbox-backdrop')).toBeNull()
    expect(document.querySelector('.quick-create-task-detail-modal')).not.toBeNull()

    act(() => document.querySelector<HTMLButtonElement>('.ant-modal-close')?.click())
    expect(document.querySelector('.quick-create-task-detail-modal')).toBeNull()
  })

  it('列表视图点击任务行仍触发行激活回调', () => {
    const onRowActivate = vi.fn()
    renderHistory(root, { onRowActivate })

    act(() => document.querySelector<HTMLButtonElement>('.quick-create-task-main')?.click())

    expect(onRowActivate).toHaveBeenCalledTimes(1)
    expect(onRowActivate).toHaveBeenCalledWith(IMAGE_TASK)
  })
})
