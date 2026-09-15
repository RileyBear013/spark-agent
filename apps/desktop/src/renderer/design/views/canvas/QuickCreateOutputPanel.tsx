import { useMemo, useState } from 'react'
import { Button } from '@lobehub/ui'
import type { CanvasMediaTaskAsset, CanvasMediaTaskInputFile } from '@spark/protocol'
import { Icons } from '../../Icons'
import { ImagePreviewModal, type LightboxImage } from '../../components/ImagePreviewModal'
import { resolveMediaDisplayUrl } from './canvas-safe-file'
import type { QuickCreateTaskRecord } from './quickCreateTaskStore'
import './QuickCreateOutputPanel.less'

function assetUrl(asset: CanvasMediaTaskAsset | undefined): string {
  return asset
    ? resolveMediaDisplayUrl({
        url: asset.url,
        filePath: asset.filePath,
        dataUrl: asset.previewDataUrl,
      })
    : ''
}

function inputUrl(input: CanvasMediaTaskInputFile | undefined): string {
  return input ? resolveMediaDisplayUrl({ url: input.url, filePath: input.path }) : ''
}

function fileName(value: string | undefined, fallback: string): string {
  return value?.split(/[\\/]/).pop() || fallback
}

function statusLabel(status: QuickCreateTaskRecord['status']): string {
  return { running: '处理中', succeeded: '已完成', failed: '未完成', cancelled: '已取消' }[status]
}

export function QuickCreateOutputPanel({
  task,
  onOpenOutput,
}: {
  task?: QuickCreateTaskRecord | undefined
  onOpenOutput?: ((asset: CanvasMediaTaskAsset) => void) | undefined
}) {
  const [outputIndex, setOutputIndex] = useState(0)
  const [compareOpen, setCompareOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)

  const outputs = useMemo(
    () => task?.assets.filter((asset) => asset.type === 'image' || asset.type === 'video') ?? [],
    [task?.assets],
  )
  const safeOutputIndex = Math.min(outputIndex, Math.max(outputs.length - 1, 0))
  const currentOutput = outputs[safeOutputIndex]
  const currentUrl = assetUrl(currentOutput)
  const inputImage = task?.inputFiles.find((input) => input.type === 'image')
  const inputImageUrl = inputUrl(inputImage)
  const imageOutputs = outputs.filter((asset) => asset.type === 'image')
  const imagePreviewIndex =
    currentOutput?.type === 'image' ? imageOutputs.indexOf(currentOutput) : -1
  const lightboxImages: LightboxImage[] = imageOutputs
    .map((asset, index) => {
      const src = assetUrl(asset)
      return src
        ? {
            src,
            alt: asset.title ?? `生成结果 ${index + 1}`,
            fileName: fileName(asset.filePath, `quick-create-${index + 1}.png`),
          }
        : null
    })
    .filter((item): item is LightboxImage => item != null)
  const lightboxStartIndex = lightboxImages.findIndex((image) => image.src === currentUrl)

  if (!task) {
    return (
      <section className="quick-create-output-panel is-empty" aria-label="输出预览">
        <div className="quick-create-output-empty">
          <span className="quick-create-output-empty-mark">
            <Icons.Image size={22} />
          </span>
          <strong>等待创作结果</strong>
          <span>提交任务后，结果会在这里呈现。</span>
        </div>
      </section>
    )
  }

  const openPreview = () => {
    if (currentOutput?.type === 'image' && lightboxImages.length > 0) setPreviewOpen(true)
  }

  return (
    <section className="quick-create-output-panel" aria-label="输出预览">
      <div className="quick-create-output-meta">
        <span className={`quick-create-task-status is-${task.status}`}>
          <i />
          {statusLabel(task.status)}
        </span>
        <span className="quick-create-output-count">
          {outputs.length > 0
            ? `${outputs.length} 个输出`
            : task.status === 'running'
              ? '队列处理中'
              : '暂无输出'}
        </span>
        {currentOutput?.filePath && onOpenOutput && (
          <Button size="small" type="text" onClick={() => onOpenOutput(currentOutput)}>
            打开产物
          </Button>
        )}
      </div>

      {outputs.length > 0 && currentOutput && currentUrl ? (
        <>
          <div className="quick-create-output-stage">
            {compareOpen && currentOutput.type === 'image' && inputImageUrl ? (
              <div className="quick-create-compare-view" aria-label="输入图与输出图对比">
                <div>
                  <span>输入图</span>
                  <img src={inputImageUrl} alt="输入参考图" />
                </div>
                <div>
                  <span>输出图</span>
                  <img src={currentUrl} alt="生成输出图" />
                </div>
              </div>
            ) : currentOutput.type === 'video' ? (
              <video src={currentUrl} controls className="quick-create-output-media" />
            ) : (
              <button
                type="button"
                className="quick-create-output-image-button"
                onClick={openPreview}
                aria-label="点击查看大图"
              >
                <img src={currentUrl} alt={currentOutput.title ?? '生成结果'} />
                <span>点击查看大图</span>
              </button>
            )}
          </div>
          <div className="quick-create-output-toolbar">
            <button
              type="button"
              aria-label="上一项输出"
              disabled={outputs.length < 2}
              onClick={() =>
                setOutputIndex((current) => (current - 1 + outputs.length) % outputs.length)
              }
            >
              <Icons.ChevronLeft size={15} />
            </button>
            <span>
              {safeOutputIndex + 1} / {outputs.length}
            </span>
            <button
              type="button"
              aria-label="下一项输出"
              disabled={outputs.length < 2}
              onClick={() => setOutputIndex((current) => (current + 1) % outputs.length)}
            >
              <Icons.ChevronRight size={15} />
            </button>
            {currentOutput.type === 'image' && inputImageUrl && (
              <button
                type="button"
                className={compareOpen ? 'is-active' : ''}
                onClick={() => setCompareOpen((current) => !current)}
              >
                <Icons.Combine size={14} />
                {compareOpen ? '退出对比' : '输入 / 输出对比'}
              </button>
            )}
          </div>
        </>
      ) : task.text ? (
        <pre className="quick-create-output-text">{task.text}</pre>
      ) : task.status === 'running' ? (
        <div className="quick-create-output-pending">
          <div className="quick-create-output-loader" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <strong>创作进行中</strong>
          <span>任务已加入队列，完成后会自动展示结果。</span>
          {task.progress !== undefined && (
            <div
              className="quick-create-output-progress"
              aria-label={`处理进度 ${Math.round(task.progress)}%`}
            >
              <span style={{ width: `${Math.min(100, Math.max(0, task.progress))}%` }} />
            </div>
          )}
          <small>
            {task.progress !== undefined
              ? `${Math.round(task.progress)}%`
              : '可在任务管理中查看详情'}
          </small>
        </div>
      ) : task.status === 'failed' ? (
        <div className="quick-create-output-pending is-error" role="alert">
          <Icons.AlertTriangle size={20} />
          <strong>这次创作没有完成</strong>
          <span>{task.error?.message ?? '任务未能返回结果，请检查配置后重试。'}</span>
        </div>
      ) : (
        <div className="quick-create-output-pending is-cancelled">
          <Icons.XCircle size={20} />
          <strong>任务已取消</strong>
          <span>可以在任务管理中重新提交这项创作。</span>
        </div>
      )}

      {previewOpen && currentOutput?.type === 'image' && lightboxImages.length > 0 && (
        <ImagePreviewModal
          src={currentUrl}
          alt={currentOutput.title ?? '生成结果'}
          fileName={fileName(currentOutput.filePath, 'quick-create-output.png')}
          onClose={() => setPreviewOpen(false)}
          navigation={{
            images: lightboxImages,
            startIndex: Math.max(
              lightboxStartIndex >= 0 ? lightboxStartIndex : imagePreviewIndex,
              0,
            ),
          }}
        />
      )}
    </section>
  )
}
