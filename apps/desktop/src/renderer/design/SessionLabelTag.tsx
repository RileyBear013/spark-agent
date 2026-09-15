/**
 * SessionLabelTag — 会话标记的彩色状态标签（色点 + 标记名称）。
 *
 * 与置顶图标、筛选器色点共用 session-labels.less 的同一份标记色板，
 * 用于需要显式写出标记名称的位置（当前为会话行悬浮信息卡）。
 */
import { useI18n } from './i18n'
import { getSessionLabelMeta, type SessionLabelKey } from './session-labels'

export function SessionLabelTag({
  labelKey,
}: {
  /** 会话当前标记；未标记或未知标记时不渲染。 */
  labelKey?: SessionLabelKey | null | undefined
}) {
  const { t } = useI18n()
  const meta = labelKey != null ? getSessionLabelMeta(labelKey) : null
  if (meta == null) return null
  return (
    <span className={`session-label-tag ${meta.colorClass}`}>
      <span className={`session-label-dot ${meta.colorClass}`} aria-hidden />
      {t(meta.labelKey)}
    </span>
  )
}
