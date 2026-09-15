import type { ProviderProfile } from '@spark/protocol'

/**
 * 文本对话渠道与多媒体生成渠道（图像 / 语音 / 视频）的区分。
 *
 * 判定沿用会话模型选择器（ComposerV2）与 Agent 绑定选择（AgentsView）的既有约定：
 * 只看 provider 的 modelType，image / voice / video 整条渠道视为多媒体生成渠道。
 *
 * 注意：modelType='multimodal' 包含 doubao-seed-2-1、Qwen3-VL 这类多模态理解 LLM，
 * 属于文本对话渠道，不能一并排除。
 */
export function isMediaProviderProfile(provider: ProviderProfile): boolean {
  return (
    provider.modelType === 'image' ||
    provider.modelType === 'voice' ||
    provider.modelType === 'video'
  )
}

/**
 * 向量模型渠道（Embeddings API）只产出向量，不能承接对话文本 turn。
 * 判定沿用仓库既有约定：MemoryPanel / openai-fast-mode / custom-tools-ui
 * 均以 codexApiKind === 'embedding' 识别向量渠道。
 */
export function isEmbeddingProviderProfile(provider: ProviderProfile): boolean {
  return provider.codexApiKind === 'embedding'
}

/**
 * 过滤出可用于文本 turn 的对话渠道（大语言模型渠道）。
 *
 * 定时任务的执行体是文本 turn，而主进程 resolveScheduledTaskRuntime 会按 modelId
 * 反查拥有该模型的 provider；一旦多媒体生成渠道或向量渠道进入候选，选中它的模型
 * 会让文本 turn 落到图像/视频/Embeddings 渠道上执行，因此候选列表必须先剔除这两类。
 */
export function filterConversationalProviders<T extends ProviderProfile>(
  providers: readonly T[],
): T[] {
  return providers.filter(
    (provider) => !isMediaProviderProfile(provider) && !isEmbeddingProviderProfile(provider),
  )
}
