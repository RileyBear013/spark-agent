// @vitest-environment jsdom

import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthDesktopLoginStatusEvent } from '@spark/protocol'
import { AuthProvider, useAuth, type AuthContextValue } from './AuthContext'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>(),
}))

let exposed: AuthContextValue | null = null

function Consumer(): React.ReactElement {
  exposed = useAuth()
  return <div />
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function emit(channel: string, payload: unknown): void {
  mocks.handlers.get(channel)?.(payload)
}

describe('AuthContext browser login', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    exposed = null
    mocks.handlers.clear()
    mocks.invoke.mockReset().mockImplementation(async (channel: string) => {
      if (channel === 'auth:bootstrap') {
        return { isAuthenticated: false, baseUrl: 'https://api.example' }
      }
      if (channel === 'auth:client-config') return {}
      if (channel === 'auth:desktop-login-start') {
        return { webLoginUrl: 'https://web.example/login?desktop=1&state=abc' }
      }
      return {}
    })
    Object.defineProperty(window, 'spark', {
      configurable: true,
      value: {
        invoke: mocks.invoke,
        on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
          mocks.handlers.set(channel, handler)
          return () => mocks.handlers.delete(channel)
        }),
      },
    })
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
  })

  async function render(): Promise<void> {
    act(() => {
      root = createRoot(container)
      root.render(
        <AuthProvider>
          <Consumer />
        </AuthProvider>,
      )
    })
    await flush()
  }

  it('拉取网页登录地址并进入等待态', async () => {
    await render()

    await act(async () => {
      await exposed?.desktopLogin.start()
    })

    expect(mocks.invoke).toHaveBeenCalledWith('auth:desktop-login-start', {})
    expect(exposed?.desktopLogin.webLoginUrl).toBe('https://web.example/login?desktop=1&state=abc')
    expect(exposed?.desktopLogin.starting).toBe(false)
    expect(exposed?.desktopLogin.startError).toBeUndefined()
  })

  it('发起失败时回到表单并内联错误，不进入等待态', async () => {
    await render()
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'auth:desktop-login-start') {
        throw new Error('无法打开系统浏览器，请检查默认浏览器设置后重试')
      }
      return {}
    })

    await act(async () => {
      await exposed?.desktopLogin.start()
    })

    expect(exposed?.desktopLogin.phase).toBe('idle')
    expect(exposed?.desktopLogin.startError).toBe('无法打开系统浏览器，请检查默认浏览器设置后重试')
  })

  it('主进程推送的状态驱动等待/失败/超时展示', async () => {
    await render()

    act(() => emit('stream:auth:desktop-login-status', { status: 'waiting' }))
    expect(exposed?.desktopLogin.phase).toBe('waiting')

    act(() =>
      emit('stream:auth:desktop-login-status', {
        status: 'expired',
        message: '授权已超时，请重新发起登录',
      }),
    )
    expect(exposed?.desktopLogin.phase).toBe('expired')
    expect(exposed?.desktopLogin.message).toBe('授权已超时，请重新发起登录')

    act(() =>
      emit('stream:auth:desktop-login-status', {
        status: 'failed',
        message: '登录会话不存在或已失效，请重新发起登录',
      }),
    )
    expect(exposed?.desktopLogin.phase).toBe('failed')
    expect(exposed?.desktopLogin.message).toBe('登录会话不存在或已失效，请重新发起登录')
  })

  it('取消后立即回到表单，并通知主进程停止轮询', async () => {
    await render()
    act(() => emit('stream:auth:desktop-login-status', { status: 'waiting' }))

    await act(async () => {
      await exposed?.desktopLogin.cancel()
    })

    expect(mocks.invoke).toHaveBeenCalledWith('auth:desktop-login-cancel', {})
    expect(exposed?.desktopLogin.phase).toBe('idle')
    expect(exposed?.desktopLogin.webLoginUrl).toBeUndefined()
  })

  it('登录成功后再登出，不会残留上一次浏览器登录结果', async () => {
    await render()
    act(() => emit('stream:auth:desktop-login-status', { status: 'success' }))
    expect(exposed?.desktopLogin.phase).toBe('success')

    act(() => emit('stream:auth:state-changed', { isAuthenticated: false }))

    expect(exposed?.desktopLogin.phase).toBe('idle')
  })

  it('会话过期同样清理浏览器登录状态', async () => {
    await render()
    act(() =>
      emit('stream:auth:desktop-login-status', {
        status: 'failed' satisfies AuthDesktopLoginStatusEvent['status'],
        message: '换取登录凭证失败',
      }),
    )

    act(() => emit('stream:auth:session-expired', {}))

    expect(exposed?.desktopLogin.phase).toBe('idle')
    expect(exposed?.desktopLogin.message).toBeUndefined()
  })
})
