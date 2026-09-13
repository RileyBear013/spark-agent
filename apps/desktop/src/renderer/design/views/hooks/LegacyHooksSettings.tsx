/**
 * 经典通知设置（V1 sound/notification 节点）——从 SettingsView 抽出的兼容区块。
 *
 * Phase F 迁移完成前保留双轨：本区块继续写 Settings 的 hooks/data（V1 事实源），
 * V2 Hook 由 hook_definitions/hook_bindings 管理；执行所有权切换后此区块将移除。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@lobehub/ui'
import { Switch } from 'antd'
import { Icons } from '../../Icons'
import { useToast } from '../../components/Toast'

type HookNodeType = 'permission_request' | 'ask_user_question' | 'session_end' | 'session_fail'

interface HookNodeConfig {
  sound: boolean
  notification: boolean
}

interface HookConfig {
  enabled: boolean
  nodes: Record<HookNodeType, HookNodeConfig>
}

const LEGACY_HOOKS_STORAGE_KEY = 'spark-settings-hooks'

const DEFAULT_HOOK_CONFIG: HookConfig = {
  enabled: true,
  nodes: {
    permission_request: { sound: true, notification: true },
    ask_user_question: { sound: true, notification: true },
    session_end: { sound: true, notification: true },
    session_fail: { sound: true, notification: true },
  },
}

const HOOK_NODE_LABELS: Record<HookNodeType, { label: string; desc: string }> = {
  permission_request: { label: '权限请求', desc: 'Agent 需要您的审批' },
  ask_user_question: { label: '用户提问', desc: 'Agent 需要您提供更多信息' },
  session_end: { label: '任务完成', desc: '当前任务已成功完成' },
  session_fail: { label: '任务失败', desc: '任务执行出错' },
}

const HOOK_NODE_ICONS: Record<
  HookNodeType,
  (p: { size?: number; className?: string }) => React.JSX.Element
> = {
  permission_request: Icons.Shield,
  ask_user_question: Icons.Chat,
  session_end: Icons.CheckCircle,
  session_fail: Icons.AlertTriangle,
}

function readStoredConfig(): HookConfig {
  if (typeof window === 'undefined') return DEFAULT_HOOK_CONFIG
  const raw = window.localStorage.getItem(LEGACY_HOOKS_STORAGE_KEY)
  if (raw == null) return DEFAULT_HOOK_CONFIG
  try {
    const parsed = JSON.parse(raw) as Partial<HookConfig>
    return {
      enabled: parsed.enabled ?? true,
      nodes: { ...DEFAULT_HOOK_CONFIG.nodes, ...parsed.nodes },
    }
  } catch {
    return DEFAULT_HOOK_CONFIG
  }
}

function useLegacyHookSettings(): [HookConfig, (patch: Partial<HookConfig>) => void] {
  const [config, setConfig] = useState<HookConfig>(readStoredConfig)
  const loadedRef = useRef(false)

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    window.spark
      ?.invoke('settings:get', { category: 'hooks', key: 'data' })
      .then((res) => {
        if (res.value != null && typeof res.value === 'object') {
          const merged = { ...DEFAULT_HOOK_CONFIG, ...(res.value as Partial<HookConfig>) }
          setConfig(merged)
          window.localStorage.setItem(LEGACY_HOOKS_STORAGE_KEY, JSON.stringify(merged))
        }
      })
      .catch(() => {})
  }, [])

  const update = useCallback((patch: Partial<HookConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch }
      window.localStorage.setItem(LEGACY_HOOKS_STORAGE_KEY, JSON.stringify(next))
      window.spark
        ?.invoke('settings:set', { category: 'hooks', key: 'data', value: next })
        .catch(() => {})
      return next
    })
  }, [])

  return [config, update]
}

export function LegacyHooksSettings() {
  const [config, setConfig] = useLegacyHookSettings()
  const [testing, setTesting] = useState<string | null>(null)
  const [migrated, setMigrated] = useState(false)
  const { toast } = useToast()

  useEffect(() => {
    window.spark
      ?.invoke('settings:get', { category: 'hooks-v2', key: 'ownership' })
      .then((res) => setMigrated(res.value === 'v2'))
      .catch(() => {})
  }, [])

  const updateNodeConfig = (node: HookNodeType, type: 'sound' | 'notification', value: boolean) => {
    setConfig({
      ...config,
      nodes: {
        ...config.nodes,
        [node]: {
          ...config.nodes[node],
          [type]: value,
        },
      },
    })
  }

  const testHook = async (node: HookNodeType) => {
    setTesting(node)
    try {
      await window.spark?.invoke('hook:play-sound', {})
      const nodeInfo = HOOK_NODE_LABELS[node]
      await window.spark?.invoke('hook:show-notification', {
        title: `测试：${nodeInfo.label}`,
        body: `这是一条测试通知，来自 ${nodeInfo.label} 节点`,
      })
      toast.success('Hook 测试完成')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '测试失败')
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="hookv2-legacy-inner">
      <div className="subsec-h">经典通知（兼容）</div>
      <div className="muted hookv2-legacy-hint">
        {migrated
          ? '旧配置已迁移为上方 Hooks 系统的内置定义（可搜索「内置迁移」），本区块不再生效，仅保留回滚兼容读取。'
          : '旧版节点开关。迁移到上方 Hooks 系统后此区块将移除；当前两者并行执行，不会重复通知。'}
      </div>
      {migrated ? null : (
        <>
          <div className="row hookv2-legacy-head">
            <div className="flex1">启用经典通知</div>
            <Switch
              size="middle"
              checked={config.enabled}
              onChange={(v) => setConfig({ ...config, enabled: v })}
            />
          </div>
          {config.enabled && (
            <div className="hook-nodes-list">
              {(Object.keys(HOOK_NODE_LABELS) as HookNodeType[]).map((node) => {
                const info = HOOK_NODE_LABELS[node]
                const nodeConfig = config.nodes[node]
                const Icon = HOOK_NODE_ICONS[node]
                const anyEnabled = nodeConfig.sound || nodeConfig.notification
                return (
                  <div key={node} className="hook-node-card">
                    <div className="hook-node-header">
                      <div className="hook-node-icon-wrap">
                        <Icon size={14} />
                      </div>
                      <div className="hook-node-meta flex1 min-w-0">
                        <div className="hook-node-label">{info.label}</div>
                        <div className="hook-node-desc">{info.desc}</div>
                      </div>
                      <span className={`badge dot ${anyEnabled ? 'success' : ''}`}>
                        {anyEnabled ? '已启用' : '已关闭'}
                      </span>
                    </div>
                    <div className="hook-node-toggles">
                      <div className="hook-toggle-row">
                        <div className="hook-toggle-info">
                          <Icons.Bell size={13} className="hook-toggle-icon" />
                          <span className="hook-toggle-label">系统通知</span>
                          <span className="hook-toggle-hint">原生横幅通知，点击聚焦窗口</span>
                        </div>
                        <Switch
                          size="middle"
                          checked={nodeConfig.notification}
                          onChange={(v) => updateNodeConfig(node, 'notification', v)}
                        />
                      </div>
                      <div className="hook-toggle-row">
                        <div className="hook-toggle-info">
                          <Icons.Activity size={13} className="hook-toggle-icon" />
                          <span className="hook-toggle-label">提示音</span>
                          <span className="hook-toggle-hint">系统默认提示音</span>
                        </div>
                        <Switch
                          size="middle"
                          checked={nodeConfig.sound}
                          onChange={(v) => updateNodeConfig(node, 'sound', v)}
                        />
                      </div>
                    </div>
                    <div className="hook-node-footer">
                      <Button
                        size="middle"
                        type="text"
                        loading={testing === node}
                        icon={<Icons.Play size={11} />}
                        onClick={() => void testHook(node)}
                        disabled={testing === node}
                      >
                        测试
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
