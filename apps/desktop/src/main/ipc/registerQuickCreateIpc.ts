/**
 * 快速创作 IPC
 *
 * 提供：cleanup-task-resources（删除任务时清理其专属文件资源）。
 *
 * 清理策略（防止误删共享资源，渲染端传入的路径都会在此二次过滤）：
 *   - 产物文件：仅删除画布媒体目录（userData/.spark-artifacts/media）下的文件；
 *   - 输入文件：仅删除 quick-create-inputs 任务专属拷贝目录下的文件——
 *     用户原始文件与与其他功能共享的粘贴素材目录不在该目录内，天然被跳过；
 *   - 删除优先送系统回收站（可恢复），回收站不可用时回退为直接删除。
 */

import { app, shell } from 'electron'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from '@spark/shared'
import type {
  QuickCreateCleanupTaskResourcesRequest,
  QuickCreateCleanupTaskResourcesResponse,
} from '@spark/protocol'
import { typedIpcHandle } from './typed-ipc.js'

const log = createLogger('quick-create-ipc')

/** 与 ipc/index.ts 的 getDefaultCanvasMediaDir() 保持一致：画布多媒体产物默认落盘根目录 */
function getCanvasMediaRootDir(): string {
  return path.join(app.getPath('userData'), '.spark-artifacts', 'media')
}

/** 快速创作输入素材的任务专属拷贝目录（file:prepare-media-input 落盘位置） */
function getQuickCreateInputRootDir(): string {
  return path.join(getCanvasMediaRootDir(), 'quick-create-inputs')
}

function isFileInsideDir(candidate: string, dir: string): boolean {
  const resolved = path.resolve(candidate)
  const resolvedDir = path.resolve(dir)
  if (resolved === resolvedDir) return false
  return resolved.startsWith(resolvedDir + path.sep)
}

async function statIsFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile()
  } catch {
    return false
  }
}

/** 送回收站优先，失败（如环境不支持）回退为直接删除 */
async function removeToTrashOrDelete(filePath: string): Promise<void> {
  try {
    await shell.trashItem(filePath)
  } catch {
    await fs.rm(filePath, { force: true })
  }
}

export function registerQuickCreateIpc(): void {
  typedIpcHandle(
    'quick-create:cleanup-task-resources',
    async (
      req: QuickCreateCleanupTaskResourcesRequest,
    ): Promise<QuickCreateCleanupTaskResourcesResponse> => {
      const deletedPaths: string[] = []
      const skippedPaths: string[] = []
      const errors: Array<{ path: string; message: string }> = []

      const cleanup = async (candidates: string[], allowedDir: string) => {
        for (const candidate of candidates) {
          if (!isFileInsideDir(candidate, allowedDir) || !(await statIsFile(candidate))) {
            skippedPaths.push(candidate)
            continue
          }
          try {
            await removeToTrashOrDelete(candidate)
            deletedPaths.push(candidate)
          } catch (err) {
            errors.push({
              path: candidate,
              message: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }

      // 输入素材只在任务专属拷贝目录内删除；产物在画布媒体目录内删除
      await cleanup(req.inputPaths, getQuickCreateInputRootDir())
      const inputDeleted = deletedPaths.length
      await cleanup(req.assetPaths, getCanvasMediaRootDir())
      log.info(
        `[cleanup-task-resources] inputs deleted=${inputDeleted}, assets deleted=${
          deletedPaths.length - inputDeleted
        }, skipped=${skippedPaths.length}, errors=${errors.length}`,
      )

      return { deletedPaths, skippedPaths, errors }
    },
  )
}
