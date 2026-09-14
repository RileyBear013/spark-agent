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

const CANCELLED_TASK: QuickCreateTaskRecord = {
  ...IMAGE_TASK,
  id: 'task-cancelled',
  status: 'cancelled',
  assets: [],
}

function renderHistory(root: Root, props: Partial<Parameters<typeof QuickCreateTaskHistory>[0]>) {
  act(() =>
    root.render(
      <QuickCreateTaskHistory
        tasks={[IMAGE_TASK, VIDEO_TASK, RUNNING_TASK]}
        expandedTaskId={null}
        onRowActivate={vi.fn()}
        onReuse={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onDelete={vi.fn()}
        onOpenOutput={vi.fn()}
        onSavePrompt={vi.fn()}
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

  it('点击卡片打开详情弹层，弹层内点击图片进入独立产物查看', () => {
    renderHistory(root, {})

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="卡片视图"]')?.click())
    act(() => document.querySelector<HTMLButtonElement>('.quick-create-card-media')?.click())

    const modal = document.querySelector('.quick-create-task-detail-modal')
    expect(modal).not.toBeNull()
    expect(document.body.textContent).toContain('清晨窗边的静物')
    expect(document.querySelector('.quick-create-media-viewer-modal')).toBeNull()

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="查看大图"]')?.click())
    expect(document.querySelector('.quick-create-media-viewer-modal')).not.toBeNull()
    expect(document.querySelector('.media-artifact-viewer')).not.toBeNull()
    expect(
      document.querySelector('.media-artifact-viewer-stage img')?.getAttribute('src'),
    ).toContain('safe-file://')

    act(() =>
      document
        .querySelector<HTMLButtonElement>('.quick-create-media-viewer-modal .ant-modal-close')
        ?.click(),
    )
    expect(document.querySelector('.quick-create-media-viewer-modal')).toBeNull()
    expect(document.querySelector('.quick-create-task-detail-modal')).not.toBeNull()
  })

  it('列表详情内查看产物使用独立弹层，不切换创作结果区块', () => {
    renderHistory(root, { expandedTaskId: IMAGE_TASK.id })

    act(() =>
      document.querySelector<HTMLButtonElement>('.quick-create-history-output-thumb')?.click(),
    )

    expect(document.querySelector('.quick-create-media-viewer-modal')).not.toBeNull()
    expect(document.querySelector('.media-artifact-viewer-stage img')).not.toBeNull()

    act(() =>
      document
        .querySelector<HTMLButtonElement>('.quick-create-media-viewer-modal .ant-modal-close')
        ?.click(),
    )
    expect(document.querySelector('.quick-create-media-viewer-modal')).toBeNull()
  })

  it('视频任务详情的产物以独立弹层查看并提供视频播放器', () => {
    renderHistory(root, { expandedTaskId: VIDEO_TASK.id })

    act(() =>
      document.querySelector<HTMLButtonElement>('.quick-create-history-output-thumb')?.click(),
    )

    expect(document.querySelector('.quick-create-media-viewer-modal')).not.toBeNull()
    expect(document.querySelector('.media-artifact-video')).not.toBeNull()
  })

  it('列表视图点击任务行仍触发行激活回调', () => {
    const onRowActivate = vi.fn()
    renderHistory(root, { onRowActivate })

    act(() => document.querySelector<HTMLButtonElement>('.quick-create-task-main')?.click())

    expect(onRowActivate).toHaveBeenCalledTimes(1)
    expect(onRowActivate).toHaveBeenCalledWith(IMAGE_TASK)
  })

  it('在任务详情操作区保存提示词到提示词库', () => {
    const onSavePrompt = vi.fn()
    renderHistory(root, { onSavePrompt, expandedTaskId: IMAGE_TASK.id })

    act(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('.quick-create-task-actions button'))
        .find((button) => button.textContent?.includes('存入提示词库'))
        ?.click(),
    )

    expect(onSavePrompt).toHaveBeenCalledWith(IMAGE_TASK)
  })

  it('任务详情提示词 label 后可一键复制提示词', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    renderHistory(root, { expandedTaskId: IMAGE_TASK.id })

    const copyButton = document.querySelector<HTMLButtonElement>('[aria-label="复制提示词"]')
    expect(copyButton).not.toBeNull()

    await act(async () => copyButton?.click())
    expect(writeText).toHaveBeenCalledWith('清晨窗边的静物')
  })

  it('空提示词的反推任务不显示复制按钮', () => {
    const reverseTask: QuickCreateTaskRecord = {
      ...IMAGE_TASK,
      id: 'task-reverse',
      mode: 'reverse',
      prompt: '',
      assets: [],
    }
    renderHistory(root, { tasks: [reverseTask], expandedTaskId: reverseTask.id })

    expect(document.querySelector('[aria-label="复制提示词"]')).toBeNull()
    expect(document.body.textContent).toContain('图片反推任务')
  })

  it('成功任务详情显示重新生成并回调重试', () => {
    const onRetry = vi.fn()
    renderHistory(root, { onRetry, expandedTaskId: IMAGE_TASK.id })

    const retryButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.quick-create-task-actions button'),
    ).find((button) => button.textContent?.includes('重新生成'))
    expect(retryButton).toBeDefined()

    act(() => retryButton?.click())
    expect(onRetry).toHaveBeenCalledWith(IMAGE_TASK)
  })

  it('已取消任务显示重试按钮', () => {
    const onRetry = vi.fn()
    renderHistory(root, { tasks: [CANCELLED_TASK], onRetry, expandedTaskId: CANCELLED_TASK.id })

    const retryButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.quick-create-task-actions button'),
    ).find((button) => button.textContent?.includes('重试'))
    expect(retryButton).toBeDefined()

    act(() => retryButton?.click())
    expect(onRetry).toHaveBeenCalledWith(CANCELLED_TASK)
  })

  it('任意状态（含运行中）都显示复用配置', () => {
    const onReuse = vi.fn()
    renderHistory(root, { tasks: [RUNNING_TASK], onReuse, expandedTaskId: RUNNING_TASK.id })

    const reuseButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.quick-create-task-actions button'),
    ).find((button) => button.textContent?.includes('复用配置'))
    expect(reuseButton).toBeDefined()
    expect(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('.quick-create-task-actions button'),
      ).some((button) => button.textContent?.includes('重试')),
    ).toBe(false)

    act(() => reuseButton?.click())
    expect(onReuse).toHaveBeenCalledWith(RUNNING_TASK)
  })
})
