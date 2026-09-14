/**
 * 自定义覆盖滚动条（ChatOverlayScrollbar）的「用户上滚意图」判定。
 *
 * 滚动条交互直接写 element.scrollTop，不会派发 wheel/touchstart；若不把它纳入
 * ChatView 的用户上滚源事件闸门（userScrolledRef），流式贴底 pin 会在下一帧
 * 把视图拽回底部——这是「输出中用滚动条上滚被弹回」的根因。仅识别「向上」，
 * 与 wheel deltaY<0 同语义；向下回到底部仍由距底解锁逻辑恢复跟随。
 */

/** 滑块键盘导航中代表「向上」的键。 */
const UPWARD_SCROLL_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'PageUp', 'Home'])

export function isUpwardScrollbarKey(key: string): boolean {
  return UPWARD_SCROLL_KEYS.has(key)
}

/** 拖拽 / 轨道点击产生的目标位置是否相对当前位置向上。 */
export function isUpwardScrollbarMove(fromScrollTop: number, toScrollTop: number): boolean {
  return toScrollTop < fromScrollTop
}
