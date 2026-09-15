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
 *
 * 分页模型（2026-09）：列表按类分片做服务端分页（PAGE_SIZE/页），进入分类页签
 * 或翻页时按需加载；「全部」视图只聚合各类第一页。updates 通道（体积 = 本地
 * 安装相关条目，天然有界）保持全量拉取，用于六态富化与全局计数。
 * 可通过 embedded 模式嵌进扩展中心（McpView）页签，隐藏页面级标题栏。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Drawer, Pagination } from 'antd'
import { Button, Empty, Input, Tag } from '@lobehub/ui'
import type {
  TeamRegistryAssetListItemDto,
  TeamRegistryAssetUpdateItemDto,
  TeamRegistryMcpListItemDto,
  TeamRegistryMcpUpdateItemDto,
  TeamRegistryUpdateItemDto,
  TeamRegistryVersionItemDto,
  RemoteSkillItem,
} from '@spark/protocol'
import { Icons } from '../Icons'
import { useIpcInvoke } from '../hooks/useIpc'
import { useApp } from '../AppContext'
import { useToast } from '../components/Toast'
import { TeamVersionsModal } from './TeamAssetMarket'
import { TeamStorePublish } from './TeamStorePublish'
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

/** 每类每页拉取条数：卡片网格 4 列 × 6 行，服务端与传输都有界 */
const PAGE_SIZE = 24

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

/** 单类资产的分片状态：当前页卡片 + 服务端总数 + 拉取状态 */
interface KindPage {
  cards: StoreCard[]
  total: number
  loading: boolean
  failed: boolean
}

type PagesState = Record<StoreKind, KindPage>

/** 五类资产的 updates 映射（六态富化数据源；全量、有界） */
interface UpdateMaps {
  app: Record<string, TeamRegistryAssetUpdateItemDto>
  workflow: Record<string, TeamRegistryAssetUpdateItemDto>
  agent: Record<string, TeamRegistryAssetUpdateItemDto>
  skill: Record<string, TeamRegistryUpdateItemDto>
  mcp: Record<string, TeamRegistryMcpUpdateItemDto>
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

/** 「全部」视图的分节顺序：平台资产（应用/工作流/助手）在前，扩展资产（技能/MCP）在后 */
const GROUP_ORDER: readonly StoreKind[] = ['app', 'workflow', 'agent', 'skill', 'mcp']

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

function emptyPages(): PagesState {
  const blank = (): KindPage => ({ cards: [], total: 0, loading: false, failed: false })
  return { app: blank(), workflow: blank(), agent: blank(), skill: blank(), mcp: blank() }
}

function emptyUpdMaps(): UpdateMaps {
  return { app: {}, workflow: {}, agent: {}, skill: {}, mcp: {} }
}

/** 列表条目 → 卡片（不带六态；六态在展示前用 updates 映射富化） */
function envelopeCard(kind: StoreKind, it: TeamRegistryAssetListItemDto): StoreCard {
  return {
    kind,
    slug: it.slug,
    name: it.name,
    description: it.description ?? '',
    version: it.version,
    author: it.author ?? '',
    updatedAt: it.updatedAt ?? '',
    state: 'not-installed',
    localId: null,
    localVersion: null,
    protocol: '',
    downloadCount: 0,
  }
}

function mcpCard(m: TeamRegistryMcpListItemDto): StoreCard {
  return {
    kind: 'mcp',
    slug: m.slug,
    name: m.name,
    description: m.description ?? '',
    version: m.version,
    author: '',
    updatedAt: '',
    state: 'not-installed',
    localId: null,
    localVersion: null,
    protocol: m.protocol ?? '',
    downloadCount: 0,
  }
}

function skillCard(s: RemoteSkillItem): StoreCard {
  const slug = s.id.startsWith('team:') ? s.id.slice('team:'.length) : s.id
  return {
    kind: 'skill',
    slug,
    name: s.name,
    description: s.description ?? '',
    version: s.version ?? '',
    author: s.author ?? '',
    updatedAt: '',
    state: s.localId != null ? 'up-to-date' : 'not-installed',
    localId: s.localId ?? null,
    localVersion: null,
    protocol: '',
    downloadCount: s.downloadCount ?? 0,
  }
}

/** 用 updates 映射富化卡片六态（按 kind 定位对应映射，字段名各不相同） */
function enrichCard(card: StoreCard, maps: UpdateMaps): StoreCard {
  switch (card.kind) {
    case 'mcp': {
      const u = maps.mcp[card.slug]
      return u == null
        ? card
        : {
            ...card,
            state: u.state ?? 'not-installed',
            localId: u.localServerId ?? null,
            localVersion: u.localVersion ?? null,
          }
    }
    case 'skill': {
      const u = maps.skill[card.slug]
      return u == null
        ? card
        : {
            ...card,
            state: u.state ?? card.state,
            localId: u.localSkillId ?? card.localId,
            localVersion: u.localVersion ?? null,
            updatedAt: u.remoteUpdatedAt ?? card.updatedAt,
          }
    }
    default: {
      const u = maps[card.kind][card.slug]
      return u == null
        ? card
        : {
            ...card,
            state: u.state ?? 'not-installed',
            localId: u.localId ?? null,
            localVersion: u.localVersion ?? null,
          }
    }
  }
}

function toUpdMap<T extends { slug: string }>(
  r: PromiseSettledResult<{ updates: T[] }>,
): Record<string, T> {
  const map: Record<string, T> = {}
  if (r.status === 'fulfilled') {
    for (const u of r.value.updates) map[u.slug] = u
  }
  return map
}

// ─── 页面组件 ──────────────────────────────────────────────────────────

export function TeamStoreView({ embedded = false }: { embedded?: boolean } = {}) {
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
  const [pages, setPages] = useState<PagesState>(emptyPages)
  const [pageByKind, setPageByKind] = useState<Record<StoreKind, number>>({
    app: 1,
    workflow: 1,
    agent: 1,
    skill: 1,
    mcp: 1,
  })
  const [updMaps, setUpdMaps] = useState<UpdateMaps>(emptyUpdMaps)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [category, setCategory] = useState<Category>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<'recent' | 'name'>('recent')
  const [installingSlugs, setInstallingSlugs] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [detail, setDetail] = useState<StoreCard | null>(null)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const reloadToken = useRef(0)
  const queryRef = useRef('')
  const loadedMarker = useRef<Partial<Record<StoreKind, { page: number; query: string }>>>({})

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  /** 单类拉取：返回该类一页结果（失败以 failed 标记，不抛出） */
  const fetchKindPage = useCallback(
    async (kind: StoreKind, page: number, q: string): Promise<KindPage> => {
      try {
        if (kind === 'skill') {
          const res = await searchSkills({
            query: q,
            registryId: 'team',
            limit: PAGE_SIZE,
            offset: (page - 1) * PAGE_SIZE,
          })
          const cards = res.skills
            .filter((s) => s.id.startsWith('team:'))
            .map((s): StoreCard => skillCard(s))
          return { cards, total: res.total ?? cards.length, loading: false, failed: false }
        }
        if (kind === 'mcp') {
          const res = await listMcp({
            page,
            pageSize: PAGE_SIZE,
            ...(q !== '' ? { query: q } : {}),
          })
          return {
            cards: res.servers.map((m): StoreCard => mcpCard(m)),
            total: res.total ?? res.servers.length,
            loading: false,
            failed: false,
          }
        }
        const res = await listAssets({
          assetType: kind,
          page,
          pageSize: PAGE_SIZE,
          ...(q !== '' ? { query: q } : {}),
        })
        return {
          cards: res.items.map((it): StoreCard => envelopeCard(kind, it)),
          total: res.total ?? res.items.length,
          loading: false,
          failed: false,
        }
      } catch {
        return { cards: [], total: 0, loading: false, failed: true }
      }
    },
    [listAssets, listMcp, searchSkills],
  )

  /** updates 通道刷新（体积 = 本地安装相关条目，全量有界） */
  const reloadUpdates = useCallback(
    async (token: number) => {
      const results = await Promise.allSettled([
        listAssetUpdates({ assetType: 'workflow' }),
        listAssetUpdates({ assetType: 'agent' }),
        listAssetUpdates({ assetType: 'app' }),
        listSkillUpdates({}),
        listMcpUpdates({}),
      ])
      if (token !== reloadToken.current) return
      const [uwf, uag, uap, usk, umc] = results
      setUpdMaps({
        workflow: toUpdMap(uwf),
        agent: toUpdMap(uag),
        app: toUpdMap(uap),
        skill: toUpdMap(usk),
        mcp: toUpdMap(umc),
      })
    },
    [listAssetUpdates, listMcpUpdates, listSkillUpdates],
  )

  /** 全量刷新：配置 → updates → 五类第 1 页（搜索词变化/刷新按钮/发布后走这里） */
  const reloadAll = useCallback(async () => {
    const token = ++reloadToken.current
    setLoading(true)
    setError('')
    try {
      const configRes = await getConfig({})
      if (token !== reloadToken.current) return
      setConfigured(configRes.snapshot.configured)
      if (!configRes.snapshot.configured) {
        setPages(emptyPages())
        return
      }
      await reloadUpdates(token)
      if (token !== reloadToken.current) return
      const q = queryRef.current
      const kinds: StoreKind[] = ['app', 'workflow', 'agent', 'skill', 'mcp']
      const results = await Promise.all(kinds.map((k) => fetchKindPage(k, 1, q)))
      if (token !== reloadToken.current) return
      const next = emptyPages()
      kinds.forEach((k, i) => {
        const result = results[i]
        if (result) next[k] = result
      })
      setPages(next)
      loadedMarker.current = Object.fromEntries(kinds.map((k) => [k, { page: 1, query: q }]))
    } catch (err) {
      if (token !== reloadToken.current) return
      setError(describeError(err))
    } finally {
      if (token === reloadToken.current) setLoading(false)
    }
  }, [fetchKindPage, getConfig, reloadUpdates])

  useEffect(() => {
    void reloadAll()
  }, [reloadAll])

  // 搜索词落定：全部类目回第 1 页重新检索（reloadAll 依赖 debouncedQuery 触发）
  useEffect(() => {
    queryRef.current = debouncedQuery
    setPageByKind({ app: 1, workflow: 1, agent: 1, skill: 1, mcp: 1 })
    loadedMarker.current = {}
  }, [debouncedQuery])

  /** 单类翻页加载：进入分类页签且目标页不在手时触发 */
  const loadKind = useCallback(
    async (kind: StoreKind, page: number) => {
      const token = ++reloadToken.current
      setPages((prev) => ({ ...prev, [kind]: { ...prev[kind], loading: true, failed: false } }))
      const result = await fetchKindPage(kind, page, queryRef.current)
      if (token !== reloadToken.current) return
      setPages((prev) => ({ ...prev, [kind]: result }))
      loadedMarker.current[kind] = { page, query: queryRef.current }
    },
    [fetchKindPage],
  )

  useEffect(() => {
    if (category === 'all' || configured !== true) return
    const want = { page: pageByKind[category], query: debouncedQuery }
    const marker = loadedMarker.current[category]
    if (marker != null && marker.page === want.page && marker.query === want.query) return
    loadedMarker.current[category] = want
    void loadKind(category, want.page)
  }, [category, pageByKind, debouncedQuery, configured, loadKind])

  /** 刷新：分页复位到第 1 页并整表重拉 */
  const handleRefresh = () => {
    setPageByKind({ app: 1, workflow: 1, agent: 1, skill: 1, mcp: 1 })
    void reloadAll()
  }

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
      // 安装只改变本地状态：刷新 updates 即可，列表无需重拉
      await reloadUpdates(++reloadToken.current)
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

  /** 跨页可更新目标：从 updates 映射构造（不依赖当前页数据） */
  const updatableCards = useMemo(() => {
    const targets: StoreCard[] = []
    for (const kind of GROUP_ORDER) {
      for (const slug of Object.keys(updMaps[kind])) {
        const u = updMaps[kind][slug]
        if (u?.state === 'remote-newer') {
          targets.push({
            kind,
            slug,
            name: u.name ?? slug,
            description: '',
            version: u.remoteVersion ?? '',
            author: '',
            updatedAt: '',
            state: 'remote-newer',
            localId: null,
            localVersion: null,
            protocol: '',
            downloadCount: 0,
          })
        }
      }
    }
    return targets
  }, [updMaps])

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
      await reloadUpdates(++reloadToken.current)
    } finally {
      setBulkBusy(false)
    }
  }

  // ── 派生视图 ──
  /** 各类富化后的展示卡片 */
  const enriched = useMemo(() => {
    const out = {} as Record<StoreKind, StoreCard[]>
    for (const k of GROUP_ORDER) out[k] = pages[k].cards.map((c) => enrichCard(c, updMaps))
    return out
  }, [pages, updMaps])

  const kindTotals = useMemo(() => {
    const totals: Record<Category, number> = { all: 0, app: 0, workflow: 0, agent: 0, skill: 0, mcp: 0 }
    for (const k of GROUP_ORDER) {
      totals[k] = pages[k].total
      totals.all += pages[k].total
    }
    return totals
  }, [pages])

  /** 全局六态计数（跨页；来自全量 updates + 服务端 total） */
  const statusCounts = useMemo(() => {
    const localIdOf = (kind: StoreKind, slug: string): string | null => {
      switch (kind) {
        case 'skill':
          return updMaps.skill[slug]?.localSkillId ?? null
        case 'mcp':
          return updMaps.mcp[slug]?.localServerId ?? null
        default:
          return updMaps[kind][slug]?.localId ?? null
      }
    }
    let updatable = 0
    let attention = 0
    let installed = 0
    for (const k of GROUP_ORDER) {
      for (const slug of Object.keys(updMaps[k])) {
        const u = updMaps[k][slug]
        if (u == null) continue
        if (u.state === 'remote-newer') updatable += 1
        if (ATTENTION_STATES.has(u.state)) attention += 1
        if (localIdOf(k, slug) != null) installed += 1
      }
    }
    const total = kindTotals.all
    return { updatable, attention, installed, notInstalled: Math.max(0, total - installed) }
  }, [updMaps, kindTotals])

  /** 当前页内过滤 + 排序（服务端已按搜索词 blur 过滤，这里做状态筛选与排序） */
  const visibleFor = useCallback(
    (kind: StoreKind): StoreCard[] => {
      const q = debouncedQuery.toLowerCase()
      let rows = enriched[kind]
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
      const byName = (a: StoreCard, b: StoreCard): number =>
        a.name.localeCompare(b.name, 'zh-Hans-CN')
      return [...rows].sort(sort === 'recent' ? byRecent : byName)
    },
    [enriched, statusFilter, debouncedQuery, sort],
  )

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

  const renderCard = (card: StoreCard) => (
    <StoreCardItem
      key={`${card.kind}:${card.slug}`}
      card={card}
      busy={bulkBusy || installingSlugs.has(card.slug)}
      onOpen={() => setDetail(card)}
      onInstall={(c) => void handleInstall(c)}
    />
  )

  const totalCards = kindTotals.all
  const failedKinds = GROUP_ORDER.filter((k) => pages[k].failed)

  const headerActions = (
    <div className="team-store-header-actions">
      {configured === true && (
        <Button size="small" type="primary" onClick={() => setPublishOpen(true)}>
          <Icons.Upload size={13} />
          上传共享
        </Button>
      )}
      <Button size="small" onClick={handleRefresh} loading={loading}>
        刷新
      </Button>
    </div>
  )

  return (
    <div className="team-store-page">
      {embedded ? (
        <div className="team-store-header team-store-header--embedded">{headerActions}</div>
      ) : (
        <header className="team-store-header">
          <div className="team-store-header-text">
            <h2>
              <Icons.Package size={18} />
              团队商店
            </h2>
            <p>团队共享的应用、工作流、助手、技能与 MCP —— 一键安装、版本可选、开箱即运行。</p>
          </div>
          {headerActions}
        </header>
      )}

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
          {failedKinds.length > 0 && (
            <div className="team-store-warn-line">
              {`以下分类加载失败，其余分类正常：${failedKinds.map((k) => KIND_META[k].label).join('、')}`}
            </div>
          )}

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
                <span className="team-store-cat-count">{kindTotals[k]}</span>
              </button>
            ))}
          </div>

          <div className="team-store-status">
            {(
              [
                ['all', '全部状态', null],
                ['updatable', '可更新', statusCounts.updatable],
                ['not-installed', '未安装', statusCounts.notInstalled],
                ['installed', '已安装', statusCounts.installed],
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
              <Button size="small" onClick={handleRefresh}>
                重试
              </Button>
            </div>
          ) : loading && totalCards === 0 ? (
            <div className="team-store-loading">
              <Icons.Spinner size={16} />
              正在加载团队资产…
            </div>
          ) : totalCards === 0 ? (
            <div className="team-store-unconfigured">
              <Empty
                description={
                  debouncedQuery !== ''
                    ? '没有符合搜索条件的资产'
                    : '团队注册中心还没有共享资产——点右上角「上传共享」，把本地的应用 / 工作流 / 助手分享给团队'
                }
              />
            </div>
          ) : category === 'all' ? (
            // 「全部」视图按类分节排版（各类第一页）：应用 / 工作流 / 助手 / 技能 / MCP，
            // 空分类不渲染；分节头带服务端总数，超出一页提供「查看全部」跳转。
            GROUP_ORDER.filter((k) => visibleFor(k).length > 0).map((k) => {
              const SectionIcon = KIND_ICONS[k]
              const sectionCards = visibleFor(k)
              const total = pages[k].total
              return (
                <section key={k} className="team-store-section" aria-label={KIND_META[k].label}>
                  <div className="team-store-section-head">
                    <span className={`tsc-icon tsc-icon--${k}`}>
                      <SectionIcon size={13} />
                    </span>
                    <h3>{KIND_META[k].label}</h3>
                    <span className="team-store-section-count">{total}</span>
                    {total > sectionCards.length && (
                      <button
                        type="button"
                        className="team-store-section-more"
                        onClick={() => setCategory(k)}
                      >
                        查看全部
                      </button>
                    )}
                  </div>
                  <div className="team-store-grid">{sectionCards.map(renderCard)}</div>
                </section>
              )
            })
          ) : (
            <>
              <div className="team-store-grid">{visibleFor(category).map(renderCard)}</div>
              <div className="team-store-pager">
                <Pagination
                  size="small"
                  current={pageByKind[category]}
                  pageSize={PAGE_SIZE}
                  total={pages[category].total}
                  showSizeChanger={false}
                  onChange={(p) => setPageByKind((prev) => ({ ...prev, [category]: p }))}
                />
              </div>
            </>
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
        onInstalled={() => void reloadUpdates(++reloadToken.current)}
      />

      <TeamStorePublish
        open={publishOpen}
        remoteCards={(['workflow', 'app', 'agent'] as const).flatMap((k) =>
          visibleFor(k).map((c) => ({ kind: k, name: c.name, version: c.version })),
        )}
        onClose={() => setPublishOpen(false)}
        onPublished={handleRefresh}
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
        <span className="tsc-ver">v{card.version}</span>
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
