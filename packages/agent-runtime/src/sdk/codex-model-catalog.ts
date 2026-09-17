import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { SDKExecutorConfig } from './types.js'

type CatalogModel = Record<string, unknown> & { slug?: unknown }
type ModelCatalog = { models: CatalogModel[] }

const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 100

/**
 * Codex 给未知模型使用的 fallback metadata 上限是 272K，`model_context_window`
 * 只能在该上限内覆盖。自定义 Provider 必须把模型先放入 model_catalog_json，才能
 * 让 Codex 使用 Spark 已解析出的上下文窗口。
 */
export async function withCodexModelCatalog(
  config: SDKExecutorConfig,
): Promise<SDKExecutorConfig> {
  if (
    config.codexCliProvider == null ||
    typeof config.contextWindowTokens !== 'number' ||
    !Number.isFinite(config.contextWindowTokens) ||
    config.contextWindowTokens <= 0 ||
    config.codexModelCatalogPath != null
  ) {
    return config
  }

  const configuredCodexHome = resolveCodexHome(config)
  const catalogPath = await ensureCodexModelCatalog({
    model: config.model,
    contextWindowTokens: config.contextWindowTokens,
    ...(configuredCodexHome != null ? { codexHome: configuredCodexHome } : {}),
  })
  return catalogPath == null ? config : { ...config, codexModelCatalogPath: catalogPath }
}

/**
 * 创建/复用一个由 Spark 管理的 Codex model_catalog_json。
 *
 * 目录内容以 Codex 自己的 models_cache.json 为模板，保留运行时版本需要的字段；
 * 当前 Provider 的模型条目始终覆盖为 Spark 配置的窗口，并关闭 Codex 额外的 95%
 * effective headroom。Spark 已经用自己的 70% soft limit 和 Runtime 的 90% auto
 * compact 规则留出安全空间，这样 UI 与 Provider 配置都以同一个 1M 硬窗口为准。
 */
export async function ensureCodexModelCatalog(params: {
  model: string
  contextWindowTokens: number
  codexHome?: string | undefined
}): Promise<string | null> {
  const model = params.model.trim()
  const contextWindowTokens = Math.floor(params.contextWindowTokens)
  if (
    model.length === 0 ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return null
  }

  const codexHome =
    params.codexHome?.trim() || process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex')
  const sourceCatalog = await readSourceCatalog(path.join(codexHome, 'models_cache.json'))
  const catalog = createCodexModelCatalog({
    model,
    contextWindowTokens,
    sourceCatalog,
  })
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`
  const digest = createHash('sha256').update(serialized).digest('hex').slice(0, 20)
  const catalogPath = path.join(codexHome, `spark-model-catalog-${digest}.json`)

  try {
    await mkdir(codexHome, { recursive: true })
    let existing: string | null = null
    try {
      existing = await readFile(catalogPath, 'utf8')
    } catch {
      // The generated catalog does not exist yet.
    }
    if (existing !== serialized) await writeFile(catalogPath, serialized, 'utf8')
    return catalogPath
  } catch {
    // A catalog is a compatibility bridge. If the user's Codex home is read-only,
    // retain the original config and let the Runtime report its own limit.
    return null
  }
}

/** Pure builder exported for focused tests and future catalog diagnostics. */
export function createCodexModelCatalog(params: {
  model: string
  contextWindowTokens: number
  sourceCatalog?: ModelCatalog | null
}): ModelCatalog {
  const sourceModels = params.sourceCatalog?.models ?? []
  // 只复用同名条目；把任意已知模型（例如 gpt）的 instructions/capability
  // 拷贝给第三方模型会改变 Codex 的行为。未知模型使用下面的中性 fallback。
  const sourceModel = sourceModels.find((entry) => entry.slug === params.model)
  const modelEntry: CatalogModel = {
    ...(sourceModel != null ? cloneRecord(sourceModel) : createFallbackModel(params.model)),
    slug: params.model,
    display_name: params.model,
    context_window: Math.floor(params.contextWindowTokens),
    max_context_window: Math.floor(params.contextWindowTokens),
    effective_context_window_percent: DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
    // Let Codex derive its normal 90% auto-compact threshold from the configured window.
    auto_compact_token_limit: null,
  }

  const modelIndex = sourceModels.findIndex((entry) => entry.slug === params.model)
  const models = sourceModels.map((entry) => cloneRecord(entry))
  if (modelIndex >= 0) models[modelIndex] = modelEntry
  else models.push(modelEntry)
  return { models }
}

async function readSourceCatalog(filePath: string): Promise<ModelCatalog | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      models?: unknown
    }
    if (!Array.isArray(parsed.models)) return null
    const models = parsed.models.filter(isCatalogModel)
    return models.length > 0 ? { models } : null
  } catch {
    return null
  }
}

function isCatalogModel(value: unknown): value is CatalogModel {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function cloneRecord(value: CatalogModel): CatalogModel {
  return JSON.parse(JSON.stringify(value)) as CatalogModel
}

export function resolveCodexHome(config: SDKExecutorConfig): string {
  const candidates = [config.customEnv?.CODEX_HOME, config.codexCliProvider?.env?.CODEX_HOME]
  return (
    candidates.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() ||
    process.env.CODEX_HOME?.trim() ||
    path.join(homedir(), '.codex')
  )
}

function createFallbackModel(model: string): CatalogModel {
  return {
    slug: model,
    display_name: model,
    description: null,
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: 'unified_exec',
    visibility: 'none',
    supported_in_api: true,
    priority: 99,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    model_messages: { instructions_template: '' },
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    supports_reasoning_summaries: true,
    default_reasoning_summary: 'auto',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'bytes', limit: 10_000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    supports_search_tool: false,
    supports_experimental_context: false,
    use_responses_lite: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    auto_review_model_override: null,
    model_specialty: null,
    tool_mode: null,
    multi_agent_version: null,
    multi_agent_reasoning_effort: null,
  }
}
