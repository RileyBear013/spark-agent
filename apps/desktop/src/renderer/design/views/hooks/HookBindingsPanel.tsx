/**
 * Hook 作用域绑定面板（设计方案 §9/§10/§15.1）。
 *
 * 四类作用域（application/workspace/agent/session）的绑定 upsert 与授权：
 * - 启用执行类绑定必须授权当前 executionHash；定义执行属性变化后旧授权失效，
 *   绑定进入 needs_review，需在此重新确认。
 * - 授权前展示将外发的映射字段预览（§17：明确标出哪些字段将离开 SparkWork）。
 */

import React, { useEffect, useMemo, useState } from 'react'
import { Button, Input, Select, Tag } from '@lobehub/ui'
import { Modal as AntdModal, Switch } from 'antd'
import { Icons } from '../../Icons'
import { useToast } from '../../components/Toast'
import type { HookBindingV1, HookDefinitionV1 } from '@spark/protocol'
import { HOOK_SCOPE_LABELS, hooksV2Api } from './hooksV2Ipc'

type ScopeKind = 'application' | 'workspace' | 'agent' | 'session'

const SCOPE_OPTIONS: Array<{ value: ScopeKind; label: string }> = [
  { value: 'application', label: '应用（全局）' },
  { value: 'workspace', label: '项目（主 Workspace）' },
  { value: 'agent', label: 'Agent' },
  { value: 'session', label: '会话' },
]

function bindingStateTag(state: HookBindingV1['state']): React.ReactElement {
  if (state === 'active') return <Tag className="tone-success">生效中</Tag>
  if (state === 'needs_review') return <Tag className="tone-warning">待重新授权</Tag>
  return <Tag>已停用</Tag>
}

export interface HookBindingsPanelProps {
  definition: HookDefinitionV1
  onChanged: () => void
}

export function HookBindingsPanel({ definition, onChanged }: HookBindingsPanelProps) {
  const { toast } = useToast()
  const [bindings, setBindings] = useState<HookBindingV1[]>([])
  const [loading, setLoading] = useState(false)
  const [addScope, setAddScope] = useState<ScopeKind>('application')
  const [addScopeId, setAddScopeId] = useState('')

  const reload = async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await hooksV2Api.listBindings({ hookId: definition.id })
      setBindings(res.bindings)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载绑定失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (definition.id == null) return
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition.id])

  const scopeLabel = (binding: HookBindingV1): string => {
    const label = HOOK_SCOPE_LABELS[binding.scopeKind] ?? binding.scopeKind
    return binding.scopeKind === 'application' ? label : `${label} · ${binding.scopeId}`
  }

  const confirmAuthorize = (binding: HookBindingV1): void => {
    const fields = Object.keys(definition.inputMapping)
    AntdModal.confirm({
      title: `授权执行该 Hook？`,
      content: (
        <div>
          <p>
            授权对象：<strong>{definition.name}</strong>（事件 {definition.eventName}）
          </p>
          <p>
            动作：
            {definition.action.type === 'tool.invoke'
              ? `调用工具 ${definition.action.target.qualifiedName}`
              : definition.action.type === 'builtin.notification'
                ? '系统通知'
                : '提示音'}
          </p>
          {fields.length > 0 && (
            <p>
              将随动作外发的字段：
              {fields.map((field) => (
                <Tag key={field}>{field}</Tag>
              ))}
            </p>
          )}
          <p className="muted">
            授权与当前定义的执行哈希绑定；之后任何执行属性（事件/条件/映射/动作/策略）变化都会使授权失效。
          </p>
        </div>
      ),
      okText: '确认授权',
      cancelText: '取消',
      onOk: async () => {
        try {
          await hooksV2Api.upsertBinding({
            hookId: definition.id,
            scopeKind: binding.scopeKind,
            ...(binding.scopeKind !== 'application' ? { scopeId: binding.scopeId } : {}),
            enabled: true,
            authorizeExecutionHash: definition.executionHash,
            authorizedEffect: definition.action.type,
          })
          toast.success('已授权并启用')
          await reload()
          onChanged()
        } catch (error) {
          toast.error(error instanceof Error ? error.message : '授权失败')
        }
      },
    })
  }

  const toggleEnabled = async (binding: HookBindingV1, enabled: boolean): Promise<void> => {
    try {
      await hooksV2Api.upsertBinding({
        hookId: definition.id,
        scopeKind: binding.scopeKind,
        ...(binding.scopeKind !== 'application' ? { scopeId: binding.scopeId } : {}),
        enabled,
      })
      await reload()
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新绑定失败')
    }
  }

  const addBinding = async (): Promise<void> => {
    if (addScope !== 'application' && addScopeId.trim() === '') {
      toast.error('请填写作用域对象 ID')
      return
    }
    try {
      await hooksV2Api.upsertBinding({
        hookId: definition.id,
        scopeKind: addScope,
        ...(addScope !== 'application' ? { scopeId: addScopeId.trim() } : {}),
        enabled: true,
        authorizeExecutionHash: definition.executionHash,
        authorizedEffect: definition.action.type,
      })
      setAddScopeId('')
      toast.success('绑定已创建并授权')
      await reload()
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建绑定失败')
    }
  }

  const sorted = useMemo(
    () =>
      [...bindings].sort((a, b) => {
        const order: Record<string, number> = { application: 0, workspace: 1, agent: 2, session: 3 }
        return (order[a.scopeKind] ?? 9) - (order[b.scopeKind] ?? 9)
      }),
    [bindings],
  )

  return (
    <div className="hookv2-bindings">
      <div className="hookv2-subhead">作用域绑定</div>
      {loading && <div className="muted">加载中…</div>}
      {!loading && sorted.length === 0 && (
        <div className="muted hookv2-empty">
          暂无绑定。Hook 定义需要绑定到作用域并授权后才会执行。
        </div>
      )}
      {sorted.map((binding) => (
        <div key={binding.id} className="hookv2-binding-row">
          <div className="hookv2-binding-meta flex1 min-w-0">
            <div className="hookv2-binding-scope">
              {scopeLabel(binding)} {bindingStateTag(binding.state)}
            </div>
            <div className="muted hookv2-binding-sub">
              {binding.trustedExecutionHash != null
                ? `授权哈希 ${binding.trustedExecutionHash.slice(0, 12)}…`
                : '未授权'}
              {binding.authorizedAt != null ? ` · ${binding.authorizedAt.slice(0, 10)}` : ''}
            </div>
          </div>
          <div className="hookv2-binding-actions">
            {binding.state === 'needs_review' && (
              <Button size="small" onClick={() => confirmAuthorize(binding)}>
                重新授权
              </Button>
            )}
            {binding.state !== 'needs_review' && (
              <Switch
                size="small"
                checked={binding.enabled}
                onChange={(v) => void toggleEnabled(binding, v)}
              />
            )}
          </div>
        </div>
      ))}

      <div className="hookv2-binding-add">
        <Select
          size="small"
          value={addScope}
          options={SCOPE_OPTIONS}
          style={{ width: 170 }}
          onChange={(v) => setAddScope(v)}
        />
        {addScope !== 'application' && (
          <Input
            size="small"
            value={addScopeId}
            placeholder={
              addScope === 'workspace'
                ? 'workspace ID'
                : addScope === 'agent'
                  ? 'agent ID'
                  : 'session ID'
            }
            style={{ width: 220 }}
            onChange={(e) => setAddScopeId(e.target.value)}
          />
        )}
        <Button
          size="small"
          type="text"
          icon={<Icons.Plus size={12} />}
          onClick={() => void addBinding()}
        >
          添加绑定
        </Button>
      </div>
    </div>
  )
}
