/**
 * 会话右侧配置面板 → Hooks 区块（设计方案 §15.3）。
 *
 * 展示当前会话的「最终生效列表」：来源作用域、覆盖关系、被停用/待复核原因；
 * 允许会话临时停用继承 Hook（session 绑定 enabled=false 显式覆盖），或恢复执行。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Button, Tag } from '@lobehub/ui'
import { Switch } from 'antd'
import { useToast } from '../../components/Toast'
import type { HookEffectiveBindingV1 } from '@spark/protocol'
import { HOOK_EVENT_LABELS, HOOK_SCOPE_LABELS, describeHookAction, hooksV2Api } from './hooksV2Ipc'

const DISABLED_REASON_LABELS: Record<string, string> = {
  overridden_disabled: '被更高优先级作用域显式停用',
  definition_disabled: '定义已停用',
  needs_review: '授权失效，待重新确认',
}

function effectiveTag(item: HookEffectiveBindingV1): React.ReactElement {
  if (item.disabled) {
    return (
      <Tag className="tone-warning">
        {DISABLED_REASON_LABELS[item.disabledReason ?? ''] ?? '已停用'}
      </Tag>
    )
  }
  if (item.binding.state === 'needs_review') return <Tag className="tone-warning">待重新授权</Tag>
  if (item.binding.state === 'disabled') return <Tag>已停用</Tag>
  return <Tag className="tone-success">生效中</Tag>
}

export interface SessionHooksSectionProps {
  sessionId: string | null
}

export function SessionHooksSection({ sessionId }: SessionHooksSectionProps) {
  const { toast } = useToast()
  const [items, setItems] = useState<HookEffectiveBindingV1[]>([])
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    if (sessionId == null) return
    setLoading(true)
    try {
      const res = await hooksV2Api.listEffective(sessionId)
      setItems(res.items)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载生效列表失败')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    void reload()
  }, [reload])

  const setSessionOverride = async (
    item: HookEffectiveBindingV1,
    enabled: boolean,
  ): Promise<void> => {
    if (sessionId == null) return
    try {
      await hooksV2Api.upsertBinding({
        hookId: item.hook.id,
        scopeKind: 'session',
        scopeId: sessionId,
        enabled,
        // 重新启用（恢复执行）时按当前定义执行哈希授权，使会话覆盖立即生效。
        ...(enabled
          ? {
              authorizeExecutionHash: item.hook.executionHash,
              authorizedEffect: item.hook.action.type,
            }
          : {}),
      })
      await reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新会话覆盖失败')
    }
  }

  if (sessionId == null) return null

  return (
    <div className="session-hooks-section">
      <div className="runtime-env-hint">
        会话覆盖优先于 Agent / 项目 / 应用级绑定；关闭即为临时停用该 Hook，不影响其他作用域。
      </div>
      {loading && items.length === 0 && <div className="muted">加载中…</div>}
      {!loading && items.length === 0 && (
        <div className="muted session-hooks-empty">
          当前会话没有生效的 Hook。可在 设置 → Hooks 中创建并绑定。
        </div>
      )}
      {items.map((item) => {
        const sessionOverride = item.sourceScope === 'session'
        return (
          <div key={item.hook.id} className="session-hooks-row">
            <div className="flex1 min-w-0">
              <div className="session-hooks-name">
                {item.hook.name} {effectiveTag(item)}
              </div>
              <div className="muted session-hooks-sub">
                {HOOK_EVENT_LABELS[item.hook.eventName].label} · {describeHookAction(item.hook)} ·
                来源 {HOOK_SCOPE_LABELS[item.sourceScope] ?? item.sourceScope}
                {item.shadowedBy.length > 0
                  ? ` · 覆盖 ${item.shadowedBy
                      .map((s) => HOOK_SCOPE_LABELS[s.scopeKind] ?? s.scopeKind)
                      .join('/')}`
                  : ''}
              </div>
            </div>
            <div className="session-hooks-actions">
              {sessionOverride && item.binding.state === 'needs_review' ? (
                <Button size="small" onClick={() => void setSessionOverride(item, true)}>
                  重新授权
                </Button>
              ) : (
                <Switch
                  size="small"
                  checked={
                    sessionOverride
                      ? item.binding.enabled
                      : !item.disabled && item.binding.state === 'active'
                  }
                  onChange={(v) => void setSessionOverride(item, v)}
                />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
