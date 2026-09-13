/**
 * TeamStoreView — 团队商店（M5）
 *
 * 五类团队资产（应用/工作流/助手/技能/MCP）的聚合商店页：
 * 搜索 / 分类页签（带计数）/ 状态筛选 / 排序 / 卡片网格 / 详情抽屉
 * （完整元数据 + 版本历史逐版本安装与回滚）/ 可更新横幅与一键全部更新。
 *
 * 纯 UI 层——全部消费既有 IPC 通道（team-registry:* 与 skill-registry:search），
 * 六态徽标语义与各管理页团队区块一致；发布动作仍保留在各管理页（创作者上下文），
 * 本页专注消费侧。侧栏角标由 useTeamStoreUpdatableCount 提供。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Drawer } from 'antd'
import { Button, Empty, Input, Tag } from '@lobehub/ui'
import type {
  TeamRegistryAssetListItemDto,
  TeamRegistryAssetUpdateItemDto,
  TeamRegistryMcpListItemDto,
  TeamRegistryMcpUpdateItemDto,
  TeamRegistryUpdateItemDto,
  TeamRegistryVersionItemDto,
} from '@spark/protocol'
import { Icons } from '../Icons'
import { useIpcInvoke } from '../hooks/useIpc'
import { useApp } from '../AppContext'
import { useToast } from '../components/Toast'
import { TeamVersionsModal } from './TeamAssetMarket'
import './TeamStoreView.less'

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

// ─── 商店卡片统一模型 ───────────────────────────────────────────────────

type StoreKind = 'app' | 'workflow' | 'agent' | 'skill' | 'mcp'

const KIND_META: Record<StoreKind, { label: string; tagColor: string }> = {
  app: { label: '应用', tagColor: 'blue' },
  workflow: { label: '工作流', tagColor: 'purple' },
  agent: { label: '助手', tagColor: 'green' },
  skill: { label: '技能', tagColor: 'orange' },
  mcp: { label: 'MCP', tagColor: 'cyan' },
}


interface StoreCard {
  kind: StoreKind
  slug: string
  name: string
  description: string
  version: string
  author: string
  /** ISO 时间；技能/MCP 列表通道不提供时为空串 */
  updatedAt: string
  /** 六态字符串，语义与 list-*-updates 通道一致 */
  state: string
  localId: string | null
  localVersion: string | null
  /** MCP 专属：传输协议（stdio/http/sse） */
  protocol: string
  /** 技能专属：团队下载量 */
  downloadCount: number
}

/** 需要用户注意的异常态（正常态为 not-installed / up-to-date / remote-newer） */
const ATTENTION_STATES = new Set([
  'local-modified',
  'remote-missing',
  'version-equal-content-differs',
  'local-newer',
])

function stateBadge(state: string): { text: string; cls: string } | null {
  if (state === 'remote-newer') return { text: '可更新', cls: 'ts-badge--update' }
  if (state === 'local-modified') return { text: '本地已修改', cls: 'ts-badge--warn' }
  if (state === 'remote-missing') return { text: '远端已删除', cls: 'ts-badge--warn' }
  if (state === 'version-equal-content-differs') return { text: '内容有差异', cls: 'ts-badge--warn' }
  if (state === 'local-newer') return { text: '本地更新', cls: 'ts-badge--warn' }
  return null
}

function relativeTime(iso: string): string {
  if (iso === '') return ''
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return ''
  const diff = Date.now() - ts
  if (diff <= 0) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type Category = 'all' | StoreKind
type StatusFilter = 'all' | 'updatable' | 'not-installed' | 'installed' | 'attention'

function matchStatus(card: StoreCard, filter: StatusFilter): boolean {
  switch (filter) {
    case 'updatable':
      return card.state === 'remote-newer'
    case 'not-installed':
      return card.localId == null
    case 'installed':
      return card.localId != null
    case 'attention':
      return ATTENTION_STATES.has(card.state)
    default:
      return true
  }
}

// ─── 页面组件 ──────────────────────────────────────────────────────────

export function TeamStoreView() {
  const { invoke: getConfig } = useIpcInvoke('team-registry:config-get')
  const { invoke: listAssets } = useIpcInvoke('team-registry:list-assets')
  const { invoke: listAssetUpdates } = useIpcInvoke('team-registry:list-asset-updates')
  const { invoke: installAsset } = useIpcInvoke('team-registry:install-asset')
  const { invoke: listAssetVersions } = useIpcInvoke('team-registry:list-asset-versions')
  const { invoke: searchSkills } = useIpcInvoke('skill-registry:search')
  const { invoke: installSkill } = useIpcInvoke('team-registry:install-skill')
  const { invoke: listSkillUpdates } = useIpcInvoke('team-registry:list-updates')
  const { invoke: listSkillVersions } = useIpcInvoke('team-registry:list-skill-versions')
  const { invoke: listMcp } = useIpcInvoke('team-registry:list-mcp')
  const { invoke: installMcp } = useIpcInvoke('team-registry:install-mcp')
  const { invoke: listMcpUpdates } = useIpcInvoke('team-registry:list-mcp-updates')
  const { invoke: listMcpVersions } = useIpcInvoke('team-registry:list-mcp-versions')
  const { setTweak } = useApp()
  const { toast } = useToast()

  const [configured, setConfigured] = useState<boolean | null>(null)
  const [cards, setCards] = useState<StoreCard[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [partialError, setPartialError] = useState('')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [category, setCategory] = useState<Category>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<'recent' | 'name'>('recent')
  const [installingSlugs, setInstallingSlugs] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [detail, setDetail] = useState<StoreCard | null>(null)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const reloadToken = useRef(0)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  // reload 期间在闭包间传递各 updates 映射（避免一长串 state）
  const skillUpdatesRef = useRef<Record<string, TeamRegistryUpdateItemDto>>({})

  const toUpdMap = useCallback(
    <T extends { slug: string }>(r: PromiseSettledResult<{ updates: T[] }>): Record<string, T> => {
      const map: Record<string, T> = {}
      if (r.status === 'fulfilled') {
        for (const u of r.value.updates) map[u.slug] = u
      }
      return map
    },
    [],
  )

  const reload = useCallback(async () => {
    const token = ++reloadToken.current
    setLoading(true)
    setError('')
    setPartialError('')
    try {
      const configRes = await getConfig({})
      if (token !== reloadToken.current) return
      setConfigured(configRes.snapshot.configured)
      if (!configRes.snapshot.configured) {
        setCards([])
        return
      }
      const results = await Promise.allSettled([
        listAssets({ assetType: 'workflow' }),
        listAssets({ assetType: 'agent' }),
        listAssets({ assetType: 'app' }),
        searchSkills({ query: '', registryId: 'team', limit: 100 }),
        listMcp({}),
        listAssetUpdates({ assetType: 'workflow' }),
        listAssetUpdates({ assetType: 'agent' }),
        listAssetUpdates({ assetType: 'app' }),
        listSkillUpdates({}),
        listMcpUpdates({}),
      ])
      if (token !== reloadToken.current) return
      const [wfR, agR, apR, skR, mcR, uwfR, uagR, uapR, uskR, umcR] = results

      const wfUpd = toUpdMap(uwfR)
      const agUpd = toUpdMap(uagR)
      const apUpd = toUpdMap(uapR)
      const skUpd = toUpdMap(uskR)
      const mcUpd = toUpdMap(umcR)
      skillUpdatesRef.current = skUpd

      const envelopeCards = (
        kind: StoreKind,
        r: PromiseSettledResult<{ items: TeamRegistryAssetListItemDto[] }>,
        upd: Record<string, TeamRegistryAssetUpdateItemDto>,
      ): StoreCard[] =>
        r.status === 'fulfilled'
          ? r.value.items.map((it): StoreCard => {
              const u = upd[it.slug]
              return {
                kind,
                slug: it.slug,
                name: it.name,
                description: it.description ?? '',
                version: it.version,
                author: it.author ?? '',
                updatedAt: it.updatedAt ?? '',
                state: u?.state ?? 'not-installed',
                localId: u?.localId ?? null,
                localVersion: u?.localVersion ?? null,
                protocol: '',
                downloadCount: 0,
              }
            })
          : []

      const mcpCards: StoreCard[] =
        mcR.status === 'fulfilled'
          ? mcR.value.servers.map((m): StoreCard => {
              const u = mcUpd[m.slug]
              return {
                kind: 'mcp',
                slug: m.slug,
                name: m.name,
                description: m.description ?? '',
                version: m.version,
                author: '',
                updatedAt: '',
                state: u?.state ?? 'not-installed',
                localId: u?.localServerId ?? null,
                localVersion: u?.localVersion ?? null,
                protocol: m.protocol ?? '',
                downloadCount: 0,
              }
            })
          : []

      const skillCards: StoreCard[] =
        skR.status === 'fulfilled'
          ? skR.value.skills
              .filter((s) => s.id.startsWith('team:'))
              .map((s): StoreCard => {
                const slug = s.id.slice('team:'.length)
                const u = skUpd[slug]
                const localId = s.localId ?? u?.localSkillId ?? null
                return {
                  kind: 'skill',
                  slug,
                  name: s.name,
                  description: s.description ?? '',
                  version: s.version ?? '',
                  author: s.author ?? '',
                  updatedAt: u?.remoteUpdatedAt ?? '',
                  state: u?.state ?? (localId != null ? 'up-to-date' : 'not-installed'),
                  localId,
                  localVersion: u?.localVersion ?? null,
                  protocol: '',
                  downloadCount: s.downloadCount ?? 0,
                }
              })
          : []

      const failedLabels: string[] = []
      if (apR.status === 'rejected') failedLabels.push(KIND_META.app.label)
      if (wfR.status === 'rejected') failedLabels.push(KIND_META.workflow.label)
      if (agR.status === 'rejected') failedLabels.push(KIND_META.agent.label)
      if (skR.status === 'rejected') failedLabels.push(KIND_META.skill.label)
      if (mcR.status === 'rejected') failedLabels.push(KIND_META.mcp.label)

      if (failedLabels.length === 5) {
        setError('团队注册中心连接失败，请检查网络与配置')
        setCards([])
        return
      }
      setCards([
        ...envelopeCards('app', apR, apUpd),
        ...envelopeCards('workflow', wfR, wfUpd),
        ...envelopeCards('agent', agR, agUpd),
        ...skillCards,
        ...mcpCards,
      ])
      setPartialError(
        failedLabels.length > 0 ? `以下分类加载失败，其余分类正常：${failedLabels.join('、')}` : '',
      )
    } catch (err) {
      if (token !== reloadToken.current) return
      setError(describeError(err))
    } finally {
      if (token === reloadToken.current) setLoading(false)
    }
  }, [getConfig, listAssets, listAssetUpdates, listMcp, listMcpUpdates, listSkillUpdates, searchSkills, toUpdMap])

  useEffect(() => {
    void reload()
  }, [reload])

  // ── 安装核心（不含 toast，供单项与批量共用） ──
  const doInstall = useCallback(
    async (card: StoreCard, version?: string) => {
      if (card.kind === 'skill') {
        await installSkill({ slug: card.slug, ...(version != null && version !== '' ? { version } : {}) })
      } else if (card.kind === 'mcp') {
        await installMcp({ slug: card.slug, ...(version != null && version !== '' ? { version } : {}) })
      } else {
        await installAsset({
          assetType: card.kind,
          slug: card.slug,
          ...(version != null && version !== '' ? { version } : {}),
        })
      }
    },
    [installAsset, installMcp, installSkill],
  )

  const handleInstall = async (card: StoreCard, version?: string) => {
    setInstallingSlugs((prev) => new Set(prev).add(card.slug))
    try {
      await doInstall(card, version)
      toast.success(`已安装：${card.name}${version != null && version !== '' ? ` v${version}` : ''}`)
      await reload()
    } catch (err) {
      toast.error(`安装失败：${describeError(err)}`)
    } finally {
      setInstallingSlugs((prev) => {
        const next = new Set(prev)
        next.delete(card.slug)
        return next
      })
    }
  }

  const updatableCards = useMemo(
    () => cards.filter((c) => c.state === 'remote-newer'),
    [cards],
  )

  const handleUpdateAll = async () => {
    if (updatableCards.length === 0 || bulkBusy) return
    setBulkBusy(true)
    let ok = 0
    let fail = 0
    try {
      for (const card of updatableCards) {
        try {
          await doInstall(card)
          ok += 1
        } catch {
          fail += 1
        }
      }
      if (fail === 0) {
        toast.success(`已全部更新（${ok} 个）`)
      } else {
        toast.warning(`更新完成：${ok} 个成功，${fail} 个失败`)
      }
      await reload()
    } finally {
      setBulkBusy(false)
    }
  }

  // ── 派生视图 ──
  const kindCounts = useMemo(() => {
    const counts: Record<Category, number> = { all: cards.length, app: 0, workflow: 0, agent: 0, skill: 0, mcp: 0 }
    for (const c of cards) counts[c.kind] += 1
    return counts
  }, [cards])

  const statusCounts = useMemo(
    () => ({
      updatable: cards.filter((c) => c.state === 'remote-newer').length,
      notInstalled: cards.filter((c) => c.localId == null).length,
      attention: cards.filter((c) => ATTENTION_STATES.has(c.state)).length,
    }),
    [cards],
  )

  const filtered = useMemo(() => {
    const q = debouncedQuery.toLowerCase()
    let rows = cards
    if (category !== 'all') rows = rows.filter((c) => c.kind === category)
    if (statusFilter !== 'all') rows = rows.filter((c) => matchStatus(c, statusFilter))
    if (q !== '') {
      rows = rows.filter((c) => `${c.name} ${c.description} ${c.author}`.toLowerCase().includes(q))
    }
    const byRecent = (a: StoreCard, b: StoreCard): number => {
      const ta = a.updatedAt === '' ? 0 : Date.parse(a.updatedAt)
      const tb = b.updatedAt === '' ? 0 : Date.parse(b.updatedAt)
      if (ta !== tb) return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta)
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    }
    const byName = (a: StoreCard, b: StoreCard): number => a.name.localeCompare(b.name, 'zh-Hans-CN')
    return [...rows].sort(sort === 'recent' ? byRecent : byName)
  }, [cards, category, statusFilter, debouncedQuery, sort])

  const fetchVersions = useCallback(
    async (card: StoreCard): Promise<TeamRegistryVersionItemDto[]> => {
      if (card.kind === 'skill') {
        return (await listSkillVersions({ slug: card.slug })).versions
      }
      if (card.kind === 'mcp') {
        return (await listMcpVersions({ slug: card.slug })).versions
      }
      return (await listAssetVersions({ assetType: card.kind, slug: card.slug })).versions
    },
    [listAssetVersions, listMcpVersions, listSkillVersions],
  )

  const detailUpdateBusy = detail != null && installingSlugs.has(detail.slug)
  const detailBadge = detail != null ? stateBadge(detail.state) : null
  const detailInstalled = detail != null && detail.localId != null

  return (
    <div className="team-store-page">
      <header className="team-store-header">
        <div className="team-store-header-text">
          <h2>
            <Icons.Package size={18} />
            团队商店
          </h2>
          <p>团队共享的应用、工作流、助手、技能与 MCP —— 一键安装、版本可选、开箱即运行。</p>
        </div>
        <div className="team-store-header-actions">
          <Button size="small" onClick={() => void reload()} loading={loading}>
            刷新
          </Button>
        </div>
      </header>

      {configured === false ? (
        <div className="team-store-unconfigured">
          <Empty description="团队商店未启用——先到「设置 → 团队注册中心」配置团队 Nacos">
            <Button type="primary" onClick={() => setTweak('view', 'settings')}>
              去配置
            </Button>
          </Empty>
        </div>
      ) : (
        <>
          {updatableCards.length > 0 && (
            <div className="team-store-update-banner" role="status">
              <Icons.Rocket size={14} />
              <span>
                <b>{updatableCards.length}</b> 个资产有新版本
              </span>
              <Button size="small" type="primary" loading={bulkBusy} onClick={() => void handleUpdateAll()}>
                一键全部更新
              </Button>
            </div>
          )}
          {partialError !== '' && <div className="team-store-warn-line">{partialError}</div>}

          <div className="team-store-toolbar">
            <Input
              className="team-store-search"
              placeholder="搜索名称、简介或发布者…"
              value={query}
              allowClear
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="team-store-sort" role="group" aria-label="排序方式">
              <button
                type="button"
                className={sort === 'recent' ? 'is-active' : ''}
                onClick={() => setSort('recent')}
              >
                最新
              </button>
              <button
                type="button"
                className={sort === 'name' ? 'is-active' : ''}
                onClick={() => setSort('name')}
              >
                名称
              </button>
            </div>
          </div>

          <div className="team-store-cats" role="tablist" aria-label="资产分类">
            {(['all', 'app', 'workflow', 'agent', 'skill', 'mcp'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={category === k}
                className={`team-store-cat${category === k ? ' is-active' : ''}${k !== 'all' ? ` team-store-cat--${k}` : ''}`}
                onClick={() => setCategory(k)}
              >
                {k === 'all' ? '全部' : KIND_META[k].label}
                <span className="team-store-cat-count">{kindCounts[k]}</span>
              </button>
            ))}
          </div>

          <div className="team-store-status">
            {(
              [
                ['all', '全部状态', null],
                ['updatable', '可更新', statusCounts.updatable],
                ['not-installed', '未安装', statusCounts.notInstalled],
                ['installed', '已安装', null],
                ['attention', '需注意', statusCounts.attention],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                className={`team-store-chip${statusFilter === key ? ' is-active' : ''}`}
                onClick={() => setStatusFilter(key)}
              >
                {label}
                {count != null && count > 0 ? <span>{count}</span> : null}
              </button>
            ))}
          </div>

          {error !== '' ? (
            <div className="team-store-error">
              {error}
              <Button size="small" onClick={() => void reload()}>
                重试
              </Button>
            </div>
          ) : loading && cards.length === 0 ? (
            <div className="team-store-loading">
              <Icons.Spinner size={16} />
              正在加载团队资产…
            </div>
          ) : filtered.length === 0 ? (
            <div className="team-store-unconfigured">
              <Empty
                description={
                  cards.length === 0
                    ? '团队注册中心还没有共享资产——到各管理页把应用/工作流/助手/技能发布到团队'
                    : '没有符合当前筛选条件的资产'
                }
              />
            </div>
          ) : (
            <div className="team-store-grid">
              {filtered.map((card) => (
                <StoreCardItem
                  key={`${card.kind}:${card.slug}`}
                  card={card}
                  busy={bulkBusy || installingSlugs.has(card.slug)}
                  onOpen={() => setDetail(card)}
                  onInstall={(c) => void handleInstall(c)}
                />
              ))}
            </div>
          )}
        </>
      )}

      <Drawer
        title={detail?.name ?? ''}
        open={detail != null}
        width="min(520px, 94vw)"
        destroyOnClose
        onClose={() => {
          setDetail(null)
          setVersionsOpen(false)
        }}
      >
        {detail != null && (
          <div className="team-store-detail">
            <div className="tsd-badges">
              <Tag color={KIND_META[detail.kind].tagColor}>{KIND_META[detail.kind].label}</Tag>
              {detailBadge != null && (
                <span className={`ts-badge ${detailBadge.cls}`}>{detailBadge.text}</span>
              )}
              {detailBadge == null && detailInstalled && (
                <span className="ts-badge ts-badge--ok">已安装</span>
              )}
            </div>
            <p className="tsd-desc">{detail.description !== '' ? detail.description : '（暂无简介）'}</p>
            <dl className="tsd-meta">
              <div>
                <dt>当前版本</dt>
                <dd>v{detail.version}</dd>
              </div>
              <div>
                <dt>发布者</dt>
                <dd>{detail.author !== '' ? detail.author : '—'}</dd>
              </div>
              <div>
                <dt>更新时间</dt>
                <dd>{relativeTime(detail.updatedAt) !== '' ? relativeTime(detail.updatedAt) : '—'}</dd>
              </div>
              {detail.kind === 'mcp' && (
                <div>
                  <dt>传输协议</dt>
                  <dd>{detail.protocol !== '' ? detail.protocol : '—'}</dd>
                </div>
              )}
              {detail.kind === 'skill' && (
                <div>
                  <dt>团队下载</dt>
                  <dd>{detail.downloadCount} 次</dd>
                </div>
              )}
              <div>
                <dt>本地状态</dt>
                <dd>
                  {detail.localVersion != null
                    ? `已安装 v${detail.localVersion}`
                    : '未安装'}
                </dd>
              </div>
              <div>
                <dt>标识</dt>
                <dd className="tsd-slug">{detail.slug}</dd>
              </div>
            </dl>
            <div className="tsd-actions">
              {detailUpdateBusy || bulkBusy ? (
                <span className="tsc-busy">安装中…</span>
              ) : (
                <>
                  {detail.state === 'remote-newer' ? (
                    <Button type="primary" onClick={() => void handleInstall(detail)}>
                      更新到 v{detail.version}
                    </Button>
                  ) : (
                    <Button
                      type="primary"
                      onClick={() => void handleInstall(detail)}
                    >
                      {detailInstalled ? '重装最新版' : '安装最新版'}
                    </Button>
                  )}
                  <Button onClick={() => setVersionsOpen(true)}>版本历史 / 回滚</Button>
                </>
              )}
            </div>
            <p className="tsd-hint">
              工作流 / 助手 / 应用安装后为草稿或停用态，到对应管理页确认启用；
              随包捆绑的 MCP 默认停用，需在「扩展中心」补齐密钥后开启。
            </p>
          </div>
        )}
      </Drawer>

      <TeamVersionsModal
        open={versionsOpen}
        title={`版本历史 · ${detail?.name ?? ''}`}
        currentVersion={detail?.localVersion ?? null}
        fetchVersions={async () => (detail != null ? fetchVersions(detail) : [])}
        onInstall={async (v) => {
          if (detail != null) await handleInstall(detail, v)
        }}
        onClose={() => setVersionsOpen(false)}
        onInstalled={() => void reload()}
      />
    </div>
  )
}

// ─── 卡片 ──────────────────────────────────────────────────────────────

const KIND_ICONS = {
  app: Icons.AppWindow,
  workflow: Icons.Workflow,
  agent: Icons.Assistant,
  skill: Icons.Skills,
  mcp: Icons.MCP,
}

function StoreCardItem({
  card,
  busy,
  onOpen,
  onInstall,
}: {
  card: StoreCard
  busy: boolean
  onOpen: () => void
  onInstall: (card: StoreCard) => void
}) {
  const meta = KIND_META[card.kind]
  const badge = stateBadge(card.state)
  const installed = card.localId != null
  const Icon = KIND_ICONS[card.kind]
  const relTime = relativeTime(card.updatedAt)
  return (
    <article
      className={`team-store-card team-store-card--${card.kind}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <div className="tsc-head">
        <span className={`tsc-icon tsc-icon--${card.kind}`}>
          <Icon size={15} />
        </span>
        <span className="tsc-name" title={card.name}>
          {card.name}
        </span>
        <span className={`tsc-type tsc-type--${card.kind}`}>{meta.label}</span>
      </div>
      <p className="tsc-desc">{card.description !== '' ? card.description : '（暂无简介）'}</p>
      <div className="tsc-meta">
        <span>v{card.version}</span>
        {card.author !== '' && <span>by {card.author}</span>}
        {relTime !== '' && <span>{relTime}</span>}
        {card.kind === 'mcp' && card.protocol !== '' && <span>{card.protocol}</span>}
        {card.kind === 'skill' && card.downloadCount > 0 && <span>{card.downloadCount} 下载</span>}
      </div>
      <div className="tsc-foot">
        <div className="tsc-badges">
          {badge != null ? (
            <span className={`ts-badge ${badge.cls}`}>{badge.text}</span>
          ) : installed ? (
            <span className="ts-badge ts-badge--ok">已安装</span>
          ) : null}
        </div>
        <div className="tsc-actions" onClick={(e) => e.stopPropagation()}>
          {busy ? (
            <span className="tsc-busy">安装中…</span>
          ) : card.state === 'remote-newer' ? (
            <Button size="small" type="primary" onClick={() => onInstall(card)}>
              更新
            </Button>
          ) : !installed ? (
            <Button size="small" type="primary" onClick={() => onInstall(card)}>
              安装
            </Button>
          ) : (
            <Button size="small" onClick={() => onInstall(card)}>
              重装
            </Button>
          )}
        </div>
      </div>
    </article>
  )
}
