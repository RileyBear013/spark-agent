import { Box, Text } from 'ink'
import type { ReactElement } from 'react'

import type { TerminalCapabilities, TuiTheme } from '../theme.js'

export interface WelcomeBoxProps {
  readonly version: string
  readonly model: string | undefined
  readonly cwd?: string | undefined
  readonly capabilities: TerminalCapabilities
  readonly theme: TuiTheme
}

// Pixel sparkle mark: solid blocks only, so every monospace font renders it
// identically. The core brightens towards the middle like a struck spark.
const MARK_ROWS: readonly { readonly cells: string; readonly tone: 'core' | 'edge' | 'tip' }[] = [
  { cells: '  █  ', tone: 'tip' },
  { cells: ' ███ ', tone: 'edge' },
  { cells: '█████', tone: 'core' },
  { cells: ' ███ ', tone: 'edge' },
  { cells: '  █  ', tone: 'tip' },
]

/**
 * Empty-state welcome panel: pixel brand mark beside model and workspace, with
 * the handful of keys that matter on first contact. Replaced by the
 * transcript as soon as the first turn starts.
 */
export function WelcomeBox(props: WelcomeBoxProps): ReactElement {
  const width = Math.min(props.capabilities.width - 2, 64)
  const markColor = (tone: 'core' | 'edge' | 'tip'): string => {
    switch (tone) {
      case 'core':
        return props.theme.accentStrong ?? props.theme.accent
      case 'edge':
        return props.theme.accent
      case 'tip':
        return props.theme.faint ?? props.theme.dim
    }
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={props.theme.dim}
      paddingX={2}
      paddingY={1}
      width={width}
    >
      <Box flexShrink={0}>
        <Box flexDirection="column">
          {MARK_ROWS.map((row, index) => (
            <Text key={index} color={markColor(row.tone)}>
              {row.cells}
            </Text>
          ))}
        </Box>
        {/* One blank row above and below keeps the identity block vertically
            centred against the five-pixel mark. */}
        <Box flexDirection="column" marginLeft={2}>
          <Text> </Text>
          <Text>
            <Text color={props.theme.accentStrong ?? props.theme.accent} bold>
              Spark
            </Text>
            <Text color={props.theme.dim}> v{props.version}</Text>
          </Text>
          <Text>
            <Text color={props.theme.dim}>模型 </Text>
            <Text {...(props.theme.fg === undefined ? {} : { color: props.theme.fg })}>
              {props.model ?? '未选择模型'}
            </Text>
          </Text>
          {props.cwd !== undefined && props.cwd !== '' && (
            <Text color={props.theme.dim}>目录 {props.cwd}</Text>
          )}
          <Text> </Text>
        </Box>
      </Box>
      <Text> </Text>
      <Text color={props.theme.dim}>输入任务直接开始 · /help 查看全部命令</Text>
      <Text color={props.theme.dim}>↑↓ 历史 · Shift+Enter 换行 · Esc 中断 · Ctrl+C 两次退出</Text>
    </Box>
  )
}
