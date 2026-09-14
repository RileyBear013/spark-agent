import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('SessionWorkflowPicker styles', () => {
  it('uses an opaque application surface for the workflow menu', () => {
    const styles = readFileSync(new URL('./SessionWorkflowPicker.less', import.meta.url), 'utf8')

    expect(styles).toMatch(/background: var\(--panel\);/)
    expect(styles).not.toContain('--color-bg-elevated')
    expect(styles).not.toContain('#fff')
  })

  it('matches the composer permission/reasoning menu visual language', () => {
    const styles = readFileSync(new URL('./SessionWorkflowPicker.less', import.meta.url), 'utf8')

    // 与权限策略 / 推理强度弹窗同一套容器视觉：无 1px 边框、--r-md 圆角、--shadow-lg 阴影
    expect(styles).toContain('box-shadow: var(--shadow-lg)')
    expect(styles).toMatch(/\.session-workflow-menu\s*\{[^}]*border-radius: var\(--r-md\);/)
    expect(styles).not.toMatch(/\.session-workflow-menu\s*\{[^}]*border:\s*1px/)
    expect(styles).toMatch(/\.session-workflow-option\s*\{[^}]*border-radius: var\(--r-sm\);/)
  })

  it('uses a compact icon trigger and truncates workflow option text', () => {
    const styles = readFileSync(new URL('./SessionWorkflowPicker.less', import.meta.url), 'utf8')

    expect(styles).toMatch(/\.session-workflow-trigger\s*\{[\s\S]*?width: 29px;/)
    expect(styles).toMatch(/\.session-workflow-trigger\.is-selected\s*\{/)
    expect(styles).toMatch(
      /\.session-workflow-option-label\s*\{[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/,
    )
    expect(styles).toMatch(
      /\.session-workflow-option-description\s*\{[\s\S]*?flex: 0 0 auto;[\s\S]*?white-space: nowrap;/,
    )
  })

  it('places the picker in the outer parameter bar immediately after the debug toggle', () => {
    const source = readFileSync(new URL('../ComposerV2.tsx', import.meta.url), 'utf8')
    const pickerOccurrences = source.match(/<SessionWorkflowPicker/g) ?? []
    const debugToggleIndex = source.indexOf('className={`composer-debug-toggle')
    const workflowPickerIndex = source.indexOf('<SessionWorkflowPicker')
    const contextMeterIndex = source.indexOf('<ContextMeterWithPopup', workflowPickerIndex)

    expect(pickerOccurrences).toHaveLength(1)
    expect(debugToggleIndex).toBeGreaterThan(-1)
    expect(workflowPickerIndex).toBeGreaterThan(debugToggleIndex)
    expect(contextMeterIndex).toBeGreaterThan(workflowPickerIndex)
  })
})
