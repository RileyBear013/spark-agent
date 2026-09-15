/**
 * useGitCommitContextMenu —— 提交行右键菜单的开合状态。
 *
 * 单独成文件（而非与菜单组件同文件）的原因：菜单组件文件只应有组件导出，
 * 否则 react-refresh 会因「同文件混合导出 hook 与组件」告警。
 *
 * 每个提交列表（提交板块列表 / 提交内文件历史列表）各持有一个实例，互不串扰。
 */
import { useCallback, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { WorkspaceGitCommitEntry } from '@spark/protocol'

export interface GitCommitMenuTarget {
  commit: WorkspaceGitCommitEntry
  /** 右键事件的视口坐标（clientX / clientY） */
  x: number
  y: number
}

export function useGitCommitContextMenu(): {
  menuTarget: GitCommitMenuTarget | null
  openCommitMenu: (event: ReactMouseEvent, commit: WorkspaceGitCommitEntry) => void
  closeCommitMenu: () => void
} {
  const [menuTarget, setMenuTarget] = useState<GitCommitMenuTarget | null>(null)

  const openCommitMenu = useCallback(
    (event: ReactMouseEvent, commit: WorkspaceGitCommitEntry): void => {
      event.preventDefault()
      event.stopPropagation()
      setMenuTarget({ commit, x: event.clientX, y: event.clientY })
    },
    [],
  )
  const closeCommitMenu = useCallback((): void => setMenuTarget(null), [])

  return { menuTarget, openCommitMenu, closeCommitMenu }
}
