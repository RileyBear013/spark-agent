import type { ComponentType } from 'react'
import type { CanvasMediaTaskAsset } from '@spark/protocol'
import { Icons } from '../../Icons'
import type { LightboxImage } from '../../components/ImagePreviewModal'
import { resolveMediaDisplayUrl } from './canvas-safe-file'
import type {
  QuickCreateMode,
  QuickCreateTaskRecord,
  QuickCreateTaskStatus,
} from './quickCreateTaskStore'

export const MODE_ITEMS: Array<{
  id: QuickCreateMode
  label: string
  icon: ComponentType<{ size?: number }>
}> = [
  { id: 'image', label: '图片生成', icon: Icons.ImagePlus },
  { id: 'reverse', label: '图片反推', icon: Icons.Eye },
  { id: 'video', label: '视频生成', icon: Icons.Video },
]

export function modeLabel(mode: QuickCreateMode): string {
  return MODE_ITEMS.find((item) => item.id === mode)?.label ?? mode
}

export function titleForPrompt(prompt: string, mode: QuickCreateMode): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim()
  return firstLine?.slice(0, 40) || `${modeLabel(mode)}提示词`
}

export function statusLabel(status: QuickCreateTaskStatus): string {
  return { running: '处理中', succeeded: '已完成', failed: '未完成', cancelled: '已取消' }[status]
}

export function taskOutputUrl(asset: CanvasMediaTaskAsset | undefined): string {
  return asset
    ? resolveMediaDisplayUrl({
        url: asset.url,
        filePath: asset.filePath,
        dataUrl: asset.previewDataUrl,
      })
    : ''
}

/** 任务详情弹层的大图浏览清单：只收集成功解析出 URL 的图片产物。 */
export function lightboxImagesOf(task: QuickCreateTaskRecord): LightboxImage[] {
  return task.assets
    .map((asset, index) => {
      const src = asset.type === 'image' ? taskOutputUrl(asset) : ''
      return src
        ? {
            src,
            alt: asset.title ?? `生成结果 ${index + 1}`,
            fileName: asset.filePath?.split(/[\\/]/).pop() || `quick-create-${index + 1}.png`,
          }
        : null
    })
    .filter((item): item is LightboxImage => item != null)
}
