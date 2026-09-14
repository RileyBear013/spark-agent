import { describe, expect, it } from 'vitest'
import { buildStartupGuidanceDataUrl, resolveStartupGuidanceLocale } from './startup-guidance'

function decodeDataUrl(url: string): string {
  return decodeURIComponent(url.slice(url.indexOf(',') + 1))
}

describe('startup guidance', () => {
  it('shows the Chinese slow-start explanation after the configured delay', () => {
    const html = decodeDataUrl(
      buildStartupGuidanceDataUrl({ locale: 'zh-CN', version: '0.11.68', slowHintDelayMs: 1_500 }),
    )

    expect(html).toContain('正在启动 SparkWork…')
    expect(html).toContain('启动时间较长，可能正在优化本地数据')
    expect(html).toContain('首次升级预计约 20 秒，完成前请勿退出应用。')
    expect(html).toContain('}, 1500)')
    expect(html).toContain('v0.11.68')
  })

  it('includes dark-mode, reduced-motion and live-region support', () => {
    const html = decodeDataUrl(buildStartupGuidanceDataUrl({ locale: 'en', version: '1.0.0' }))

    expect(html).toContain('@media (prefers-color-scheme: dark)')
    expect(html).toContain('@media (prefers-reduced-motion: reduce)')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('A longer startup may mean local data is being optimized')
  })

  it('selects Chinese only for Chinese application locales', () => {
    expect(resolveStartupGuidanceLocale('zh-CN')).toBe('zh-CN')
    expect(resolveStartupGuidanceLocale('zh-TW')).toBe('zh-CN')
    expect(resolveStartupGuidanceLocale('en-US')).toBe('en')
  })
})
