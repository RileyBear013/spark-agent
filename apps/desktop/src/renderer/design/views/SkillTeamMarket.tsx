/**
 * SkillTeamMarket — 技能商店「团队源」Tab + 发布到团队弹窗
 *
 * TeamMarketTab：列出团队 Nacos 注册中心共享的技能（skill-registry:search
 * registryId='team'），支持安装 / 卸载 / 更新（版本徽标来自 team-registry:list-updates）。
 * PublishSkillToTeamModal：把本地已装技能发布到团队源（版本号可指定，默认 patch+1）。
 * 复用 SkillStoreView 的 skill-store-* 卡片样式，本文件只补少量私有类。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from 'antd'
import { Button, Empty, Input } from '@lobehub/ui'
import type { RemoteSkillItem, SkillItem, TeamRegistryUpdateItemDto } from '@spark/protocol'
import { Icons } from '../Icons'
import { useIpcInvoke } from '../hooks/useIpc'
import { useToast } from '../components/Toast'

// ─── 团队源市场 Tab ────────────────────────────────────────────────────

export function TeamMarketTab({ onInstalled }: { onInstalled: () => void }) {
  const { invoke: getConfig } = useIpcInvoke('team-registry:config-get')
  const { invoke: searchTeam } = useIpcInvoke('skill-registry:search')
  const { invoke: installSkill } = useIpcInvoke('team-registry:install-skill')
  const { invoke: uninstallRemote } = useIpcInvoke('skill-registry:uninstall')
  const { invoke: listUpdates } = useIpcInvoke('team-registry:list-updates')
  const { toast } = useToast()

  const [configured, setConfigured] = useState<boolean | null>(null)
  const [skills, setSkills] = useState<RemoteSkillItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [installingSlugs, setInstallingSlugs] = useState<Set<string>>(new Set())
  const [updates, setUpdates] = useState<Record<string, TeamRegistryUpdateItemDto>>({})
  const reloadToken = useRef(0)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [query])

  const reload = useCallback(async () => {
    const token = ++reloadToken.current
    setLoading(true)
    setError('')
    try {
      const [configRes, searchRes] = await Promise.all([
        getConfig({}),
        searchTeam({ query: debouncedQuery, registryId: 'team', limit: 100 }),
      ])
      if (token !== reloadToken.current) return
      setConfigured(configRes.snapshot.configured)
      setSkills(searchRes.skills)
    } catch (err) {
      if (token !== reloadToken.current) return
      setError(describeError(err))
    } finally {
      if (token === reloadToken.current) setLoading(false)
    }
  }, [debouncedQuery, getConfig, searchTeam])

  const reloadUpdates = useCallback(async () => {
    try {
      const res = await listUpdates({})
      const map: Record<string, TeamRegistryUpdateItemDto> = {}
      for (const item of res.updates) map[item.slug] = item
      setUpdates(map)
    } catch {
      // 更新徽标是增强信息，失败静默
    }
  }, [listUpdates])

  useEffect(() => {
    void reload()
    void reloadUpdates()
  }, [reload, reloadUpdates])

  const handleInstall = async (skill: RemoteSkillItem) => {
    const slug = slugOf(skill)
    if (!slug) return
    setInstallingSlugs((prev) => new Set(prev).add(slug))
    try {
      await installSkill({ slug })
      toast.success(`已从团队源安装：${skill.name}`)
      await Promise.all([reload(), reloadUpdates()])
      onInstalled()
    } catch (err) {
      toast.error(`安装失败：${describeError(err)}`)
    } finally {
      setInstallingSlugs((prev) => {
        const next = new Set(prev)
        next.delete(slug)
        return next
      })
    }
  }

  const handleUninstall = async (skill: RemoteSkillItem) => {
    if (!skill.localId) return
    try {
      await uninstallRemote({ localSkillId: skill.localId })
      toast.success(`已卸载：${skill.name}`)
      await Promise.all([reload(), reloadUpdates()])
      onInstalled()
    } catch (err) {
      toast.error(`卸载失败：${describeError(err)}`)
    }
  }

  const sortedSkills = useMemo(
    () => [...skills].sort((a, b) => b.downloadCount - a.downloadCount),
    [skills],
  )

  if (configured === false) {
    return (
      <div className="skill-store-empty">
        <Empty
          description={
            <span>
              团队源尚未配置。请到 <b>设置 → 团队注册中心</b> 填写 Nacos 地址与凭据后重试。
            </span>
          }
        />
      </div>
    )
  }

  return (
    <div className="skill-store-body team-market-tab">
      <div className="skill-store-toolbar">
        <div className="skill-store-toolbar-left">
          <Input
            className="team-market-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索团队技能（名称 / 描述）"
            allowClear
          />
        </div>
        <div className="skill-store-toolbar-right">
          <span className="team-market-count">{sortedSkills.length} 个团队技能</span>
        </div>
      </div>

      {error !== '' ? (
        <div className="skill-store-empty">
          <Empty description={`团队源加载失败：${error}`} />
        </div>
      ) : loading && sortedSkills.length === 0 ? (
        <div className="skill-store-empty">
          <Empty description="正在加载团队源…" />
        </div>
      ) : sortedSkills.length === 0 ? (
        <div className="skill-store-empty">
          <Empty
            description={
              debouncedQuery
                ? '没有匹配的团队技能，换个关键词试试。'
                : '团队源还没有共享技能——到「已安装」页选中一个技能，点「发布到团队」。'
            }
          />
        </div>
      ) : (
        <div className="skill-store-cards">
          {sortedSkills.map((skill) => {
            const slug = slugOf(skill) ?? ''
            const update = updates[slug]
            const busy = installingSlugs.has(slug)
            return (
              <div key={skill.id} className="skill-store-card">
                <div className="skill-store-card-top">
                  <div className="skill-store-card-icon skill-store-card-icon--default">
                    <Icons.Users size={20} />
                  </div>
                  <div className="skill-store-card-info">
                    <div className="skill-store-card-title">
                      {skill.name}
                      {update?.state === 'remote-newer' && (
                        <span className="team-market-badge team-market-badge--update">可更新</span>
                      )}
                      {update?.state === 'local-modified' && (
                        <span className="team-market-badge team-market-badge--warn">本地已修改</span>
                      )}
                      {update?.state === 'local-newer' && (
                        <span className="team-market-badge team-market-badge--muted">本地版本更高</span>
                      )}
                      {update?.state === 'remote-missing' && (
                        <span className="team-market-badge team-market-badge--warn">远端已删除</span>
                      )}
                    </div>
                    <div className="skill-store-card-subtitle">
                      {skill.description || skill.version}
                    </div>
                    <div className="team-market-meta">
                      v{skill.version || '0.0.0'} · {skill.author || 'team'}
                    </div>
                  </div>
                  <div className="skill-store-card-actions">
                    {busy ? (
                      <span className="skill-store-card-progress">安装中…</span>
                    ) : skill.installed ? (
                      <>
                        {update?.state === 'remote-newer' && (
                          <Button size="small" type="primary" onClick={() => void handleInstall(skill)}>
                            更新
                          </Button>
                        )}
                        <Button
                          size="small"
                          type="text"
                          danger
                          onClick={() => void handleUninstall(skill)}
                        >
                          卸载
                        </Button>
                      </>
                    ) : (
                      <Button size="small" type="primary" onClick={() => void handleInstall(skill)}>
                        安装
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function slugOf(skill: RemoteSkillItem): string | null {
  if (!skill.id.startsWith('team:')) return null
  return skill.id.slice('team:'.length) || null
}

// ─── 发布到团队弹窗 ────────────────────────────────────────────────────

interface PublishResultView {
  slug: string
  version: string
  skillName: string
  fileCount: number
  checksum: string
  previousRemoteVersion: string | null
  warnings: string[]
  skipped: Array<{ path: string; reason: string }>
}

export function PublishSkillToTeamModal({
  open,
  skill,
  onClose,
}: {
  open: boolean
  skill: SkillItem | null
  onClose: () => void
}) {
  const { invoke: publishSkill } = useIpcInvoke('team-registry:publish-skill')
  const { toast } = useToast()
  const [version, setVersion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<PublishResultView | null>(null)

  useEffect(() => {
    if (open) {
      setVersion('')
      setError('')
      setResult(null)
    }
  }, [open, skill?.id])

  const handlePublish = async () => {
    if (!skill) return
    setBusy(true)
    setError('')
    try {
      const res = await publishSkill({
        localSkillId: skill.id,
        ...(version.trim() !== '' ? { version: version.trim() } : {}),
      })
      setResult(res)
      toast.success(`已发布到团队源：${res.slug} v${res.version}`)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="发布到团队源"
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
      {skill == null ? null : result == null ? (
        <div className="team-publish-form">
          <p className="team-publish-hint">
            即将把 <b>{skill.name}</b> 发布到团队 Nacos 注册中心（原生 AI Skill 包）。
            技能目录内的文本文件会完整共享；二进制 / 超限文件会在发布结果中列出。
          </p>
          <label className="team-publish-field">
            <span>版本号（留空自动递增 patch 位，首发为 1.0.0）</span>
            <Input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="如 1.0.1（留空自动）"
              autoComplete="off"
            />
          </label>
          {error !== '' && <div className="team-publish-error">{error}</div>}
        </div>
      ) : (
        <div className="team-publish-result">
          <div className="team-publish-result-row">
            <span>技能</span>
            <b>
              {result.slug} · v{result.version}
              {result.previousRemoteVersion != null
                ? `（远端原为 v${result.previousRemoteVersion}）`
                : '（首发）'}
            </b>
          </div>
          <div className="team-publish-result-row">
            <span>共享范围</span>
            <b>团队可见（PUBLIC）</b>
          </div>
          <div className="team-publish-result-row">
            <span>文件数</span>
            <b>{result.fileCount}</b>
          </div>
          <div className="team-publish-result-row">
            <span>内容校验</span>
            <b className="team-publish-checksum">{result.checksum.slice(0, 16)}…</b>
          </div>
          {result.warnings.length > 0 ? (
            <div className="team-publish-skipped">
              <div className="team-publish-skipped-title">警告：</div>
              <ul>
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {result.skipped.length > 0 ? (
            <div className="team-publish-skipped">
              <div className="team-publish-skipped-title">已跳过 {result.skipped.length} 个文件：</div>
              <ul>
                {result.skipped.slice(0, 20).map((item) => (
                  <li key={item.path}>
                    {item.path}（{skippedReasonLabel(item.reason)}）
                  </li>
                ))}
              </ul>
              {result.skipped.length > 20 ? <div>…等共 {result.skipped.length} 个</div> : null}
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  )
}

function skippedReasonLabel(reason: string): string {
  if (reason === 'binary') return '二进制文件不共享'
  if (reason === 'too-large') return '超过单文件 1MB 上限'
  if (reason === 'ignored') return '命中忽略规则'
  return reason
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
