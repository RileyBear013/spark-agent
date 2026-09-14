// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('../hooks/useIpc', () => ({
  useIpcInvoke: (channel: string) => ({
    invoke: channel === 'settings:get' ? harness.getSetting : harness.setSetting,
    loading: false,
    error: null,
  }),
}))

// 返回稳定引用：组件的 useCallback([..., toast]) 依赖 toast，
// 每次渲染新对象会触发 effect 无限重跑（测试挂起根因）。
vi.mock('../components/Toast', () => {
  const stableToast = { error: harness.toastError }
  const stableCtx = { toast: stableToast }
  return { useToast: () => stableCtx }
})

import { SessionWorkflowSettingsSection } from './SessionWorkflowSettingsSection'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function switches(container: HTMLElement): [HTMLButtonElement, HTMLButtonElement] {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
  const [writeSwitch, runtimeSwitch] = found
  if (writeSwitch == null || runtimeSwitch == null) {
    throw new Error(`expected 2 switches, found ${found.length}`)
  }
  return [writeSwitch, runtimeSwitch]
}

async function renderSection(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<SessionWorkflowSettingsSection />))
  return { container, root }
}

describe('SessionWorkflowSettingsSection', () => {
  let mounted: { container: HTMLDivElement; root: Root } | null = null

  beforeEach(() => {
    harness.getSetting.mockReset().mockResolvedValue({ value: null })
    harness.setSetting.mockReset().mockResolvedValue({ ok: true })
    harness.toastError.mockReset()
  })

  afterEach(async () => {
    if (mounted) {
      await act(async () => mounted?.root.unmount())
      mounted.container.remove()
      mounted = null
    }
  })

  it('renders both flags off by default and disables the runtime switch', async () => {
    mounted = await renderSection()

    const [writeSwitch, runtimeSwitch] = switches(mounted.container)
    expect(writeSwitch).toBeDefined()
    expect(runtimeSwitch).toBeDefined()
    expect(writeSwitch.getAttribute('aria-checked')).toBe('false')
    expect(runtimeSwitch.getAttribute('aria-checked')).toBe('false')
    expect(runtimeSwitch.disabled).toBe(true)
  })

  it('reflects persisted true values and enables the runtime switch', async () => {
    harness.getSetting.mockImplementation(({ key }: { key: string }) =>
      Promise.resolve({ value: key === 'writeEnabled' ? true : true }),
    )
    mounted = await renderSection()

    const [writeSwitch, runtimeSwitch] = switches(mounted.container)
    expect(writeSwitch.getAttribute('aria-checked')).toBe('true')
    expect(runtimeSwitch.getAttribute('aria-checked')).toBe('true')
    expect(runtimeSwitch.disabled).toBe(false)
  })

  it('persists writeEnabled with the sessionWorkflowBinding category', async () => {
    mounted = await renderSection()

    const [writeSwitch] = switches(mounted.container)
    await act(async () => writeSwitch.click())

    expect(harness.setSetting).toHaveBeenCalledWith({
      category: 'sessionWorkflowBinding',
      key: 'writeEnabled',
      value: true,
    })
    expect(writeSwitch.getAttribute('aria-checked')).toBe('true')
  })

  it('keeps the runtime switch disabled while the mounting flag is off', async () => {
    harness.getSetting.mockImplementation(({ key }: { key: string }) =>
      Promise.resolve({ value: key === 'runtimeEnabled' ? true : null }),
    )
    mounted = await renderSection()

    const [, runtimeSwitch] = switches(mounted.container)
    expect(runtimeSwitch.getAttribute('aria-checked')).toBe('true')
    expect(runtimeSwitch.disabled).toBe(true)
  })

  it('rolls back to persisted values when saving fails', async () => {
    harness.setSetting.mockRejectedValue(new Error('db locked'))
    mounted = await renderSection()

    const [writeSwitch] = switches(mounted.container)
    await act(async () => writeSwitch.click())

    expect(harness.toastError).toHaveBeenCalled()
    // 失败后回读：两 key 各至少被读取两轮（初始 + 回滚）。
    expect(harness.getSetting.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(writeSwitch.getAttribute('aria-checked')).toBe('false')
  })
})
