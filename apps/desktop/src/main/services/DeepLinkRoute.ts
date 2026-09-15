/**
 * Spark-Agent 自定义协议（`spark-agent://`）入口解析
 *
 * 所有 deep link 都需要在三个入口统一处理：
 *   1. macOS 运行中：`app.on('open-url')`
 *   2. Windows 运行中：`installSingleInstanceLock` 的 commandLine 回调
 *   3. 两端冷启动：启动时扫描 `process.argv`
 *
 * 为避免在 index.ts 里按 host 堆叠 if，这里把「URL → 路由」集中成纯函数，
 * 新增 host 只需扩展这里的分支与类型。
 *
 * 安全约定：deep link 属于不可信输入（浏览器历史、Windows 命令行 argv、
 * 恶意程序抢注同协议均可构造），因此每个 host 只接受严格格式的参数，
 * 并且**绝不承载任何凭证**（见桌面端浏览器登录设计：只传 state）。
 */

const PROTOCOL = 'spark-agent:'
const MAX_CODE_LENGTH = 256
/** state：与服务端 32~128 个十六进制字符的约定一致（桌面端生成 64 字符） */
const MAX_STATE_LENGTH = 128
const STATE_RE = /^[0-9a-f]{32,128}$/

export type DeepLinkRoute =
  | { kind: 'redeem'; code: string }
  | { kind: 'auth-callback'; state: string }

/** 拒绝空白与控制字符（含换行注入） */
function hasUnsafeCharacters(value: string): boolean {
  return /[\s\p{Cc}]/u.test(value)
}

function parseTarget(value: string): URL | null {
  try {
    const target = new URL(value)
    return target.protocol === PROTOCOL ? target : null
  } catch {
    return null
  }
}

/** `spark-agent://redeem?code=xxx` */
function parseRedeem(target: URL): DeepLinkRoute | null {
  const code = target.searchParams.get('code')?.trim() ?? ''
  if (!code || code.length > MAX_CODE_LENGTH || hasUnsafeCharacters(code)) return null
  return { kind: 'redeem', code }
}

/** `spark-agent://auth-callback?state=xxx`（仅唤醒信号，不含任何凭证） */
function parseAuthCallback(target: URL): DeepLinkRoute | null {
  const state = target.searchParams.get('state')?.trim() ?? ''
  if (!STATE_RE.test(state) || state.length > MAX_STATE_LENGTH) return null
  return { kind: 'auth-callback', state }
}

export function parseDeepLinkRoute(value: string): DeepLinkRoute | null {
  const target = parseTarget(value)
  if (!target) return null
  switch (target.hostname) {
    case 'redeem':
      return parseRedeem(target)
    case 'auth-callback':
      return parseAuthCallback(target)
    default:
      return null
  }
}

export function findDeepLinkRoute(values: readonly string[]): DeepLinkRoute | null {
  for (const value of values) {
    const route = parseDeepLinkRoute(value)
    if (route) return route
  }
  return null
}
