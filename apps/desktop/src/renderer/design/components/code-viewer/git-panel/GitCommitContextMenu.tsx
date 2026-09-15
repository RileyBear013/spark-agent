/**
 * GitCommitContextMenu —— Git 面板提交行的右键菜单（提交列表行与文件历史行共用）。
 *
 * 三项能力：
 *  - 复制提交 ID：复制完整 hash（与提交详情浮层的复制按钮同源语义，短 hash 只用于展示）；
 *  - 复制提交信息：标题 + 正文（formatGitCommitMessageText，等同 git log 的提交信息）；
 *  - 添加到会话：把提交作为 CommitReference chip 追加进当前会话输入框，
 *    与文件树右键「添加到对话」走同一条 insertToComposer 追加通道。
 *
 * createPortal 到 document.body（逃逸 gp-scroll 的 overflow 裁剪），position: fixed 并按
 * 视口边界 clamp；点击浮层外部 / Esc / 面板滚动时关闭（滚动会让 fixed 浮层与锚点错位）。
 * 开合状态由 useGitCommitContextMenu 持有（见同目录 useGitCommitContextMenu.ts）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icons } from '../../../Icons'
import { useToast } from '../../Toast'
import { insertToComposer } from '../composerInsert'
import { formatGitCommitMessageText } from './gitPanelViewUtils'
import type { GitCommitMenuTarget } from './useGitCommitContextMenu'

const MENU_WIDTH = 200
const MENU_EDGE = 8

export function GitCommitContextMenu({
  target,
  onClose,
}: {
  target: GitCommitMenuTarget
  onClose: () => void
}) {
  const { toast } = useToast()
  const menuRef = useRef<HTMLDivElement | null>(null)
  // 先隐形渲染量尺寸，layout effect 里 clamp 后再显示，避免首帧闪现在视口外
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = menuRef.current
    if (el == null) return
    const rect = el.getBoundingClientRect()
    const maxLeft = Math.max(MENU_EDGE, window.innerWidth - MENU_EDGE - rect.width)
    const maxTop = Math.max(MENU_EDGE, window.innerHeight - MENU_EDGE - rect.height)
    setPosition({
      left: Math.min(Math.max(target.x, MENU_EDGE), maxLeft),
      top: Math.min(Math.max(target.y, MENU_EDGE), maxTop),
    })
  }, [target])

  // 点击浮层外部 / Esc 关闭
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent): void => {
      if (menuRef.current != null && !menuRef.current.contains(event.target as Node)) onClose()
    }
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  // 滚动让 fixed 浮层与锚点错位：任何滚动立即收起（与提交详情浮层同一处理）
  useEffect(() => {
    window.addEventListener('scroll', onClose, true)
    return () => window.removeEventListener('scroll', onClose, true)
  }, [onClose])

  const { commit } = target

  const copyText = useCallback(
    async (text: string, successMessage: string, failureMessage: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(text)
        toast.success(successMessage)
      } catch {
        // 剪贴板不可用（非受信渲染进程）时明确提示，不静默失败
        toast.error(failureMessage)
      }
    },
    [toast],
  )

  const handleAddToSession = useCallback(async (): Promise<void> => {
    const applied = await insertToComposer({
      commitReferences: [
        { hash: commit.hash, shortHash: commit.shortHash, subject: commit.subject },
      ],
    })
    if (applied) toast.success(`已添加到会话：${commit.shortHash}`)
    else toast.error('未找到当前会话的输入框，添加失败')
  }, [commit.hash, commit.shortHash, commit.subject, toast])

  return createPortal(
    <div
      ref={menuRef}
      className="action-menu context-action-menu gp-commit-menu"
      style={{
        position: 'fixed',
        left: position?.left ?? target.x,
        top: position?.top ?? target.y,
        minWidth: MENU_WIDTH,
        zIndex: 10000,
        visibility: position == null ? 'hidden' : 'visible',
      }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        // 浮层内再右键：关闭当前浮层，交回行重新触发，避免叠层
        event.preventDefault()
        onClose()
      }}
    >
      <button
        type="button"
        role="menuitem"
        className="action-menu-item"
        onClick={() => {
          onClose()
          void copyText(commit.hash, '已复制提交 ID', '复制提交 ID 失败')
        }}
      >
        <Icons.Hash size={14} />
        <span>复制提交 ID</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="action-menu-item"
        onClick={() => {
          onClose()
          void copyText(formatGitCommitMessageText(commit), '已复制提交信息', '复制提交信息失败')
        }}
      >
        <Icons.FileText size={14} />
        <span>复制提交信息</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="action-menu-item"
        onClick={() => {
          onClose()
          void handleAddToSession()
        }}
      >
        <Icons.MessageSquarePlus size={14} />
        <span>添加到会话</span>
      </button>
    </div>,
    document.body,
  )
}
