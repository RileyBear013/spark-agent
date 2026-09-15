/**
 * SidebarActionMenu — 会话栏的扁平菜单内容（一级条目 + 可选二级浮层）。
 *
 * 从 SidebarSessionList.tsx 抽出：该文件已接近单文件长度上限，且「标记」条目
 * 需要 hover 展开二级浮层的开合状态，独立成组件比继续堆在列表文件里清晰。
 *
 * 二级浮层走 antd Dropdown（portal 渲染），因此不会被一级菜单的
 * overflow:hidden 裁剪；placement/align 与 SidebarFilterMenu 的子菜单保持一致。
 */
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Dropdown } from '@lobehub/ui'
import { Icons } from './Icons'
import './SidebarActionMenu.less'

export interface SidebarActionMenuItem {
  icon: ReactNode
  label: string
  danger?: boolean
  /** 禁用条目：点击无效（用于已标记会话的置顶开关） */
  disabled?: boolean
  /** 条目标题下的次要说明，用于解释被禁用的原因 */
  hint?: string
  /**
   * 二级浮层内容。提供时该条目只负责 hover 展开，不再触发一级动作；
   * 浮层内的条目自行负责选中后的动作（含关闭一级菜单）。
   */
  submenu?: ReactNode
  onClick?: () => void
}

/** 与 SidebarFilterMenu.SUBMENU_PLACEMENT 同款：向右侧展开。 */
const SUBMENU_PLACEMENT = 'rightTop' as unknown as 'topRight'

function SubmenuRow({ item }: { item: SidebarActionMenuItem }) {
  const [open, setOpen] = useState(false)
  return (
    <Dropdown
      menu={{ items: [] }}
      open={open}
      onOpenChange={setOpen}
      trigger={['hover']}
      placement={SUBMENU_PLACEMENT}
      align={{ offset: [4, 0], overflow: { shiftX: true, adjustY: true } }}
      popupRender={() => item.submenu}
    >
      <button
        type="button"
        className={`action-menu-item action-menu-item-has-submenu${open ? ' is-open' : ''}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {item.icon}
        <span className="action-menu-item-label">{item.label}</span>
        <Icons.ChevronRight size={12} className="action-menu-item-chev" />
      </button>
    </Dropdown>
  )
}

export function SidebarActionMenu({
  items,
  onAction,
}: {
  items: SidebarActionMenuItem[]
  onAction?: () => void
}) {
  const actionQueuedRef = useRef(false)
  const runAction = (item: SidebarActionMenuItem) => {
    if (item.disabled || item.submenu != null) return
    if (actionQueuedRef.current) return
    actionQueuedRef.current = true
    onAction?.()
    window.setTimeout(() => {
      actionQueuedRef.current = false
      item.onClick?.()
    }, 0)
  }

  return (
    <div
      className="action-menu"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((item) =>
        item.submenu != null ? (
          <SubmenuRow key={item.label} item={item} />
        ) : (
          <button
            type="button"
            key={item.label}
            className={`action-menu-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled === true}
            onPointerDown={(e) => {
              e.stopPropagation()
              runAction(item)
            }}
            onClick={(e) => {
              e.stopPropagation()
              runAction(item)
            }}
          >
            {item.icon}
            <span className="action-menu-item-label">
              {item.label}
              {item.hint != null && <span className="action-menu-item-hint">{item.hint}</span>}
            </span>
          </button>
        ),
      )}
    </div>
  )
}
