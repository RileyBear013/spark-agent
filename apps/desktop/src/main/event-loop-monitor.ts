/**
 * 主进程事件循环阻塞监测器（诊断插桩，根因确认后移除）
 *
 * 背景：用户偶发「界面动画正常但鼠标划过窗口变 loading 转圈」——渲染进程
 * 合成器线程独立，CSS 动画不受影响；macOS 主线程 >~2s 不处理事件时鼠标才会
 * 变忙碌圈。因此嫌疑锁定在主进程事件循环被同步长任务（sqlite 同步 IO /
 * Keychain 访问等）间歇性阻塞，但日志时间空洞无法定罪。
 *
 * 机制（零新增依赖，全部 Node 内置）：
 *   1. perf_hooks.monitorEventLoopDelay 直方图，每秒检查一次窗口内最大延迟；
 *   2. 常驻 V8 采样 profiler（inspector API，1ms 采样，独立线程采样——主线程
 *      被卡住时恰恰能采到被卡住的调用栈）按 60s 分段滚动运行，无阻塞时每段
 *      仅覆盖写同一个临时文件，磁盘占用恒定；
 *   3. 检测到 >500ms 阻塞后：立即截断当前分段 → 按阻塞时间窗过滤采样 →
 *      聚合出阻塞期间的热点调用栈（自帧 + 调用链）→ 以 warn 级别写入
 *      <logs>/main.log（生产环境默认 warn 级，debug/info 不落盘）；
 *      完整 .cpuprofile 另存 <logs>/main-block-profiles/ 供深挖。
 *
 * 前缀统一为 [main-blocked]，便于检索。SPARK_DISABLE_LOOP_MONITOR=1 可关闭。
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { Session } from 'node:inspector'
import type { Profiler } from 'node:inspector'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger, getLogFilePath } from '@spark/shared'

const log = createLogger('main')

const BLOCK_THRESHOLD_MS = 500
const CHECK_INTERVAL_MS = 1_000
const SEGMENT_MS = 60_000
const SAMPLING_INTERVAL_US = 1_000
const MAX_BLOCK_PROFILES = 8
const TOP_FRAMES = 12
const MAX_CHAIN_ANCESTORS = 6

// ─── 纯函数：阻塞窗口内的热点帧聚合（独立导出便于单测） ──────────────────────

export interface BlockFrameSummary {
  /** 自帧 + 最多 MAX_CHAIN_ANCESTORS 层调用链，如 `fnA ← fnB ← fnC` */
  label: string
  /** 阻塞窗口内该自帧的采样命中数 */
  hits: number
}

/** 短路径：只保留文件名:行号，避免日志里刷长绝对路径 */
function shortFrame(node: Profiler.ProfileNode): string {
  const frame = node.callFrame
  const name = frame.functionName || '(anonymous)'
  const url = frame.url || ''
  if (!url || url.startsWith('native ')) return url ? `${name} [${url}]` : name
  const basename = url.split('/').pop() ?? url
  const line = (frame.lineNumber ?? -1) + 1
  return `${name} (${basename}:${line})`
}

/**
 * 从 cpuprofile 中聚合 [windowStartMs, windowEndMs]（相对 profile 起点）时间窗内
 * 各叶子帧（采样时刻栈顶）的命中数，按命中数降序返回 top N。
 * '(idle)' 与 '(program)' 帧不算阻塞证据，直接过滤；'(garbage collector)'
 * 保留——GC 停顿本身是真实根因信号。
 */
export function aggregateTopFramesInWindow(
  profile: Profiler.Profile,
  windowStartMs: number,
  windowEndMs: number,
  limit = TOP_FRAMES,
): BlockFrameSummary[] {
  const { nodes, samples, timeDeltas } = profile
  if (!nodes?.length || !samples?.length || !timeDeltas?.length) return []

  const nodeById = new Map<number, Profiler.ProfileNode>()
  const parentById = new Map<number, number>()
  for (const node of nodes) {
    nodeById.set(node.id, node)
    for (const childId of node.children ?? []) parentById.set(childId, node.id)
  }

  // timeDeltas[i] 是第 i 个采样距上一个采样的微秒数；累加得到相对 profile 起点的偏移
  const counts = new Map<number, number>()
  let offsetUs = 0
  for (let i = 0; i < samples.length; i++) {
    offsetUs += timeDeltas[i] ?? 0
    const offsetMs = offsetUs / 1000
    if (offsetMs < windowStartMs) continue
    if (offsetMs > windowEndMs) break
    const id = samples[i]
    if (id == null) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  const entries = [...counts.entries()]
    .map(([id, hits]) => {
      const node = nodeById.get(id)
      if (!node) return null
      const self = shortFrame(node)
      if (self === '(idle)' || self === '(program)') return null
      // 自帧 ← 直接调用者 ← ... 最多 MAX_CHAIN_ANCESTORS 层
      const chain: string[] = []
      let cursor: number | undefined = parentById.get(id)
      while (cursor != null && chain.length < MAX_CHAIN_ANCESTORS) {
        const parent = nodeById.get(cursor)
        if (!parent) break
        chain.push(shortFrame(parent))
        cursor = parentById.get(cursor)
      }
      const label = chain.length > 0 ? `${self} ← ${chain.join(' ← ')}` : self
      return { label, hits }
    })
    .filter((v): v is BlockFrameSummary => v != null)
    .sort((a, b) => b.hits - a.hits)
  return entries.slice(0, limit)
}

// ─── 运行时：直方图检测 + 滚动 profiler ───────────────────────────────────────

interface PendingBlock {
  /** 本次检测窗口内观察到的最大事件循环延迟（毫秒） */
  durationMs: number
  /** 检测时刻墙钟时间（Date.now()） */
  detectedAt: number
}

let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null
let checkTimer: ReturnType<typeof setInterval> | null = null
let session: Session | null = null
let stopping = false
let pendingBlock: PendingBlock | null = null
let segmentStartWallMs = 0
let segmentWaiter: (() => void) | null = null
let profilerLoopRunning = false

function send(
  method: 'Profiler.enable' | 'Profiler.setSamplingInterval' | 'Profiler.start' | 'Profiler.stop',
  params?: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!session) {
      reject(new Error('inspector session not connected'))
      return
    }
    session.post(method, params, (err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
  })
}

function waitSegment(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      segmentWaiter = null
      resolve()
    }, SEGMENT_MS)
    segmentWaiter = () => {
      clearTimeout(timer)
      segmentWaiter = null
      resolve()
    }
  })
}

function interruptSegment(): void {
  segmentWaiter?.()
}

/** 解析 profile 落盘目录：<logs>/main-block-profiles；文件日志未初始化时返回 null */
function resolveProfileDir(): string | null {
  const logFilePath = getLogFilePath()
  if (!logFilePath) return null
  const dir = path.join(path.dirname(logFilePath), 'main-block-profiles')
  try {
    fs.mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return null
  }
}

/** 覆盖写滚动分段（无阻塞证据时的占位快照，磁盘占用恒定） */
function writeRollingSegment(profile: Profiler.Profile, dir: string): void {
  try {
    fs.writeFileSync(path.join(dir, 'segment-latest.cpuprofile'), JSON.stringify(profile))
  } catch (err) {
    log.warn(`[main-blocked] failed to write rolling segment: ${String(err)}`)
  }
}

/** 持久化阻塞现场 profile，并按 MAX_BLOCK_PROFILES 剪枝旧文件 */
function writeBlockProfile(
  profile: Profiler.Profile,
  dir: string,
  durationMs: number,
  detectedAt: number,
): string | null {
  const stamp = new Date(detectedAt).toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `block-${stamp}-${Math.round(durationMs)}ms.cpuprofile`)
  try {
    fs.writeFileSync(file, JSON.stringify(profile))
  } catch (err) {
    log.warn(`[main-blocked] failed to write block profile: ${String(err)}`)
    return null
  }
  try {
    const stale = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('block-') && name.endsWith('.cpuprofile'))
      .sort()
    for (const name of stale.slice(0, Math.max(0, stale.length - MAX_BLOCK_PROFILES))) {
      fs.unlinkSync(path.join(dir, name))
    }
  } catch {
    /* 剪枝失败不影响本次记录 */
  }
  return file
}

async function handleStoppedSegment(profile: Profiler.Profile): Promise<void> {
  const block = pendingBlock
  pendingBlock = null

  const dir = resolveProfileDir()
  if (!block) {
    if (dir) writeRollingSegment(profile, dir)
    return
  }

  // 阻塞时间窗（相对 profile 起点的毫秒偏移）：检测时刻回溯 durationMs。
  // 检测本身最多晚 CHECK_INTERVAL_MS，窗口略有重叠但不影响定位热点。
  const blockEndOffset = Math.max(0, block.detectedAt - segmentStartWallMs)
  const blockStartOffset = Math.max(0, blockEndOffset - block.durationMs)
  const top = aggregateTopFramesInWindow(profile, blockStartOffset, blockEndOffset)

  log.warn(
    `[main-blocked] event loop blocked ${Math.round(block.durationMs)}ms (threshold ${BLOCK_THRESHOLD_MS}ms); top frames during block:`,
  )
  if (top.length === 0) {
    log.warn(
      '[main-blocked] no JS samples in block window (可能阻塞在 native 层，如同步 IO / Keychain)',
    )
  } else {
    top.forEach((frame, index) => {
      log.warn(`[main-blocked] #${index + 1} ${frame.hits} hits | ${frame.label}`)
    })
  }
  if (dir) {
    const file = writeBlockProfile(profile, dir, block.durationMs, block.detectedAt)
    if (file) log.warn(`[main-blocked] full cpuprofile saved: ${file}`)
  }
}

async function runProfilerLoop(): Promise<void> {
  try {
    await send('Profiler.enable')
    await send('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US })
  } catch (err) {
    log.warn(`[main-blocked] profiler init failed, monitor degraded to delay-only: ${String(err)}`)
    return
  }
  while (!stopping && session) {
    try {
      await send('Profiler.start')
      segmentStartWallMs = Date.now()
      await waitSegment()
      const result = (await send('Profiler.stop')) as { profile?: Profiler.Profile }
      if (result?.profile) await handleStoppedSegment(result.profile)
    } catch (err) {
      log.warn(`[main-blocked] profiler segment error: ${String(err)}`)
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
  }
  try {
    session?.disconnect()
  } catch {
    /* ignore */
  }
}

function checkBlock(): void {
  if (!histogram) return
  const maxNs = histogram.max
  histogram.reset()
  const durationMs = maxNs / 1e6
  if (durationMs < BLOCK_THRESHOLD_MS) return
  // 当前分段已标记过阻塞（例如连续多个检查窗口都超阈值）时不重复截断
  if (pendingBlock) return
  pendingBlock = { durationMs, detectedAt: Date.now() }
  interruptSegment()
}

/**
 * 激活事件来源的最小结构类型。主进程传入 Electron 的 `app`；用结构化参数而非
 * 直接 import electron，保证本模块在单测（node 环境）中可安全加载。
 */
export interface ActivationSource {
  on(event: 'did-become-active', listener: () => void): unknown
}

/**
 * 启动事件循环阻塞监测。必须在 initFileLogger 之后调用（profile 落盘目录依赖
 * 日志目录）；重复调用为 no-op。
 *
 * appTarget（可选）：传入 Electron `app` 后，额外以 warn 级记录
 * `[main-activate]` 激活事件。定位「点 Dock 图标无法置前」时，把该时间戳与
 * [main-blocked] 条目对照：若激活事件的处理时间落在阻塞窗口之后，说明激活
 * 请求被阻塞排队——与鼠标变忙碌圈是同一根因。
 */
export function startEventLoopMonitor(appTarget?: ActivationSource): void {
  if (process.env.SPARK_DISABLE_LOOP_MONITOR === '1') return
  if (histogram) return

  try {
    appTarget?.on('did-become-active', () => {
      log.warn('[main-activate] app became active (did-become-active processed)')
    })
  } catch (err) {
    log.warn(`[main-activate] failed to hook activation events: ${String(err)}`)
  }

  histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()

  session = new Session()
  try {
    session.connect()
  } catch (err) {
    log.warn(`[main-blocked] inspector session connect failed: ${String(err)}`)
    session = null
  }

  if (session && !profilerLoopRunning) {
    profilerLoopRunning = true
    void runProfilerLoop().finally(() => {
      profilerLoopRunning = false
    })
  }

  checkTimer = setInterval(checkBlock, CHECK_INTERVAL_MS)
  checkTimer.unref?.()
  // 用 warn 级确保生产环境（默认 warn 起落盘）也能在 main.log 看到插桩已生效
  log.warn(
    `[main-blocked] monitor armed (threshold=${BLOCK_THRESHOLD_MS}ms, sampling=${SAMPLING_INTERVAL_US}us)`,
  )
}

/** 停止监测（应用退出时调用；进程退出本身也会清理，不调用也安全） */
export function stopEventLoopMonitor(): void {
  stopping = true
  if (checkTimer) {
    clearInterval(checkTimer)
    checkTimer = null
  }
  histogram?.disable()
  histogram = null
  interruptSegment()
}
