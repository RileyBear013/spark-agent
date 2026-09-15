// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasMediaTaskStreamPayload, CanvasTextTaskStreamPayload } from '@spark/protocol'
import {
  __resetQuickCreateTaskStreamSyncForTests,
  ensureQuickCreateTaskStreamSync,
  reconcileQuickCreateRunningTasks,
} from './quickCreateTaskStreamSync'
import {
  readQuickCreateTasks,
  writeQuickCreateTasks,
  type QuickCreateTaskRecord,
} from './quickCreateTaskStore'

type StreamHandler = (payload: unknown) => void

const mediaHandlers = new Map<string, StreamHandler>()
const invokeMock = vi.fn()

function installSparkStub(): void {
  Object.defineProperty(window, 'spark', {
    configurable: true,
    value: {
      on: (channel: string, handler: StreamHandler) => {
        mediaHandlers.set(channel, handler)
      },
      invoke: invokeMock,
    },
  })
}

function emitMedia(payload: CanvasMediaTaskStreamPayload): void {
  mediaHandlers.get('stream:canvas:media-task')?.(payload)
}

function emitText(payload: CanvasTextTaskStreamPayload): void {
  mediaHandlers.get('stream:canvas:text-task')?.(payload)
}

function seedTask(overrides: Partial<QuickCreateTaskRecord>): QuickCreateTaskRecord {
  return {
    id: 'task-1',
    mode: 'image',
    operation: 'text_to_image',
    prompt: '静物',
    inputFiles: [],
    modelParams: {},
    status: 'running',
    assets: [],
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    ...overrides,
  }
}

function firstPersistedTask(): QuickCreateTaskRecord {
  const task = readQuickCreateTasks()[0]
  expect(task).toBeDefined()
  return task as QuickCreateTaskRecord
}

beforeEach(() => {
  localStorage.clear()
  mediaHandlers.clear()
  invokeMock.mockReset()
  __resetQuickCreateTaskStreamSyncForTests()
  installSparkStub()
  ensureQuickCreateTaskStreamSync()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ensureQuickCreateTaskStreamSync', () => {
  it('后台媒体事件把 running 任务回写为终态并写入产物', () => {
    writeQuickCreateTasks([seedTask({ id: 'task-media' })])

    emitMedia({
      clientTaskId: 'task-media',
      runtimeTaskId: 'rt-1',
      status: 'succeeded',
      response: {
        runtimeTaskId: 'rt-1',
        status: 'succeeded',
        providerProfileId: 'p1',
        provider: 'openai-images',
        model: 'm1',
        mode: 'sync',
        assets: [{ type: 'image', filePath: '/tmp/out.png' }],
      },
    })

    const task = firstPersistedTask()
    expect(task.status).toBe('succeeded')
    expect(task.assets).toEqual([{ type: 'image', filePath: '/tmp/out.png' }])
    expect(task.runtimeTaskId).toBe('rt-1')
  })

  it('未知 clientTaskId 的事件被忽略', () => {
    writeQuickCreateTasks([seedTask({ id: 'task-media' })])

    emitMedia({
      clientTaskId: 'unknown-task',
      runtimeTaskId: 'rt-x',
      status: 'succeeded',
      response: {
        runtimeTaskId: 'rt-x',
        status: 'succeeded',
        providerProfileId: 'p1',
        provider: '',
        model: '',
        mode: 'sync',
        assets: [{ type: 'image', filePath: '/tmp/out.png' }],
      },
    })

    expect(firstPersistedTask().status).toBe('running')
  })

  it('终态后到达的过期 running 事件不回退状态', () => {
    writeQuickCreateTasks([
      seedTask({
        id: 'task-media',
        status: 'succeeded',
        assets: [{ type: 'image', filePath: '/tmp/kept.png' }],
      }),
    ])

    emitMedia({
      clientTaskId: 'task-media',
      runtimeTaskId: 'rt-1',
      status: 'running',
      response: {
        runtimeTaskId: 'rt-1',
        status: 'running',
        providerProfileId: 'p1',
        provider: '',
        model: '',
        mode: 'sync',
        assets: [],
      },
    })

    const task = firstPersistedTask()
    expect(task.status).toBe('succeeded')
    expect(task.assets).toEqual([{ type: 'image', filePath: '/tmp/kept.png' }])
  })

  it('后台文本事件回写反推任务文本结果', () => {
    writeQuickCreateTasks([seedTask({ id: 'task-reverse', mode: 'reverse', operation: 'image_prompt_reverse' })])

    emitText({
      clientTaskId: 'task-reverse',
      status: 'succeeded',
      response: {
        status: 'succeeded',
        providerProfileId: 'p1',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        text: 'a still life by the window',
      },
    })

    const task = firstPersistedTask()
    expect(task.status).toBe('succeeded')
    expect(task.text).toBe('a still life by the window')
  })
})

describe('reconcileQuickCreateRunningTasks', () => {
  it('有 runtimeTaskId 且后台已成功：回写终态与产物', async () => {
    writeQuickCreateTasks([seedTask({ id: 'task-1', runtimeTaskId: 'rt-1' })])
    invokeMock.mockResolvedValue({
      found: true,
      status: 'succeeded',
      runtimeTaskId: 'rt-1',
      providerProfileId: 'p1',
      provider: 'openai-images',
      model: 'm1',
      mode: 'sync',
      assets: [{ type: 'image', filePath: '/tmp/recovered.png' }],
    })

    const patches: Array<[string, Partial<QuickCreateTaskRecord>]> = []
    await reconcileQuickCreateRunningTasks((id, patch) => patches.push([id, patch]))

    expect(invokeMock).toHaveBeenCalledWith('canvas:task:get-media', { runtimeTaskId: 'rt-1' })
    expect(patches).toEqual([
      ['task-1', { status: 'succeeded', assets: [{ type: 'image', filePath: '/tmp/recovered.png' }] }],
    ])
  })

  it('后台仍在运行：保持 running 不动', async () => {
    writeQuickCreateTasks([seedTask({ id: 'task-1', runtimeTaskId: 'rt-1' })])
    invokeMock.mockResolvedValue({
      found: true,
      status: 'running',
      runtimeTaskId: 'rt-1',
      providerProfileId: 'p1',
      provider: '',
      model: '',
      mode: 'async',
      assets: [],
    })

    const patches: Array<[string, Partial<QuickCreateTaskRecord>]> = []
    await reconcileQuickCreateRunningTasks((id, patch) => patches.push([id, patch]))

    expect(patches).toEqual([])
  })

  it('后台记录不存在：标失败', async () => {
    writeQuickCreateTasks([seedTask({ id: 'task-1', runtimeTaskId: 'rt-gone' })])
    invokeMock.mockResolvedValue({
      found: false,
      status: 'failed',
      runtimeTaskId: 'rt-gone',
      providerProfileId: '',
      provider: '',
      model: '',
      mode: 'sync',
      assets: [],
      pollingAvailable: false,
      error: { code: 'task_not_found', message: 'Media task not found: rt-gone' },
    })

    const patches: Array<[string, Partial<QuickCreateTaskRecord>]> = []
    await reconcileQuickCreateRunningTasks((id, patch) => patches.push([id, patch]))

    expect(patches).toHaveLength(1)
    expect(patches[0]?.[1].status).toBe('failed')
  })

  it('无 runtimeTaskId 且未超时：保持 running', async () => {
    writeQuickCreateTasks([seedTask({ id: 'task-1', createdAt: new Date().toISOString() })])

    const patches: Array<[string, Partial<QuickCreateTaskRecord>]> = []
    await reconcileQuickCreateRunningTasks((id, patch) => patches.push([id, patch]))

    expect(invokeMock).not.toHaveBeenCalled()
    expect(patches).toEqual([])
  })

  it('无 runtimeTaskId 且超过 24h：标失败', async () => {
    writeQuickCreateTasks([
      seedTask({ id: 'task-1', createdAt: '2026-09-01T00:00:00.000Z' }),
    ])

    const patches: Array<[string, Partial<QuickCreateTaskRecord>]> = []
    await reconcileQuickCreateRunningTasks((id, patch) => patches.push([id, patch]))

    expect(patches).toHaveLength(1)
    const [patchId, patch] = patches[0] ?? []
    expect(patchId).toBe('task-1')
    expect(patch?.status).toBe('failed')
    expect(patch?.error?.code).toBe('task_state_lost')
  })
})
