// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionGetWorkflowBindingResponse, WorkflowItem } from '@spark/protocol'

const harness = vi.hoisted(() => ({
  state: null as SessionGetWorkflowBindingResponse | null,
  features: null as SessionGetWorkflowBindingResponse['features'] | null,
  workflows: [] as WorkflowItem[],
  loading: false,
  error: null as string | null,
  reload: vi.fn(),
  update: vi.fn(),
  abandonRun: vi.fn(),
}))

vi.mock('./useSessionWorkflowBinding', () => ({
  useSessionWorkflowBinding: () => ({
    state: harness.state,
    features: harness.state?.features ?? harness.features,
    workflows: harness.workflows,
    loading: harness.loading,
    saving: false,
    abandoning: false,
    error: harness.error,
    reload: harness.reload,
    update: harness.update,
    abandonRun: harness.abandonRun,
  }),
}))

import { SessionWorkflowPicker } from './SessionWorkflowPicker'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('SessionWorkflowPicker', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    harness.update.mockReset()
    harness.reload.mockReset()
    harness.abandonRun.mockReset()
    harness.state = null
    harness.workflows = [makeWorkflow('workflow-a', 'Workflow A')]
    harness.loading = false
    harness.error = null
    harness.features = null
  })

  it('lets a new session choose a workflow before the session is created', async () => {
    harness.state = null
    harness.features = {
      writeEnabled: true,
      runtimeRequested: true,
      runtimeEnabled: true,
    }
    harness.workflows = [makeWorkflow('workflow-b', 'Workflow B')]
    const onDraftBindingChange = vi.fn()

    await act(async () =>
      root.render(
        <SessionWorkflowPicker
          sessionId={null}
          draftBinding={null}
          onDraftBindingChange={onDraftBindingChange}
        />,
      ),
    )

    const trigger = container.querySelector<HTMLButtonElement>('.session-workflow-trigger')
    expect(trigger?.textContent).toBe('')
    expect(trigger?.getAttribute('aria-label')).toBe('选择新会话使用的工作流')
    await act(async () => trigger?.click())
    expect(document.body.textContent).toContain('Workflow B')

    const workflowOption = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ].find((button) => button.textContent?.includes('Workflow B'))
    await act(async () => workflowOption?.click())

    expect(onDraftBindingChange).toHaveBeenCalledWith({
      mode: 'override',
      workflowId: 'workflow-b',
    })
    expect(document.querySelector('.session-workflow-menu')).toBeNull()
    expect(harness.update).not.toHaveBeenCalled()
  })

  // 弹层必须 Portal 到 body 直接子节点并以 fixed 定位渲染。
  // 若回退为就地渲染，会被输入区祖先的 overflow/层叠裁剪导致“点了但弹层不可见”。
  it('renders the open menu as a portal on document.body with fixed positioning', async () => {
    harness.features = {
      writeEnabled: true,
      runtimeRequested: true,
      runtimeEnabled: true,
    }

    await act(async () =>
      root.render(
        <SessionWorkflowPicker
          sessionId={null}
          draftBinding={null}
          onDraftBindingChange={vi.fn()}
        />,
      ),
    )

    expect(container.querySelector('.session-workflow-menu')).toBeNull()
    const trigger = container.querySelector<HTMLButtonElement>('.session-workflow-trigger')
    await act(async () => trigger?.click())

    const menu = document.body.querySelector<HTMLDivElement>(':scope > .session-workflow-menu')
    expect(menu).not.toBeNull()
    expect(menu?.style.visibility).toBe('visible')
    expect(menu?.style.left).not.toBe('')
    expect(menu?.style.bottom).not.toBe('')

    await act(async () => trigger?.click())
    expect(document.body.querySelector(':scope > .session-workflow-menu')).toBeNull()
  })

  it('shows an icon-only selected state without rendering the workflow name', async () => {
    harness.features = {
      writeEnabled: true,
      runtimeRequested: true,
      runtimeEnabled: true,
    }

    await act(async () =>
      root.render(
        <SessionWorkflowPicker
          sessionId={null}
          draftBinding={{ mode: 'override', workflowId: 'workflow-a' }}
          onDraftBindingChange={vi.fn()}
        />,
      ),
    )

    const trigger = container.querySelector<HTMLButtonElement>('.session-workflow-trigger')
    expect(trigger?.classList.contains('is-selected')).toBe(true)
    expect(trigger?.dataset.selected).toBe('true')
    expect(trigger?.getAttribute('aria-label')).toContain('Workflow A')
    expect(trigger?.textContent).toBe('')
  })

  it('closes the workflow menu with Escape', async () => {
    harness.state = makeState({
      writeEnabled: true,
      runtimeRequested: true,
      runtimeEnabled: true,
    })
    await act(async () => root.render(<SessionWorkflowPicker sessionId="session-a" />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.session-workflow-trigger')?.click(),
    )
    expect(document.querySelector('.session-workflow-menu')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus()

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.querySelector('.session-workflow-menu')).toBeNull()
    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>('.session-workflow-trigger'),
    )
  })

  it('clears a pending draft selection when workflow writes are turned off', async () => {
    harness.state = null
    harness.features = {
      writeEnabled: false,
      runtimeRequested: false,
      runtimeEnabled: false,
    }
    const onDraftBindingChange = vi.fn()

    await act(async () =>
      root.render(
        <SessionWorkflowPicker
          sessionId={null}
          draftBinding={{ mode: 'override', workflowId: 'workflow-a' }}
          onDraftBindingChange={onDraftBindingChange}
        />,
      ),
    )

    expect(onDraftBindingChange).toHaveBeenCalledWith(null)
    expect(container.innerHTML).toBe('')
  })

  it('clears a pending draft selection when no published workflow remains', async () => {
    harness.features = {
      writeEnabled: true,
      runtimeRequested: true,
      runtimeEnabled: true,
    }
    harness.workflows = []
    const onDraftBindingChange = vi.fn()

    await act(async () =>
      root.render(
        <SessionWorkflowPicker
          sessionId={null}
          draftBinding={{ mode: 'override', workflowId: 'workflow-a' }}
          onDraftBindingChange={onDraftBindingChange}
        />,
      ),
    )

    expect(onDraftBindingChange).toHaveBeenCalledWith(null)
    expect(container.innerHTML).toBe('')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('hides an existing binding when the session workflow feature is disabled', async () => {
    harness.state = makeState({
      writeEnabled: false,
      runtimeRequested: false,
      runtimeEnabled: false,
    })
    await act(async () => root.render(<SessionWorkflowPicker sessionId="session-a" />))

    expect(container.innerHTML).toBe('')
  })

  it('explains that a mention turn uses the member workflow', async () => {
    harness.state = makeState({
      writeEnabled: true,
      runtimeRequested: false,
      runtimeEnabled: false,
    })
    await act(async () =>
      root.render(<SessionWorkflowPicker sessionId="session-a" mentionActive />),
    )
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.session-workflow-trigger')?.click(),
    )

    expect(document.body.textContent).toContain('本条 @成员消息不应用会话工作流')
  })

  it('stays hidden for untouched sessions while the write feature is disabled', async () => {
    harness.state = {
      ...makeState({ writeEnabled: false, runtimeRequested: false, runtimeEnabled: false }),
      binding: null,
    }
    await act(async () => root.render(<SessionWorkflowPicker sessionId="session-a" />))

    expect(container.innerHTML).toBe('')
  })

  it('stays hidden when there are no published workflows', async () => {
    harness.state = makeState({
      writeEnabled: true,
      runtimeRequested: true,
      runtimeEnabled: true,
    })
    harness.workflows = []

    await act(async () => root.render(<SessionWorkflowPicker sessionId="session-a" />))

    expect(container.innerHTML).toBe('')
  })

  it('updates an enabled override and disables every option while the session is busy', async () => {
    harness.state = {
      ...makeState({ writeEnabled: true, runtimeRequested: false, runtimeEnabled: false }),
      canChange: false,
      changeBlockers: [{ code: 'turn_queue_not_empty' }],
    }
    harness.workflows = [
      {
        id: 'workflow-b',
        name: 'Workflow B',
        description: '',
        scope: 'global',
        tags: [],
        status: 'active',
        enabled: true,
        version: '2.0.0',
        graph: { nodes: [], edges: [] },
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:00.000Z',
      },
    ]
    await act(async () => root.render(<SessionWorkflowPicker sessionId="session-a" />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.session-workflow-trigger')?.click(),
    )

    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(options).toHaveLength(3)
    expect(options.every((button) => button.disabled)).toBe(true)
    expect(document.body.textContent).toContain('仍有消息等待处理')

    harness.state = makeState({
      writeEnabled: true,
      runtimeRequested: false,
      runtimeEnabled: false,
    })
    await act(async () => root.render(<SessionWorkflowPicker sessionId="session-a" />))
    const workflowB = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ].find((button) => button.textContent?.includes('Workflow B'))
    await act(async () => workflowB?.click())
    expect(harness.update).toHaveBeenCalledWith({
      mode: 'override',
      workflowId: 'workflow-b',
    })
    expect(document.querySelector('.session-workflow-menu')).toBeNull()
  })

  it('does not show a rollback warning while the requested runtime is active', async () => {
    harness.state = makeState({
      writeEnabled: true,
      runtimeRequested: true,
      runtimeEnabled: true,
    })
    await act(async () => root.render(<SessionWorkflowPicker sessionId="session-a" />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.session-workflow-trigger')?.click(),
    )

    expect(document.body.textContent).not.toContain('当前消息仍按 Agent 默认配置执行')
  })

  it('does not expose a partial picker when initial binding loading fails', async () => {
    harness.state = null
    harness.error = '读取失败'
    await act(async () => root.render(<SessionWorkflowPicker sessionId="session-a" />))

    expect(container.innerHTML).toBe('')
    expect(harness.reload).not.toHaveBeenCalled()
  })

  it('keeps long workflow names on one truncated line and exposes the full label', async () => {
    const longName = '这是一个非常非常长且不应该挤压版本号或换行的会话工作流名称'
    harness.state = makeState({
      writeEnabled: true,
      runtimeRequested: true,
      runtimeEnabled: true,
    })
    harness.workflows = [makeWorkflow('workflow-long', longName)]

    await act(async () => root.render(<SessionWorkflowPicker sessionId="session-a" />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.session-workflow-trigger')?.click(),
    )

    const workflowLabel = [
      ...document.querySelectorAll<HTMLElement>('.session-workflow-option-label'),
    ].find((item) => item.textContent === longName)
    expect(workflowLabel?.title).toBe(longName)
    expect(workflowLabel?.nextElementSibling?.textContent).toBe('v1.0.0')
  })

  it('requires a separate confirmation before abandoning a failed run', async () => {
    harness.state = {
      ...makeState({ writeEnabled: true, runtimeRequested: false, runtimeEnabled: false }),
      resumableRun: {
        id: 'run-1',
        workflowId: 'workflow-a',
        status: 'failed',
        objective: '首次尝试',
        startedAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:01.000Z',
        endedAt: '2026-09-12T00:00:01.000Z',
        graphDigest: 'digest',
      },
    }
    await act(async () => root.render(<SessionWorkflowPicker sessionId="session-a" />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.session-workflow-trigger')?.click(),
    )

    expect(document.body.textContent).toContain('上次运行失败，下一条 Host 消息将继续此运行')
    const abandon = document.querySelector<HTMLButtonElement>('.session-workflow-abandon')
    expect(abandon).not.toBeNull()
    // 单独确认：第一次点击只展开确认，不触发放弃。
    await act(async () => abandon?.click())
    expect(harness.abandonRun).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('确认放弃此运行？')

    const cancel = document.querySelector<HTMLButtonElement>('.session-workflow-abandon-cancel')
    await act(async () => cancel?.click())
    expect(document.body.textContent).not.toContain('确认放弃此运行？')

    await act(async () =>
      document.querySelector<HTMLButtonElement>('.session-workflow-abandon')?.click(),
    )
    await act(async () =>
      document.querySelector<HTMLButtonElement>('.session-workflow-abandon-accept')?.click(),
    )
    expect(harness.abandonRun).toHaveBeenCalledTimes(1)
  })
})

function makeState(
  features: SessionGetWorkflowBindingResponse['features'],
): SessionGetWorkflowBindingResponse {
  return {
    binding: {
      sessionId: 'session-a',
      bindingInstanceId: 'binding-a',
      mode: 'override',
      workflowId: 'workflow-a',
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
    },
    effective: {
      source: 'session-override',
      bindingInstanceId: 'binding-a',
      hostAgentId: 'agent-a',
      workflowId: 'workflow-a',
      workflowName: 'Workflow A',
      workflowVersion: '1.0.0',
      workflowStatus: 'active',
      workflowEnabled: true,
      executionMode: 'workflow_run',
    },
    resumableRun: null,
    canChange: true,
    changeBlockers: [],
    features,
  }
}

function makeWorkflow(id: string, name: string): WorkflowItem {
  return {
    id,
    name,
    description: '',
    scope: 'global',
    tags: [],
    status: 'active',
    enabled: true,
    version: '1.0.0',
    graph: { nodes: [], edges: [] },
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
  }
}
