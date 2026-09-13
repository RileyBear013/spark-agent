#!/usr/bin/env node
/**
 * 跨平台单元测试编排器（test:unit 的统一入口）。
 *
 * 背景：原 npm script 直接调 scripts/sqlite-abi.sh 切换 better-sqlite3 的
 * Node/Electron ABI，但 pnpm 在 Windows 上经 cmd.exe 执行脚本——.sh 与 `$?`
 * 语法均不可用，标准命令在这类机器上是坏的；且 vendor/prebuilds 里 checkin
 * 的是 macOS 二进制，Windows 上做「复制切换」会把 Mach-O 覆盖到本地
 * PE 二进制上直接损坏运行环境。
 *
 * 因此按平台分流：
 * - win32：不做任何 ABI 文件切换（better-sqlite3 保持 Electron ABI），
 *   vitest 改用 Electron 运行时执行（ELECTRON_RUN_AS_NODE=1），
 *   原生模块 ABI 天然匹配，对本机正在运行的应用零干扰。
 * - posix：沿用既有 sqlite-abi.sh 切换流程，行为与原 npm script 等价
 *   （node ABI 跑测 → finally 恢复 electron ABI，保留真实退出码）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const pkgDir = process.cwd()
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, '..')

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (result.error) {
    console.error(`[test:unit] 无法启动 ${cmd}: ${result.error.message}`)
    process.exit(1)
  }
  return result.status ?? 1
}

const vitestEntry = path.join(rootDir, 'node_modules', 'vitest', 'vitest.mjs')
if (!existsSync(vitestEntry)) {
  console.error('[test:unit] 未找到根 node_modules/vitest —— 请先 pnpm install')
  process.exit(1)
}

let code
if (process.platform === 'win32') {
  const electronExe = path.join(rootDir, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!existsSync(electronExe)) {
    console.error('[test:unit] 未找到 Electron 可执行文件（postinstall 未落 dist）——请先 pnpm install')
    process.exit(1)
  }
  code = run(electronExe, [vitestEntry, 'run', '--no-file-parallelism'], {
    cwd: pkgDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  // 注：vitest 默认多 worker 并行在 ELECTRON_RUN_AS_NODE 下会随机挂死
  // （worker 结束信号不被 electron 运行时正确回传），故强制单 worker 顺序执行；
  // 249 个测试文件实测 ~5 分钟，可接受。
} else {
  const abiScript = path.join(rootDir, 'scripts', 'sqlite-abi.sh')
  const switched = run('/bin/bash', [abiScript, 'node'])
  if (switched !== 0) process.exit(switched)
  try {
    code = run(process.execPath, [vitestEntry, 'run'], { cwd: pkgDir })
  } finally {
    run('/bin/bash', [abiScript, 'electron'])
  }
}
process.exit(code)
