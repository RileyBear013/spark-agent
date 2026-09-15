/**
 * composerInsert —— 代码查看器 → 会话输入框「追加」注入通道。
 *
 * 与 views/chat/composerAppControl.ts 的 requestComposerPrefill 区别：
 *  - prefill 是「覆盖」语义且输入框已有内容会被拒，服务于 computer-use 自动化；
 *  - 本通道是「追加」语义：文本拼到草稿末尾、附件去重累加、代码位置引用去重累加，
 *    不动用户已输入内容，服务于「添加选中代码到会话 / 添加文件到会话」这类用户主动的右键操作。
 *
 * 走 window CustomEvent 解耦：CodeViewerEditor 无需知道当前 sessionId / composer 实例，
 * 由唯一活跃的 ComposerV2 监听并消化。targetSessionId 传 null 表示不限制会话（默认）。
 *
 * 引用类产物共三种：CodeReference（代码位置）、CommitReference（Git 提交）、附件（真实文件路径）。
 * 三者的 chip 渲染、按草稿桶隔离、发送时序列化规则各自独立，互不串扰。
 */
import { useEffect, type SetStateAction } from 'react'
import type { MessageAttachment, ComposerAttachment } from '../../views/chat/ChatComposerTypes'
import { getFileNameFromPath } from '../../services/composer-attachments'

const INSERT_EVENT = 'spark:code-viewer:insert-to-composer'
const INSERT_TIMEOUT_MS = 1_000

/**
 * 代码位置引用：只存「在哪」，不存代码内容。
 * 输入框里渲染为双行 chip（上行文件名+图标，下行 路径:行号），
 * 发送时转为「路径:行号」文本交给模型，由模型按需打开文件查看——
 * 避免把大段代码灌进会话正文。
 */
export interface CodeReference {
  /** 文件绝对路径 */
  path: string
  /** 文件名（chip 上行展示） */
  name: string
  /** 起始行（1-based） */
  startLine: number
  /** 结束行（1-based，含） */
  endLine: number
}

/**
 * Git 提交引用：只存「哪条提交」，不存 diff / 提交内容。
 * 输入框里渲染为双行 chip（上行短 hash，下行提交标题），
 * 发送时转为 `[Git 提交] 短hash 标题` 文本行，由模型按需 `git show` 回查改动——
 * 避免把整段 diff 灌进会话正文。
 */
export interface CommitReference {
  /** 提交完整 hash（去重键） */
  hash: string
  /** 短 hash（chip 主展示） */
  shortHash: string
  /** 提交标题（首行；正文不进入会话） */
  subject: string
}

export interface ComposerInsertPayload {
  /** 追加到草稿末尾的文本（已有内容时以两个换行分隔） */
  text?: string
  /** 去重累加进输入框的附件（by path） */
  attachments?: MessageAttachment[]
  /** 代码位置引用：去重累加进输入框（按 path + 行号区间去重） */
  codeReferences?: CodeReference[]
  /** Git 提交引用：去重累加进输入框（按提交 hash 去重） */
  commitReferences?: CommitReference[]
}

interface ComposerInsertRequest extends ComposerInsertPayload {
  targetSessionId: string | null
  resolve(applied: boolean): void
}

/**
 * 发起一次「追加到会话输入框」请求。返回是否在超时内被某个活跃 composer 消化。
 * CodeViewerEditor 的右键 action / 自建菜单调用本函数，无需关心 composer 在哪。
 */
export function insertToComposer(
  payload: ComposerInsertPayload,
  targetSessionId: string | null = null,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (applied: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(applied)
    }
    const timeout = window.setTimeout(() => finish(false), INSERT_TIMEOUT_MS)
    window.dispatchEvent(
      new CustomEvent<ComposerInsertRequest>(INSERT_EVENT, {
        detail: { ...payload, targetSessionId, resolve: finish },
      }),
    )
  })
}

/**
 * 把 CommitReference 格式化为发送文本行：`[Git 提交] 短hash 标题`。
 * 前缀与浏览器元素引用（`[浏览器元素引用]`）同构，便于模型识别这是可回查的定位信息。
 */
export function formatCommitReferenceLine(ref: CommitReference): string {
  return `[Git 提交] ${ref.shortHash} ${ref.subject}`
}

/** 把 CodeReference 格式化为「路径:行号」文本（单行 :N，多行 :S-E）。 */
export function formatCodeReferenceLine(ref: CodeReference): string {
  const range =
    ref.startLine === ref.endLine ? `${ref.startLine}` : `${ref.startLine}-${ref.endLine}`
  return `${ref.path}:${range}`
}

/**
 * ComposerV2 挂载此 hook 消化 insert 请求。
 * 文本走 setValue 追加，附件走 appendAttachments 累加（内部已处理 20 上限与去重），
 * 代码位置引用走 appendCodeReferences 累加（由 ComposerV2 实现去重）。
 */
export function useInsertToComposer(input: {
  sessionId: string | null
  setValue(next: SetStateAction<string>): void
  appendAttachments(attachments: ComposerAttachment[]): number
  /** 代码位置引用去重累加（按 path + 行号区间去重） */
  appendCodeReferences(refs: CodeReference[]): number
  /** Git 提交引用去重累加（按提交 hash 去重） */
  appendCommitReferences(refs: CommitReference[]): number
  focus(): void
}): void {
  const {
    sessionId,
    setValue,
    appendAttachments,
    appendCodeReferences,
    appendCommitReferences,
    focus,
  } = input
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<ComposerInsertRequest>).detail
      if (detail == null) return
      // targetSessionId === null 表示不限制会话（活跃 composer 即消化）；非 null 时严格匹配。
      if (detail.targetSessionId != null && detail.targetSessionId !== sessionId) return

      if (detail.text != null && detail.text.length > 0) {
        const incoming = detail.text
        setValue((prev) => (prev.length > 0 ? `${prev}\n\n${incoming}` : incoming))
      }

      if (detail.attachments != null && detail.attachments.length > 0) {
        const stamp = Date.now()
        const next: ComposerAttachment[] = detail.attachments.map((att, index) => ({
          id: `cv-insert-${stamp}-${index}-${att.path}`,
          type: att.type,
          path: att.path,
          name: att.name ?? getFileNameFromPath(att.path),
          // 调用方（如文件树右键）已生成图片预览时原样透传，避免 chip 丢失预览
          ...(att.previewPath != null ? { previewPath: att.previewPath } : {}),
          ...(att.previewUrl != null ? { previewUrl: att.previewUrl } : {}),
        }))
        appendAttachments(next)
      }

      if (detail.codeReferences != null && detail.codeReferences.length > 0) {
        appendCodeReferences(detail.codeReferences)
      }

      if (detail.commitReferences != null && detail.commitReferences.length > 0) {
        appendCommitReferences(detail.commitReferences)
      }

      detail.resolve(true)
      focus()
    }
    window.addEventListener(INSERT_EVENT, handler)
    return () => window.removeEventListener(INSERT_EVENT, handler)
  }, [sessionId, setValue, appendAttachments, appendCodeReferences, appendCommitReferences, focus])
}
