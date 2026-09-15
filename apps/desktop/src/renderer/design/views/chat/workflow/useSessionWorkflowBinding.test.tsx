// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionGetWorkflowBindingResponse } from '@spark/protocol'

const harness = vi.hoisted(() => ({
  getBinding: vi.fn(),
  setBinding: vi.fn(),
  listWorkflows: vi.fn(),
  getSetting: vi.fn(),
  abandonRun: vi.fn(),
  streamSubscriptions: new Map<string, (payload: unknown) => void>(),
}))

vi.mock('../../../hooks/useIpc', () => ({
  useIpcInvoke: (channel: string) => ({
    invoke:
      channel === 'session:get-workflow-binding'
        ? harness.getBinding
        : channel === 'session:set-workflow-binding'
          ? harness.setBinding
          : channel === 'session:abandon-workflow-run'
            ? harness.abandonRun
            : channel === 'settings:get'
              ? harness.getSetting
              : harness.listWorkflows,
    loading: false,
    error: null,
  }),
  useIpcStream: (channel: string, callback: (payload: unknown) => void) => {
    harness.streamSubscriptions.set(channel, callback)
  },
}))

import { useSessionWorkflowBinding } from './useSessionWorkflowBinding'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let latestAbandon: (() => Promise<void>) | null = null
let latestUpdate:
  | ((next: { mode: 'inherit' | 'disabled' } | { mode: 'override'; workflowId: string }) => Promise<boolean>)
  | null = null

function Probe(props: { sessionId: string | null }): React.JSX.Element {
  const binding = useSessionWorkflowBinding(props.sessionId)
  latestAbandon = binding.abandonRun
  latestUpdate = binding.update
  return (
    <div>
      {binding.state?.binding?.sessionId ??
        (binding.features?.writeEnabled ? `draft:${binding.workflows.length}` : 'empty')}
    </div>
  )
}

describe('useSessionWorkflowBinding', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    harness.getBinding.mockReset()
    harness.setBinding.mockReset()
    harness.listWorkflows.mockReset().mockResolvedValue({ workflows: [] })
    harness.getSetting.mockReset().mockResolvedValue({ value: false })
    harness.abandonRun.mockReset()
    harness.streamSubscriptions.clear()
    latestAbandon = null
    latestUpdate = null
  })

  it('loads feature flags and published workflows for a new-session draft', async () => {
    harness.getSetting.mockImplementation(({ key }: { key: string }) => ({
      value: key === 'writeEnabled',
    }))
    harness.listWorkflows.mockResolvedValue({
      workflows: [
        {
          id: 'workflow-a',
          name: 'Workflow A',
          description: '',
          scope: 'global',
          tags: [],
          status: 'active',
          enabled: true,
          version: '1.0.0',
          graph: { nodes: [], edges: [] },
          createdAt: '2026-09-15T00:00:00.000Z',
          updatedAt: '2026-09-15T00:00:00.000Z',
        },
      ],
    })

    await act(async () => root.render(<Probe sessionId={null} />))

    expect(container.textContent).toBe('draft:1')
    expect(harness.getBinding).not.toHaveBeenCalled()
    expect(harness.getSetting).toHaveBeenCalledTimes(2)
    expect(harness.listWorkflows).toHaveBeenCalledWith({ includeArchived: false })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('ignores a stale binding response after switching sessions', async () => {
    const sessionA = deferred<SessionGetWorkflowBindingResponse>()
    const sessionB = deferred<SessionGetWorkflowBindingResponse>()
    harness.getBinding.mockImplementation(({ sessionId }: { sessionId: string }) =>
      sessionId === 'session-a' ? sessionA.promise : sessionB.promise,
    )

    await act(async () => root.render(<Probe sessionId="session-a" />))
    await act(async () => root.render(<Probe sessionId="session-b" />))
    await act(async () => sessionB.resolve(makeState('session-b')))
    expect(container.textContent).toBe('session-b')

    await act(async () => sessionA.resolve(makeState('session-a')))
    expect(container.textContent).toBe('session-b')
  })

  it('reloads when the sessionWorkflowBinding settings flags change', async () => {
    harness.getBinding.mockResolvedValue(makeState('session-a'))
    await act(async () => root.render(<Probe sessionId="session-a" />))
    expect(harness.getBinding).toHaveBeenCalledTimes(1)

    const onConfigChanged = harness.streamSubscriptions.get('stream:config:changed')
    expect(onConfigChanged).toBeDefined()

    // 设置页灰度开关变更：立即重取 binding + features。
    await act(async () =>
      onConfigChanged?.({ scope: 'settings', action: 'update', id: 'sessionWorkflowBinding' }),
    )
    expect(harness.getBinding).toHaveBeenCalledTimes(2)

    // 其他分类或其他 scope 的配置变更不触发。
    await act(async () =>
      onConfigChanged?.({ scope: 'settings', action: 'update', id: 'telemetry' }),
    )
    await act(async () => onConfigChanged?.({ scope: 'provider', action: 'update' }))
    expect(harness.getBinding).toHaveBeenCalledTimes(2)
  })

  // 返回值是选择器「失败就别关弹窗」的判据：预检不通过 / IPC 报错都要回 false。
  it('reports whether a binding write actually succeeded', async () => {
    harness.getBinding.mockResolvedValue(makeState('session-a'))
    await act(async () => root.render(<Probe sessionId="session-a" />))

    harness.setBinding.mockResolvedValueOnce({
      binding: {
        sessionId: 'session-a',
        bindingInstanceId: 'binding-session-a',
        mode: 'override',
        workflowId: 'workflow-b',
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:00.000Z',
      },
      effective: makeState('session-a').effective,
      resumableRun: null,
      preflight: { ok: true, issues: [], warnings: [] },
      error: null,
    })
    let saved = false
    await act(async () => {
      saved = (await latestUpdate?.({ mode: 'override', workflowId: 'workflow-b' })) ?? false
    })
    expect(saved).toBe(true)

    // 预检不通过：写入被主进程拒绝，必须回 false 让弹窗保留并显示原因。
    harness.setBinding.mockResolvedValueOnce({
      binding: null,
      effective: makeState('session-a').effective,
      resumableRun: null,
      preflight: {
        ok: false,
        issues: [{ code: 'unsupported_node_kind', nodeId: 'release-output', params: { kind: 'output' } }],
        warnings: [],
      },
      error: null,
    })
    let rejected = true
    await act(async () => {
      rejected = (await latestUpdate?.({ mode: 'override', workflowId: 'workflow-c' })) ?? true
    })
    expect(rejected).toBe(false)
  })

  it('abandons the failed run with the observed generation and refreshes on conflict', async () => {
    const failedState: SessionGetWorkflowBindingResponse = {
      ...makeState('session-a'),
      binding: {
        sessionId: 'session-a',
        bindingInstanceId: 'binding-gen-1',
        mode: 'override',
        workflowId: 'workflow-a',
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:00.000Z',
      },
      resumableRun: {
        id: 'run-1',
        workflowId: 'workflow-a',
        status: 'failed',
        objective: '首次尝试',
        startedAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:01.000Z',
        endedAt: '2026-09-12T00:00:01.000Z',
      },
    }
    harness.getBinding.mockResolvedValue(failedState)
    const request = {
      sessionId: 'session-a',
      expectedBindingInstanceId: 'binding-gen-1',
      runId: 'run-1',
    }

    await act(async () => root.render(<Probe sessionId="session-a" />))

    // 冲突时重新读取主进程状态，而不是沿用本地旧视图。
    harness.abandonRun.mockResolvedValueOnce({
      binding: failedState.binding,
      effective: failedState.effective,
      resumableRun: failedState.resumableRun,
      abandonedRunId: null,
      changed: false,
      error: { code: 'binding_conflict' },
    })
    harness.getBinding.mockClear()
    await act(async () => latestAbandon?.())
    expect(harness.abandonRun).toHaveBeenCalledWith(request)
    expect(harness.getBinding).toHaveBeenCalledTimes(1)

    // 重读后仍是同一失败 Run，再次放弃成功，本地状态切到新代次。
    harness.abandonRun.mockResolvedValueOnce({
      binding: { ...failedState.binding!, bindingInstanceId: 'binding-gen-2' },
      effective: failedState.effective,
      resumableRun: null,
      abandonedRunId: 'run-1',
      changed: true,
      error: null,
    })
    await act(async () => latestAbandon?.())
    expect(harness.abandonRun).toHaveBeenCalledTimes(2)

    // 成功后没有可放弃的 Run，再调用是 no-op，不发起 IPC。
    harness.abandonRun.mockClear()
    await act(async () => latestAbandon?.())
    expect(harness.abandonRun).not.toHaveBeenCalled()
  })
})

function makeState(sessionId: string): SessionGetWorkflowBindingResponse {
  return {
    binding: {
      sessionId,
      bindingInstanceId: `binding-${sessionId}`,
      mode: 'inherit',
      workflowId: null,
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
    },
    effective: {
      source: 'session-inherit',
      bindingInstanceId: `binding-${sessionId}`,
      hostAgentId: 'agent-a',
      workflowId: null,
      workflowName: null,
      workflowVersion: null,
      workflowStatus: null,
      workflowEnabled: null,
      executionMode: 'none',
    },
    resumableRun: null,
    canChange: true,
    changeBlockers: [],
    features: { writeEnabled: true, runtimeRequested: false, runtimeEnabled: false },
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
