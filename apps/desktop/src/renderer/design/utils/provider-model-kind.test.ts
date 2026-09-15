import { describe, expect, it } from 'vitest'
import type { ProviderProfile } from '@spark/protocol'

import {
  filterConversationalProviders,
  isEmbeddingProviderProfile,
  isMediaProviderProfile,
} from './provider-model-kind'

/**
 * 用例数据取自真实本机 provider 配置（provider_profiles.config_json）：
 * 多媒体渠道的 modelType 是 image / voice / video，多模态理解 LLM 是 multimodal。
 */
function provider(
  name: string,
  modelType?: ProviderProfile['modelType'],
  codexApiKind?: ProviderProfile['codexApiKind'],
): ProviderProfile {
  return {
    id: name,
    name,
    provider: 'openai',
    defaultModel: `${name}-model`,
    modelIds: [`${name}-model`],
    ...(modelType !== undefined ? { modelType } : {}),
    ...(codexApiKind !== undefined ? { codexApiKind } : {}),
    keystoreRef: '',
    isDefault: false,
    createdAt: '',
  }
}

describe('provider model kind', () => {
  it('多媒体生成渠道（image/voice/video）判为不可跑文本 turn', () => {
    expect(isMediaProviderProfile(provider('xAI 图片', 'image'))).toBe(true)
    expect(isMediaProviderProfile(provider('ToApis 多媒体合集', 'image'))).toBe(true)
    expect(isMediaProviderProfile(provider('自建MiniMax H3 视频', 'video'))).toBe(true)
    expect(isMediaProviderProfile(provider('某语音渠道', 'voice'))).toBe(true)
  })

  it('多模态理解 LLM 与旧数据（未声明 modelType）保留为可跑文本 turn', () => {
    expect(isMediaProviderProfile(provider('自部署图像理解', 'multimodal'))).toBe(false)
    expect(isMediaProviderProfile(provider('火山方舟 Seed 2.1', 'multimodal'))).toBe(false)
    expect(isMediaProviderProfile(provider('Spark 平台模型', 'text'))).toBe(false)
    expect(isMediaProviderProfile(provider('本地 Claude CLI', undefined))).toBe(false)
  })

  it('声明 Embeddings API 的向量渠道不算对话渠道', () => {
    const embedding = provider('glm向量模型', 'multimodal', 'embedding')
    expect(isEmbeddingProviderProfile(embedding)).toBe(true)

    expect(filterConversationalProviders([embedding]).map((item) => item.name)).toEqual([])
  })

  it('渠道列表只保留文本对话渠道，且保持原有顺序', () => {
    const kept = filterConversationalProviders([
      provider('Seedream 图片', 'image'),
      provider('Spark 平台模型', 'text'),
      provider('火山视频', 'video'),
      provider('glm向量模型', 'multimodal', 'embedding'),
      provider('自部署图像理解', 'multimodal'),
    ])

    expect(kept.map((item) => item.name)).toEqual(['Spark 平台模型', '自部署图像理解'])
  })
})
