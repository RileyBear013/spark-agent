// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickCreateOutputPanel } from './QuickCreateOutputPanel'
import type { QuickCreateTaskRecord } from './quickCreateTaskStore'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../components/Toast', () => ({
  useToast: () => ({
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  }),
}))

const TASK: QuickCreateTaskRecord = {
  id: 'quick-output-test',
  mode: 'image',
  operation: 'text_to_image',
  prompt: '测试输出',
  inputFiles: [{ type: 'image', path: '/tmp/input.png' }],
  modelParams: {},
  status: 'succeeded',
  assets: [
    { type: 'image', filePath: '/tmp/output-a.png', url: 'safe-file:///tmp/output-a.png' },
    { type: 'image', filePath: '/tmp/output-b.png', url: 'safe-file:///tmp/output-b.png' },
  ],
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
}

const RUNNING_TASK: QuickCreateTaskRecord = {
  ...TASK,
  id: 'quick-output-running-test',
  status: 'running',
  assets: [],
  progress: 42,
}

describe('QuickCreateOutputPanel', () => {
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
    document.body.innerHTML = ''
  })

  it('点击图片才打开统一大图预览，并支持输出翻页和输入输出对比', () => {
    act(() => root.render(<QuickCreateOutputPanel task={TASK} />))

    expect(document.querySelector('.image-lightbox-backdrop')).toBeNull()
    const firstOutputSrc = document
      .querySelector('.quick-create-output-image-button img')
      ?.getAttribute('src')
    expect(firstOutputSrc).toContain('safe-file://')

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="下一项输出"]')?.click())
    const secondOutputSrc = document
      .querySelector('.quick-create-output-image-button img')
      ?.getAttribute('src')
    expect(secondOutputSrc).toContain('safe-file://')
    expect(secondOutputSrc).not.toBe(firstOutputSrc)

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="点击查看大图"]')?.click())
    expect(document.querySelector('.image-lightbox-backdrop')).not.toBeNull()
    expect(document.querySelector('.image-lightbox-img')?.getAttribute('src')).toBe(secondOutputSrc)

    act(() => document.querySelector<HTMLButtonElement>('[title="关闭 (Esc)"]')?.click())
    expect(document.querySelector('.image-lightbox-backdrop')).toBeNull()

    act(() =>
      document
        .querySelector<HTMLButtonElement>('.quick-create-output-toolbar button:last-child')
        ?.click(),
    )
    expect(document.querySelector('.quick-create-compare-view')).not.toBeNull()
    expect(document.querySelector('.quick-create-compare-view')?.textContent).toContain('输入图')
    expect(document.querySelector('.quick-create-compare-view')?.textContent).toContain('输出图')
  })

  it('运行任务展示处理中动效和进度，失败任务不继续显示 loading', () => {
    act(() => root.render(<QuickCreateOutputPanel task={RUNNING_TASK} />))

    expect(document.querySelector('.quick-create-output-loader')).not.toBeNull()
    expect(document.querySelector('.quick-create-output-progress span')).not.toBeNull()
    expect(document.body.textContent).toContain('创作进行中')

    act(() =>
      root.render(
        <QuickCreateOutputPanel
          task={{
            ...RUNNING_TASK,
            status: 'failed',
            error: { code: 'provider_error', message: 'Provider 暂时不可用' },
          }}
        />,
      ),
    )

    expect(document.querySelector('.quick-create-output-loader')).toBeNull()
    expect(document.body.textContent).toContain('这次创作没有完成')
  })
})
