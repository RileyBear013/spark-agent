import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  QuickCreateCleanupTaskResourcesRequest,
  QuickCreateCleanupTaskResourcesResponse,
} from '@spark/protocol'
import { registerQuickCreateIpc } from './registerQuickCreateIpc.js'

// 捕获 typedIpcHandle 注册的 handler，便于直接以请求对象调用
const handlers = new Map<
  string,
  (req: QuickCreateCleanupTaskResourcesRequest) => Promise<unknown>
>()
vi.mock('./typed-ipc.js', () => ({
  typedIpcHandle: vi.fn(
    (
      channel: string,
      handler: (req: QuickCreateCleanupTaskResourcesRequest) => Promise<unknown>,
    ) => {
      handlers.set(channel, handler)
    },
  ),
}))

// electron 依赖注入：userData 指向临时目录；trash 可配置失败以覆盖回退分支
const testState = {
  userDataDir: '',
  trashFail: false,
  trashedPaths: [] as string[],
}

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return testState.userDataDir
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
  shell: {
    trashItem: async (targetPath: string) => {
      if (testState.trashFail) throw new Error('trash unavailable')
      testState.trashedPaths.push(targetPath)
      await rm(targetPath, { force: true })
    },
  },
}))

describe('registerQuickCreateIpc 清理策略', () => {
  let canvasMediaDir: string
  let inputRoot: string

  beforeAll(() => {
    registerQuickCreateIpc()
  })

  const invokeCleanup = async (
    req: QuickCreateCleanupTaskResourcesRequest,
  ): Promise<QuickCreateCleanupTaskResourcesResponse> => {
    const handler = handlers.get('quick-create:cleanup-task-resources')
    if (!handler) throw new Error('handler not registered')
    return (await handler(req)) as QuickCreateCleanupTaskResourcesResponse
  }

  beforeEach(async () => {
    testState.userDataDir = await mkdtemp(path.join(os.tmpdir(), 'quick-create-cleanup-'))
    testState.trashFail = false
    testState.trashedPaths = []
    canvasMediaDir = path.join(testState.userDataDir, '.spark-artifacts', 'media')
    inputRoot = path.join(canvasMediaDir, 'quick-create-inputs', 'images')
    await mkdir(inputRoot, { recursive: true })
    await mkdir(path.join(testState.userDataDir, 'attachments', 'pasted-images'), {
      recursive: true,
    })
  })

  afterEach(async () => {
    await rm(testState.userDataDir, { recursive: true, force: true })
  })

  it('删除画布媒体目录内的产物与 quick-create-inputs 内的输入拷贝，跳过共享与外部文件', async () => {
    const assetPath = path.join(canvasMediaDir, 'images', 'output.png')
    const inputCopy = path.join(inputRoot, 'source-copy.png')
    const sharedPaste = path.join(testState.userDataDir, 'attachments', 'pasted-images', 'p.png')
    const outsideAsset = path.join(os.tmpdir(), 'user-download.png')
    const missingInput = path.join(inputRoot, 'gone.png')
    await mkdir(path.dirname(assetPath), { recursive: true })
    await writeFile(assetPath, 'asset')
    await writeFile(inputCopy, 'input')
    await writeFile(sharedPaste, 'paste')

    const result = await invokeCleanup({
      inputPaths: [inputCopy, sharedPaste, missingInput],
      assetPaths: [assetPath, outsideAsset],
    })

    expect(result.deletedPaths.sort()).toEqual([assetPath, inputCopy].sort())
    // 共享粘贴素材与外部文件一律不删
    expect(result.skippedPaths.sort()).toEqual([missingInput, outsideAsset, sharedPaste].sort())
    await expect(stat(assetPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(inputCopy)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(sharedPaste)).resolves.toBeTruthy()
  })

  it('回收站不可用时回退为直接删除，删除失败计入 errors', async () => {
    testState.trashFail = true
    const assetPath = path.join(canvasMediaDir, 'videos', 'out.mp4')
    await mkdir(path.dirname(assetPath), { recursive: true })
    await writeFile(assetPath, 'video')

    const result = await invokeCleanup({ inputPaths: [], assetPaths: [assetPath] })

    expect(result.deletedPaths).toEqual([assetPath])
    expect(result.errors).toEqual([])
    await expect(stat(assetPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('目录、白名单根目录本身与不存在的路径一律跳过不删', async () => {
    const result = await invokeCleanup({
      inputPaths: [canvasMediaDir, path.join(canvasMediaDir, 'missing.png')],
      assetPaths: [inputRoot],
    })
    expect(result.deletedPaths).toEqual([])
    expect(result.skippedPaths.length).toBe(3)
  })
})
