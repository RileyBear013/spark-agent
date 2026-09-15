import { useMemo, useState } from 'react'
import { Button, Modal } from 'antd'
import type { CanvasMediaTaskAsset } from '@spark/protocol'
import { Icons } from '../../Icons'
import { ImagePreviewModal } from '../../components/ImagePreviewModal'
import {
  MODE_ITEMS,
  lightboxImagesOf,
  modeLabel,
  statusLabel,
  taskOutputUrl,
  titleForPrompt,
} from './quickCreateTaskPresentation'
import {
  readQuickCreatePreferences,
  writeQuickCreatePreferences,
  type QuickCreateTaskViewMode,
} from './quickCreatePreferences'
import type { QuickCreateMode, QuickCreateTaskRecord } from './quickCreateTaskStore'

type HistoryProps = {
  tasks: QuickCreateTaskRecord[]
  expandedTaskId: string | null
  onRowActivate: (task: QuickCreateTaskRecord) => void
  onFocusTask: (task: QuickCreateTaskRecord) => void
  onReuse: (task: QuickCreateTaskRecord) => void
  onCancel: (task: QuickCreateTaskRecord) => void
  onRetry: (task: QuickCreateTaskRecord) => void
  onDelete: (taskId: string) => void
  onOpenOutput: (asset: CanvasMediaTaskAsset) => void
}

/**
 * 任务管理 Tab：顶部保留概览 / 模式筛选，右侧提供 列表 / 卡片 视图切换。
 * 列表视图为可展开行；卡片视图以瀑布流只呈现产物图片，点击图片打开详情弹层。
 */
export function QuickCreateTaskHistory({
  tasks,
  expandedTaskId,
  onRowActivate,
  onFocusTask,
  onReuse,
  onCancel,
  onRetry,
  onDelete,
  onOpenOutput,
}: HistoryProps) {
  const [filter, setFilter] = useState<QuickCreateMode | 'all'>('all')
  const [view, setView] = useState<QuickCreateTaskViewMode>(
    () => readQuickCreatePreferences().taskView ?? 'list',
  )
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  const visibleTasks = useMemo(
    () => (filter === 'all' ? tasks : tasks.filter((task) => task.mode === filter)),
    [filter, tasks],
  )
  const cardTasks = useMemo(
    () => visibleTasks.filter((task) => task.assets.some((asset) => asset.type === 'image')),
    [visibleTasks],
  )
  const detailTask = useMemo(
    () => (detailTaskId ? (tasks.find((task) => task.id === detailTaskId) ?? null) : null),
    [detailTaskId, tasks],
  )
  const detailImages = useMemo(() => (detailTask ? lightboxImagesOf(detailTask) : []), [detailTask])

  const changeView = (next: QuickCreateTaskViewMode) => {
    setView(next)
    writeQuickCreatePreferences({ ...readQuickCreatePreferences(), taskView: next })
  }

  const renderTaskActions = (task: QuickCreateTaskRecord, output?: CanvasMediaTaskAsset) => (
    <div className="quick-create-task-actions">
      {task.status === 'running' && task.runtimeTaskId && (
        <Button size="small" type="text" onClick={() => void onCancel(task)}>
          取消任务
        </Button>
      )}
      {task.status === 'failed' && (
        <Button
          size="small"
          type="text"
          icon={<Icons.RotateCcw size={13} />}
          onClick={() => onRetry(task)}
        >
          重试
        </Button>
      )}
      {(task.status === 'succeeded' || task.status === 'failed') && (
        <Button size="small" type="text" onClick={() => onReuse(task)}>
          复用配置
        </Button>
      )}
      {output?.filePath && (
        <Button size="small" type="text" onClick={() => void onOpenOutput(output)}>
          打开产物
        </Button>
      )}
      <Button size="small" type="text" danger onClick={() => onDelete(task.id)}>
        移除记录
      </Button>
    </div>
  )

  return (
    <section className="quick-create-history" aria-label="任务管理">
      <div className="quick-create-history-head">
        <div className="quick-create-history-overview">
          <strong>
            {tasks.some((task) => task.status === 'running')
              ? `${tasks.filter((task) => task.status === 'running').length} 个任务处理中`
              : '任务队列空闲'}
          </strong>
          <span>
            {tasks.length} 条记录 · {tasks.filter((task) => task.status === 'succeeded').length} 个
            已完成
          </span>
        </div>
        <div className="quick-create-history-tools">
          <div className="quick-create-history-filters" role="tablist" aria-label="记录筛选">
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'all'}
              className={filter === 'all' ? 'is-active' : ''}
              onClick={() => setFilter('all')}
            >
              全部 <small>{tasks.length}</small>
            </button>
            {MODE_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={filter === item.id}
                className={filter === item.id ? 'is-active' : ''}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
                <small>{tasks.filter((task) => task.mode === item.id).length}</small>
              </button>
            ))}
          </div>
          <div className="quick-create-view-toggle" role="radiogroup" aria-label="任务展示方式">
            <button
              type="button"
              role="radio"
              aria-checked={view === 'list'}
              aria-label="列表视图"
              title="列表视图"
              className={view === 'list' ? 'is-active' : ''}
              onClick={() => changeView('list')}
            >
              <Icons.Menu size={14} />
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={view === 'grid'}
              aria-label="卡片视图"
              title="卡片视图"
              className={view === 'grid' ? 'is-active' : ''}
              onClick={() => changeView('grid')}
            >
              <Icons.Grid size={14} />
            </button>
          </div>
        </div>
      </div>

      {view === 'grid' ? (
        cardTasks.length === 0 ? (
          <div className="quick-create-history-empty">
            <Icons.History size={20} />
            <strong>还没有可展示的产物图片</strong>
            <span>卡片视图只显示已生成图片的任务，可切换回列表查看全部记录。</span>
          </div>
        ) : (
          <div className="quick-create-card-grid">
            {cardTasks.map((task) => {
              const cover = task.assets.find((asset) => asset.type === 'image')
              const coverUrl = taskOutputUrl(cover)
              const imageCount = task.assets.filter((asset) => asset.type === 'image').length
              return (
                <article className="quick-create-card" key={task.id}>
                  <button
                    type="button"
                    className="quick-create-card-media"
                    aria-label={`查看详情：${titleForPrompt(task.prompt, task.mode)}`}
                    onClick={() => setDetailTaskId(task.id)}
                  >
                    <img
                      src={coverUrl}
                      alt={titleForPrompt(task.prompt, task.mode)}
                      loading="lazy"
                    />
                    <span className="quick-create-card-veil" aria-hidden="true">
                      <strong>{titleForPrompt(task.prompt, task.mode)}</strong>
                      <small>{new Date(task.createdAt).toLocaleString()}</small>
                    </span>
                  </button>
                  {task.status !== 'succeeded' && (
                    <span className={`quick-create-task-status is-${task.status}`}>
                      <i />
                      {statusLabel(task.status)}
                    </span>
                  )}
                  {imageCount > 1 && (
                    <span className="quick-create-card-count">{imageCount} 图</span>
                  )}
                </article>
              )
            })}
          </div>
        )
      ) : (
        <div className="quick-create-history-list">
          {visibleTasks.length === 0 ? (
            <div className="quick-create-history-empty">
              <Icons.History size={20} />
              <strong>还没有创作任务</strong>
              <span>完成第一次生成后，任务会出现在这里。</span>
            </div>
          ) : (
            visibleTasks.map((task) => {
              const output = task.assets[0]
              const outputUrl = taskOutputUrl(output)
              const expanded = expandedTaskId === task.id
              return (
                <article
                  className={`quick-create-task${expanded ? ' is-expanded' : ''}`}
                  key={task.id}
                >
                  <button
                    type="button"
                    className="quick-create-task-main"
                    onClick={() => onRowActivate(task)}
                  >
                    <span className="quick-create-task-state">
                      <span className={`quick-create-task-status is-${task.status}`}>
                        <i />
                        {statusLabel(task.status)}
                      </span>
                      {task.status === 'running' && task.progress !== undefined && (
                        <small>{Math.round(task.progress)}%</small>
                      )}
                    </span>
                    <span className="quick-create-task-copy">
                      <strong>{titleForPrompt(task.prompt, task.mode)}</strong>
                      <small>
                        {modeLabel(task.mode)} · {task.modelName ?? task.modelId ?? '自动选择模型'}{' '}
                        · {new Date(task.createdAt).toLocaleString()}
                      </small>
                    </span>
                    {outputUrl && output?.type === 'image' ? (
                      <img src={outputUrl} alt="生成结果预览" />
                    ) : outputUrl && output?.type === 'video' ? (
                      <video src={outputUrl} muted />
                    ) : task.text ? (
                      <span className="quick-create-text-preview">{task.text.slice(0, 80)}</span>
                    ) : (
                      <span className="quick-create-task-placeholder">
                        <Icons.Sparkles size={15} />
                      </span>
                    )}
                    <Icons.ChevronDown size={15} className={expanded ? 'is-open' : ''} />
                  </button>
                  {expanded && (
                    <div className="quick-create-task-detail">
                      <div className="quick-create-detail-prompt">
                        <span>提示词</span>
                        <p>{task.prompt || '图片反推任务'}</p>
                      </div>
                      {task.negativePrompt && (
                        <div className="quick-create-detail-prompt">
                          <span>反向提示词</span>
                          <p>{task.negativePrompt}</p>
                        </div>
                      )}
                      {task.error && (
                        <div className="quick-create-task-error">
                          <Icons.AlertTriangle size={14} /> {task.error.message}
                        </div>
                      )}
                      <div className="quick-create-detail-meta">
                        <span>{modeLabel(task.mode)}</span>
                        <span>{task.modelName ?? task.modelId ?? '自动选择模型'}</span>
                        {task.status === 'running' && task.progress !== undefined && (
                          <span>进度 {Math.round(task.progress)}%</span>
                        )}
                      </div>
                      {task.text && <pre>{task.text}</pre>}
                      {outputUrl && (
                        <button
                          type="button"
                          className="quick-create-history-output-thumb"
                          onClick={() => onFocusTask(task)}
                        >
                          {output?.type === 'image' ? (
                            <img src={outputUrl} alt="生成结果缩略图" />
                          ) : output?.type === 'video' ? (
                            <video src={outputUrl} muted />
                          ) : null}
                          <span>在输出面板查看</span>
                        </button>
                      )}
                      {renderTaskActions(task, output)}
                    </div>
                  )}
                </article>
              )
            })
          )}
        </div>
      )}

      {detailTask && (
        <Modal
          open
          width={680}
          centered
          footer={null}
          title={null}
          className="quick-create-task-detail-modal"
          closeIcon={<Icons.X size={15} />}
          onCancel={() => setDetailTaskId(null)}
        >
          <div className="quick-create-detail-body">
            <div className="quick-create-detail-head">
              <span className={`quick-create-task-status is-${detailTask.status}`}>
                <i />
                {statusLabel(detailTask.status)}
              </span>
              <strong>{titleForPrompt(detailTask.prompt, detailTask.mode)}</strong>
              <small>
                {modeLabel(detailTask.mode)} ·{' '}
                {detailTask.modelName ?? detailTask.modelId ?? '自动选择模型'} ·{' '}
                {new Date(detailTask.createdAt).toLocaleString()}
              </small>
            </div>
            {detailImages.length > 0 ? (
              <button
                type="button"
                className="quick-create-detail-media"
                aria-label="查看大图"
                onClick={() => setLightboxOpen(true)}
              >
                <img src={detailImages[0]?.src} alt={detailImages[0]?.alt ?? '生成结果'} />
                {detailImages.length > 1 && (
                  <span className="quick-create-detail-count">
                    点击放大 · {detailImages.length} 图
                  </span>
                )}
              </button>
            ) : detailTask.status === 'running' ? (
              <div className="quick-create-detail-pending">
                <Icons.Sparkles size={16} />
                <span>任务处理中，完成后这里会显示产物图片。</span>
              </div>
            ) : (
              <div className="quick-create-detail-pending">
                <Icons.Image size={16} />
                <span>这条任务没有产物图片。</span>
              </div>
            )}
            <div className="quick-create-detail-prompt">
              <span>提示词</span>
              <p>{detailTask.prompt || '图片反推任务'}</p>
            </div>
            {detailTask.negativePrompt && (
              <div className="quick-create-detail-prompt">
                <span>反向提示词</span>
                <p>{detailTask.negativePrompt}</p>
              </div>
            )}
            {detailTask.error && (
              <div className="quick-create-task-error">
                <Icons.AlertTriangle size={14} /> {detailTask.error.message}
              </div>
            )}
            {renderTaskActions(detailTask, detailTask.assets[0])}
          </div>
        </Modal>
      )}

      {lightboxOpen && detailTask && detailImages.length > 0 && (
        <ImagePreviewModal
          src={detailImages[0]?.src ?? ''}
          alt={detailImages[0]?.alt ?? '生成结果'}
          fileName={detailImages[0]?.fileName ?? 'quick-create-output.png'}
          onClose={() => setLightboxOpen(false)}
          navigation={{ images: detailImages, startIndex: 0 }}
        />
      )}
    </section>
  )
}
