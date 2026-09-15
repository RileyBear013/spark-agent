// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  onOpenHistoricalFile: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('../VscodeFileIcon', () => ({
  VscodeFileIcon: () => <span data-testid="file-icon" />,
}))

vi.mock('../../Toast', () => ({
  useToast: () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }),
}))

import { GitCommitHistory } from './GitCommitHistory'
import { GitCommitDetailPopover } from './GitCommitDetailPopover'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const commitHash = 'a'.repeat(40)
const historyHash = 'b'.repeat(40)

function commit(overrides: Record<string, unknown> = {}) {
  return {
    hash: commitHash,
    shortHash: 'aaaaaaa',
    subject: 'update feature',
    authorName: 'Spark Test',
    date: '2026-09-08T09:00:00.000Z',
    unpushed: false,
    ...overrides,
  }
}

describe('GitCommitHistory', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mocks.invoke.mockReset().mockImplementation((channel: string) => {
      if (channel === 'workspace:git-commit-files') {
        return Promise.resolve({ files: [{ path: 'src/feature.ts', status: 'M' }] })
      }
      if (channel === 'workspace:git-file-history') {
        return Promise.resolve({
          commits: [commit({ hash: historyHash, shortHash: 'bbbbbbb', path: 'src/feature.ts' })],
        })
      }
      return Promise.resolve({})
    })
    mocks.onOpenHistoricalFile.mockReset()
    vi.stubGlobal('spark', { invoke: mocks.invoke })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('expands a commit, loads file history, and opens a selected historical diff', async () => {
    await act(async () => {
      root.render(
        <GitCommitHistory
          workspaceId="workspace-1"
          commits={[commit()]}
          loading={false}
          error={null}
          collapsed={false}
          onToggle={vi.fn()}
          onRefresh={vi.fn()}
          onOpenHistoricalFile={mocks.onOpenHistoricalFile}
        />,
      )
    })

    const commitRow = container.querySelector('.gp-commit-row')
    expect(commitRow).not.toBeNull()
    await act(async () => {
      ;(commitRow as HTMLButtonElement).click()
    })
    expect(mocks.invoke).toHaveBeenCalledWith('workspace:git-commit-files', {
      workspaceId: 'workspace-1',
      hash: commitHash,
    })
    expect(container.querySelector('.gp-commit-file-row')).not.toBeNull()

    await act(async () => {
      ;(container.querySelector('.gp-commit-file-row') as HTMLButtonElement).click()
    })
    expect(mocks.invoke).toHaveBeenCalledWith('workspace:git-file-history', {
      workspaceId: 'workspace-1',
      path: 'src/feature.ts',
      limit: 100,
    })
    expect(container.querySelector('.gp-commit-history-row')).not.toBeNull()

    await act(async () => {
      ;(container.querySelector('.gp-commit-history-row') as HTMLButtonElement).click()
    })
    expect(mocks.onOpenHistoricalFile).toHaveBeenCalledWith('src/feature.ts', historyHash, 'modify')
  })
})

describe('GitCommitDetailPopover', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.querySelector('.gp-cpop')?.remove()
  })

  it('shows one short hash while copying the full hash', async () => {
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    await act(async () => {
      root.render(
        <GitCommitDetailPopover
          commit={commit({ shortHash: 'short01' })}
          anchorEl={anchor}
          onMouseEnter={vi.fn()}
          onMouseLeave={vi.fn()}
        />,
      )
    })

    expect(document.querySelector('.gp-cpop-short')?.textContent).toBe('short01')
    expect(document.querySelector('.gp-cpop-hash')).toBeNull()
    await act(async () => {
      ;(document.querySelector('.gp-cpop-copy') as HTMLButtonElement).click()
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(commitHash)
    anchor.remove()
  })
})

describe('GitCommitHistory 右键菜单', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mocks.toastSuccess.mockReset()
    mocks.toastError.mockReset()
    mocks.invoke.mockReset().mockImplementation((channel: string) => {
      if (channel === 'workspace:git-commit-files') {
        return Promise.resolve({ files: [{ path: 'src/feature.ts', status: 'M' }] })
      }
      if (channel === 'workspace:git-file-history') {
        return Promise.resolve({
          commits: [
            commit({
              hash: historyHash,
              shortHash: 'bbbbbbb',
              subject: '历史提交标题',
              path: 'src/feature.ts',
            }),
          ],
        })
      }
      return Promise.resolve({})
    })
    vi.stubGlobal('spark', { invoke: mocks.invoke })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.querySelector('.gp-commit-menu')?.remove()
    vi.unstubAllGlobals()
  })

  async function renderHistory(): Promise<void> {
    await act(async () => {
      root.render(
        <GitCommitHistory
          workspaceId="workspace-1"
          commits={[
            commit({ shortHash: 'abc1234', subject: 'feat: 新增提交引用', body: '正文说明' }),
          ]}
          loading={false}
          error={null}
          collapsed={false}
          onToggle={vi.fn()}
          onRefresh={vi.fn()}
        />,
      )
    })
  }

  async function openMenu(): Promise<void> {
    const row = container.querySelector('.gp-commit-row') as HTMLButtonElement
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 60,
        }),
      )
    })
  }

  function menuItems(): HTMLButtonElement[] {
    return Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('.gp-commit-menu .action-menu-item'),
    )
  }

  it('右键弹出三项菜单', async () => {
    await renderHistory()
    await openMenu()
    expect(menuItems().map((item) => item.textContent)).toEqual([
      '复制提交 ID',
      '复制提交信息',
      '添加到会话',
    ])
  })

  it('复制提交 ID 复制完整 hash，复制提交信息带上正文', async () => {
    await renderHistory()
    await openMenu()
    await act(async () => {
      menuItems()[0]?.click()
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(commitHash)
    expect(mocks.toastSuccess).toHaveBeenCalledWith('已复制提交 ID')
    expect(menuItems()).toHaveLength(0)

    await openMenu()
    await act(async () => {
      menuItems()[1]?.click()
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('feat: 新增提交引用\n\n正文说明')
    expect(mocks.toastSuccess).toHaveBeenCalledWith('已复制提交信息')
  })

  it('展开提交后的文件历史行同样可用右键菜单', async () => {
    await act(async () => {
      root.render(
        <GitCommitHistory
          workspaceId="workspace-1"
          commits={[commit()]}
          loading={false}
          error={null}
          collapsed={false}
          onToggle={vi.fn()}
          onRefresh={vi.fn()}
          onOpenHistoricalFile={mocks.onOpenHistoricalFile}
        />,
      )
    })
    await act(async () => {
      ;(container.querySelector('.gp-commit-row') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(container.querySelector('.gp-commit-file-row') as HTMLButtonElement).click()
    })

    const historyRow = container.querySelector('.gp-commit-history-row') as HTMLButtonElement
    await act(async () => {
      historyRow.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 30,
          clientY: 50,
        }),
      )
    })
    expect(menuItems().map((item) => item.textContent)).toEqual([
      '复制提交 ID',
      '复制提交信息',
      '添加到会话',
    ])
    await act(async () => {
      menuItems()[0]?.click()
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(historyHash)
  })

  it('添加到会话把提交引用交给输入框追加通道', async () => {
    const received: unknown[] = []
    const listener = (event: Event): void => {
      const detail = (
        event as CustomEvent<{ commitReferences: unknown[]; resolve: (v: boolean) => void }>
      ).detail
      received.push(detail.commitReferences)
      detail.resolve(true)
    }
    window.addEventListener('spark:code-viewer:insert-to-composer', listener)
    try {
      await renderHistory()
      await openMenu()
      await act(async () => {
        menuItems()[2]?.click()
        await Promise.resolve()
      })
    } finally {
      window.removeEventListener('spark:code-viewer:insert-to-composer', listener)
    }
    expect(received).toEqual([
      [{ hash: commitHash, shortHash: 'abc1234', subject: 'feat: 新增提交引用' }],
    ])
    expect(mocks.toastSuccess).toHaveBeenCalledWith('已添加到会话：abc1234')
  })
})
