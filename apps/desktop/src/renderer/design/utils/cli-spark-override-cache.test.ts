// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  CLI_SPARK_OVERRIDE_CACHE_KEY,
  readCliSparkOverrideCache,
  rememberCliSparkOverride,
} from './cli-spark-override-cache'

describe('CLI Spark override cache', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults to an empty cache when no selection has been saved', () => {
    expect(readCliSparkOverrideCache()).toEqual({})
  })

  it('remembers third-party selections independently for each CLI', () => {
    rememberCliSparkOverride('local-claude-cli', {
      providerProfileId: 'anthropic-profile',
      modelId: 'claude-sonnet',
    })
    rememberCliSparkOverride('local-codex-cli', {
      providerProfileId: 'openai-profile',
      modelId: 'gpt-5',
    })

    expect(readCliSparkOverrideCache()).toEqual({
      'local-claude-cli': {
        providerProfileId: 'anthropic-profile',
        modelId: 'claude-sonnet',
      },
      'local-codex-cli': {
        providerProfileId: 'openai-profile',
        modelId: 'gpt-5',
      },
    })
  })

  it('persists an explicit host configuration and reads legacy object entries', () => {
    window.localStorage.setItem(
      CLI_SPARK_OVERRIDE_CACHE_KEY,
      JSON.stringify({
        'local-claude-cli': {
          providerProfileId: 'anthropic-profile',
          modelId: 'claude-sonnet',
        },
      }),
    )

    rememberCliSparkOverride('local-claude-cli', null)

    expect(readCliSparkOverrideCache()).toEqual({ 'local-claude-cli': null })
    expect(JSON.parse(window.localStorage.getItem(CLI_SPARK_OVERRIDE_CACHE_KEY) ?? '{}')).toEqual({
      'local-claude-cli': null,
    })
  })

  it('ignores malformed entries without invalidating valid cached choices', () => {
    window.localStorage.setItem(
      CLI_SPARK_OVERRIDE_CACHE_KEY,
      JSON.stringify({
        valid: { providerProfileId: 'provider', modelId: 'model' },
        host: null,
        malformed: { providerProfileId: '', modelId: 'model' },
        scalar: 'invalid',
      }),
    )

    expect(readCliSparkOverrideCache()).toEqual({
      valid: { providerProfileId: 'provider', modelId: 'model' },
      host: null,
    })
  })
})
