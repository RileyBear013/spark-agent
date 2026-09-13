/**
 * TeamStorePublish — 团队商店「上传共享」发布面板（M5.1）
 *
 * 商店侧统一的上传入口：从本页把本地工作流 / 应用 / 助手发布到团队 Nacos，
 * 不必再绕道各管理页的卡片菜单。单列本地资产（workflow:list / agent:list /
 * sub-app:list），按「同名同类」标注已在团队的内容；V2 多文件应用与已归档
 * 应用禁发并说明原因。发布动作复用 team-registry:publish-asset 通道，
 * 成功后行内展示新版本号与非阻断 warning（捆绑说明等），并联动商店刷新。
 *
 * 纯 UI 层，不新增 IPC；消费语义与各管理页 TeamAssetPublishModal 一致。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Drawer } from 'antd'
import { Button, Empty, Input, Tag } from '@lobehub/ui'
import type { SubAppSummary } from '@spark/protocol'
import { Icons } from '../Icons'
import { useIpcInvoke } from '../hooks/useIpc'
import { useToast } from '../components/Toast'
import { subAppClient } from '../sub-app/subAppClient'
import './TeamStoreView.less'

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

// ─── 本地资产行模型 ─────────────────────────────────────────────────────

type PublishKind = 'workflow' | 'app' | 'agent'

const PUBLISH_KINDS: ReadonlyArray<{
  kind: PublishKind
  label: string
}> = [
  { kind: 'workflow', label: '工作流' },
  { kind: 'app', label: '应用' },
  { kind: 'agent', label: '助手' },
]

interface LocalAssetRow {
  id: string
  name: string
  description: string
  updatedAt: string
  /** 非空 = 该行不可发布，值为原因（V2 多文件 / 已归档） */
  disabledReason: string
}

interface PublishRowResult {
  name: string
  version: string
  previousRemoteVersion: string | null
  warnings: string[]
}

/** 商店已加载的远端卡片摘要——用于「已在团队」标记 */
export interface RemoteCardSummary {
  kind: PublishKind
  name: string
  version: string
}

// ─── 面板组件 ──────────────────────────────────────────────────────────

export function TeamStorePublish({
  open,
  remoteCards,
  onClose,
  onPublished,
}: {
  open: boolean
  remoteCards: RemoteCardSummary[]
  onClose: () => void
  /** 任一资产发布成功后联动商店刷新 */
  onPublished: () => void
}) {
  const { invoke: listWorkflows } = useIpcInvoke('workflow:list')
  const { invoke: listAgents } = useIpcInvoke('agent:list')
  const { invoke: publishAsset } = useIpcInvoke('team-registry:publish-asset')
  const { toast } = useToast()

  const [kind, setKind] = useState<PublishKind>('workflow')
  const [rows, setRows] = useState<LocalAssetRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [publishingIds, setPublishingIds] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<Record<string, PublishRowResult>>({})
  const reloadToken = useRef(0)

  // 打开面板时重置状态（保留 kind，减少重复选择成本）
  useEffect(() => {
    if (open) {
      setQuery('')
      setResults({})
      setError('')
    }
  }, [open])

  const loadRows = useCallback(async () => {
    const token = ++reloadToken.current
    setLoading(true)
    setError('')
    try {
      let next: LocalAssetRow[]
      if (kind === 'workflow') {
        const res = await listWorkflows({})
        if (token !== reloadToken.current) return
        next = res.workflows.map((w) => ({
          id: w.id,
          name: w.name,
          description: w.description ?? '',
          updatedAt: w.updatedAt ?? '',
          disabledReason: '',
        }))
      } else if (kind === 'agent') {
        const res = await listAgents({ includeDisabled: true })
        if (token !== reloadToken.current) return
        next = res.agents.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description ?? '',
          updatedAt: a.updatedAt ?? '',
          disabledReason: '',
        }))
      } else {
        const res = await subAppClient.list()
        if (token !== reloadToken.current) return
        next = res.items.map((app: SubAppSummary) => ({
          id: app.id,
          name: app.name,
          description: app.description ?? '',
          updatedAt: app.updatedAt ?? '',
          disabledReason:
            app.format === 'v2'
              ? 'V2 多文件应用暂不支持发布到团队'
              : app.publicationStatus === 'archived'
                ? '已归档应用不支持发布'
                : '',
        }))
      }
      setRows(next)
    } catch (err) {
      if (token !== reloadToken.current) return
      setError(describeError(err))
      setRows([])
    } finally {
      if (token === reloadToken.current) setLoading(false)
    }
  }, [kind, listAgents, listWorkflows])

  useEffect(() => {
    if (!open) return
    void loadRows()
  }, [open, loadRows])

  const handlePublish = async (row: LocalAssetRow) => {
    if (publishingIds.has(row.id)) return
    setPublishingIds((prev) => new Set(prev).add(row.id))
    try {
      const res = await publishAsset({ assetType: kind, localId: row.id })
      setResults((prev) => ({
        ...prev,
        [row.id]: {
          name: res.name,
          version: res.version,
          previousRemoteVersion: res.previousRemoteVersion,
          warnings: res.warnings,
        },
      }))
      toast.success(`已发布到团队：${res.name} v${res.version}`)
      onPublished()
    } catch (err) {
      toast.error(`发布失败：${describeError(err)}`)
    } finally {
      setPublishingIds((prev) => {
        const next = new Set(prev)
        next.delete(row.id)
        return next
      })
    }
  }

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return rows
    return rows.filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(q))
  }, [rows, query])

  /** 该行是否已在团队（同名同类视为已共享；slug 由名称确定派生，同名即同 slug） */
  const publishedVersionOf = useCallback(
    (row: LocalAssetRow): string | null => {
      const hit = remoteCards.find((c) => c.kind === kind && c.name === row.name)
      return hit?.version ?? null
    },
    [remoteCards, kind],
  )

  const kindLabel = PUBLISH_KINDS.find((k) => k.kind === kind)?.label ?? ''

  return (
    <Drawer
      title={
        <span className="team-store-pub-title">
          <Icons.Upload size={15} />
          上传共享到团队
        </span>
      }
      open={open}
      width="min(560px, 94vw)"
      destroyOnClose
      onClose={onClose}
    >
      <div className="team-store-pub">
        <p className="team-store-pub-hint">
          发布会把本地{kindLabel}连同伴依赖（技能、MCP、被引用的助手）打包为自包含内容，
          团队成员在商店一键安装即可运行；版本号由注册中心自动分配。
        </p>

        <div className="team-store-pub-tabs" role="tablist" aria-label="选择资产类型">
          {PUBLISH_KINDS.map(({ kind: k, label }) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              className={`team-store-pub-tab${kind === k ? ' is-active' : ''}`}
              onClick={() => setKind(k)}
            >
              {label}
            </button>
          ))}
        </div>

        <Input
          className="team-store-pub-search"
          placeholder={`搜索本地${kindLabel}…`}
          value={query}
          allowClear
          onChange={(e) => setQuery(e.target.value)}
        />

        {error !== '' ? (
          <div className="team-store-error">
            {error}
            <Button size="small" onClick={() => void loadRows()}>
              重试
            </Button>
          </div>
        ) : loading ? (
          <div className="team-store-loading">
            <Icons.Spinner size={16} />
            正在读取本地{kindLabel}…
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="team-store-pub-empty">
            <Empty
              description={
                rows.length === 0
                  ? `本机还没有${kindLabel}——先到对应管理页创建`
                  : '没有符合搜索条件的本地资产'
              }
            />
          </div>
        ) : (
          <div className="team-store-pub-list">
            {filteredRows.map((row) => {
              const busy = publishingIds.has(row.id)
              const result = results[row.id]
              const sharedVersion = publishedVersionOf(row)
              const disabled = row.disabledReason !== ''
              return (
                <div
                  key={row.id}
                  className={`team-store-pub-row${disabled ? ' is-disabled' : ''}`}
                >
                  <div className="team-store-pub-row-info">
                    <div className="team-store-pub-row-name">
                      <span className="team-store-pub-row-title" title={row.name}>
                        {row.name}
                      </span>
                      {sharedVersion != null && (
                        <Tag color="green">已在团队 v{sharedVersion}</Tag>
                      )}
                    </div>
                    {row.description !== '' && (
                      <div className="team-store-pub-row-desc" title={row.description}>
                        {row.description}
                      </div>
                    )}
                    {disabled && (
                      <div className="team-store-pub-row-warn">{row.disabledReason}</div>
                    )}
                    {result != null && (
                      <div className="team-store-pub-result">
                        已发布 <b>v{result.version}</b>
                        {result.previousRemoteVersion != null
                          ? `（远端原为 v${result.previousRemoteVersion}）`
                          : '（首发）'}
                        {result.warnings.map((warning) => (
                          <div key={warning} className="team-store-pub-warn">
                            {warning}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="team-store-pub-row-actions">
                    {busy ? (
                      <span className="tsc-busy">发布中…</span>
                    ) : disabled ? null : (
                      <Button
                        size="small"
                        type={result != null ? 'default' : 'primary'}
                        onClick={() => void handlePublish(row)}
                      >
                        {result != null ? '再发一版' : '发布'}
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Drawer>
  )
}
