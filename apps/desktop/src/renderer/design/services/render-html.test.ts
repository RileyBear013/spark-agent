import { describe, expect, it } from 'vitest'
import {
  normalizeHtmlRenderHeight,
  parseRenderHtmlInput,
  parseRenderHtmlResult,
} from './render-html'

describe('render-html service', () => {
  it.each([
    [240, 240],
    [240.6, 241],
    ['360px', 360],
    [' 360 ', 360],
    [80, 120],
    [1200, 800],
    ['auto', 400],
    [undefined, 400],
  ])('normalizes HTML height %p to %p', (input, expected) => {
    expect(normalizeHtmlRenderHeight(input)).toBe(expected)
  })

  it('normalizes height consistently in tool calls and accepted tool results', () => {
    expect(
      parseRenderHtmlInput({ html: '<main>内容</main>', title: '示例', height: '920px' }),
    ).toMatchObject({ height: 800 })

    expect(
      parseRenderHtmlResult({ accepted: true, html: '<main>内容</main>', height: 119.5 }),
    ).toMatchObject({ accepted: true, height: 120 })
  })
})
