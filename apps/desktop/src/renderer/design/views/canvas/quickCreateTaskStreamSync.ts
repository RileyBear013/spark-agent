import type {
  CanvasMediaTaskStreamPayload,
  CanvasTextTaskStreamPayload,
} from '@spark/protocol'
import type { QuickCreateTaskRecord } from './quickCreateTaskStore'
import { readQuickCreateTasks, writeQuickCreateTasks } from './quickCreateTaskStore'

/**
 * 快速创作任务的后台事件同步层。
 *
 * QuickCreateView 是按路由条件渲染的，切走视图即卸载；若任务进度订阅只挂在视图内，
 * 主进程后台任务完成后广播的 stream 事件将无人接收，任务记录会永远停在 running。
 * 本模块在首次进入视图时注册一次全局订阅（随渲染进程生命周期常驻），
 * 把事件补丁直接回写到 localStorage 任务存储，保证切页/后台运行期间状态照常流转。
 */

let subscribed = false

function now(): string {
  return new Date().toISOString()
}

function isTerminal(status: QuickCreateTaskRecord['status']): boolean {
  return status !== 'running'
}

/** 按 clientTaskId 把补丁回写到任务存储；任务不存在或补丁为过期运行态时忽略。 */
function applyTaskPatch(
  clientTaskId: string,
  patch: Partial<QuickCreateTaskRecord>,
): boolean {
  const tasks = readQuickCreateTasks()
  const index = tasks.findIndex((task) => task.id === clientTaskId)
  const existing = tasks[index]
  if (!existing) return false
  if (isTerminal(existing.status) && patch.status === 'running') return false
  writeQuickCreateTasks(
    tasks.map((task, i) =>
      i === index ? { ...task, ...patch, updatedAt: now() } : task,
    ),
  )
  return true
}

function handleMediaTaskStream(payload: CanvasMediaTaskStreamPayload): void {
  if (!payload.clientTaskId) return
  const response = payload.response
  applyTaskPatch(payload.clientTaskId, {
    status:
      payload.status === 'running'
        ? 'running'
        : response.status === 'cancelled'
          ? 'cancelled'
          : response.status === 'succeeded'
            ? 'succeeded'
            : 'failed',
    ...(response.providerProfileId ? { providerProfileId: response.providerProfileId } : {}),
    ...(response.provider ? { providerName: response.provider } : {}),
    ...(response.model ? { modelId: response.model } : {}),
    ...(response.runtimeTaskId ? { runtimeTaskId: response.runtimeTaskId } : {}),
    ...(response.requestId ? { requestId: response.requestId } : {}),
    assets: response.assets,
    ...(response.error ? { error: response.error } : {}),
    ...(response.progress !== undefined ? { progress: response.progress } : {}),
  })
}

function handleTextTaskStream(payload: CanvasTextTaskStreamPayload): void {
  if (!payload.clientTaskId) return
  const response = payload.response
  applyTaskPatch(payload.clientTaskId, {
    status: response.status === 'succeeded' ? 'succeeded' : 'failed',
    ...(response.providerProfileId ? { providerProfileId: response.providerProfileId } : {}),
    ...(response.provider ? { providerName: response.provider } : {}),
    ...(response.model ? { modelId: response.model } : {}),
    text: response.text,
    ...(response.error ? { error: response.error } : {}),
  })
}

/** 幂等注册全局 stream 订阅；在 QuickCreateView 挂载时调用一次即可。 */
export function ensureQuickCreateTaskStreamSync(): void {
  if (subscribed) return
  if (typeof window === 'undefined' || typeof window.spark?.on !== 'function') return
  subscribed = true
  window.spark.on('stream:canvas:media-task', handleMediaTaskStream)
  window.spark.on('stream:canvas:text-task', handleTextTaskStream)
}

/** 无 runtimeTaskId 的任务（反推/文本等）无法向后端查询，超时后按失败收尾。 */
const STALE_RUNNING_THRESHOLD_MS = 24 * 60 * 60 * 1000

/**
 * 视图重新挂载时对账：对停在 running 的任务查询持久化 runtime 记录的真实状态。
 * - 有 runtimeTaskId：通过 canvas:task:get-media 只读查询；终态回写、记录缺失标失败、仍在运行保持不动。
 * - 无 runtimeTaskId 且超时：标失败，避免永久挂起。
 */
export async function reconcileQuickCreateRunningTasks(
  applyPatch: (id: string, patch: Partial<QuickCreateTaskRecord>) => void,
): Promise<void> {
  const stale = readQuickCreateTasks().filter((task) => task.status === 'running')
  await Promise.all(
    stale.map(async (task) => {
      if (task.runtimeTaskId) {
        try {
          const response = await window.spark.invoke('canvas:task:get-media', {
            runtimeTaskId: task.runtimeTaskId,
          })
          if (!response.found) {
            applyPatch(task.id, {
              status: 'failed',
              error: {
                code: 'task_not_found',
                message: '后台任务记录不存在或已被清理，无法恢复状态',
              },
            })
            return
          }
          // 后台仍在运行时保持 running，全局订阅会在完成时回写
          const status = response.status
          if (status != null && isTerminal(status)) {
            applyPatch(task.id, {
              status:
                status === 'cancelled'
                  ? 'cancelled'
                  : status === 'succeeded'
                    ? 'succeeded'
                    : 'failed',
              assets: response.assets,
              ...(response.error ? { error: response.error } : {}),
              ...(response.progress !== undefined ? { progress: response.progress } : {}),
            })
          }
        } catch {
          // 查询失败（如主进程繁忙）不改动记录，等下一次挂载再对账
        }
        return
      }
      const elapsed = Date.now() - new Date(task.createdAt).getTime()
      if (Number.isFinite(elapsed) && elapsed > STALE_RUNNING_THRESHOLD_MS) {
        applyPatch(task.id, {
          status: 'failed',
          error: {
            code: 'task_state_lost',
            message: '任务状态已丢失（无后台任务标识），请重新提交',
          },
        })
      }
    }),
  )
}

/** 测试专用：重置单例订阅标记。 */
export function __resetQuickCreateTaskStreamSyncForTests(): void {
  subscribed = false
}
