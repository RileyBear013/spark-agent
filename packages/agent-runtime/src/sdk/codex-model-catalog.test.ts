import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createCodexModelCatalog,
  ensureCodexModelCatalog,
  withCodexModelCatalog,
} from './codex-model-catalog.js'
import { buildCodexConfig } from './codex-sdk-executor.js'

describe('codex model catalog bridge', () => {
  it('overrides the selected custom model metadata without dropping the source catalog', () => {
    const catalog = createCodexModelCatalog({
      model: 'deepseek-v4.1-flash',
      contextWindowTokens: 1_000_000,
      sourceCatalog: {
        models: [
          {
            slug: 'gpt-5.5',
            display_name: 'GPT-5.5',
            context_window: 272_000,
            max_context_window: 272_000,
            model_messages: { instructions_template: 'gpt-only instructions' },
          },
        ],
      },
    })

    expect(catalog.models).toHaveLength(2)
    expect(catalog.models[0]).toMatchObject({ slug: 'gpt-5.5', context_window: 272_000 })
    expect(catalog.models[1]).toMatchObject({
      slug: 'deepseek-v4.1-flash',
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      effective_context_window_percent: 100,
      auto_compact_token_limit: null,
    })
    expect(catalog.models[1]).not.toHaveProperty(
      'model_messages.instructions_template',
      'gpt-only instructions',
    )
  })

  it('writes a valid reusable catalog under the configured Codex home', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'spark-codex-catalog-test-'))
    try {
      await writeFile(
        join(codexHome, 'models_cache.json'),
        JSON.stringify({
          models: [
            {
              slug: 'gpt-5.5',
              display_name: 'GPT-5.5',
              context_window: 272_000,
              max_context_window: 272_000,
            },
          ],
        }),
        'utf8',
      )

      const catalogPath = await ensureCodexModelCatalog({
        model: 'deepseek-v4.1-flash',
        contextWindowTokens: 1_000_000,
        codexHome,
      })
      expect(catalogPath).toMatch(/^.+\/spark-model-catalog-[a-f0-9]{20}\.json$/)
      if (catalogPath == null) throw new Error('catalog path was not generated')
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
        models: Array<Record<string, unknown>>
      }
      expect(catalog.models.at(-1)).toMatchObject({
        slug: 'deepseek-v4.1-flash',
        context_window: 1_000_000,
        max_context_window: 1_000_000,
      })

      const secondPath = await ensureCodexModelCatalog({
        model: 'deepseek-v4.1-flash',
        contextWindowTokens: 1_000_000,
        codexHome,
      })
      expect(secondPath).toBe(catalogPath)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('uses the effective custom CODEX_HOME when building the executor config', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'spark-codex-catalog-config-test-'))
    try {
      const config = await withCodexModelCatalog({
        apiKey: 'test-key',
        model: 'deepseek-v4.1-flash',
        permissionMode: 'codex-default',
        workspaceRootPath: process.cwd(),
        contextWindowTokens: 1_000_000,
        customEnv: { CODEX_HOME: codexHome },
        codexCliProvider: { id: 'opencode', wireApi: 'responses' },
      })
      expect(config.codexModelCatalogPath).toBeDefined()
      if (config.codexModelCatalogPath == null) throw new Error('catalog path was not generated')
      expect(dirname(config.codexModelCatalogPath)).toBe(codexHome)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('passes the generated catalog path alongside the configured context window', () => {
    expect(
      buildCodexConfig({
        apiKey: 'test-key',
        model: 'deepseek-v4.1-flash',
        permissionMode: 'codex-default',
        workspaceRootPath: process.cwd(),
        contextWindowTokens: 1_000_000,
        codexModelCatalogPath: '/tmp/spark-model-catalog.json',
      }),
    ).toMatchObject({
      model_context_window: 1_000_000,
      model_catalog_json: '/tmp/spark-model-catalog.json',
    })
  })
})
