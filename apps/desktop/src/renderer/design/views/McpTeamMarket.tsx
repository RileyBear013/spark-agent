/**
 * McpTeamMarket — 团队 MCP 推拉 UI（M2）
 *
 * TeamMcpSection：MCP 管理页顶部的团队 MCP 区块——列出团队注册中心共享的
 * MCP（team-registry:list-mcp），一键安装 / 更新（徽标来自 list-mcp-updates）。
 * McpTeamPublishModal：把本地 MCP 发布到团队（team-registry:publish-mcp），
 * 发布前提示将携带的敏感命名变量（只显示键名，不显示值）。
 * 样式在 McpTeamMarket.less（mcp-team- 前缀）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from 'antd'
import { Button, Input, Tag } from '@lobehub/ui'
import { Icons } from '../Icons'
import type {
  McpServerItem,
  TeamRegistryMcpListItemDto,
  TeamRegistryMcpUpdateItemDto,
} from '@spark/protocol'
import { useIpcInvoke } from '../hooks/useIpc'
import { useToast } from '../components/Toast'
import './McpTeamMarket.less'

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

// ─── 团队 MCP 区块 ──────────────────────────────────────────────────────

export function TeamMcpSection({ onInstalled }: { onInstalled: () => void }) {
  const { invoke: getConfig } = useIpcInvoke('team-registry:config-get')
  const { invoke: listMcp } = useIpcInvoke('team-registry:list-mcp')
  const { invoke: installMcp } = useIpcInvoke('team-registry:install-mcp')
  const { invoke: listMcpUpdates } = useIpcInvoke('team-registry:list-mcp-updates')
  const { toast } = useToast()

  const [open, setOpen] = useState(false)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [servers, setServers] = useState<TeamRegistryMcpListItemDto[]>([])
  const [updates, setUpdates] = useState<Record<string, TeamRegistryMcpUpdateItemDto>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [installingSlugs, setInstallingSlugs] = useState<Set<string>>(new Set())
  const reloadToken = useRef(0)

  const reload = useCallback(async () => {
    const token = ++reloadToken.current
    setLoading(true)
    setError('')
    try {
      const configRes = await getConfig({})
      if (token !== reloadToken.current) return
      setConfigured(configRes.snapshot.configured)
      if (!configRes.snapshot.configured) {
        setServers([])
        return
      }
      const [listRes, updatesRes] = await Promise.all([
        listMcp({}),
        listMcpUpdates({}).catch(() => ({ updates: [] as TeamRegistryMcpUpdateItemDto[] })),
      ])
      if (token !== reloadToken.current) return
      setServers(listRes.servers)
      const map: Record<string, TeamRegistryMcpUpdateItemDto> = {}
      for (const item of updatesRes.updates) map[item.slug] = item
      setUpdates(map)
    } catch (err) {
      if (token !== reloadToken.current) return
      setError(describeError(err))
    } finally {
      if (token === reloadToken.current) setLoading(false)
    }
  }, [getConfig, listMcp, listMcpUpdates])

  useEffect(() => {
    void reload()
  }, [reload])

  const handleInstall = async (server: TeamRegistryMcpListItemDto) => {
    setInstallingSlugs((prev) => new Set(prev).add(server.slug))
    try {
      const res = await installMcp({ slug: server.slug })
      toast.success(
        `已安装团队 MCP：${server.slug} v${res.version}${res.requiresRestart ? '（重连或重启后生效）' : ''}`,
      )
      await reload()
      onInstalled()
    } catch (err) {
      toast.error(`安装失败：${describeError(err)}`)
    } finally {
      setInstallingSlugs((prev) => {
        const next = new Set(prev)
        next.delete(server.slug)
        return next
      })
    }
  }

  if (configured === false) {
    return (
      <div className="mcp-team-section mcp-team-section--hint">
        <Icons.Users size={14} />
        <span>
          团队 MCP 未启用——到 <b>设置 → 团队注册中心</b> 配置 Nacos 后可共享与安装团队 MCP。
        </span>
      </div>
    )
  }

  const updateCount = Object.values(updates).filter((u) => u.state === 'remote-newer').length

  return (
    <div className="mcp-team-section">
      <button
        type="button"
        className="mcp-team-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icons.Users size={14} />
        <span className="mcp-team-head-title">团队 MCP</span>
        {updateCount > 0 && (
          <span className="mcp-team-badge mcp-team-badge--update">{updateCount} 可更新</span>
        )}
        <span className="mcp-team-count">
          {loading ? '加载中…' : `${servers.length} 个共享`}
        </span>
        <span className="mcp-team-caret">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="mcp-team-body">
          {error !== '' ? (
            <div className="mcp-team-error">团队 MCP 加载失败：{error}</div>
          ) : servers.length === 0 && !loading ? (
            <div className="mcp-team-empty">
              团队注册中心还没有共享 MCP——在下方卡片点「发布到团队」图标即可共享。
            </div>
          ) : (
            <div className="mcp-team-list">
              {servers.map((server) => {
                const update = updates[server.slug]
                const installed = update?.localServerId != null
                const busy = installingSlugs.has(server.slug)
                return (
                  <div key={server.slug} className="mcp-team-item">
                    <div className="mcp-team-item-info">
                      <div className="mcp-team-item-name">
                        {server.name}
                        {server.version ? (
                          <span className="mcp-team-item-version">v{server.version}</span>
                        ) : null}
                        {update?.state === 'remote-newer' && (
                          <span className="mcp-team-badge mcp-team-badge--update">可更新</span>
                        )}
                        {update?.state === 'remote-missing' && (
                          <span className="mcp-team-badge mcp-team-badge--warn">远端已删除</span>
                        )}
                      </div>
                      {server.description && (
                        <div className="mcp-team-item-desc" title={server.description}>
                          {server.description}
                        </div>
                      )}
                    </div>
                    <div className="mcp-team-item-actions">
                      {busy ? (
                        <span className="mcp-team-item-version">安装中…</span>
                      ) : installed ? (
                        update?.state === 'remote-newer' && (
                          <Button
                            size="small"
                            type="primary"
                            onClick={() => void handleInstall(server)}
                          >
                            更新
                          </Button>
                        )
                      ) : (
                        <Button
                          size="small"
                          type="primary"
                          onClick={() => void handleInstall(server)}
                        >
                          安装
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── 发布到团队弹窗 ─────────────────────────────────────────────────────

interface McpPublishResultView {
  slug: string
  version: string
  sensitiveKeys: string[]
  previousRemoteVersion: string | null
}

export function McpTeamPublishModal({
  open,
  server,
  onClose,
  onPublished,
}: {
  open: boolean
  server: McpServerItem | null
  onClose: () => void
  onPublished: () => void
}) {
  const { invoke: publishMcp } = useIpcInvoke('team-registry:publish-mcp')
  const { toast } = useToast()
  const [version, setVersion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<McpPublishResultView | null>(null)

  useEffect(() => {
    if (open) {
      setVersion('')
      setError('')
      setResult(null)
    }
  }, [open, server?.id])

  const handlePublish = async () => {
    if (!server) return
    setBusy(true)
    setError('')
    try {
      const res = await publishMcp({
        mcpServerId: server.id,
        ...(version.trim() !== '' ? { version: version.trim() } : {}),
      })
      setResult(res)
      toast.success(`已发布到团队：${res.slug} v${res.version}`)
      onPublished()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="发布 MCP 到团队"
      open={open}
      width="min(560px, 92vw)"
      centered
      destroyOnClose
      onCancel={onClose}
      footer={
        result == null ? (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button size="small" onClick={onClose}>
              取消
            </Button>
            <Button size="small" type="primary" loading={busy} onClick={() => void handlePublish()}>
              发布
            </Button>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button size="small" type="primary" onClick={onClose}>
              完成
            </Button>
          </div>
        )
      }
    >
      {server == null ? null : result == null ? (
        <div className="mcp-team-publish-form">
          <p className="mcp-team-publish-hint">
            即将把 <b>{server.name}</b> 发布到团队 Nacos 注册中心（原生 AI MCP 资源）。
            将共享其传输配置（stdio 的 command/args/env，或远程服务的 URL）；
            发布成功后团队成员可在「MCP 管理 → 团队 MCP」一键安装。
          </p>
          <label className="mcp-team-publish-field">
            <span>版本号（留空自动递增 patch 位，首发为 1.0.0）</span>
            <Input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="如 1.0.1（留空自动）"
              autoComplete="off"
            />
          </label>
          {error !== '' && <div className="mcp-team-publish-error">{error}</div>}
        </div>
      ) : (
        <div className="mcp-team-publish-result">
          <div className="mcp-team-publish-row">
            <span>MCP</span>
            <b>
              {result.slug} · v{result.version}
              {result.previousRemoteVersion != null
                ? `（远端原为 v${result.previousRemoteVersion}）`
                : '（首发）'}
            </b>
          </div>
          <div className="mcp-team-publish-row">
            <span>共享范围</span>
            <Tag color="green">团队可见</Tag>
          </div>
          {result.sensitiveKeys.length > 0 ? (
            <div className="mcp-team-publish-warn">
              配置中包含以下敏感命名的变量（仅列键名）：{result.sensitiveKeys.join('、')}
              ——请确认不含不应共享的密钥。
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  )
}
