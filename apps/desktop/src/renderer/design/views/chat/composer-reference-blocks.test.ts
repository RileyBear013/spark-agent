import { describe, expect, it } from 'vitest'
import { EMPTY_TEXT_FALLBACK, appendComposerReferenceBlock } from './composer-reference-blocks'

describe('appendComposerReferenceBlock', () => {
  it('用户未输入正文时替换 fallback 占位', () => {
    expect(
      appendComposerReferenceBlock({
        text: EMPTY_TEXT_FALLBACK,
        block: '[Git 提交] abc1234 修正登录',
        userTyped: false,
      }),
    ).toBe('[Git 提交] abc1234 修正登录')
  })

  it('回复引用包裹 fallback 时只替换占位，保留回复上下文', () => {
    expect(
      appendComposerReferenceBlock({
        text: `[回复 You: 上一句]\n${EMPTY_TEXT_FALLBACK}`,
        block: '/a.ts:10-12',
        userTyped: false,
      }),
    ).toBe('[回复 You: 上一句]\n/a.ts:10-12')
  })

  it('用户输入了正文时追加到末尾', () => {
    expect(
      appendComposerReferenceBlock({
        text: '看看这个提交',
        block: '[Git 提交] abc1234 x',
        userTyped: true,
      }),
    ).toBe('看看这个提交\n[Git 提交] abc1234 x')
  })

  it('多类引用共存：占位已被前一类替换后，后一类追加而不是丢行', () => {
    const first = appendComposerReferenceBlock({
      text: EMPTY_TEXT_FALLBACK,
      block: '/a.ts:10',
      userTyped: false,
    })
    const second = appendComposerReferenceBlock({
      text: first,
      block: '[Git 提交] abc1234 修正登录',
      userTyped: false,
    })
    expect(second).toBe('/a.ts:10\n[Git 提交] abc1234 修正登录')
  })

  it('正文为空且无占位时直接以引用块作为正文', () => {
    expect(
      appendComposerReferenceBlock({ text: '', block: '提交 abc1234', userTyped: false }),
    ).toBe('提交 abc1234')
  })

  it('空引用块不改动正文', () => {
    expect(appendComposerReferenceBlock({ text: '正文', block: '', userTyped: true })).toBe('正文')
  })
})
