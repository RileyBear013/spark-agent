import { describe, expect, it } from 'vitest'
import { buildStartupGuidanceDataUrl, resolveStartupGuidanceLocale } from './startup-guidance'

function decodeDataUrl(url: string): string {
  return decodeURIComponent(url.slice(url.indexOf(',') + 1))
}

describe('startup guidance', () => {
  it('shows real backup, migration and launch stages in Chinese', () => {
    const html = decodeDataUrl(
      buildStartupGuidanceDataUrl({ locale: 'zh-CN', version: '0.11.70', migrationTotal: 2 }),
    )

    expect(html).toContain('正在升级本地数据')
    expect(html).toContain('创建升级恢复点')
    expect(html).toContain('升级本地数据')
    expect(html).toContain('启动 SparkWork')
    expect(html).toContain('0/2')
    expect(html).toContain('v0.11.70')
    expect(html).toContain('window.__sparkUpdateStartupGuidance')
  })

  it('uses a conservative explanation when migration preflight failed', () => {
    const html = decodeDataUrl(
      buildStartupGuidanceDataUrl({
        locale: 'zh-CN',
        version: '0.11.70',
        preflightFallback: true,
      }),
    )

    expect(html).toContain('正在检查并保护现有数据')
    expect(html).toContain('data-meta="migration"></span>')
  })

  it('supports dragging, real determinate progress and accessible reduced motion', () => {
    const html = decodeDataUrl(
      buildStartupGuidanceDataUrl({ locale: 'en', version: '1.0.0', migrationTotal: 1 }),
    )

    expect(html).toContain('-webkit-app-region: drag')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain("progress.setAttribute('aria-valuenow', String(percent))")
    expect(html).toContain("progress.removeAttribute('aria-valuenow')")
    expect(html).toContain('@media (prefers-color-scheme: dark)')
    expect(html).toContain('@media (prefers-reduced-motion: reduce)')
    expect(html).toContain('aria-live="polite"')
  })

  it('selects Chinese only for Chinese application locales', () => {
    expect(resolveStartupGuidanceLocale('zh-CN')).toBe('zh-CN')
    expect(resolveStartupGuidanceLocale('zh-TW')).toBe('zh-CN')
    expect(resolveStartupGuidanceLocale('en-US')).toBe('en')
  })
})
