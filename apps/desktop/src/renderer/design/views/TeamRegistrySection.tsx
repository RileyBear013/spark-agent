/**
 * TeamRegistrySection — 设置 → 团队注册中心
 *
 * 配置团队 Nacos AI 注册中心连接（地址 / 命名空间 / 账号 / 密码）。
 * 密码只进系统 Keychain，不进 IPC 响应（表单回显仅 hasPassword 布尔）。
 * 保存后技能商店会出现「团队源」，支持技能发布 / 安装 / 版本更新。
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Input, InputPassword } from '@lobehub/ui'
import type { TeamRegistryConfigSnapshotDto } from '@spark/protocol'
import { useIpcInvoke } from '../hooks/useIpc'
import { useToast } from '../components/Toast'
import './TeamRegistrySection.less'

type InlineStatus = { tone: 'success' | 'error' | 'info'; message: string } | null

export function TeamRegistrySection() {
  const { invoke: getConfig } = useIpcInvoke('team-registry:config-get')
  const { invoke: saveConfig } = useIpcInvoke('team-registry:config-save')
  const { invoke: testConnection } = useIpcInvoke('team-registry:test-connection')
  const { toast } = useToast()

  const [form, setForm] = useState({ serverUrl: '', namespace: 'public', username: '', password: '' })
  const [snapshot, setSnapshot] = useState<TeamRegistryConfigSnapshotDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [status, setStatus] = useState<InlineStatus>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getConfig({})
      setSnapshot(res.snapshot)
      setForm((prev) => ({
        ...prev,
        serverUrl: res.snapshot.serverUrl,
        namespace: res.snapshot.namespace,
        username: res.snapshot.username,
      }))
    } catch (err) {
      setStatus({ tone: 'error', message: `读取配置失败：${describeError(err)}` })
    } finally {
      setLoading(false)
    }
  }, [getConfig])

  useEffect(() => {
    void load()
  }, [load])

  const updateField = (key: keyof typeof form) => (value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const handleTest = async () => {
    if (!form.serverUrl.trim() || !form.username.trim() || !form.password) {
      setStatus({ tone: 'info', message: '测试连接需要完整的地址、账号和密码（密码不会保存，仅本次测试）' })
      return
    }
    setBusy('test')
    setStatus(null)
    try {
      const res = await testConnection({
        serverUrl: form.serverUrl,
        namespace: form.namespace,
        username: form.username,
        password: form.password,
      })
      setStatus(
        res.health.healthy
          ? { tone: 'success', message: `连接成功（${res.health.latencyMs}ms）` }
          : { tone: 'error', message: `连接失败：${res.health.error ?? '未知错误'}` },
      )
    } catch (err) {
      setStatus({ tone: 'error', message: describeError(err) })
    } finally {
      setBusy(null)
    }
  }

  const handleSave = async () => {
    setBusy('save')
    setStatus(null)
    try {
      const res = await saveConfig({
        serverUrl: form.serverUrl,
        namespace: form.namespace,
        username: form.username,
        // 密码留空 = 保留已存密码；输入了才更新
        ...(form.password !== '' ? { password: form.password } : {}),
      })
      setSnapshot(res.snapshot)
      setForm((prev) => ({ ...prev, password: '' }))
      if (res.healthCheck.healthy) {
        toast.success('团队注册中心已保存，连接正常')
        setStatus({ tone: 'success', message: `已保存并连接成功（${res.healthCheck.latencyMs}ms）` })
      } else {
        toast.warning('配置已保存，但连接测试失败，请检查地址与凭据')
        setStatus({ tone: 'error', message: `已保存；连接测试失败：${res.healthCheck.error ?? '未知错误'}` })
      }
    } catch (err) {
      setStatus({ tone: 'error', message: `保存失败：${describeError(err)}` })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="settings-section team-registry-section">
      <h2>团队注册中心</h2>
      <p className="lede">
        连接团队内网 Nacos AI 注册中心，把技能发布给团队共享，或从团队源安装、更新。
        凭据仅保存在本机系统钥匙串，不会出现在日志与聊天中。
      </p>

      <div className="team-registry-status">
        {loading ? (
          <span className="team-registry-status__item">正在读取配置…</span>
        ) : snapshot?.configured ? (
          <span className="team-registry-status__item team-registry-status__item--ok">
            ● 已连接就绪（{snapshot.serverUrl} · 命名空间 {snapshot.namespace}）
          </span>
        ) : (
          <span className="team-registry-status__item team-registry-status__item--muted">
            ○ 未配置——填写并保存后，技能商店将出现「团队源」
          </span>
        )}
      </div>

      <div className="team-registry-form">
        <label className="team-registry-field">
          <span className="team-registry-field__label">注册中心地址</span>
          <Input
            value={form.serverUrl}
            onChange={(e) => updateField('serverUrl')(e.target.value)}
            placeholder="http://192.168.163.174:8080"
            autoComplete="off"
          />
        </label>
        <label className="team-registry-field">
          <span className="team-registry-field__label">命名空间</span>
          <Input
            value={form.namespace}
            onChange={(e) => updateField('namespace')(e.target.value)}
            placeholder="public"
            autoComplete="off"
          />
        </label>
        <label className="team-registry-field">
          <span className="team-registry-field__label">账号</span>
          <Input
            value={form.username}
            onChange={(e) => updateField('username')(e.target.value)}
            placeholder="Nacos 控制台账号"
            autoComplete="off"
          />
        </label>
        <label className="team-registry-field">
          <span className="team-registry-field__label">密码</span>
          <InputPassword
            value={form.password}
            onChange={(e) => updateField('password')(e.target.value)}
            placeholder={
              snapshot?.hasPassword ? '已保存（留空保持不变，输入则更新）' : 'Nacos 控制台密码'
            }
            autoComplete="new-password"
          />
        </label>
      </div>

      {status != null && (
        <div className={`team-registry-inline-status team-registry-inline-status--${status.tone}`}>
          {status.message}
        </div>
      )}

      <div className="team-registry-actions">
        <Button size="small" loading={busy === 'test'} onClick={() => void handleTest()}>
          测试连接
        </Button>
        <Button
          size="small"
          type="primary"
          loading={busy === 'save'}
          disabled={!form.serverUrl.trim() || !form.username.trim()}
          onClick={() => void handleSave()}
        >
          保存配置
        </Button>
      </div>

      <div className="team-registry-note">
        说明：发布 / 更新团队资产会在 Nacos 配置中心留下完整历史（group
        SPARK_TEAM）；所有团队写操作都由你在界面上明确触发。
      </div>
    </div>
  )
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
