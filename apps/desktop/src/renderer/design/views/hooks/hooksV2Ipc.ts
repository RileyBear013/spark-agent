/**
 * Hooks V2 渲染层 IPC 封装（设计方案 §14）。
 *
 * 通道契约全部来自 @spark/protocol 的 HookV2IpcChannelMap；这里只做类型安全的
 * 薄转发与错误规整，不在 Renderer 复制松散类型。
 */

import type {
  HookDefinitionInputV1,
  HookDefinitionV1,
  HookEffectiveBindingV1,
  HookEventNameV1,
  HookEventEnvelopeV1,
  HookPreviewResultV1,
  HookRunStatusV1,
  HookRunV1,
  HookSystemStatusV1,
  HookToolCandidateV1,
  HookBindingV1,
} from '@spark/protocol'

export type {
  HookDefinitionInputV1,
  HookDefinitionV1,
  HookEffectiveBindingV1,
  HookEventNameV1,
  HookEventEnvelopeV1,
  HookPreviewResultV1,
  HookRunStatusV1,
  HookRunV1,
  HookToolCandidateV1,
  HookBindingV1,
}

async function call<C extends keyof HookV2Calls>(
  channel: C,
  request: HookV2Calls[C][0],
): Promise<HookV2Calls[C][1]> {
  try {
    return await window.spark.invoke(channel as never, request as never)
  } catch (error) {
    // IPC 层抛出的 Error 保留原始 message（含主进程校验/管理服务的中文错误）
    throw error instanceof Error ? error : new Error(String(error))
  }
}

interface HookV2Calls {
  'hookV2:list-definitions': [{ eventName?: HookEventNameV1 }, { definitions: HookDefinitionV1[] }]
  'hookV2:create-definition': [
    { definition: HookDefinitionInputV1 },
    { definition: HookDefinitionV1 },
  ]
  'hookV2:update-definition': [
    { id: string; patch: Partial<HookDefinitionInputV1> },
    { definition: HookDefinitionV1; invalidatedBindings: number },
  ]
  'hookV2:delete-definition': [
    { id: string },
    { deleted: boolean; deletedBindings: number; retainedRuns: number },
  ]
  'hookV2:validate-definition': [
    { definition: HookDefinitionInputV1 },
    { valid: boolean; errors: string[]; executionHash: string },
  ]
  'hookV2:list-bindings': [
    { hookId?: string; scopeKind?: string; scopeId?: string },
    { bindings: HookBindingV1[] },
  ]
  'hookV2:upsert-binding': [
    {
      binding: {
        hookId: string
        scopeKind: 'application' | 'workspace' | 'agent' | 'session'
        scopeId?: string
        enabled?: boolean
        authorizeExecutionHash?: string
        authorizedEffect?: string
      }
    },
    { binding: HookBindingV1 },
  ]
  'hookV2:list-effective': [{ sessionId: string }, { items: HookEffectiveBindingV1[] }]
  'hookV2:list-runs': [
    {
      sessionId?: string
      hookId?: string
      status?: HookRunStatusV1
      eventId?: string
      eventName?: HookEventNameV1
      from?: string
      to?: string
      limit?: number
    },
    { runs: HookRunV1[] },
  ]
  'hookV2:get-run': [{ id: string }, { run: HookRunV1 | null }]
  'hookV2:retry-run': [{ id: string }, { run: HookRunV1 | null }]
  'hookV2:cancel-run': [{ id: string }, { run: HookRunV1 | null }]
  'hookV2:get-system-status': [Record<string, never>, HookSystemStatusV1]
  'hookV2:set-enabled': [{ enabled: boolean }, HookSystemStatusV1]
  'hookV2:list-tool-candidates': [Record<string, never>, { candidates: HookToolCandidateV1[] }]
  'hookV2:preview': [
    { definition: HookDefinitionInputV1; sampleEnvelope?: HookEventEnvelopeV1 },
    HookPreviewResultV1,
  ]
  'hookV2:test-run': [
    { definition: HookDefinitionInputV1; sampleEnvelope?: HookEventEnvelopeV1 },
    { run: HookRunV1 },
  ]
}

export const hooksV2Api = {
  listDefinitions: (eventName?: HookEventNameV1) =>
    call('hookV2:list-definitions', { ...(eventName != null ? { eventName } : {}) }),
  createDefinition: (definition: HookDefinitionInputV1) =>
    call('hookV2:create-definition', { definition }),
  updateDefinition: (id: string, patch: Partial<HookDefinitionInputV1>) =>
    call('hookV2:update-definition', { id, patch }),
  deleteDefinition: (id: string) => call('hookV2:delete-definition', { id }),
  validateDefinition: (definition: HookDefinitionInputV1) =>
    call('hookV2:validate-definition', { definition }),
  listBindings: (filters: { hookId?: string; scopeKind?: string; scopeId?: string } = {}) =>
    call('hookV2:list-bindings', filters),
  upsertBinding: (binding: HookV2Calls['hookV2:upsert-binding'][0]['binding']) =>
    call('hookV2:upsert-binding', { binding }),
  listEffective: (sessionId: string) => call('hookV2:list-effective', { sessionId }),
  listRuns: (filters: HookV2Calls['hookV2:list-runs'][0] = {}) => call('hookV2:list-runs', filters),
  getRun: (id: string) => call('hookV2:get-run', { id }),
  retryRun: (id: string) => call('hookV2:retry-run', { id }),
  cancelRun: (id: string) => call('hookV2:cancel-run', { id }),
  getSystemStatus: () => call('hookV2:get-system-status', {}),
  setSystemEnabled: (enabled: boolean) => call('hookV2:set-enabled', { enabled }),
  listToolCandidates: () => call('hookV2:list-tool-candidates', {}),
  preview: (definition: HookDefinitionInputV1) => call('hookV2:preview', { definition }),
  testRun: (definition: HookDefinitionInputV1) => call('hookV2:test-run', { definition }),
}

// ─── 展示文案（事件 / 状态 / 错误码 / 作用域）───────────────────────────────

export const HOOK_EVENT_LABELS: Record<HookEventNameV1, { label: string; desc: string }> = {
  'turn.started': { label: 'Turn 开始', desc: 'Turn 已建立并准备进入执行管线' },
  'permission.requested': { label: '权限请求', desc: '权限请求进入等待审批' },
  'question.requested': { label: 'Agent 提问', desc: 'Agent 提问进入等待用户输入' },
  'response.committed': { label: '回答已提交', desc: '最终回答成功落库，正文已确定' },
  'turn.completed': { label: 'Turn 完成', desc: 'Turn 成功终态已持久化' },
  'turn.failed': { label: 'Turn 失败', desc: 'Turn 进入不可恢复失败终态' },
  'turn.cancelled': { label: 'Turn 已取消', desc: '用户或系统明确取消 Turn' },
}

export const HOOK_RUN_STATUS_LABELS: Record<HookRunStatusV1, { label: string; tone: string }> = {
  queued: { label: '排队中', tone: 'pending' },
  running: { label: '执行中', tone: 'processing' },
  succeeded: { label: '成功', tone: 'success' },
  failed: { label: '失败', tone: 'error' },
  skipped: { label: '已跳过', tone: 'default' },
  blocked: { label: '被阻止', tone: 'warning' },
  cancelled: { label: '已取消', tone: 'default' },
  outcome_unknown: { label: '结果未知', tone: 'warning' },
}

export const HOOK_SCOPE_LABELS: Record<string, string> = {
  application: '应用',
  workspace: '项目',
  agent: 'Agent',
  session: '会话',
}

export const HOOK_ERROR_CODE_LABELS: Record<string, string> = {
  binding_disabled: '绑定已停用',
  ambiguous_binding: '绑定冲突（历史脏数据）',
  trust_required: '授权失效，需重新确认',
  condition_not_matched: '条件不匹配',
  mapping_failed: '参数映射失败',
  tool_not_found: '目标工具不存在',
  tool_disabled: '目标工具已停用',
  tool_version_changed: '工具版本漂移',
  permission_changed: '权限发生变化',
  policy_blocked: '策略阻止',
  timeout: '执行超时',
  transient_failure: '瞬态失败',
  action_failed: '动作失败',
  outcome_unknown: '结果未知（取消后无法确认）',
}

export const HOOK_RETRY_MODE_LABELS: Record<string, string> = {
  safe: 'safe · 仅瞬态错误自动重试',
  keyed: 'keyed · 注入幂等键自动重试',
  unsafe: 'unsafe · 失败不自动重试',
}

export function describeHookAction(definition: HookDefinitionV1): string {
  const action = definition.action
  if (action.type === 'builtin.notification') return '系统通知'
  if (action.type === 'builtin.sound') return '提示音'
  return `工具 · ${action.target.qualifiedName}`
}
