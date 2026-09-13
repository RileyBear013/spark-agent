/**
 * Hook 定义编辑器（设计方案 §8/§14/§15.1）。
 *
 * 事件 → 条件 → 动作 → 参数映射 → 执行策略的受限编辑界面：
 * - 路径输入提供事件白名单 datalist 提示；合法性由主进程静态校验兜底。
 * - 保存前可「预览」（只求值不执行）；「测试运行」产生真实外部副作用，
 *   必须经二次确认（§17）。
 */

import React, { useEffect, useMemo, useState } from 'react'
import { Button, Input, InputNumber, Segmented, Select, Tag } from '@lobehub/ui'
import { Modal as AntdModal, Switch } from 'antd'
import { Icons } from '../../Icons'
import { useToast } from '../../components/Toast'
import type {
  HookDefinitionInputV1,
  HookDefinitionV1,
  HookEventNameV1,
  HookPreviewResultV1,
  HookToolCandidateV1,
  HookValueExpressionV1,
} from '@spark/protocol'
import { HOOK_EVENT_LABELS, HOOK_RETRY_MODE_LABELS, hooksV2Api } from './hooksV2Ipc'

type ActionType = 'builtin.notification' | 'builtin.sound' | 'tool.invoke'
type MappingKind = 'path' | 'const' | 'template'

interface MappingRow {
  id: number
  field: string
  kind: MappingKind
  value: string
}

interface EditorState {
  name: string
  description: string
  eventName: HookEventNameV1
  actionType: ActionType
  notificationTitle: string
  notificationBody: string
  toolQualifiedName: string
  mappings: MappingRow[]
  timeoutMs: number
  retryMode: 'safe' | 'keyed' | 'unsafe'
  maxAttempts: number
  backoffMs: number
  concurrency: 'serial_per_session' | 'parallel'
  conditionEnabled: boolean
  conditionOperator: 'eq' | 'notEq' | 'contains' | 'startsWith' | 'exists'
  conditionLeft: string
  conditionRight: string
}

const DEFAULT_EDITOR_STATE: EditorState = {
  name: '',
  description: '',
  eventName: 'response.committed',
  actionType: 'builtin.notification',
  notificationTitle: '',
  notificationBody: '',
  toolQualifiedName: '',
  mappings: [],
  timeoutMs: 15_000,
  retryMode: 'unsafe',
  maxAttempts: 3,
  backoffMs: 1000,
  concurrency: 'serial_per_session',
  conditionEnabled: false,
  conditionOperator: 'eq',
  conditionLeft: '',
  conditionRight: '',
}

const CONDITION_OPERATOR_OPTIONS = [
  { value: 'eq', label: '等于' },
  { value: 'notEq', label: '不等于' },
  { value: 'contains', label: '包含' },
  { value: 'startsWith', label: '前缀为' },
  { value: 'exists', label: '字段存在' },
]

/** 常用事件路径提示（datalist 辅助输入；白名单以主进程校验为准）。 */
function suggestedPaths(eventName: HookEventNameV1): string[] {
  const common = [
    'eventId',
    'eventName',
    'session.id',
    'session.title',
    'turn.id',
    'agent.id',
    'agent.name',
    'primaryWorkspaceId',
  ]
  const byEvent: Record<HookEventNameV1, string[]> = {
    'turn.started': [],
    'permission.requested': [
      'payload.requestId',
      'payload.toolName',
      'payload.action',
      'payload.riskLevel',
    ],
    'question.requested': ['payload.questionId', 'payload.questions'],
    'response.committed': ['payload.response.messageId', 'payload.response.finalText'],
    'turn.completed': ['payload.message'],
    'turn.failed': ['payload.message'],
    'turn.cancelled': ['payload.message'],
  }
  return [...common, ...byEvent[eventName]]
}

function editorStateFromDefinition(definition: HookDefinitionV1): EditorState {
  const expressionToRow = (field: string, expression: HookValueExpressionV1): MappingRow => {
    if ('path' in expression)
      return { id: Math.random(), field, kind: 'path', value: expression.path }
    if ('const' in expression)
      return { id: Math.random(), field, kind: 'const', value: String(expression.const) }
    return { id: Math.random(), field, kind: 'template', value: expression.template }
  }
  const condition = definition.condition
  const leaf =
    condition != null && 'left' in condition && !('conditions' in condition) ? condition : undefined
  const leafLeftPath = leaf != null && 'path' in leaf.left ? leaf.left.path : ''
  const leafRight =
    leaf != null && 'right' in leaf && 'const' in leaf.right && typeof leaf.right.const === 'string'
      ? leaf.right.const
      : ''
  return {
    name: definition.name,
    description: definition.description ?? '',
    eventName: definition.eventName,
    actionType: definition.action.type,
    notificationTitle:
      definition.action.type === 'builtin.notification' && definition.action.title != null
        ? 'template' in definition.action.title
          ? definition.action.title.template
          : ''
        : '',
    notificationBody:
      definition.action.type === 'builtin.notification' && definition.action.body != null
        ? 'template' in definition.action.body
          ? definition.action.body.template
          : ''
        : '',
    toolQualifiedName:
      definition.action.type === 'tool.invoke' ? definition.action.target.qualifiedName : '',
    mappings: Object.entries(definition.inputMapping).map(([field, expression]) =>
      expressionToRow(field, expression),
    ),
    timeoutMs: definition.timeoutMs,
    retryMode: definition.retryPolicy.mode,
    maxAttempts: definition.retryPolicy.maxAttempts,
    backoffMs: definition.retryPolicy.backoffMs,
    concurrency: definition.concurrencyPolicy,
    conditionEnabled: leaf != null,
    conditionOperator: leaf?.operator ?? 'eq',
    conditionLeft: leafLeftPath,
    conditionRight: leafRight,
  }
}

function toDefinitionInput(
  state: EditorState,
  candidates: HookToolCandidateV1[],
): HookDefinitionInputV1 {
  const inputMapping: Record<string, HookValueExpressionV1> = {}
  for (const row of state.mappings) {
    if (row.field.trim() === '') continue
    if (row.kind === 'path') inputMapping[row.field.trim()] = { path: row.value.trim() }
    else if (row.kind === 'const') inputMapping[row.field.trim()] = { const: row.value }
    else inputMapping[row.field.trim()] = { template: row.value }
  }
  let condition: HookDefinitionInputV1['condition']
  if (state.conditionEnabled && state.conditionLeft.trim() !== '') {
    const left: HookValueExpressionV1 = { path: state.conditionLeft.trim() }
    if (state.conditionOperator === 'exists') {
      condition = { operator: 'exists', left }
    } else {
      condition = {
        operator: state.conditionOperator,
        left,
        right: { const: state.conditionRight },
      }
    }
  }
  let action: HookDefinitionInputV1['action']
  if (state.actionType === 'builtin.sound') {
    action = { type: 'builtin.sound' }
  } else if (state.actionType === 'builtin.notification') {
    action = {
      type: 'builtin.notification',
      ...(state.notificationTitle.trim() !== ''
        ? { title: { template: state.notificationTitle } }
        : {}),
      ...(state.notificationBody.trim() !== ''
        ? { body: { template: state.notificationBody } }
        : {}),
    }
  } else {
    const candidate = candidates.find(
      (item) => item.target.qualifiedName === state.toolQualifiedName,
    )
    if (candidate == null) throw new Error('请选择一个目标工具')
    action = { type: 'tool.invoke', target: candidate.target }
  }
  return {
    name: state.name.trim(),
    ...(state.description.trim() !== '' ? { description: state.description.trim() } : {}),
    eventName: state.eventName,
    ...(condition != null ? { condition } : {}),
    action,
    inputMapping,
    timeoutMs: state.timeoutMs,
    retryPolicy: {
      mode: state.retryMode,
      maxAttempts: state.maxAttempts,
      backoffMs: state.backoffMs,
    },
    concurrencyPolicy: state.concurrency,
  }
}

const toNumber = (v: string | number | null | undefined, fallback: number): number => {
  const parsed = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(parsed) ? parsed : fallback
}

export interface HookDefinitionEditorProps {
  open: boolean
  /** 编辑既有定义；null = 新建。 */
  definition: HookDefinitionV1 | null
  onClose: () => void
  onSaved: (definition: HookDefinitionV1) => void
}

export function HookDefinitionEditor({
  open,
  definition,
  onClose,
  onSaved,
}: HookDefinitionEditorProps) {
  const { toast } = useToast()
  const [state, setState] = useState<EditorState>(DEFAULT_EDITOR_STATE)
  const [candidates, setCandidates] = useState<HookToolCandidateV1[]>([])
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [conditionOpen, setConditionOpen] = useState(false)
  const [preview, setPreview] = useState<HookPreviewResultV1 | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setState(definition != null ? editorStateFromDefinition(definition) : DEFAULT_EDITOR_STATE)
    setPreview(null)
    setAdvancedOpen(
      definition != null &&
        (definition.timeoutMs !== 15_000 ||
          definition.retryPolicy.mode !== 'unsafe' ||
          definition.concurrencyPolicy !== 'serial_per_session'),
    )
    setConditionOpen(definition?.condition != null)
    hooksV2Api
      .listToolCandidates()
      .then((res) => setCandidates(res.candidates))
      .catch(() => setCandidates([]))
  }, [open, definition])

  const patch = (partial: Partial<EditorState>): void => setState((s) => ({ ...s, ...partial }))
  const paths = useMemo(() => suggestedPaths(state.eventName), [state.eventName])
  const selectedCandidate = candidates.find(
    (item) => item.target.qualifiedName === state.toolQualifiedName,
  )

  const currentInput = (): HookDefinitionInputV1 | null => {
    try {
      if (state.name.trim() === '') {
        toast.error('请填写 Hook 名称')
        return null
      }
      return toDefinitionInput(state, candidates)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return null
    }
  }

  const runPreview = async (): Promise<void> => {
    const input = currentInput()
    if (input == null) return
    setPreviewLoading(true)
    try {
      const result = await hooksV2Api.preview(input)
      setPreview(result)
      if (!result.valid) toast.warning(`定义存在 ${result.errors.length} 处校验问题`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '预览失败')
    } finally {
      setPreviewLoading(false)
    }
  }

  const runTest = (): void => {
    const input = currentInput()
    if (input == null) return
    AntdModal.confirm({
      title: '执行测试运行？',
      content:
        '测试运行会按当前配置真实执行动作（例如向外部工具发送数据），并产生独立的测试运行记录。此操作不可撤销。',
      okText: '确认执行',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const { run } = await hooksV2Api.testRun(input)
          toast.success(`测试运行已入队（${run.id.slice(0, 8)}…），结果见运行记录`)
        } catch (error) {
          toast.error(error instanceof Error ? error.message : '测试运行失败')
        }
      },
    })
  }

  const save = async (): Promise<void> => {
    const input = currentInput()
    if (input == null) return
    setSaving(true)
    try {
      if (definition == null) {
        const res = await hooksV2Api.createDefinition(input)
        toast.success('Hook 定义已创建；启用前请在「作用域绑定」中完成授权')
        onSaved(res.definition)
      } else {
        const res = await hooksV2Api.updateDefinition(definition.id, input)
        if (res.invalidatedBindings > 0) {
          toast.warning(`执行属性变化，${res.invalidatedBindings} 个绑定需重新授权后才会执行`)
        } else {
          toast.success('Hook 定义已保存')
        }
        onSaved(res.definition)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const eventOptions = (Object.keys(HOOK_EVENT_LABELS) as HookEventNameV1[]).map((name) => ({
    value: name,
    label: `${HOOK_EVENT_LABELS[name].label} · ${name}`,
  }))
  const toolOptions = candidates.map((candidate) => ({
    value: candidate.target.qualifiedName,
    label: candidate.selectable
      ? `${candidate.title}（${candidate.target.sourceKind}）`
      : `${candidate.title}（不可选：${candidate.unselectableReason ?? '策略限制'}）`,
    disabled: !candidate.selectable,
  }))

  return (
    <AntdModal
      open={open}
      title={definition != null ? `编辑 Hook · ${definition.name}` : '新建 Hook'}
      width={720}
      footer={null}
      onCancel={onClose}
      destroyOnHidden
    >
      <div className="hookv2-editor">
        <div className="hookv2-form-row">
          <div className="hookv2-field">
            <div className="hookv2-field-label">名称</div>
            <Input
              value={state.name}
              placeholder="例如：回答完成后发送 Webhook"
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>
          <div className="hookv2-field hookv2-field--wide">
            <div className="hookv2-field-label">说明（可选）</div>
            <Input
              value={state.description}
              placeholder="用途备注，不参与授权哈希"
              onChange={(e) => patch({ description: e.target.value })}
            />
          </div>
        </div>

        <div className="hookv2-form-row">
          <div className="hookv2-field hookv2-field--wide">
            <div className="hookv2-field-label">
              生命周期事件
              <span className="hookv2-field-hint">{HOOK_EVENT_LABELS[state.eventName].desc}</span>
            </div>
            <Select
              value={state.eventName}
              options={eventOptions}
              onChange={(v) => patch({ eventName: v })}
            />
          </div>
        </div>

        <div className="hookv2-form-row">
          <div className="hookv2-field hookv2-field--wide">
            <div className="hookv2-field-label">动作</div>
            <Segmented
              value={state.actionType}
              options={[
                { value: 'builtin.notification', label: '系统通知' },
                { value: 'builtin.sound', label: '提示音' },
                { value: 'tool.invoke', label: '调用工具' },
              ]}
              onChange={(v) => patch({ actionType: v as ActionType })}
            />
          </div>
        </div>

        {state.actionType === 'builtin.notification' && (
          <div className="hookv2-form-row">
            <div className="hookv2-field">
              <div className="hookv2-field-label">
                通知标题（可选，支持 $&#123;path&#125; 模板）
              </div>
              <Input
                value={state.notificationTitle}
                placeholder="留空使用事件默认标题"
                onChange={(e) => patch({ notificationTitle: e.target.value })}
              />
            </div>
            <div className="hookv2-field">
              <div className="hookv2-field-label">通知正文（可选）</div>
              <Input
                value={state.notificationBody}
                placeholder="例如：$&#123;agent.name&#125; 完成了任务"
                onChange={(e) => patch({ notificationBody: e.target.value })}
              />
            </div>
          </div>
        )}

        {state.actionType === 'tool.invoke' && (
          <>
            <div className="hookv2-form-row">
              <div className="hookv2-field hookv2-field--wide">
                <div className="hookv2-field-label">目标工具（来自统一工具目录）</div>
                <Select
                  value={state.toolQualifiedName || undefined}
                  options={toolOptions}
                  placeholder="选择工具"
                  onChange={(v) => patch({ toolQualifiedName: v })}
                />
                {selectedCandidate != null && (
                  <div className="hookv2-field-meta">
                    <Tag>风险：{selectedCandidate.risk}</Tag>
                    <Tag>幂等：{selectedCandidate.idempotency}</Tag>
                    <Tag>effect：{selectedCandidate.effect}</Tag>
                    {selectedCandidate.target.version != null && (
                      <Tag>版本：{selectedCandidate.target.version}</Tag>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="hookv2-form-row">
              <div className="hookv2-field hookv2-field--wide">
                <div className="hookv2-field-label">
                  参数映射
                  <span className="hookv2-field-hint">
                    事件字段 → 工具入参；映射的字段将随动作离开 SparkWork
                  </span>
                </div>
                {state.mappings.length === 0 && (
                  <div className="muted hookv2-mapping-empty">暂无映射，工具将以空参数调用</div>
                )}
                {state.mappings.map((row) => (
                  <div key={row.id} className="hookv2-mapping-row">
                    <Input
                      value={row.field}
                      placeholder="参数名"
                      onChange={(e) =>
                        patch({
                          mappings: state.mappings.map((item) =>
                            item.id === row.id ? { ...item, field: e.target.value } : item,
                          ),
                        })
                      }
                    />
                    <Segmented
                      size="small"
                      value={row.kind}
                      options={[
                        { value: 'path', label: '路径' },
                        { value: 'const', label: '常量' },
                        { value: 'template', label: '模板' },
                      ]}
                      onChange={(v) =>
                        patch({
                          mappings: state.mappings.map((item) =>
                            item.id === row.id ? { ...item, kind: v as MappingKind } : item,
                          ),
                        })
                      }
                    />
                    {row.kind === 'path' ? (
                      <>
                        <Input
                          value={row.value}
                          placeholder="payload.response.finalText"
                          list="hookv2-path-suggestions"
                          onChange={(e) =>
                            patch({
                              mappings: state.mappings.map((item) =>
                                item.id === row.id ? { ...item, value: e.target.value } : item,
                              ),
                            })
                          }
                        />
                        <datalist id="hookv2-path-suggestions">
                          {paths.map((path) => (
                            <option key={path} value={path} />
                          ))}
                        </datalist>
                      </>
                    ) : (
                      <Input
                        value={row.value}
                        placeholder={
                          row.kind === 'template' ? '回答：${payload.response.finalText}' : '固定值'
                        }
                        onChange={(e) =>
                          patch({
                            mappings: state.mappings.map((item) =>
                              item.id === row.id ? { ...item, value: e.target.value } : item,
                            ),
                          })
                        }
                      />
                    )}
                    <Button
                      size="small"
                      type="text"
                      icon={<Icons.Trash size={12} />}
                      onClick={() =>
                        patch({ mappings: state.mappings.filter((item) => item.id !== row.id) })
                      }
                    />
                  </div>
                ))}
                <Button
                  size="small"
                  type="text"
                  icon={<Icons.Plus size={12} />}
                  onClick={() =>
                    patch({
                      mappings: [
                        ...state.mappings,
                        { id: Math.random(), field: '', kind: 'path', value: '' },
                      ],
                    })
                  }
                >
                  添加映射
                </Button>
              </div>
            </div>
          </>
        )}

        <div className="hookv2-fold">
          <button
            type="button"
            className="hookv2-fold-toggle"
            onClick={() => setConditionOpen(!conditionOpen)}
          >
            <Icons.ChevronRight size={12} className={conditionOpen ? 'rot90' : ''} />
            触发条件（可选）
          </button>
          {conditionOpen && (
            <div className="hookv2-fold-body">
              <div className="hookv2-toggle-line">
                <span>仅当条件满足时执行</span>
                <Switch
                  size="small"
                  checked={state.conditionEnabled}
                  onChange={(v) => patch({ conditionEnabled: v })}
                />
              </div>
              {state.conditionEnabled && (
                <div className="hookv2-form-row">
                  <div className="hookv2-field">
                    <div className="hookv2-field-label">操作符</div>
                    <Select
                      value={state.conditionOperator}
                      options={CONDITION_OPERATOR_OPTIONS}
                      onChange={(v) => patch({ conditionOperator: v })}
                    />
                  </div>
                  <div className="hookv2-field">
                    <div className="hookv2-field-label">事件路径</div>
                    <Input
                      value={state.conditionLeft}
                      placeholder="agent.name"
                      list="hookv2-path-suggestions"
                      onChange={(e) => patch({ conditionLeft: e.target.value })}
                    />
                  </div>
                  {state.conditionOperator !== 'exists' && (
                    <div className="hookv2-field">
                      <div className="hookv2-field-label">比较值（常量）</div>
                      <Input
                        value={state.conditionRight}
                        placeholder="比较字符串"
                        onChange={(e) => patch({ conditionRight: e.target.value })}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="hookv2-fold">
          <button
            type="button"
            className="hookv2-fold-toggle"
            onClick={() => setAdvancedOpen(!advancedOpen)}
          >
            <Icons.ChevronRight size={12} className={advancedOpen ? 'rot90' : ''} />
            执行策略
          </button>
          {advancedOpen && (
            <div className="hookv2-fold-body">
              <div className="hookv2-form-row">
                <div className="hookv2-field">
                  <div className="hookv2-field-label">超时（毫秒）</div>
                  <InputNumber
                    value={state.timeoutMs}
                    min={1000}
                    max={120000}
                    step={1000}
                    onChange={(v) => patch({ timeoutMs: toNumber(v, 15_000) })}
                  />
                </div>
                <div className="hookv2-field">
                  <div className="hookv2-field-label">最大尝试次数</div>
                  <InputNumber
                    value={state.maxAttempts}
                    min={1}
                    max={10}
                    onChange={(v) => patch({ maxAttempts: toNumber(v, 3) })}
                  />
                </div>
                <div className="hookv2-field">
                  <div className="hookv2-field-label">退避基数（毫秒）</div>
                  <InputNumber
                    value={state.backoffMs}
                    min={0}
                    max={600000}
                    step={500}
                    onChange={(v) => patch({ backoffMs: toNumber(v, 1000) })}
                  />
                </div>
              </div>
              <div className="hookv2-form-row">
                <div className="hookv2-field">
                  <div className="hookv2-field-label">重试策略</div>
                  <Select
                    value={state.retryMode}
                    options={Object.entries(HOOK_RETRY_MODE_LABELS).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    onChange={(v) => patch({ retryMode: v as EditorState['retryMode'] })}
                  />
                </div>
                <div className="hookv2-field">
                  <div className="hookv2-field-label">并发策略</div>
                  <Segmented
                    value={state.concurrency}
                    options={[
                      { value: 'serial_per_session', label: '会话内串行' },
                      { value: 'parallel', label: '并行' },
                    ]}
                    onChange={(v) => patch({ concurrency: v as EditorState['concurrency'] })}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {preview != null && (
          <div className="hookv2-preview">
            <div className="hookv2-preview-head">
              <Icons.Eye size={12} /> 映射预览（不执行动作）
            </div>
            {preview.errors.length > 0 && (
              <ul className="hookv2-preview-errors">
                {preview.errors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            )}
            <div className="hookv2-preview-line">
              条件判定：
              <Tag>{preview.conditionMatched ? '匹配' : '不匹配'}</Tag>
            </div>
            {Object.keys(preview.mappedInput).length > 0 && (
              <div className="hookv2-preview-line">
                将发送的字段：
                <pre>{JSON.stringify(preview.mappedInput, null, 2)}</pre>
              </div>
            )}
          </div>
        )}

        <div className="hookv2-editor-footer">
          <div className="hookv2-editor-footer-left">
            <Button
              loading={previewLoading}
              icon={<Icons.Eye size={12} />}
              onClick={() => void runPreview()}
            >
              预览
            </Button>
            <Button icon={<Icons.Play size={12} />} onClick={runTest}>
              测试运行
            </Button>
          </div>
          <div className="hookv2-editor-footer-right">
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" loading={saving} onClick={() => void save()}>
              {definition != null ? '保存' : '创建'}
            </Button>
          </div>
        </div>
      </div>
    </AntdModal>
  )
}
