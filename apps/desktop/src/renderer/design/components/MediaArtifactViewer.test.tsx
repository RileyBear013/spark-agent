// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaArtifactViewer } from './MediaArtifactViewer'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./Toast', () => ({
  useToast: () => ({
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  }),
}))

const MEDIA = {
  src: 'safe-file:///tmp/output-a.png',
  alt: '生成结果',
  fileName: 'output-a.png',
  filePath: '/tmp/output-a.png',
  type: 'image' as const,
}

describe('MediaArtifactViewer', () => {
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

  it('工具栏提供缩放、复制、下载、所在文件夹，缩放后可重置回适屏', () => {
    act(() => root.render(<MediaArtifactViewer media={MEDIA} onOpenFullscreen={vi.fn()} />))

    expect(document.querySelector('[title="复制图片"]')).not.toBeNull()
    expect(document.querySelector('[title="下载到本地"]')).not.toBeNull()
    expect(document.querySelector('[title="打开产物所在文件夹"]')).not.toBeNull()

    const zoomLabel = () => document.querySelector('.media-artifact-viewer-zoom-level')?.textContent
    expect(zoomLabel()).toBe('100%')

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="放大"]')?.click())
    expect(zoomLabel()).toBe('140%')

    act(() =>
      document.querySelector<HTMLButtonElement>('.media-artifact-viewer-zoom-level')?.click(),
    )
    expect(zoomLabel()).toBe('100%')
  })

  it('有参考图时提供对比开关，左侧输入图右侧输出图；无参考图时不渲染入口', () => {
    act(() =>
      root.render(
        <MediaArtifactViewer media={MEDIA} inputImage={{ src: 'safe-file:///tmp/input.png' }} />,
      ),
    )

    act(() => document.querySelector<HTMLButtonElement>('[title="并排查看输入与输出"]')?.click())
    const stage = document.querySelector('.media-artifact-viewer-stage.is-compare')
    expect(stage).not.toBeNull()
    const panes = stage?.querySelectorAll('.media-artifact-compare-pane img')
    expect(panes?.length).toBe(2)
    expect(panes?.[0]?.getAttribute('src')).toBe('safe-file:///tmp/input.png')
    expect(panes?.[1]?.getAttribute('src')).toBe(MEDIA.src)

    act(() => root.unmount())
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => root.render(<MediaArtifactViewer media={MEDIA} />))
    expect(document.querySelector('[title="并排查看输入与输出"]')).toBeNull()
  })

  it('翻页插槽在多图时渲染并可切换，大图入口透传回调', () => {
    const onOpenFullscreen = vi.fn()
    act(() =>
      root.render(
        <MediaArtifactViewer
          media={MEDIA}
          pagination={{ index: 1, total: 3, onPrev: vi.fn(), onNext: vi.fn() }}
          onOpenFullscreen={onOpenFullscreen}
        />,
      ),
    )

    expect(document.querySelector('[title="并排查看输入与输出"]')).toBeNull()
    expect(document.body.textContent).toContain('2 / 3')
    expect(document.querySelector('[aria-label="上一项输出"]')).not.toBeNull()

    act(() => document.querySelector<HTMLButtonElement>('[title="打开全屏大图预览"]')?.click())
    expect(onOpenFullscreen).toHaveBeenCalledTimes(1)
  })

  it('视频产物回退为原生播放器，不提供缩放与对比', () => {
    act(() =>
      root.render(
        <MediaArtifactViewer
          media={{ ...MEDIA, type: 'video', src: 'safe-file:///tmp/out.mp4' }}
          inputImage={{ src: 'safe-file:///tmp/input.png' }}
          onOpenFullscreen={vi.fn()}
        />,
      ),
    )

    expect(document.querySelector('.media-artifact-video')).not.toBeNull()
    expect(document.querySelector('.media-artifact-viewer-zoom')).toBeNull()
    expect(document.querySelector('[title="并排查看输入与输出"]')).toBeNull()
    expect(document.querySelector('[title="打开全屏大图预览"]')).toBeNull()
  })
})
