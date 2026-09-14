/**
 * 产物查看器的轻量偏好（localStorage）。
 *
 * 目前只承载「上次下载目录」：下载产物时作为 file:save-image 的 defaultDirectory，
 * 让下一次保存对话框直接落在用户上次选择的目录。
 */

const DOWNLOAD_DIR_KEY = 'spark:media-viewer:download-dir:v1'

export function readLastMediaDownloadDir(): string | undefined {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return undefined
  try {
    const value = window.localStorage.getItem(DOWNLOAD_DIR_KEY)
    return value && value.trim() ? value : undefined
  } catch {
    return undefined
  }
}

export function writeLastMediaDownloadDir(dirPath: string): void {
  const trimmed = dirPath.trim()
  if (!trimmed) return
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return
  try {
    window.localStorage.setItem(DOWNLOAD_DIR_KEY, trimmed)
  } catch {
    // 存储不可用时保持内存态即可，不影响本次下载
  }
}
