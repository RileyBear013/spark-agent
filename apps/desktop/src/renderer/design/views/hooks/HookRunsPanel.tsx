/**
 * Hook 运行记录面板（设计方案 §14/§18）。
 *
 * 按状态/事件筛选运行记录，支持重试（终态）与取消（排队中），
 * 展开可见脱敏输入/输出摘要、错误码与调用归因。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Button, Select, Tag } from '@lobehub/ui'
import { Icons } from '../../Icons'
import { useToast } from '../../components/Toast'
import type { HookRunStatusV1, HookRunV1 } from '@spark/protocol'
import { HOOK_ERROR_CODE_LABELS, HOOK_RUN_STATUS_LABELS, hooksV2Api } from './hooksV2Ipc'

const STATUS_OPTIONS: Array<{ value: HookRunStatusV1; label: string }> = (
  Object.keys(HOOK_RUN_STATUS_LABELS) as HookRunStatusV1[]
).map((status) => ({ value: status, label: HOOK_RUN_STATUS_LABELS[status].label }))

function statusTag(run: HookRunV1): React.ReactElement {
  const meta = HOOK_RUN_STATUS_LABELS[run.status]
  return <Tag className={`tone-${meta.tone}`}>{meta.label}</Tag>
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

export interface HookRunsPanelProps {
  /** 限定某个 Hook；null = 全部。 */
  hookId: string | null
  refreshKey: number
}

export function HookRunsPanel({ hookId, refreshKey }: HookRunsPanelProps) {
  const { toast } = useToast()
  const [runs, setRuns] = useState<HookRunV1[]>([])
  const [statusFilter, setStatusFilter] = useState<HookRunStatusV1 | undefined>()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await hooksV2Api.listRuns({
        ...(hookId != null ? { hookId } : {}),
        ...(statusFilter != null ? { status: statusFilter } : {}),
        limit: 50,
      })
      setRuns(res.runs)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载运行记录失败')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hookId, statusFilter, refreshKey])

  useEffect(() => {
    void reload()
  }, [reload])

  const retry = async (run: HookRunV1): Promise<void> => {
    try {
      const res = await hooksV2Api.retryRun(run.id)
      if (res.run == null) toast.error('该运行不在可重试的终态')
      else {
        toast.success('已重新入队')
        await reload()
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重试失败')
    }
  }

  const cancel = async (run: HookRunV1): Promise<void> => {
    try {
      const res = await hooksV2Api.cancelRun(run.id)
      if (res.run == null) toast.error('仅排队中的运行可取消')
      else {
        toast.success('已取消')
        await reload()
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '取消失败')
    }
  }

  return (
    <div className="hookv2-runs">
      <div className="hookv2-subhead hookv2-runs-head">
        <span>运行记录</span>
        <div className="hookv2-runs-filters">
          <Select
            size="small"
            allowClear
            placeholder="全部状态"
            options={STATUS_OPTIONS}
            style={{ width: 140 }}
            value={statusFilter}
            onChange={(v) => setStatusFilter(v)}
          />
          <Button
            size="small"
            type="text"
            icon={<Icons.Activity size={12} />}
            onClick={() => void reload()}
          >
            刷新
          </Button>
        </div>
      </div>
      {loading && runs.length === 0 && <div className="muted">加载中…</div>}
      {!loading && runs.length === 0 && (
        <div className="muted hookv2-empty">
          暂无运行记录。事件发生并匹配绑定后，这里会出现执行记录。
        </div>
      )}
      {runs.map((run) => {
        const expanded = expandedId === run.id
        return (
          <div key={run.id} className="hookv2-run-row">
            <button
              type="button"
              className="hookv2-run-line"
              onClick={() => setExpandedId(expanded ? null : run.id)}
            >
              <Icons.ChevronRight size={12} className={expanded ? 'rot90' : ''} />
              {statusTag(run)}
              {run.isTest && <Tag>测试</Tag>}
              <span className="hookv2-run-event">{run.eventName}</span>
              <span className="muted hookv2-run-time">
                {run.createdAt.slice(5, 19).replace('T', ' ')}
              </span>
              <span className="muted hookv2-run-attempts">尝试 {run.attemptCount}</span>
              <span className="muted hookv2-run-duration">{formatDuration(run.durationMs)}</span>
              {run.errorCode != null && (
                <span className="hookv2-run-error">
                  {HOOK_ERROR_CODE_LABELS[run.errorCode] ?? run.errorCode}
                </span>
              )}
            </button>
            {expanded && (
              <div className="hookv2-run-detail">
                <div className="hookv2-run-detail-grid">
                  <div>
                    <div className="muted">运行 ID</div>
                    <code>{run.id}</code>
                  </div>
                  <div>
                    <div className="muted">事件 ID</div>
                    <code>{run.eventId}</code>
                  </div>
                  <div>
                    <div className="muted">定义 / 修订</div>
                    <code>
                      {run.hookId.slice(0, 8)}… · rev {run.hookRevision}
                    </code>
                  </div>
                  <div>
                    <div className="muted">会话 / Turn</div>
                    <code>
                      {run.sessionId.slice(0, 8)}… · {run.turnId.slice(0, 8)}…
                    </code>
                  </div>
                </div>
                {run.errorMessage != null && (
                  <div className="hookv2-run-error-message">{run.errorMessage}</div>
                )}
                {run.inputSummary != null && (
                  <div>
                    <div className="muted">输入摘要（已脱敏）</div>
                    <pre>{JSON.stringify(run.inputSummary, null, 2)}</pre>
                  </div>
                )}
                {run.outputSummary != null && (
                  <div>
                    <div className="muted">输出摘要（已脱敏）</div>
                    <pre>{JSON.stringify(run.outputSummary, null, 2)}</pre>
                  </div>
                )}
                <div className="hookv2-run-actions">
                  {['failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(run.status) && (
                    <Button size="small" onClick={() => void retry(run)}>
                      重试
                    </Button>
                  )}
                  {run.status === 'queued' && (
                    <Button size="small" onClick={() => void cancel(run)}>
                      取消
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
