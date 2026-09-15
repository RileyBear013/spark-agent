/**
 * composer-reference-blocks — 引用类内容（代码位置 / 浏览器元素 / Git 提交）在发送正文里的拼接规则。
 *
 * 三类引用的发送文本由各自模块序列化，但拼进正文的规则只有一条：
 *  - 用户什么都没输入时，引用文本替换掉 fallback 占位（如「请查看附件。」），
 *    否则模型只会看到一句「请查看附件。」而拿不到引用；
 *  - 用户输入了正文时，引用文本追加到正文末尾。
 *
 * 多类引用同时存在时（例如同时加了代码位置和 Git 提交），只有第一个能替换占位，
 * 后续的必须追加——否则占位已被替换后 `replace` 匹配不到，后一类引用的文本会被静默丢弃。
 */

/** 输入框为空时的 fallback 占位文本（ComposerV2 的兜底提示）。 */
export const EMPTY_TEXT_FALLBACK = '请查看附件。'

export function appendComposerReferenceBlock(input: {
  /** 当前待发送正文（可能已含回复引用前缀或 fallback 占位） */
  text: string
  /** 引用序列化后的文本块（多行时用 \n 连接） */
  block: string
  /** 用户是否真实输入了正文 */
  userTyped: boolean
}): string {
  const { text, block, userTyped } = input
  if (block.length === 0) return text
  if (!userTyped && text.includes(EMPTY_TEXT_FALLBACK)) {
    return text.replace(EMPTY_TEXT_FALLBACK, block)
  }
  if (text.length === 0) return block
  return `${text}\n${block}`
}
