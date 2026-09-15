/**
 * SessionLabelMenu — 会话「标记」二级浮层内容。
 *
 * 由会话右键菜单的「标记」行 hover 展开（antd Dropdown 走 portal 渲染，
 * 因此不受一级菜单 overflow:hidden 的裁剪），列出全部标记 + 取消标记，
 * 当前标记高亮并打勾。
 */
import { Icons } from './Icons'
import { useI18n } from './i18n'
import { SESSION_LABELS, type SessionLabelKey } from './session-labels'
import './SessionLabelMenu.less'

export function SessionLabelMenu({
  current,
  onSelect,
}: {
  /** 当前标记；null = 未标记 */
  current: SessionLabelKey | null
  /** 选中某个标记；传 null 表示取消标记 */
  onSelect: (next: SessionLabelKey | null) => void
}) {
  const { t } = useI18n()
  return (
    <div
      className="session-label-menu"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {SESSION_LABELS.map((meta) => {
        const active = meta.key === current
        return (
          <button
            key={meta.key}
            type="button"
            className={`session-label-menu-item${active ? ' is-active' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              onSelect(meta.key)
            }}
          >
            <span className={`session-label-dot ${meta.colorClass}`} aria-hidden />
            <span className="session-label-menu-text">{t(meta.labelKey)}</span>
            {active && <Icons.Check size={14} className="session-label-menu-check" />}
          </button>
        )
      })}
      {current != null && (
        <>
          <div className="session-label-menu-divider" />
          <button
            type="button"
            className="session-label-menu-item"
            onClick={(e) => {
              e.stopPropagation()
              onSelect(null)
            }}
          >
            <span className="session-label-dot" aria-hidden />
            <span className="session-label-menu-text">{t('sidebar.session.label.clear')}</span>
          </button>
        </>
      )}
    </div>
  )
}
