/**
 * Agent 编辑页 → Hooks 区块（设计方案 §15.2）。
 *
 * 展示每个 Hook 定义在该 Agent 上的生效来源（Agent 覆盖 / 继承应用级），
 * 允许启用、停用或覆盖；Agent 专属覆盖走与设置页一致的绑定与授权流程。
 * 旧 hookConfig 表单由本区块替代（V1 配置已在 §16 迁移中转换为 agent 绑定）。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Button, Tag } from '@lobehub/ui'
import { Switch } from 'antd'
import { useToast } from '../../components/Toast'
import type { HookBindingV1, HookDefinitionV1 } from '@spark/protocol'
import { HOOK_EVENT_LABELS, describeHookAction, hooksV2Api } from './hooksV2Ipc'

function stateTag(binding: HookBindingV1 | undefined): React.ReactElement {
  if (binding == null) return <Tag>未启用</Tag>
  if (binding.state === 'active') return <Tag className="tone-success">生效中</Tag>
  if (binding.state === 'needs_review') return <Tag className="tone-warning">待重新授权</Tag>
  return <Tag>已停用</Tag>
}

export interface AgentHooksSectionProps {
  /** 正在编辑的 Agent ID（未保存的新建 Agent 尚无 ID，此时提示先保存）。 */
  agentId: string | null
}

export function AgentHooksSection({ agentId }: AgentHooksSectionProps) {
  const { toast } = useToast()
  const [definitions, setDefinitions] = useState<HookDefinitionV1[]>([])
  const [agentBindings, setAgentBindings] = useState<HookBindingV1[]>([])
  const [appBindings, setAppBindings] = useState<HookBindingV1[]>([])
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    if (agentId == null) return
    setLoading(true)
    try {
      const [definitionsRes, agentRes, appRes] = await Promise.all([
        hooksV2Api.listDefinitions(),
        hooksV2Api.listBindings({ scopeKind: 'agent', scopeId: agentId }),
        hooksV2Api.listBindings({ scopeKind: 'application' }),
      ])
      setDefinitions(definitionsRes.definitions)
      setAgentBindings(agentRes.bindings)
      setAppBindings(appRes.bindings)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载 Hook 配置失败')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  useEffect(() => {
    void reload()
  }, [reload])

  const upsertAgentBinding = async (
    definition: HookDefinitionV1,
    options: { enabled: boolean; authorize?: boolean },
  ): Promise<void> => {
    try {
      await hooksV2Api.upsertBinding({
        hookId: definition.id,
        scopeKind: 'agent',
        scopeId: agentId ?? '',
        enabled: options.enabled,
        ...(options.authorize === true
          ? {
              authorizeExecutionHash: definition.executionHash,
              authorizedEffect: definition.action.type,
            }
          : {}),
      })
      await reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新绑定失败')
    }
  }

  if (agentId == null) {
    return <div className="muted agent-hooks-empty">保存 Agent 后即可配置其专属 Hook 覆盖。</div>
  }

  return (
    <div className="agent-hooks-section">
      <div className="muted agent-hooks-hint">
        Agent 覆盖优先于应用级绑定；未覆盖的定义继承应用级状态（含其授权与停用）。
      </div>
      {loading && definitions.length === 0 && <div className="muted">加载中…</div>}
      {!loading && definitions.length === 0 && (
        <div className="muted agent-hooks-empty">还没有 Hook 定义。可在 设置 → Hooks 中创建。</div>
      )}
      {definitions.map((definition) => {
        const agentBinding = agentBindings.find((item) => item.hookId === definition.id)
        const appBinding = appBindings.find((item) => item.hookId === definition.id)
        return (
          <div key={definition.id} className="agent-hooks-row">
            <div className="flex1 min-w-0">
              <div className="agent-hooks-name">
                {definition.name} {!definition.enabled && <Tag>定义已停用</Tag>}
              </div>
              <div className="muted agent-hooks-sub">
                {HOOK_EVENT_LABELS[definition.eventName].label} · {describeHookAction(definition)}
                {agentBinding != null ? ' · Agent 覆盖' : appBinding != null ? ' · 继承应用' : ''}
              </div>
            </div>
            <div className="agent-hooks-state">{stateTag(agentBinding ?? appBinding)}</div>
            <div className="agent-hooks-actions">
              {agentBinding?.state === 'needs_review' ? (
                <Button
                  size="small"
                  onClick={() =>
                    void upsertAgentBinding(definition, { enabled: true, authorize: true })
                  }
                >
                  重新授权
                </Button>
              ) : (
                <Switch
                  size="small"
                  checked={
                    agentBinding != null ? agentBinding.enabled : appBinding?.enabled === true
                  }
                  onChange={(v) =>
                    void upsertAgentBinding(definition, { enabled: v, authorize: v })
                  }
                />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
