/**
 * TeamAssetMarket — 信封型团队资产（工作流/平台 Agent/子应用）推拉 UI（M3/M4）
 *
 * TeamAssetSection：各管理页顶部的团队资产区块——浏览团队共享资产
 * （team-registry:list-assets）、一键安装/更新（徽标来自 list-asset-updates）。
 * TeamAssetPublishModal：把本地资产发布到团队（team-registry:publish-asset），
 * 发布成功后展示非阻断 warning（如「引用是机器本地 id」）。
 * 与 McpTeamMarket 同构（mcp-team- 样式类复用同一套视觉）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from 'antd'
import { Button, Tag } from '@lobehub/ui'
import { Icons } from '../Icons'
import type {
  TeamRegistryAssetListItemDto,
  TeamRegistryAssetTypeDto,
  TeamRegistryAssetUpdateItemDto,
  TeamRegistryVersionItemDto,
} from '@spark/protocol'
import { useIpcInvoke } from '../hooks/useIpc'
import { useToast } from '../components/Toast'
import './McpTeamMarket.less'

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

const ASSET_TYPE_LABEL: Record<TeamRegistryAssetTypeDto, string> = {
  workflow: '工作流',
  agent: 'Agent',
  app: '应用',
}

// ─── 团队资产区块 ───────────────────────────────────────────────────────

export function TeamAssetSection({
  assetType,
  onInstalled,
}: {
  assetType: TeamRegistryAssetTypeDto
  onInstalled?: () => void
}) {
  const { invoke: getConfig } = useIpcInvoke('team-registry:config-get')
  const { invoke: listAssets } = useIpcInvoke('team-registry:list-assets')
  const { invoke: installAsset } = useIpcInvoke('team-registry:install-asset')
  const { invoke: listUpdates } = useIpcInvoke('team-registry:list-asset-updates')
  const { invoke: listVersions } = useIpcInvoke('team-registry:list-asset-versions')
  const { toast } = useToast()

  const [open, setOpen] = useState(false)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [items, setItems] = useState<TeamRegistryAssetListItemDto[]>([])
  const [updates, setUpdates] = useState<Record<string, TeamRegistryAssetUpdateItemDto>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [installingSlugs, setInstallingSlugs] = useState<Set<string>>(new Set())
  const [versionsFor, setVersionsFor] = useState<TeamRegistryAssetListItemDto | null>(null)
  const reloadToken = useRef(0)

  const label = ASSET_TYPE_LABEL[assetType]

  const reload = useCallback(async () => {
    const token = ++reloadToken.current
    setLoading(true)
    setError('')
    try {
      const configRes = await getConfig({})
      if (token !== reloadToken.current) return
      setConfigured(configRes.snapshot.configured)
      if (!configRes.snapshot.configured) {
        setItems([])
        return
      }
      const [listRes, updatesRes] = await Promise.all([
        listAssets({ assetType }),
        listUpdates({ assetType }).catch(() => ({
          updates: [] as TeamRegistryAssetUpdateItemDto[],
        })),
      ])
      if (token !== reloadToken.current) return
      setItems(listRes.items)
      const map: Record<string, TeamRegistryAssetUpdateItemDto> = {}
      for (const item of updatesRes.updates) map[item.slug] = item
      setUpdates(map)
    } catch (err) {
      if (token !== reloadToken.current) return
      setError(describeError(err))
    } finally {
      if (token === reloadToken.current) setLoading(false)
    }
  }, [assetType, getConfig, listAssets, listUpdates])

  useEffect(() => {
    void reload()
  }, [reload])

  const handleInstall = async (item: TeamRegistryAssetListItemDto, version?: string) => {
    setInstallingSlugs((prev) => new Set(prev).add(item.slug))
    try {
      const res = await installAsset({
        assetType,
        slug: item.slug,
        ...(version != null && version !== '' ? { version } : {}),
      })
      toast.success(
        `已安装团队${label}：${res.name} v${res.version}${
          res.updatedExisting ? '（已更新本地版本）' : ''
        }`,
      )
      await reload()
      onInstalled?.()
    } catch (err) {
      toast.error(`安装失败：${describeError(err)}`)
    } finally {
      setInstallingSlugs((prev) => {
        const next = new Set(prev)
        next.delete(item.slug)
        return next
      })
    }
  }

  if (configured === false) {
    return (
      <div className="mcp-team-section mcp-team-section--hint">
        <Icons.Users size={14} />
        <span>
          团队{label}未启用——到 <b>设置 → 团队注册中心</b> 配置 Nacos 后可共享与安装团队
          {label}。
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
        <span className="mcp-team-head-title">团队{label}</span>
        {updateCount > 0 && (
          <span className="mcp-team-badge mcp-team-badge--update">{updateCount} 可更新</span>
        )}
        <span className="mcp-team-count">
          {loading ? '加载中…' : `${items.length} 个共享`}
        </span>
        <span className="mcp-team-caret">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="mcp-team-body">
          {error !== '' ? (
            <div className="mcp-team-error">团队{label}加载失败：{error}</div>
          ) : items.length === 0 && !loading ? (
            <div className="mcp-team-empty">
              团队注册中心还没有共享{label}——发布后团队成员可在此一键安装。
            </div>
          ) : (
            <div className="mcp-team-list">
              {items.map((item) => {
                const update = updates[item.slug]
                const installed = update?.localId != null
                const busy = installingSlugs.has(item.slug)
                return (
                  <div key={item.slug} className="mcp-team-item">
                    <div className="mcp-team-item-info">
                      <div className="mcp-team-item-name">
                        {item.name}
                        {item.version ? (
                          <span className="mcp-team-item-version">v{item.version}</span>
                        ) : null}
                        {update?.state === 'remote-newer' && (
                          <span className="mcp-team-badge mcp-team-badge--update">可更新</span>
                        )}
                        {update?.state === 'local-modified' && (
                          <span className="mcp-team-badge mcp-team-badge--warn">本地已修改</span>
                        )}
                        {update?.state === 'remote-missing' && (
                          <span className="mcp-team-badge mcp-team-badge--warn">远端已删除</span>
                        )}
                        {item.author && (
                          <span className="mcp-team-item-version">by {item.author}</span>
                        )}
                      </div>
                      {item.description && (
                        <div className="mcp-team-item-desc" title={item.description}>
                          {item.description}
                        </div>
                      )}
                    </div>
                    <div className="mcp-team-item-actions">
                      <Button size="small" type="text" onClick={() => setVersionsFor(item)}>
                        版本
                      </Button>
                      {busy ? (
                        <span className="mcp-team-item-version">安装中…</span>
                      ) : installed ? (
                        update?.state === 'remote-newer' && (
                          <Button
                            size="small"
                            type="primary"
                            onClick={() => void handleInstall(item)}
                          >
                            更新
                          </Button>
                        )
                      ) : (
                        <Button
                          size="small"
                          type="primary"
                          onClick={() => void handleInstall(item)}
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

      <TeamVersionsModal
        open={versionsFor != null}
        title={`团队${label}版本 · ${versionsFor?.name ?? ''}`}
        currentVersion={versionsFor ? (updates[versionsFor.slug]?.localVersion ?? null) : null}
        fetchVersions={async () => {
          if (!versionsFor) return []
          const res = await listVersions({ assetType, slug: versionsFor.slug })
          return res.versions
        }}
        onInstall={async (v) => {
          if (!versionsFor) return
          await handleInstall(versionsFor, v)
        }}
        onClose={() => setVersionsFor(null)}
        onInstalled={async () => {
          await reload()
          onInstalled?.()
        }}
      />
    </div>
  )
}

// ─── 发布到团队弹窗 ─────────────────────────────────────────────────────

interface AssetPublishResultView {
  slug: string
  name: string
  version: string
  previousRemoteVersion: string | null
  warnings: string[]
}

export function TeamAssetPublishModal({
  open,
  assetType,
  localId,
  localName,
  hint,
  onClose,
  onPublished,
}: {
  open: boolean
  assetType: TeamRegistryAssetTypeDto
  /** 本地实体 id；null = 关闭态 */
  localId: string | null
  localName: string
  /** 弹窗内补充说明（如 V1/V2 限制） */
  hint?: string | undefined
  onClose: () => void
  onPublished: () => void
}) {
  const { invoke: publishAsset } = useIpcInvoke('team-registry:publish-asset')
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<AssetPublishResultView | null>(null)

  const label = ASSET_TYPE_LABEL[assetType]

  useEffect(() => {
    if (open) {
      setError('')
      setResult(null)
    }
  }, [open, localId])

  const handlePublish = async () => {
    if (localId == null) return
    setBusy(true)
    setError('')
    try {
      const res = await publishAsset({ assetType, localId })
      setResult(res)
      toast.success(`已发布到团队：${res.name} v${res.version}`)
      onPublished()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`发布${label}到团队`}
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
      {localId == null ? null : result == null ? (
        <div className="mcp-team-publish-form">
          <p className="mcp-team-publish-hint">
            即将把 <b>{localName}</b> 发布到团队 Nacos 注册中心，团队成员可在对应管理页的
            「团队{label}」区块一键安装或更新。
            {hint != null && hint !== '' ? <br /> : null}
            {hint}
          </p>
          <p className="mcp-team-publish-hint">
            版本号由注册中心自动分配（0.0.N 单调递增）；发布后团队成员可在「版本」列表安装任意历史版本。
          </p>
          {error !== '' && <div className="mcp-team-publish-error">{error}</div>}
        </div>
      ) : (
        <div className="mcp-team-publish-result">
          <div className="mcp-team-publish-row">
            <span>{label}</span>
            <b>
              {result.name} · v{result.version}
              {result.previousRemoteVersion != null
                ? `（远端原为 v${result.previousRemoteVersion}）`
                : '（首发）'}
            </b>
          </div>
          <div className="mcp-team-publish-row">
            <span>共享范围</span>
            <Tag color="green">团队可见</Tag>
          </div>
          {result.warnings.map((warning) => (
            <div key={warning} className="mcp-team-publish-warn">
              {warning}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}


// ─── 团队资产版本列表弹窗（安装历史版本 / 回滚；各团队区块共用） ─────────

export function TeamVersionsModal({
  open,
  title,
  currentVersion,
  fetchVersions,
  onInstall,
  onClose,
  onInstalled,
}: {
  open: boolean
  title: string
  /** 本地当前安装版本（null = 未安装）；与行版本相同则该行禁用并标注当前版本 */
  currentVersion: string | null
  fetchVersions: () => Promise<TeamRegistryVersionItemDto[]>
  onInstall: (version: string) => Promise<void>
  onClose: () => void
  /** 安装成功后的父组件联动刷新 */
  onInstalled?: () => void
}) {
  const { toast } = useToast()
  const [versions, setVersions] = useState<TeamRegistryVersionItemDto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busyVersion, setBusyVersion] = useState<string | null>(null)
  const reloadToken = useRef(0)

  useEffect(() => {
    if (!open) return
    const token = ++reloadToken.current
    setLoading(true)
    setError('')
    setVersions([])
    fetchVersions()
      .then((rows) => {
        if (token === reloadToken.current) setVersions(rows)
      })
      .catch((err) => {
        if (token === reloadToken.current) setError(describeError(err))
      })
      .finally(() => {
        if (token === reloadToken.current) setLoading(false)
      })
    // fetchVersions 随选中资产变化，重置效应只依赖 open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleInstall = async (version: string) => {
    setBusyVersion(version)
    try {
      await onInstall(version)
      toast.success(`已安装版本 v${version}`)
      onInstalled?.()
      onClose()
    } catch (err) {
      toast.error(`安装 v${version} 失败：${describeError(err)}`)
    } finally {
      setBusyVersion(null)
    }
  }

  return (
    <Modal
      title={title}
      open={open}
      width="min(520px, 92vw)"
      centered
      destroyOnClose
      onCancel={onClose}
      footer={null}
    >
      {loading ? (
        <div className="mcp-team-empty">加载版本列表…</div>
      ) : error !== '' ? (
        <div className="mcp-team-error">版本列表加载失败：{error}</div>
      ) : versions.length === 0 ? (
        <div className="mcp-team-empty">该资产还没有已发布版本。</div>
      ) : (
        <div className="mcp-team-list">
          {versions.map((row) => {
            const isCurrent = currentVersion != null && currentVersion === row.version
            const busy = busyVersion === row.version
            return (
              <div key={row.version} className="mcp-team-item">
                <div className="mcp-team-item-info">
                  <div className="mcp-team-item-name">
                    v{row.version}
                    <span className="mcp-team-item-version">
                      {/online/i.test(row.status) ? '已上线' : '已发布'}
                    </span>
                    {isCurrent && <span className="mcp-team-item-version">当前版本</span>}
                    {row.author && <span className="mcp-team-item-version">by {row.author}</span>}
                  </div>
                </div>
                <div className="mcp-team-item-actions">
                  {busy ? (
                    <span className="mcp-team-item-version">安装中…</span>
                  ) : (
                    <Button
                      size="small"
                      type={isCurrent ? 'default' : 'primary'}
                      disabled={isCurrent}
                      onClick={() => void handleInstall(row.version)}
                    >
                      {isCurrent ? '当前版本' : '安装此版本'}
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
