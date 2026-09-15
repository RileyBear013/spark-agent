/**
 * ComposerCommitReferenceStrip —— 输入框内的 Git 提交引用 chip 组。
 *
 * 与代码位置引用 chip 同构：双行展示（上行短 hash、下行提交标题），右侧 ✕ 移除。
 * 完整展示文本（`[Git 提交] 短hash 标题`，即发送时写入正文的那一行）挂在 tooltip 上，
 * 避免同一条信息在 chip 内重复两遍。
 */
import { Tooltip } from '@lobehub/ui'
import { Icons } from '../../Icons'
import {
  formatCommitReferenceLine,
  type CommitReference,
} from '../../components/code-viewer/composerInsert'
import { commitRefKey } from './composer-commit-references'

export function ComposerCommitReferenceStrip({
  references,
  onRemove,
}: {
  references: CommitReference[]
  /** 移除一条引用（键为提交 hash） */
  onRemove: (key: string) => void
}) {
  if (references.length === 0) return null
  return (
    <div className="composer-attachment-strip composer-commit-ref-strip" aria-label="Git 提交引用">
      {references.map((reference) => {
        const line = formatCommitReferenceLine(reference)
        return (
          <Tooltip
            key={commitRefKey(reference)}
            title={line}
            placement="top"
            mouseEnterDelay={0.05}
          >
            <div className="composer-attachment-chip composer-commit-ref-chip">
              <Icons.GitCommit size={13} />
              <div className="composer-commit-ref-text">
                <span className="composer-commit-ref-hash">{reference.shortHash}</span>
                <span className="composer-commit-ref-subject">{reference.subject}</span>
              </div>
              <button
                type="button"
                title="移除提交引用"
                aria-label={`移除提交 ${reference.shortHash} 引用`}
                onClick={() => onRemove(commitRefKey(reference))}
              >
                <Icons.X size={12} />
              </button>
            </div>
          </Tooltip>
        )
      })}
    </div>
  )
}
