import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionRepository, SparkDatabase } from '@spark/storage'
import {
  SessionCrudController,
  type SessionCrudHost,
} from '../../../services/session/session-crud.js'

/**
 * 会话标记（打标）读写往返：标记存 metadata（sessionLabel + labeledAt），
 * 与手动置顶的 pinned_at 完全解耦 —— 打标不得改写 pinned_at。
 */
describe('session label metadata round-trip', () => {
  let db: SparkDatabase
  let directory: string
  let crud: SessionCrudController
  let sessionRepo: SessionRepository

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'spark-session-label-'))
    db = new SparkDatabase(join(directory, 'test.db'))
    db.runMigrations(resolve(process.cwd(), '../storage/migrations'))
    sessionRepo = new SessionRepository(db)
    sessionRepo.create({
      id: 'session-label',
      kind: 'chat',
      title: '打标测试',
      status: 'idle',
      projectId: '',
      providerProfileId: 'provider-test',
      modelId: 'model-test',
      agentAdapter: 'claude',
    })
    const host: SessionCrudHost = {
      bumpMcpVersion: vi.fn(),
      applyPermissionModeChange: vi.fn(),
      clearSessionMemoryForEvents: vi.fn(() => false),
      cleanupSessionEventsInBackground: vi.fn(),
    }
    crud = new SessionCrudController(db, host)
  })

  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('persists the label with a timestamp without touching pinnedAt', async () => {
    const updated = await crud.updateSession({
      sessionId: 'session-label',
      sessionLabel: 'pending-review',
    })

    expect(updated.session.sessionLabel).toBe('pending-review')
    expect(updated.session.labeledAt).not.toBeNull()
    // 标记与手动置顶正交：打标不写 pinned_at。
    expect(updated.session.pinnedAt).toBeNull()

    const listed = await crud.listSessions()
    expect(listed.sessions).toHaveLength(1)
    expect(listed.sessions[0]?.sessionLabel).toBe('pending-review')
    expect(listed.sessions[0]?.labeledAt).toBe(updated.session.labeledAt)
  })

  it('clears both the label and its timestamp when unlabeling', async () => {
    await crud.updateSession({ sessionId: 'session-label', sessionLabel: 'suspended' })
    const cleared = await crud.updateSession({ sessionId: 'session-label', sessionLabel: null })

    expect(cleared.session.sessionLabel).toBeNull()
    expect(cleared.session.labeledAt).toBeNull()

    const listed = await crud.listSessions()
    expect(listed.sessions[0]?.sessionLabel).toBeNull()
    expect(listed.sessions[0]?.labeledAt).toBeNull()
  })

  it('keeps manual pinning independent from labeling', async () => {
    await crud.updateSession({ sessionId: 'session-label', pinned: true })
    const labeled = await crud.updateSession({
      sessionId: 'session-label',
      sessionLabel: 'undelivered',
    })

    expect(labeled.session.pinnedAt).not.toBeNull()
    expect(labeled.session.sessionLabel).toBe('undelivered')
  })

  it('ignores unknown or corrupted stored labels', async () => {
    sessionRepo.patchMetadata('session-label', {
      sessionLabel: 'not-a-real-label',
      labeledAt: '2026-01-01T00:00:00.000Z',
    })

    const listed = await crud.listSessions()
    expect(listed.sessions[0]?.sessionLabel).toBeNull()
    expect(listed.sessions[0]?.labeledAt).toBeNull()
  })
})
