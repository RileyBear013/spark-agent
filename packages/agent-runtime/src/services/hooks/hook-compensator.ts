import type { SparkDatabase } from '@spark/storage'
import { SettingsRepository } from '@spark/storage'
import { createLogger } from '@spark/shared'
import type { HookLifecycleBridge } from './hook-lifecycle-bridge.js'

const log = createLogger('hooks:compensator')

/**
 * §13.2 补偿扫描器：生命周期事实持久化与 outbox 写入之间存在极小的崩溃窗口
 * （同一同步方法内的相邻语句），本扫描器按稳定事实源兜底补发丢失的事件。
 *
 * - 事实源与游标：turn_requests（turnId + status）、agent_events 的最终
 *   assistant_message（messageId + isFinal）；单调游标存 settings('hooks-v2',
 *   'compensator_cursor')，扫描窗口带 5 分钟重叠，LIMIT 截断的行下轮仍会覆盖。
 * - 幂等：事件 ID 由事件名 + 稳定源 ID 确定性生成，hook_events 主键去重；
 *   未使用 Hook 功能时 bridge 短路，保持零写入。
 * - permission.requested / question.requested 的事实源是内存态（审批桥与提问
 *   pending 队列），当前表无法提供稳定事实或游标——按设计方案，这两个事件
 *   不宣称具备崩溃不丢的交付保证。
 */

const CURSOR_CATEGORY = 'hooks-v2'
const CURSOR_KEY = 'compensator_cursor'
/** 扫描窗口重叠：吸收游标推进与事实写入的时钟偏差，并覆盖 LIMIT 截断。 */
const OVERLAP_MS = 5 * 60_000
const SWEEP_BATCH_LIMIT = 200
const TERMINAL_STATUS_BY_REQUEST: Record<string, 'completed' | 'failed' | 'cancelled'> = {
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
}

interface TurnRequestRow {
  id: string
  session_id: string
  status: string
  error_message: string | null
  created_at: string
}

interface AssistantEventRow {
  id: string
  session_id: string
  turn_id: string | null
  event_json: string
  created_at: string
}

export interface CompensatorSweepResult {
  /** 本次重放的 turn 级事件数（含幂等跳过）。 */
  turnFacts: number
  /** 本次重放的 response.committed 数（含幂等跳过）。 */
  responseFacts: number
}

export class HookCompensator {
  private readonly settings: SettingsRepository
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly db: SparkDatabase,
    private readonly bridge: HookLifecycleBridge,
  ) {
    this.settings = new SettingsRepository(db)
  }

  /** 首次运行初始化游标为当前时间：不回溯历史事实，只保证此后的事实不丢。 */
  private ensureCursor(): string | null {
    const existing = this.settings.get(CURSOR_CATEGORY, CURSOR_KEY)
    if (typeof existing === 'string' && existing !== '') return existing
    const now = new Date().toISOString()
    this.settings.set(CURSOR_CATEGORY, CURSOR_KEY, now)
    return null
  }

  sweepOnce(): CompensatorSweepResult {
    const cursor = this.ensureCursor()
    if (cursor == null) return { turnFacts: 0, responseFacts: 0 }
    const since = new Date(Date.parse(cursor) - OVERLAP_MS).toISOString()

    let turnFacts = 0
    let responseFacts = 0
    try {
      const turns = this.db.raw
        .prepare(
          `SELECT id, session_id, status, error_message, created_at FROM turn_requests
           WHERE created_at > ? ORDER BY created_at LIMIT ?`,
        )
        .all(since, SWEEP_BATCH_LIMIT) as TurnRequestRow[]
      for (const turn of turns) {
        this.bridge.turnStarted(turn.session_id, turn.id)
        const terminal = TERMINAL_STATUS_BY_REQUEST[turn.status]
        if (terminal != null) {
          this.bridge.turnTerminal(
            turn.session_id,
            turn.id,
            terminal,
            turn.error_message ?? undefined,
          )
        }
        turnFacts += 1
      }

      const messages = this.db.raw
        .prepare(
          `SELECT id, session_id, turn_id, event_json, created_at FROM agent_events
           WHERE event_type = 'assistant_message' AND created_at > ?
           ORDER BY created_at LIMIT ?`,
        )
        .all(since, SWEEP_BATCH_LIMIT) as AssistantEventRow[]
      for (const message of messages) {
        if (message.turn_id == null || message.turn_id === '') continue
        let parsed: { mode?: string; isFinal?: boolean; content?: string }
        try {
          parsed = JSON.parse(message.event_json) as typeof parsed
        } catch {
          continue
        }
        if (parsed.mode !== 'complete' || parsed.isFinal !== true) continue
        this.bridge.responseCommitted(
          message.session_id,
          message.turn_id,
          message.id,
          parsed.content ?? '',
        )
        responseFacts += 1
      }

      this.settings.set(CURSOR_CATEGORY, CURSOR_KEY, new Date().toISOString())
    } catch (error) {
      // 补偿器故障不影响主流程；游标未推进，下一轮重扫同一窗口。
      log.warn(
        `compensator sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return { turnFacts, responseFacts }
  }

  start(intervalMs = 60_000): void {
    if (this.timer != null) return
    this.timer = setInterval(() => {
      this.sweepOnce()
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
