import { useEffect, useState } from 'react'
import type { SessionWorkflowBindingCreate } from '@spark/protocol'

const COMPOSER_RESET_DRAFT_EVENT = 'spark:composer:reset-draft'

/**
 * 新会话尚无 sessionId，工作流选择先保存在 Renderer 草稿态。
 * 会话落库或用户再次点击“新建任务”时清空，避免跨会话继承临时选择。
 */
export function useNewSessionWorkflowDraft(sessionId: string | null) {
  const [binding, setBinding] = useState<SessionWorkflowBindingCreate | null>(null)

  useEffect(() => {
    if (sessionId != null) setBinding(null)
  }, [sessionId])

  useEffect(() => {
    const reset = () => setBinding(null)
    window.addEventListener(COMPOSER_RESET_DRAFT_EVENT, reset)
    return () => window.removeEventListener(COMPOSER_RESET_DRAFT_EVENT, reset)
  }, [])

  return { binding, setBinding }
}
