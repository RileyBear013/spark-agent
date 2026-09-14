/**
 * SessionWorkflowSettingsSection — 设置 → Agent → 会话工作流
 *
 * 「会话临时挂载工作流」的灰度功能开关（app_settings 表 sessionWorkflowBinding 分类）：
 * - writeEnabled：会话输入框的挂载入口与绑定管理；关闭后仅已有挂载的会话保留只读展示。
 * - runtimeEnabled：挂载工作流的会话由工作流编排引擎执行消息；编辑器试跑与
 *   Tool Package workflows.run 走同一链路。灰度顺序要求先开入口再开接管。
 *
 * 读取语义与 readSessionWorkflowFeatureFlags 严格一致：仅 value === true 视为开启。
 * 写入成功后主进程广播 stream:config:changed(scope='settings')，
 * 已打开会话的 useSessionWorkflowBinding 会自动重取入口可见性，无需重开会话。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Switch } from 'antd'
import { useIpcInvoke } from '../hooks/useIpc'
import { useToast } from '../components/Toast'

const SETTINGS_CATEGORY = 'sessionWorkflowBinding'
const KEY_WRITE_ENABLED = 'writeEnabled'
const KEY_RUNTIME_ENABLED = 'runtimeEnabled'

type SessionWorkflowFlagKey = typeof KEY_WRITE_ENABLED | typeof KEY_RUNTIME_ENABLED

interface SessionWorkflowFlags {
  writeEnabled: boolean
  runtimeEnabled: boolean
}

function SettingsRow({ title, desc, right }: { title: string; desc?: string; right?: ReactNode }) {
  return (
    <div className="settings-card-row">
      <div className="flex1 min-w-0">
        <div className="row-title">{title}</div>
        {desc && <div className="row-desc">{desc}</div>}
      </div>
      <div className="row-action">{right}</div>
    </div>
  )
}

export function SessionWorkflowSettingsSection() {
  const { invoke: getSetting } = useIpcInvoke('settings:get')
  const { invoke: setSetting } = useIpcInvoke('settings:set')
  const { toast } = useToast()
  const [flags, setFlags] = useState<SessionWorkflowFlags>({
    writeEnabled: false,
    runtimeEnabled: false,
  })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [writeRes, runtimeRes] = await Promise.all([
        getSetting({ category: SETTINGS_CATEGORY, key: KEY_WRITE_ENABLED }),
        getSetting({ category: SETTINGS_CATEGORY, key: KEY_RUNTIME_ENABLED }),
      ])
      setFlags({
        writeEnabled: writeRes?.value === true,
        runtimeEnabled: runtimeRes?.value === true,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '读取会话工作流设置失败')
    } finally {
      setLoading(false)
    }
  }, [getSetting, toast])

  useEffect(() => {
    void load()
  }, [load])

  const updateFlag = useCallback(
    (key: SessionWorkflowFlagKey, next: boolean) => {
      setBusy(true)
      setSetting({ category: SETTINGS_CATEGORY, key, value: next })
        .then(() => {
          setFlags((prev) => ({ ...prev, [key]: next }))
        })
        .catch((err: unknown) => {
          toast.error(err instanceof Error ? err.message : '保存设置失败')
          // 写入失败时以库内真实值为准回滚显示。
          void load()
        })
        .finally(() => {
          setBusy(false)
        })
    },
    [load, setSetting, toast],
  )

  return (
    <div className="settings-section">
      <h2>会话工作流</h2>
      <div className="lede">为单个会话临时挂载工作流的灰度功能开关。</div>

      <div className="settings-card">
        <SettingsRow
          title="会话工作流挂载"
          desc="在会话输入框提供工作流挂载入口，可为单个会话临时挂载或停用工作流；关闭后仅已有挂载的会话保留只读展示。默认关闭，属灰度功能。"
          right={
            <Switch
              size="middle"
              loading={busy}
              disabled={loading}
              checked={flags.writeEnabled}
              onChange={(v) => updateFlag(KEY_WRITE_ENABLED, v)}
            />
          }
        />
        <SettingsRow
          title="工作流运行时接管"
          desc="开启后，挂载工作流的会话消息由工作流编排引擎执行，编辑器试跑与 Tool Package 运行走同一链路；需先开启挂载入口。开关保存后立即生效，已打开的会话会自动刷新入口。"
          right={
            <Switch
              size="middle"
              loading={busy}
              disabled={loading || !flags.writeEnabled}
              checked={flags.runtimeEnabled}
              onChange={(v) => updateFlag(KEY_RUNTIME_ENABLED, v)}
            />
          }
        />
      </div>
    </div>
  )
}
