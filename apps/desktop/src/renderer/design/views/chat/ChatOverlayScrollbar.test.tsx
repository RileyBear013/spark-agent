// @vitest-environment jsdom

import React, { useRef } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatOverlayScrollMetrics } from './chat-overlay-scrollbar-metrics'

vi.mock('./chat-overlay-scrollbar-metrics', async () => {
  const actual = await vi.importActual<typeof import('./chat-overlay-scrollbar-metrics')>(
    './chat-overlay-scrollbar-metrics',
  )
  const mockedMetrics: ChatOverlayScrollMetrics = {
    visible: true,
    thumbHeight: 100,
    thumbTop: 0,
    scrollTop: 1_500,
    maxScrollTop: 1_500,
  }
  return {
    ...actual,
    // jsdom 无布局，clientHeight/scrollHeight 均为 0；用固定指标让滑块可见、可交互。
    calculateOverlayScrollbarMetrics: () => mockedMetrics,
  }
})

import { ChatOverlayScrollbar } from './ChatOverlayScrollbar'
import { isUpwardScrollbarKey, isUpwardScrollbarMove } from './overlay-scrollbar-user-intent'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

function pointerEvent(type: string, init: MouseEventInit): MouseEvent {
  return new MouseEvent(type, init)
}

describe('overlay scrollbar user scroll intent', () => {
  describe('pure helpers', () => {
    it('treats only upward navigation keys as user scroll-up intent', () => {
      expect(isUpwardScrollbarKey('ArrowUp')).toBe(true)
      expect(isUpwardScrollbarKey('PageUp')).toBe(true)
      expect(isUpwardScrollbarKey('Home')).toBe(true)
      expect(isUpwardScrollbarKey('ArrowDown')).toBe(false)
      expect(isUpwardScrollbarKey('PageDown')).toBe(false)
      expect(isUpwardScrollbarKey('End')).toBe(false)
    })

    it('detects upward scrollbar moves by comparing scroll positions', () => {
      expect(isUpwardScrollbarMove(1_500, 0)).toBe(true)
      expect(isUpwardScrollbarMove(1_500, 1_499)).toBe(true)
      expect(isUpwardScrollbarMove(1_500, 1_500)).toBe(false)
      expect(isUpwardScrollbarMove(0, 1_500)).toBe(false)
    })
  })

  describe('component interactions', () => {
    let container: HTMLDivElement
    let root: Root
    let scroller: HTMLDivElement
    let onUserScrollIntentUp: ReturnType<typeof vi.fn>

    beforeEach(() => {
      globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
      container = document.createElement('div')
      document.body.appendChild(container)
      onUserScrollIntentUp = vi.fn()

      function Harness() {
        const scrollRef = useRef<HTMLDivElement>(null)
        return (
          <div>
            <div id="scroller" ref={scrollRef} />
            <ChatOverlayScrollbar
              scrollRef={scrollRef}
              controlsId="scroller"
              onUserScrollIntentUp={onUserScrollIntentUp}
            />
          </div>
        )
      }

      root = createRoot(container)
      act(() => {
        root.render(<Harness />)
      })
      scroller = container.querySelector<HTMLDivElement>('#scroller')!
      // jsdom 未实现 Element 的 scrollBy/scrollTo，键盘导航分支需要它们存在
      scroller.scrollBy = vi.fn()
      scroller.scrollTo = vi.fn()
      // 模拟「贴底跟随中」：位于最大滚动位置
      scroller.scrollTop = 1_500
    })

    afterEach(() => {
      act(() => {
        root.unmount()
      })
      container.remove()
    })

    function getThumb(): HTMLDivElement {
      const thumb = container.querySelector<HTMLDivElement>('.chat-overlay-scrollbar-thumb')
      if (thumb == null) throw new Error('scrollbar thumb not rendered')
      return thumb
    }

    it('marks user scroll intent when dragging the thumb upward', () => {
      const thumb = getThumb()
      act(() => {
        thumb.dispatchEvent(pointerEvent('pointerdown', { clientY: 300, bubbles: true }))
      })
      act(() => {
        window.dispatchEvent(pointerEvent('pointermove', { clientY: 200 }))
      })
      expect(onUserScrollIntentUp).toHaveBeenCalled()
      expect(scroller.scrollTop).toBeLessThan(1_500)
    })

    it('does not mark intent when dragging the thumb downward', () => {
      const thumb = getThumb()
      act(() => {
        thumb.dispatchEvent(pointerEvent('pointerdown', { clientY: 300, bubbles: true }))
      })
      act(() => {
        window.dispatchEvent(pointerEvent('pointermove', { clientY: 400 }))
      })
      expect(onUserScrollIntentUp).not.toHaveBeenCalled()
    })

    it('marks user scroll intent on upward keyboard navigation', () => {
      const thumb = getThumb()
      act(() => {
        thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
      })
      expect(onUserScrollIntentUp).toHaveBeenCalledTimes(1)
    })

    it('does not mark intent on downward keyboard navigation', () => {
      const thumb = getThumb()
      act(() => {
        thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
      })
      expect(onUserScrollIntentUp).not.toHaveBeenCalled()
    })

    it('marks user scroll intent when clicking the track above the current position', () => {
      const track = container.querySelector<HTMLDivElement>('.chat-overlay-scrollbar')!
      // jsdom 中 track 的 getBoundingClientRect 全为 0，clientY 越小目标位置越靠上
      act(() => {
        track.dispatchEvent(pointerEvent('pointerdown', { clientY: 0, bubbles: true }))
      })
      expect(onUserScrollIntentUp).toHaveBeenCalledTimes(1)
    })

    it('does not mark intent when clicking the track below the current position', () => {
      const track = container.querySelector<HTMLDivElement>('.chat-overlay-scrollbar')!
      act(() => {
        track.dispatchEvent(pointerEvent('pointerdown', { clientY: 9_999, bubbles: true }))
      })
      expect(onUserScrollIntentUp).not.toHaveBeenCalled()
    })
  })
})
