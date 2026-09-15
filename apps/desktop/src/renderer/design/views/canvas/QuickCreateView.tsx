import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from 'react'
import { AutoComplete, Input, Modal, Select, Spin, message } from 'antd'
import { Button } from '@lobehub/ui'
import type {
  CanvasMediaModelSummary,
  CanvasMediaTaskAsset,
  CanvasMediaTaskCreateResponse,
  CanvasMediaTaskInputFile,
  CanvasMediaTaskStreamPayload,
  CanvasTextTaskCreateResponse,
  CanvasTextTaskStreamPayload,
  MediaCapabilityId,
  ProviderProfile,
} from '@spark/protocol'
import { Icons } from '../../Icons'
import { SidebarExpandButton } from '../../SidebarExpandButton'
import { useApp } from '../../AppContext'
import { canvasApi } from './canvas.api'
import { CanvasModelPicker } from './CanvasModelPicker'
import {
  buildModelParams,
  mergeSchemaFields,
  modelSuggestedFields,
  operationDefaultModelParams,
  operationSuggestedFields,
  resolveInitialModelParamDraftValue,
  schemaFields,
  updateModelParamDraftValue,
} from './CanvasInlineAiComposer'
import {
  aspectRatioOptions,
  aspectRatioShape,
  aspectRatioShortLabel,
  isAspectRatioValue,
  parameterOptionValues,
  partitionParameterFields,
  type CanvasParameterPresentation,
} from './canvasParameterPresentation'
import type { CanvasOperationType } from './canvas.types'
import { resolveMediaDisplayUrl } from './canvas-safe-file'
import { mediaModelKey } from './canvasModelPickerModel'
import { QuickCreateOutputPanel } from './QuickCreateOutputPanel'
import { QuickCreateTaskHistory } from './QuickCreateTaskHistory'
import { MODE_ITEMS, modeLabel, titleForPrompt } from './quickCreateTaskPresentation'
import {
  quickCreateParamScope,
  readQuickCreateCustomSizeHistory,
  readQuickCreatePreferences,
  recordQuickCreateCustomSize,
  removeQuickCreateCustomSize,
  writeQuickCreatePreferences,
  type QuickCreatePreferences,
} from './quickCreatePreferences'
import {
  readGlobalPromptLibrary,
  writeGlobalPromptLibrary,
  type GlobalPromptLibraryItem,
} from './canvasPromptLibraryStore'
import {
  readQuickCreateTasks,
  writeQuickCreateTasks,
  type QuickCreateMode,
  type QuickCreateTaskRecord,
} from './quickCreateTaskStore'
import './QuickCreateView.less'

type QuickInput = CanvasMediaTaskInputFile & {
  id: string
  name: string
  previewUrl: string
}

const QUICK_CREATE_MAX_INPUT_BYTES = 72 * 1024 * 1024

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('无法读取剪贴板图片'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('无法读取剪贴板图片'))
    reader.readAsDataURL(blob)
  })
}

function quickParameterLabel(presentation: CanvasParameterPresentation): string {
  if (presentation.control === 'count') return '生成数量'
  return presentation.label.replace(
    /\s+(size|aspect_ratio|aspectRatio|resolution|quality|image_format|durationSeconds)$/i,
    '',
  )
}

/** 比例矩形按等比缩放（CSS max-width/height 会各自截断导致比例失真，必须在 JS 侧缩放） */
function scaledRatioShape(value: string, scale: number) {
  const shape = aspectRatioShape(value)
  return {
    width: Math.max(5, Math.round(shape.width * scale)),
    height: Math.max(5, Math.round(shape.height * scale)),
    ...(shape.adaptive ? { adaptive: true } : {}),
  }
}

/** 重复的约简比例（如 1024x1024 与 2048x2048 都是 1:1）附加分辨率档位区分 */
function resolutionBucket(value: string): string {
  const width = Number(
    value
      .trim()
      .toLowerCase()
      .match(/^(\d+)[x×*]/)?.[1] ?? 0,
  )
  if (width >= 4096) return '4K'
  if (width >= 2048) return '2K'
  if (width >= 1024) return '1K'
  return String(width || '')
}

function ratioButtonLabel(
  option: string,
  field: CanvasParameterPresentation['field'],
  shortLabelCounts: Map<string, number>,
): string {
  const enumLabel = field.enumLabels?.[option]
  if (enumLabel && enumLabel !== option) return enumLabel
  const short = aspectRatioShortLabel(option)
  if (!short) return option
  if ((shortLabelCounts.get(short) ?? 0) > 1) {
    const bucket = resolutionBucket(option)
    return bucket ? `${short} · ${bucket}` : option
  }
  return short
}

function QuickCreateCountStepper({
  presentation,
  value,
  onChange,
}: {
  presentation: CanvasParameterPresentation
  value: string
  onChange: (value: string) => void
}) {
  const options = parameterOptionValues(presentation.field)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
  const minimum = presentation.field.minimum ?? Math.min(...options, 1)
  const maximum = presentation.field.maximum ?? Math.max(...options, 4)
  const parsed = Number(value)
  const current = Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.round(parsed)))
    : minimum
  return (
    <div className="quick-create-count-stepper" aria-label="生成数量">
      <button
        type="button"
        aria-label="减少生成数量"
        disabled={current <= minimum}
        onClick={() => onChange(String(current - 1))}
      >
        <Icons.Minus size={14} />
      </button>
      <input
        aria-label="生成数量"
        inputMode="numeric"
        min={minimum}
        max={maximum}
        step={1}
        type="number"
        value={value}
        placeholder={String(current)}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => onChange(String(current))}
      />
      <span>张</span>
      <button
        type="button"
        aria-label="增加生成数量"
        disabled={current >= maximum}
        onClick={() => onChange(String(current + 1))}
      >
        <Icons.Plus size={14} />
      </button>
    </div>
  )
}

function QuickCreateSizeControl({
  presentation,
  value,
  parameterScope,
  onChange,
  onRemoveCustomSize,
}: {
  presentation: CanvasParameterPresentation
  value: string
  parameterScope: string
  onChange: (value: string) => void
  onRemoveCustomSize: (fieldName: string, value: string) => void
}) {
  const { field, control } = presentation
  const allOptions = parameterOptionValues(field)
  const ratioOptions = (control === 'size' ? allOptions : aspectRatioOptions(field)).filter(
    isAspectRatioValue,
  )
  const visualOptions = ratioOptions.slice(0, 6)
  const overflowRatioOptions = ratioOptions.filter((option) => !visualOptions.includes(option))
  const resolutionOptions =
    control === 'size' ? allOptions.filter((option) => !isAspectRatioValue(option)) : []
  const history = field.allowCustom
    ? readQuickCreateCustomSizeHistory(parameterScope, field.name)
    : []
  const normalizedValue = value.trim()
  const customPreview =
    field.allowCustom &&
    normalizedValue &&
    !allOptions.includes(normalizedValue) &&
    isAspectRatioValue(normalizedValue)
      ? aspectRatioShape(normalizedValue)
      : null
  const moreGroups = [
    ...(overflowRatioOptions.length > 0
      ? [
          {
            label: '画面比例',
            options: overflowRatioOptions.map((option) => ({
              value: option,
              label: field.enumLabels?.[option] ?? option,
            })),
          },
        ]
      : []),
    ...(resolutionOptions.length > 0
      ? [
          {
            label: '分辨率',
            options: resolutionOptions.map((option) => ({
              value: option,
              label: field.enumLabels?.[option] ?? option,
            })),
          },
        ]
      : []),
  ]

  const shortLabelCounts = new Map<string, number>()
  for (const option of visualOptions) {
    const short = aspectRatioShortLabel(option)
    if (short) shortLabelCounts.set(short, (shortLabelCounts.get(short) ?? 0) + 1)
  }

  return (
    <div className="quick-create-parameter-field is-size-field" data-parameter-name={field.name}>
      <div className="quick-create-parameter-label is-size-label">
        <span>{quickParameterLabel(presentation)}</span>
        <em>{value ? (field.enumLabels?.[value] ?? value) : '默认'}</em>
      </div>
      {visualOptions.length > 0 && (
        <div className="quick-create-size-grid" role="group" aria-label="画面比例">
          {visualOptions.map((option) => {
            const shape = scaledRatioShape(option, 0.72)
            return (
              <button
                key={option}
                type="button"
                className={option === value ? 'is-selected' : ''}
                aria-pressed={option === value}
                title={field.enumLabels?.[option] ?? option}
                onClick={() => onChange(option)}
              >
                <span className="quick-create-size-frame-wrap">
                  <span
                    className={`quick-create-size-frame${shape.adaptive ? ' is-adaptive' : ''}`}
                    style={{ width: shape.width, height: shape.height }}
                  />
                </span>
                <span>{ratioButtonLabel(option, field, shortLabelCounts)}</span>
              </button>
            )
          })}
        </div>
      )}
      {(moreGroups.length > 0 || field.allowCustom) && (
        <div className="quick-create-size-extra">
          {moreGroups.length > 0 && (
            <Select
              className="quick-create-size-more"
              aria-label="更多尺寸"
              value={allOptions.includes(value) ? value : undefined}
              placeholder="更多尺寸"
              options={moreGroups}
              onChange={(next) => onChange(String(next))}
            />
          )}
          {field.allowCustom && (
            <AutoComplete
              className="quick-create-size-input"
              value={value || undefined}
              options={[...new Set([...allOptions, ...history])].map((option) => ({
                value: option,
                label: field.enumLabels?.[option] ?? option,
              }))}
              allowClear
              placeholder="自定义尺寸，如 1536x1024"
              onChange={(next) => onChange(next == null ? '' : String(next))}
              filterOption={(input, option) =>
                String(option?.value ?? option?.label ?? '')
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
            />
          )}
        </div>
      )}
      {customPreview && (
        <div className="quick-create-size-custom-preview" aria-label={`预览尺寸 ${value}`}>
          <span
            className={`quick-create-size-frame${customPreview.adaptive ? ' is-adaptive' : ''}`}
            style={{ width: customPreview.width, height: customPreview.height }}
          />
          <span>{value}</span>
        </div>
      )}
      {history.length > 0 && (
        <div className="quick-create-size-history" aria-label="已保存的自定义尺寸">
          {history.map((savedValue) => {
            const shape = scaledRatioShape(savedValue, 0.5)
            return (
              <span
                className={`quick-create-size-history-item${savedValue === value ? ' is-selected' : ''}`}
                key={savedValue}
              >
                <button type="button" onClick={() => onChange(savedValue)}>
                  <span
                    className="quick-create-size-history-frame"
                    style={{ width: shape.width, height: shape.height }}
                  />
                  {savedValue}
                </button>
                <button
                  type="button"
                  aria-label={`删除自定义尺寸 ${savedValue}`}
                  onClick={() => onRemoveCustomSize(field.name, savedValue)}
                >
                  <Icons.X size={11} />
                </button>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

function QuickCreateParameterControl({
  presentation,
  value,
  parameterScope,
  onChange,
  onRemoveCustomSize,
}: {
  presentation: CanvasParameterPresentation
  value: string
  parameterScope: string
  onChange: (value: string) => void
  onRemoveCustomSize: (fieldName: string, value: string) => void
}) {
  const { field, control } = presentation
  if (control === 'aspect-ratio' || control === 'size') {
    return (
      <QuickCreateSizeControl
        presentation={presentation}
        value={value}
        parameterScope={parameterScope}
        onChange={onChange}
        onRemoveCustomSize={onRemoveCustomSize}
      />
    )
  }
  if (control === 'count') {
    return (
      <div className="quick-create-parameter-field" data-parameter-name={field.name}>
        <div className="quick-create-parameter-label">
          <span>{quickParameterLabel(presentation)}</span>
        </div>
        <QuickCreateCountStepper presentation={presentation} value={value} onChange={onChange} />
      </div>
    )
  }

  const options = parameterOptionValues(field).map((option) => ({
    value: option,
    label: field.enumLabels?.[option] ?? option,
  }))
  const isNumber = field.type === 'integer' || field.type === 'number'
  const isAutocomplete = control === 'autocomplete' || field.allowCustom === true
  return (
    <div className="quick-create-parameter-field" data-parameter-name={field.name}>
      <div className="quick-create-parameter-label">
        <span>{quickParameterLabel(presentation)}</span>
      </div>
      {isAutocomplete ? (
        <AutoComplete
          value={value || undefined}
          options={options}
          allowClear
          placeholder={field.placeholder ?? '默认'}
          onChange={(next) => onChange(next == null ? '' : String(next))}
          filterOption={(input, option) =>
            String(option?.label ?? option?.value ?? '')
              .toLowerCase()
              .includes(input.toLowerCase())
          }
        />
      ) : options.length > 0 || control === 'boolean' ? (
        <Select
          value={value || undefined}
          options={
            control === 'boolean'
              ? [
                  { value: 'true', label: '开启' },
                  { value: 'false', label: '关闭' },
                ]
              : options
          }
          allowClear
          placeholder="默认"
          onChange={(next) => onChange(next == null ? '' : String(next))}
        />
      ) : (
        <Input
          value={value}
          type={isNumber ? 'number' : 'text'}
          min={isNumber ? field.minimum : undefined}
          max={isNumber ? field.maximum : undefined}
          step={isNumber && field.type === 'integer' ? 1 : field.multipleOf}
          placeholder={field.placeholder ?? '默认'}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  )
}

function QuickCreateParameterPanel({
  fields,
  values,
  parameterScope,
  onChange,
}: {
  fields: ReturnType<typeof schemaFields>
  values: Record<string, string>
  parameterScope: string
  onChange: (name: string, value: string) => void
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [customSizeHistoryVersion, setCustomSizeHistoryVersion] = useState(0)
  const groups = useMemo(() => {
    const partitioned = partitionParameterFields(fields)
    const isQuality = (presentation: CanvasParameterPresentation) =>
      /^(image|video)?quality$/i.test(presentation.field.name.replace(/[^a-z]/gi, ''))
    return {
      common: partitioned.common.filter((presentation) => !isQuality(presentation)),
      advanced: [
        ...partitioned.advanced,
        ...partitioned.common.filter((presentation) => isQuality(presentation)),
      ],
    }
  }, [fields])
  const removeCustomSize = useCallback(
    (fieldName: string, value: string) => {
      removeQuickCreateCustomSize(parameterScope, fieldName, value)
      setCustomSizeHistoryVersion((current) => current + 1)
    },
    [parameterScope],
  )
  const advancedSummary = useMemo(() => {
    const parts: string[] = []
    for (const presentation of groups.advanced) {
      const raw = values[presentation.field.name]?.trim()
      if (!raw) continue
      parts.push(
        `${quickParameterLabel(presentation)} ${presentation.field.enumLabels?.[raw] ?? raw}`,
      )
      if (parts.length >= 3) break
    }
    return parts.length > 0 ? parts.join(' · ') : '默认'
  }, [groups.advanced, values])
  if (fields.length === 0) return null
  return (
    <div className="quick-create-parameter-panel">
      <div className="quick-create-parameter-grid">
        {groups.common.map((presentation) => (
          <QuickCreateParameterControl
            key={`${presentation.field.name}-${customSizeHistoryVersion}`}
            presentation={presentation}
            value={values[presentation.field.name] ?? ''}
            parameterScope={parameterScope}
            onChange={(next) => onChange(presentation.field.name, next)}
            onRemoveCustomSize={removeCustomSize}
          />
        ))}
        {groups.advanced.length > 0 && (
          <button
            type="button"
            className={`quick-create-advanced-toggle${advancedOpen ? ' is-open' : ''}`}
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((current) => !current)}
          >
            <Icons.Sliders size={12} />
            <span className="quick-create-advanced-name">高级</span>
            <span className="quick-create-advanced-summary">{advancedSummary}</span>
            <Icons.ChevronDown size={12} className={advancedOpen ? 'is-open' : ''} />
          </button>
        )}
      </div>
      {advancedOpen && groups.advanced.length > 0 && (
        <div className="quick-create-parameter-grid is-advanced">
          {groups.advanced.map((presentation) => (
            <QuickCreateParameterControl
              key={`${presentation.field.name}-${customSizeHistoryVersion}`}
              presentation={presentation}
              value={values[presentation.field.name] ?? ''}
              parameterScope={parameterScope}
              onChange={(next) => onChange(presentation.field.name, next)}
              onRemoveCustomSize={removeCustomSize}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const IMAGE_CAPABILITIES: MediaCapabilityId[] = ['image.generate', 'image.edit']
const VIDEO_CAPABILITIES: MediaCapabilityId[] = [
  'video.generate',
  'video.image_to_video',
  'video.reference_to_video',
  'video.edit',
]

function now(): string {
  return new Date().toISOString()
}

function guessMimeType(filePath: string, kind: 'image' | 'video'): string {
  const extension = filePath.split('.').pop()?.toLowerCase()
  const byExtension: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    m4v: 'video/x-m4v',
  }
  return byExtension[extension ?? ''] ?? `${kind}/*`
}

async function prepareInputFile(filePath: string, kind: 'image' | 'video'): Promise<QuickInput> {
  const mimeType = guessMimeType(filePath, kind)
  const saved = await window.spark.invoke('file:prepare-media-input', {
    sourcePath: filePath,
    kind,
  })
  if (saved.sizeBytes > QUICK_CREATE_MAX_INPUT_BYTES) {
    throw new Error('输入视频或图片不能超过 72MB')
  }
  return {
    id: `${Date.now()}-${saved.filePath}`,
    name: filePath.split(/[\\/]/).pop() || '输入素材',
    type: kind,
    role: 'input',
    path: saved.filePath,
    url: saved.fileUrl,
    mimeType,
    sizeBytes: saved.sizeBytes,
    previewUrl: saved.fileUrl,
  }
}

async function preparePastedImage(file: File, index: number): Promise<QuickInput> {
  if (file.size > QUICK_CREATE_MAX_INPUT_BYTES) {
    throw new Error('粘贴图片不能超过 72MB')
  }
  const dataUrl = await readBlobAsDataUrl(file)
  const saved = await window.spark.invoke('file:save-pasted-image', {
    dataUrl,
    suggestedBaseName: `quick-create-pasted-${index + 1}`,
    ...(file.type ? { mimeType: file.type } : {}),
  })
  return {
    id: `${Date.now()}-${index}-${saved.filePath}`,
    name: saved.fileName,
    type: 'image',
    role: 'input',
    path: saved.filePath,
    mimeType: file.type || 'image/png',
    sizeBytes: file.size,
    previewUrl: resolveMediaDisplayUrl({ filePath: saved.filePath }),
  }
}

function operationFor(mode: QuickCreateMode, inputs: readonly QuickInput[]): CanvasOperationType {
  if (mode === 'reverse') return 'image_prompt_reverse'
  if (mode === 'image') return inputs.length > 0 ? 'image_edit' : 'text_to_image'
  if (inputs.some((input) => input.type === 'video')) return 'video_edit'
  return inputs.length > 0 ? 'image_to_video' : 'text_to_video'
}

function capabilityFor(
  mode: QuickCreateMode,
  inputs: readonly QuickInput[],
  model?: CanvasMediaModelSummary,
): MediaCapabilityId | undefined {
  if (mode === 'reverse') return undefined
  const candidates: MediaCapabilityId[] =
    mode === 'image'
      ? inputs.length > 0
        ? ['image.edit']
        : IMAGE_CAPABILITIES
      : inputs.some((input) => input.type === 'video')
        ? ['video.edit']
        : inputs.length > 0
          ? ['video.image_to_video', 'video.reference_to_video', 'video.generate']
          : ['video.generate', 'video.reference_to_video']
  return (
    candidates.find((id) => model?.capabilities.some((item) => item.id === id)) ?? candidates[0]
  )
}

function quickInputFromTaskFile(file: CanvasMediaTaskInputFile, index: number): QuickInput {
  const source = file.path ?? file.url ?? ''
  return {
    ...file,
    id: `restored-${index}-${source}`,
    name: source.split(/[\\/]/).pop() || `输入素材 ${index + 1}`,
    previewUrl: resolveMediaDisplayUrl({ url: file.url, filePath: file.path }),
  }
}

export function QuickCreateView() {
  const { t } = useApp()
  const [savedPreferences] = useState<QuickCreatePreferences>(() => readQuickCreatePreferences())
  const [activeTab, setActiveTab] = useState<'compose' | 'tasks'>('compose')
  const [mode, setMode] = useState<QuickCreateMode>(savedPreferences?.mode ?? 'image')
  const [prompt, setPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [inputs, setInputs] = useState<QuickInput[]>([])
  const [tasks, setTasks] = useState<QuickCreateTaskRecord[]>(readQuickCreateTasks)
  const [models, setModels] = useState<CanvasMediaModelSummary[]>([])
  const [textProviders, setTextProviders] = useState<ProviderProfile[]>([])
  const [modelKey, setModelKey] = useState(savedPreferences?.modelKey ?? '')
  const [textProviderId, setTextProviderId] = useState(savedPreferences?.textProviderId ?? '')
  const [textModelId, setTextModelId] = useState(savedPreferences?.textModelId ?? '')
  const [modelParamDraft, setModelParamDraft] = useState<Record<string, string>>({})
  const [modelsLoading, setModelsLoading] = useState(true)
  const [promptLibrary, setPromptLibrary] = useState<GlobalPromptLibraryItem[]>([])
  const [promptPickerOpen, setPromptPickerOpen] = useState(false)
  const [negativeOpen, setNegativeOpen] = useState(false)
  const [promptSearch, setPromptSearch] = useState('')
  const [pendingSubmissions, setPendingSubmissions] = useState(0)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null)
  const [paramReadyScope, setParamReadyScope] = useState('')
  const taskIdsRef = useRef(new Set(tasks.map((task) => task.id)))
  const hydratingParamsRef = useRef(false)

  const updateTask = useCallback((id: string, patch: Partial<QuickCreateTaskRecord>) => {
    setTasks((current) => {
      const next = current.map((task) =>
        task.id === id ? { ...task, ...patch, updatedAt: now() } : task,
      )
      writeQuickCreateTasks(next)
      return next
    })
  }, [])

  const operation = operationFor(mode, inputs)
  const compatibleModels = useMemo(
    () =>
      models.filter((model) => {
        const candidate = capabilityFor(mode, inputs, model)
        return candidate != null && model.capabilities.some((item) => item.id === candidate)
      }),
    [inputs, mode, models],
  )
  const effectiveModelKey = compatibleModels.some((model) => mediaModelKey(model) === modelKey)
    ? modelKey
    : compatibleModels[0]
      ? mediaModelKey(compatibleModels[0])
      : ''
  const selectedModel = useMemo(
    () => models.find((model) => mediaModelKey(model) === effectiveModelKey),
    [effectiveModelKey, models],
  )
  const capabilityId = capabilityFor(mode, inputs, selectedModel)
  const selectedCapability = selectedModel?.capabilities.find((item) => item.id === capabilityId)
  const requestInputs = useMemo<CanvasMediaTaskInputFile[]>(
    () =>
      inputs.map((input, index) => {
        const role =
          mode === 'image'
            ? index === 0
              ? ('input' as const)
              : ('reference' as const)
            : capabilityId === 'video.reference_to_video' || capabilityId === 'video.generate'
              ? ('reference' as const)
              : input.type === 'video'
                ? ('input' as const)
                : index === 0
                  ? ('first_frame' as const)
                  : ('reference' as const)
        return { ...input, role }
      }),
    [capabilityId, inputs, mode],
  )
  const selectedTextProvider = useMemo(
    () => textProviders.find((provider) => provider.id === textProviderId) ?? textProviders[0],
    [textProviderId, textProviders],
  )
  const effectiveTextProviderId = selectedTextProvider?.id ?? ''
  const effectiveTextModelId =
    textModelId && selectedTextProvider?.modelIds.includes(textModelId)
      ? textModelId
      : (selectedTextProvider?.defaultModel ?? '')
  const fields = useMemo(
    () =>
      mode === 'reverse'
        ? []
        : mergeSchemaFields(
            schemaFields(selectedCapability?.paramSchema ?? {}),
            operationSuggestedFields(operation),
            modelSuggestedFields(selectedModel),
          ),
    [mode, operation, selectedCapability, selectedModel],
  )
  const parameterScope = useMemo(
    () =>
      quickCreateParamScope({
        operation,
        modelKey: effectiveModelKey,
        ...(capabilityId ? { capabilityId } : {}),
      }),
    [capabilityId, effectiveModelKey, operation],
  )
  const filteredPrompts = useMemo(() => {
    const keyword = promptSearch.trim().toLowerCase()
    return promptLibrary.filter(
      (item) =>
        !keyword ||
        `${item.title} ${item.text} ${item.tags.join(' ')}`.toLowerCase().includes(keyword),
    )
  }, [promptLibrary, promptSearch])
  const stats = useMemo(
    () => ({
      total: tasks.length,
      running: tasks.filter((task) => task.status === 'running').length,
      succeeded: tasks.filter((task) => task.status === 'succeeded').length,
    }),
    [tasks],
  )
  const focusedTask = useMemo(
    () => (focusedTaskId ? tasks.find((task) => task.id === focusedTaskId) : undefined) ?? tasks[0],
    [focusedTaskId, tasks],
  )

  useEffect(() => {
    writeQuickCreatePreferences({
      ...readQuickCreatePreferences(),
      mode,
      ...(effectiveModelKey ? { modelKey: effectiveModelKey } : {}),
      ...(effectiveTextProviderId ? { textProviderId: effectiveTextProviderId } : {}),
      ...(effectiveTextModelId ? { textModelId: effectiveTextModelId } : {}),
    })
  }, [effectiveModelKey, effectiveTextModelId, effectiveTextProviderId, mode])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      Promise.all(
        IMAGE_CAPABILITIES.map((capability) =>
          canvasApi.listMediaModels({ capability, enabledOnly: true }),
        ),
      ),
      Promise.all(
        VIDEO_CAPABILITIES.map((capability) =>
          canvasApi.listMediaModels({ capability, enabledOnly: true }),
        ),
      ),
      window.spark.invoke('provider:list', { includeDisabled: false }),
      readGlobalPromptLibrary(),
    ])
      .then(([imageResults, videoResults, providerResult, library]) => {
        if (cancelled) return
        const nextModels = [...imageResults, ...videoResults]
          .flatMap((result) => result.models)
          .filter(
            (model, index, list) =>
              list.findIndex((candidate) => mediaModelKey(candidate) === mediaModelKey(model)) ===
              index,
          )
        setModels(nextModels)
        setTextProviders(
          providerResult.profiles.filter(
            (provider) =>
              provider.enabled !== false &&
              Boolean(provider.keystoreRef) &&
              provider.modelType === 'multimodal',
          ),
        )
        setPromptLibrary(library.items)
      })
      .catch((error) => {
        if (!cancelled) {
          setModels([])
          setTextProviders([])
          message.warning(error instanceof Error ? error.message : '快速创作配置加载失败')
        }
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    hydratingParamsRef.current = true
    const defaults: Record<string, unknown> = {
      ...operationDefaultModelParams(operation, selectedModel),
      ...(selectedCapability?.defaults ?? {}),
    }
    const cachedParams = readQuickCreatePreferences().paramsByScope?.[parameterScope] ?? {}
    const next: Record<string, string> = {}
    for (const field of fields) {
      const value = resolveInitialModelParamDraftValue({
        operation,
        field,
        fieldName: field.name,
        presetParams: {},
        existingParams: {},
        defaultParams: defaults,
      })
      const cachedValue = cachedParams[field.name]
      if (cachedValue) next[field.name] = cachedValue
      else if (value) next[field.name] = value
    }
    setModelParamDraft(next)
    setParamReadyScope(parameterScope)
  }, [fields, operation, parameterScope, selectedCapability, selectedModel])

  useEffect(() => {
    if (paramReadyScope !== parameterScope) return
    if (hydratingParamsRef.current) {
      hydratingParamsRef.current = false
      return
    }
    const current = readQuickCreatePreferences()
    writeQuickCreatePreferences({
      ...current,
      paramsByScope: {
        ...(current.paramsByScope ?? {}),
        [parameterScope]: modelParamDraft,
      },
    })
  }, [modelParamDraft, paramReadyScope, parameterScope])

  useEffect(() => {
    const unsubscribeMedia = window.spark.on(
      'stream:canvas:media-task',
      (payload: CanvasMediaTaskStreamPayload) => {
        if (!payload.clientTaskId || !taskIdsRef.current.has(payload.clientTaskId)) return
        const response = payload.response
        updateTask(payload.clientTaskId, {
          status:
            payload.status === 'running'
              ? 'running'
              : response.status === 'cancelled'
                ? 'cancelled'
                : response.status === 'succeeded'
                  ? 'succeeded'
                  : 'failed',
          ...(response.providerProfileId ? { providerProfileId: response.providerProfileId } : {}),
          ...(response.provider ? { providerName: response.provider } : {}),
          ...(response.model ? { modelId: response.model } : {}),
          ...(response.runtimeTaskId ? { runtimeTaskId: response.runtimeTaskId } : {}),
          ...(response.requestId ? { requestId: response.requestId } : {}),
          assets: response.assets,
          ...(response.error ? { error: response.error } : {}),
          ...(response.progress !== undefined ? { progress: response.progress } : {}),
        })
      },
    )
    const unsubscribeText = window.spark.on(
      'stream:canvas:text-task',
      (payload: CanvasTextTaskStreamPayload) => {
        if (!payload.clientTaskId || !taskIdsRef.current.has(payload.clientTaskId)) return
        const response = payload.response
        updateTask(payload.clientTaskId, {
          status: response.status === 'succeeded' ? 'succeeded' : 'failed',
          ...(response.providerProfileId ? { providerProfileId: response.providerProfileId } : {}),
          ...(response.provider ? { providerName: response.provider } : {}),
          ...(response.model ? { modelId: response.model } : {}),
          text: response.text,
          ...(response.error ? { error: response.error } : {}),
        })
      },
    )
    return () => {
      unsubscribeMedia()
      unsubscribeText()
    }
  }, [updateTask])

  const addTask = useCallback((task: QuickCreateTaskRecord) => {
    taskIdsRef.current.add(task.id)
    setTasks((current) => {
      const next = [task, ...current.filter((item) => item.id !== task.id)]
      writeQuickCreateTasks(next)
      return next
    })
  }, [])

  const handleChooseFiles = useCallback(
    async (filePaths: string[]) => {
      const allowedKind = mode === 'video' ? undefined : 'image'
      const selectedPaths = allowedKind
        ? filePaths.filter((filePath) => /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(filePath))
        : filePaths.filter((filePath) =>
            /\.(png|jpe?g|webp|gif|bmp|heic|heif|mp4|mov|webm|m4v)$/i.test(filePath),
          )
      if (selectedPaths.length === 0) {
        message.warning(mode === 'video' ? '请选择图片或视频素材' : '请选择图片素材')
        return
      }
      if (mode === 'reverse' && selectedPaths.length > 1) {
        message.warning('图片反推仅支持一张输入图片')
        return
      }
      try {
        const prepared = await Promise.all(
          selectedPaths
            .slice(0, mode === 'reverse' ? 1 : 6)
            .map((filePath) =>
              prepareInputFile(
                filePath,
                /\.(mp4|mov|webm|m4v)$/i.test(filePath) ? 'video' : 'image',
              ),
            ),
        )
        setInputs(mode === 'reverse' ? prepared.slice(0, 1) : prepared)
      } catch (error) {
        message.error(error instanceof Error ? error.message : '读取输入素材失败')
      }
    },
    [mode],
  )

  const handlePasteInput = useCallback(
    async (event: ReactClipboardEvent<HTMLDivElement>) => {
      const imageItems = Array.from(event.clipboardData?.items ?? []).filter((item) =>
        item.type.startsWith('image/'),
      )
      if (imageItems.length === 0) return
      event.preventDefault()
      try {
        const pasted = await Promise.all(
          imageItems.slice(0, mode === 'reverse' ? 1 : 6).map((item, index) => {
            const file = item.getAsFile()
            return file ? preparePastedImage(file, index) : null
          }),
        )
        const prepared = pasted.filter((item): item is QuickInput => item != null)
        if (prepared.length === 0) return
        setInputs((current) =>
          mode === 'reverse' ? prepared.slice(0, 1) : [...current, ...prepared].slice(0, 6),
        )
        message.success(`已粘贴 ${prepared.length} 张图片`)
      } catch (error) {
        message.error(error instanceof Error ? error.message : '粘贴图片失败')
      }
    },
    [mode],
  )

  const handlePickFiles = useCallback(async () => {
    try {
      const picked = await window.spark.invoke('dialog:open-file', {
        title: mode === 'video' ? '选择图片或视频素材' : '选择输入图片',
        multiple: mode !== 'reverse',
        filters:
          mode === 'video'
            ? [
                {
                  name: '图片与视频',
                  extensions: [
                    'png',
                    'jpg',
                    'jpeg',
                    'webp',
                    'gif',
                    'bmp',
                    'heic',
                    'heif',
                    'mp4',
                    'mov',
                    'webm',
                    'm4v',
                  ],
                },
              ]
            : [
                {
                  name: '图片',
                  extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'heif'],
                },
              ],
      })
      const paths = picked.filePaths ?? (picked.filePath ? [picked.filePath] : [])
      if (!picked.canceled && paths.length > 0) await handleChooseFiles(paths)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '打开素材选择器失败')
    }
  }, [handleChooseFiles, mode])

  const handleModeChange = (nextMode: QuickCreateMode) => {
    setMode(nextMode)
    setPrompt('')
    setNegativePrompt('')
    setNegativeOpen(false)
    setInputs([])
    setPromptPickerOpen(false)
  }

  const saveCurrentPrompt = useCallback(async () => {
    const text = prompt.trim()
    if (!text) {
      message.warning('请输入提示词后再保存')
      return
    }
    try {
      const library = await readGlobalPromptLibrary()
      const existing = library.items.find((item) => item.text.trim() === text)
      const timestamp = now()
      const item: GlobalPromptLibraryItem = existing
        ? { ...existing, usageCount: existing.usageCount + 1, updatedAt: timestamp }
        : {
            id: `quick-create-${Date.now()}`,
            title: titleForPrompt(text, mode),
            text,
            category: '快速创作',
            tags: [modeLabel(mode)],
            coverUrl: null,
            coverMimeType: null,
            usageCount: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          }
      const next = existing
        ? library.items.map((candidate) => (candidate.id === existing.id ? item : candidate))
        : [item, ...library.items]
      await writeGlobalPromptLibrary({ ...library, items: next })
      setPromptLibrary(next)
      message.success(existing ? '已记录本次使用' : '已保存到提示词库')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存提示词失败')
    }
  }, [mode, prompt])

  const submitTask = useCallback(
    async (source?: QuickCreateTaskRecord) => {
      const taskId =
        source?.id ?? `quick-create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const taskMode = source?.mode ?? mode
      const taskPrompt = source?.prompt ?? prompt.trim()
      const taskInputs: Array<QuickInput | CanvasMediaTaskInputFile> =
        source?.inputFiles ?? requestInputs
      const taskOperation = source?.operation ?? operationFor(taskMode, taskInputs as QuickInput[])
      if (taskMode === 'reverse' && taskInputs.length !== 1) {
        message.warning('图片反推需要先选择一张图片')
        return
      }
      if (taskMode !== 'reverse' && !taskPrompt) {
        message.warning('请先输入提示词')
        return
      }
      const taskModel = source?.modelId ? undefined : selectedModel
      const taskCapability = source?.operation
        ? undefined
        : capabilityFor(taskMode, taskInputs as QuickInput[], selectedModel)
      const params = source?.modelParams ?? buildModelParams(fields, modelParamDraft)
      const providerProfileId =
        source?.providerProfileId ??
        (taskMode === 'reverse' ? effectiveTextProviderId : taskModel?.providerProfileId)
      const modelId =
        source?.modelId ??
        (taskMode === 'reverse' ? effectiveTextModelId : taskModel?.effectiveModelId)
      const providerName = source?.providerName ?? taskModel?.providerName
      const modelName = source?.modelName ?? taskModel?.displayName
      const manifestId = source?.manifestId ?? taskModel?.manifestId
      const record: QuickCreateTaskRecord = {
        id: taskId,
        mode: taskMode,
        operation: taskOperation,
        prompt: taskPrompt,
        ...((source?.negativePrompt ?? negativePrompt.trim())
          ? { negativePrompt: source?.negativePrompt ?? negativePrompt.trim() }
          : {}),
        inputFiles: taskInputs.map((input) => {
          const { id: _id, name: _name, previewUrl: _previewUrl, ...file } = input as QuickInput
          return file
        }),
        ...(providerProfileId ? { providerProfileId } : {}),
        ...(modelId ? { modelId } : {}),
        ...(providerName ? { providerName } : {}),
        ...(modelName ? { modelName } : {}),
        ...(manifestId ? { manifestId } : {}),
        modelParams: params,
        status: 'running',
        assets: [],
        createdAt: source?.createdAt ?? now(),
        updatedAt: now(),
      }
      addTask(record)
      setFocusedTaskId(taskId)
      setActiveTab('compose')
      setExpandedTaskId(taskId)
      setPendingSubmissions((current) => current + 1)
      let requestAccepted = false
      try {
        if (taskMode === 'reverse') {
          const response = (await window.spark.invoke('canvas:task:generate-text', {
            operation: 'image_prompt_reverse',
            prompt:
              '请分析输入图片并反推出可直接用于图片生成的详细提示词。输出主体、构图、镜头、光线、色彩、材质和风格，直接给出提示词，不要解释。',
            inputFiles: record.inputFiles,
            ...(record.providerProfileId ? { providerProfileId: record.providerProfileId } : {}),
            ...(record.modelId ? { modelId: record.modelId } : {}),
            waitForCompletion: false,
            clientTaskId: taskId,
          })) as CanvasTextTaskCreateResponse
          if (response.status !== 'running') {
            updateTask(taskId, {
              status: response.status === 'succeeded' ? 'succeeded' : 'failed',
              providerProfileId: response.providerProfileId,
              providerName: response.provider,
              modelId: response.model,
              text: response.text,
              ...(response.error ? { error: response.error } : {}),
            })
          }
        } else {
          const response = (await window.spark.invoke('canvas:task:create-media', {
            operation: taskOperation,
            prompt: record.prompt,
            ...(record.negativePrompt ? { negativePrompt: record.negativePrompt } : {}),
            inputFiles: record.inputFiles,
            ...(record.providerProfileId ? { providerProfileId: record.providerProfileId } : {}),
            ...(record.manifestId ? { manifestId: record.manifestId } : {}),
            ...(record.modelId ? { modelId: record.modelId } : {}),
            ...(taskCapability ? { capabilityId: taskCapability } : {}),
            ...(Object.keys(record.modelParams).length > 0
              ? { modelParams: record.modelParams }
              : {}),
            clientTaskId: taskId,
            waitForCompletion: false,
          })) as CanvasMediaTaskCreateResponse
          requestAccepted = response.status === 'running' || response.status === 'succeeded'
          if (response.status !== 'running') {
            updateTask(taskId, {
              status:
                response.status === 'succeeded'
                  ? 'succeeded'
                  : response.status === 'cancelled'
                    ? 'cancelled'
                    : 'failed',
              providerProfileId: response.providerProfileId,
              providerName: response.provider,
              modelId: response.model,
              ...(response.runtimeTaskId ? { runtimeTaskId: response.runtimeTaskId } : {}),
              ...(response.requestId ? { requestId: response.requestId } : {}),
              assets: response.assets,
              ...(response.error ? { error: response.error } : {}),
              ...(response.progress !== undefined ? { progress: response.progress } : {}),
            })
          } else {
            updateTask(taskId, {
              ...(response.providerProfileId || record.providerProfileId
                ? { providerProfileId: response.providerProfileId || record.providerProfileId }
                : {}),
              ...(response.provider || record.providerName
                ? { providerName: response.provider || record.providerName }
                : {}),
              ...(response.model || record.modelId
                ? { modelId: response.model || record.modelId }
                : {}),
              ...(response.runtimeTaskId ? { runtimeTaskId: response.runtimeTaskId } : {}),
              ...(response.requestId ? { requestId: response.requestId } : {}),
              ...(response.progress !== undefined ? { progress: response.progress } : {}),
            })
          }
        }
        if (!source && requestAccepted && taskMode !== 'reverse') {
          for (const field of fields) {
            if (
              field.allowCustom &&
              (field.name === 'size' || /ratio|width|height/i.test(field.name))
            ) {
              recordQuickCreateCustomSize(
                parameterScope,
                field.name,
                params[field.name],
                field.enumValues,
              )
            }
          }
        }
        if (!source) {
          setPrompt((current) => (current.trim() === taskPrompt ? '' : current))
          const submittedNegativePrompt = negativePrompt.trim()
          setNegativePrompt((current) =>
            current.trim() === submittedNegativePrompt ? '' : current,
          )
        }
      } catch (error) {
        updateTask(taskId, {
          status: 'failed',
          error: {
            code: 'ipc_error',
            message: error instanceof Error ? error.message : String(error),
          },
        })
        message.error(error instanceof Error ? error.message : '提交创作任务失败')
      } finally {
        setPendingSubmissions((current) => Math.max(0, current - 1))
      }
    },
    [
      addTask,
      fields,
      mode,
      modelParamDraft,
      negativePrompt,
      prompt,
      requestInputs,
      selectedModel,
      effectiveTextModelId,
      effectiveTextProviderId,
      parameterScope,
      updateTask,
    ],
  )

  const retryTask = useCallback(
    (task: QuickCreateTaskRecord) => {
      void submitTask(task)
    },
    [submitTask],
  )

  const cancelTask = useCallback(
    async (task: QuickCreateTaskRecord) => {
      if (!task.runtimeTaskId) return
      try {
        await window.spark.invoke('canvas:task:cancel-media', { runtimeTaskId: task.runtimeTaskId })
        updateTask(task.id, { status: 'cancelled' })
      } catch (error) {
        message.error(error instanceof Error ? error.message : '取消任务失败')
      }
    },
    [updateTask],
  )

  const deleteTask = (taskId: string) => {
    Modal.confirm({
      title: '移除这条创作记录？',
      content: '只会移除快速创作历史，不会删除已经生成的图片或视频文件。',
      okText: '移除记录',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => {
        taskIdsRef.current.delete(taskId)
        setTasks((current) => {
          const next = current.filter((task) => task.id !== taskId)
          writeQuickCreateTasks(next)
          return next
        })
      },
    })
  }

  const openOutput = async (asset: CanvasMediaTaskAsset) => {
    if (!asset.filePath) {
      message.info('当前产物没有本地文件路径')
      return
    }
    try {
      const result = await window.spark.invoke('file:open', { filePath: asset.filePath })
      if (!result.opened) message.error(result.error ?? '打开产物失败')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '打开产物失败')
    }
  }

  const handleReuseTask = useCallback(
    (task: QuickCreateTaskRecord) => {
      setMode(task.mode)
      setPrompt(task.prompt)
      setNegativePrompt(task.negativePrompt ?? '')
      setInputs(task.inputFiles.map(quickInputFromTaskFile))
      const taskParams = Object.fromEntries(
        Object.entries(task.modelParams).map(([name, value]) => [name, String(value)]),
      )
      const reusedModel = task.modelId
        ? models.find(
            (candidate) =>
              candidate.effectiveModelId === task.modelId &&
              (task.manifestId == null || candidate.manifestId === task.manifestId),
          )
        : undefined
      const reusedModelKey = reusedModel ? mediaModelKey(reusedModel) : (task.modelId ?? '')
      const reusedCapability =
        task.mode === 'reverse'
          ? undefined
          : capabilityFor(task.mode, task.inputFiles.map(quickInputFromTaskFile), reusedModel)
      const reusedScope = quickCreateParamScope({
        operation: task.operation,
        modelKey: reusedModelKey,
        ...(reusedCapability ? { capabilityId: reusedCapability } : {}),
      })
      const preferences = readQuickCreatePreferences()
      writeQuickCreatePreferences({
        ...preferences,
        mode: task.mode,
        ...(reusedModelKey ? { modelKey: reusedModelKey } : {}),
        ...(task.mode === 'reverse' && task.providerProfileId
          ? { textProviderId: task.providerProfileId }
          : {}),
        ...(task.mode === 'reverse' && task.modelId ? { textModelId: task.modelId } : {}),
        paramsByScope: {
          ...(preferences.paramsByScope ?? {}),
          [reusedScope]: taskParams,
        },
      })
      setModelParamDraft(taskParams)
      if (task.mode === 'reverse') {
        setTextProviderId(task.providerProfileId ?? '')
        setTextModelId(task.modelId ?? '')
      } else if (reusedModel) {
        setModelKey(reusedModelKey)
      }
      setFocusedTaskId(task.id)
      setActiveTab('compose')
      setExpandedTaskId(null)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    },
    [models],
  )

  const handleTaskRowActivate = useCallback((task: QuickCreateTaskRecord) => {
    setFocusedTaskId(task.id)
    setExpandedTaskId((current) => (current === task.id ? null : task.id))
  }, [])

  const handleFocusTaskInWorkbench = useCallback((task: QuickCreateTaskRecord) => {
    setFocusedTaskId(task.id)
    setActiveTab('compose')
  }, [])

  return (
    <div className="quick-create-view">
      <div
        className={`quick-create-tabbar${t.sidebarHidden ? ' is-sidebar-hidden' : ''}`}
        onDoubleClick={() => {
          window.spark?.invoke('window:maximize', {}).catch(() => {})
        }}
      >
        {t.sidebarHidden && <SidebarExpandButton />}
        <nav className="quick-create-tabs" role="tablist" aria-label="快速创作工作区">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'compose'}
            className={activeTab === 'compose' ? 'is-active' : ''}
            onClick={() => setActiveTab('compose')}
          >
            <Icons.Brush size={14} /> 创作表单
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'tasks'}
            className={activeTab === 'tasks' ? 'is-active' : ''}
            onClick={() => setActiveTab('tasks')}
          >
            <Icons.ListTodo size={14} /> 任务管理
            {stats.running > 0 && <small>{stats.running}</small>}
          </button>
        </nav>
      </div>

      <main className="quick-create-main">
        {activeTab === 'compose' ? (
          <section className="quick-create-workbench" aria-label="创作配置与输出">
            <div className="quick-create-form-pane">
              <div className="quick-create-mode-rail" role="tablist" aria-label="创作模式">
                {MODE_ITEMS.map((item) => {
                  const Icon = item.icon
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={mode === item.id}
                      className={`quick-create-mode${mode === item.id ? ' is-active' : ''}`}
                      onClick={() => handleModeChange(item.id)}
                    >
                      <Icon size={17} />
                      <strong>{item.label}</strong>
                    </button>
                  )
                })}
              </div>

              <div className="quick-create-form">
                <div className="quick-create-prompt-wrap">
                  <textarea
                    id="quick-create-prompt"
                    className="quick-create-prompt"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    aria-label="提示词"
                    placeholder={
                      mode === 'reverse'
                        ? '选择一张图片后开始反推；这里不需要填写提示词'
                        : mode === 'video'
                          ? '描述主体、动作、镜头运动和时长，例如：雨夜街头，霓虹倒影，镜头缓慢推进…'
                          : '描述主体、构图、光线和风格，例如：清晨窗边的产品静物，柔和侧光…'
                    }
                    disabled={mode === 'reverse'}
                  />
                  {mode !== 'reverse' && (
                    <div className="quick-create-prompt-tools">
                      <button
                        type="button"
                        title="从提示词库插入"
                        aria-label="从提示词库插入"
                        onClick={() => {
                          setPromptPickerOpen((value) => !value)
                          setPromptSearch('')
                        }}
                      >
                        <Icons.Book size={14} />
                      </button>
                      <button
                        type="button"
                        title="保存提示词"
                        aria-label="保存提示词"
                        onClick={() => void saveCurrentPrompt()}
                      >
                        <Icons.Plus size={14} />
                      </button>
                    </div>
                  )}
                  {promptPickerOpen && mode !== 'reverse' && (
                    <div className="quick-create-prompt-picker">
                      <div className="quick-create-picker-head">
                        <strong>提示词库</strong>
                        <span>{promptLibrary.length} 条</span>
                        <button
                          type="button"
                          aria-label="关闭提示词库"
                          onClick={() => setPromptPickerOpen(false)}
                        >
                          <Icons.X size={14} />
                        </button>
                      </div>
                      <Input
                        prefix={<Icons.Search size={14} />}
                        value={promptSearch}
                        onChange={(event) => setPromptSearch(event.target.value)}
                        placeholder="搜索标题、内容或标签"
                        allowClear
                      />
                      <div className="quick-create-picker-list">
                        {filteredPrompts.length === 0 ? (
                          <span className="quick-create-picker-empty">还没有匹配的提示词</span>
                        ) : (
                          filteredPrompts.slice(0, 8).map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => {
                                setPrompt(item.text)
                                setPromptPickerOpen(false)
                              }}
                            >
                              <strong>{item.title}</strong>
                              <small>{item.text}</small>
                              <em>{item.usageCount} 次使用</em>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                  {mode !== 'reverse' && (negativeOpen || negativePrompt.trim()) && (
                    <div className="quick-create-negative-inline">
                      <Input
                        aria-label="反向提示词"
                        value={negativePrompt}
                        onChange={(event) => setNegativePrompt(event.target.value)}
                        placeholder="反向提示词：模糊、低清、文字水印…"
                        variant="borderless"
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        title="收起反向提示词"
                        aria-label="收起反向提示词"
                        onClick={() => {
                          setNegativeOpen(false)
                          setNegativePrompt('')
                        }}
                      >
                        <Icons.X size={12} />
                      </button>
                    </div>
                  )}
                  {mode !== 'reverse' && !negativeOpen && !negativePrompt.trim() && (
                    <div className="quick-create-negative-bar">
                      <button type="button" onClick={() => setNegativeOpen(true)}>
                        <Icons.EyeOff size={11} />
                        反向提示词
                      </button>
                    </div>
                  )}
                </div>

                <div
                  className="quick-create-input-zone"
                  tabIndex={0}
                  role="group"
                  aria-label={
                    mode === 'reverse'
                      ? '输入图片，仅支持 1 张，可直接粘贴'
                      : '参考素材，可选，可直接粘贴图片'
                  }
                  onPaste={(event) => void handlePasteInput(event)}
                >
                  <div className="quick-create-input-list">
                    {inputs.map((input) => (
                      <div className="quick-create-input-chip" key={input.id}>
                        {input.type === 'video' ? (
                          <video src={input.previewUrl} muted />
                        ) : (
                          <img src={input.previewUrl} alt={input.name} />
                        )}
                        <span>{input.name}</span>
                        <button
                          type="button"
                          aria-label={`移除 ${input.name}`}
                          onClick={() =>
                            setInputs((current) => current.filter((item) => item.id !== input.id))
                          }
                        >
                          <Icons.X size={12} />
                        </button>
                      </div>
                    ))}
                    {(mode !== 'reverse' || inputs.length === 0) && (
                      <button
                        type="button"
                        className="quick-create-input-add"
                        aria-label="添加素材，也可直接粘贴"
                        onClick={() => void handlePickFiles()}
                      >
                        <Icons.ImagePlus size={16} />
                      </button>
                    )}
                  </div>
                </div>

                {mode === 'reverse' ? (
                  <div className="quick-create-control-row quick-create-text-model-row">
                    <label htmlFor="quick-create-provider">视觉理解模型</label>
                    <Select
                      id="quick-create-provider"
                      value={effectiveTextProviderId || undefined}
                      placeholder="选择 Provider"
                      options={textProviders.map((provider) => ({
                        label: provider.name,
                        value: provider.id,
                      }))}
                      onChange={(value) => {
                        setTextProviderId(value ?? '')
                        const provider = textProviders.find((item) => item.id === value)
                        setTextModelId(provider?.defaultModel ?? '')
                      }}
                    />
                    <Select
                      aria-label="选择视觉理解模型"
                      value={effectiveTextModelId || undefined}
                      placeholder="选择模型"
                      options={(
                        textProviders.find((provider) => provider.id === textProviderId)
                          ?.modelIds ?? []
                      ).map((model) => ({ label: model, value: model }))}
                      onChange={(value) => setTextModelId(value ?? '')}
                    />
                  </div>
                ) : (
                  <>
                    <div className="quick-create-control-row">
                      <div className="quick-create-model-control">
                        <span className="quick-create-control-label">模型</span>
                        {modelsLoading ? (
                          <Spin size="small" />
                        ) : (
                          <CanvasModelPicker
                            models={compatibleModels}
                            value={effectiveModelKey}
                            loading={modelsLoading}
                            onChange={setModelKey}
                          />
                        )}
                      </div>
                      {!modelsLoading && !selectedModel && (
                        <span className="quick-create-capability-hint">
                          暂无匹配的已启用模型，请先到模型服务配置
                        </span>
                      )}
                    </div>
                    <QuickCreateParameterPanel
                      fields={fields}
                      values={modelParamDraft}
                      parameterScope={parameterScope}
                      onChange={(name, value) =>
                        setModelParamDraft((current) =>
                          updateModelParamDraftValue(current, name, value),
                        )
                      }
                    />
                  </>
                )}

                <div className="quick-create-submit-row">
                  {pendingSubmissions > 0 && (
                    <span className="quick-create-submit-status" aria-live="polite">
                      <Icons.ListTodo size={13} />
                      {pendingSubmissions} 个任务提交中
                    </span>
                  )}
                  <Button
                    type="primary"
                    disabled={
                      modelsLoading || (mode === 'reverse' ? inputs.length !== 1 : !prompt.trim())
                    }
                    onClick={() => void submitTask()}
                  >
                    <Icons.Sparkles size={15} /> 开始创作
                  </Button>
                </div>
              </div>
            </div>
            <QuickCreateOutputPanel
              key={focusedTask?.id ?? 'empty'}
              task={focusedTask}
              onOpenOutput={openOutput}
            />
          </section>
        ) : (
          <QuickCreateTaskHistory
            tasks={tasks}
            expandedTaskId={expandedTaskId}
            onRowActivate={handleTaskRowActivate}
            onFocusTask={handleFocusTaskInWorkbench}
            onReuse={handleReuseTask}
            onCancel={(task) => void cancelTask(task)}
            onRetry={retryTask}
            onDelete={deleteTask}
            onOpenOutput={(asset) => void openOutput(asset)}
          />
        )}
      </main>
    </div>
  )
}
