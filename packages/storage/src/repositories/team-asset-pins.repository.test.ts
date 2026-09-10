import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SparkDatabase } from '../database.js'
import { TeamAssetPinsRepository } from './team-asset-pins.repository.js'

function createTestDb(testDir: string): SparkDatabase {
  const dbPath = join(testDir, 'test.db')
  const migrationsDir = join(process.cwd(), 'migrations')
  const db = new SparkDatabase(dbPath)
  db.runMigrations(migrationsDir)
  return db
}

describe('TeamAssetPinsRepository', () => {
  let db: SparkDatabase
  let repo: TeamAssetPinsRepository
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `team-pins-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
    db = createTestDb(testDir)
    repo = new TeamAssetPinsRepository(db)
  })

  afterEach(() => {
    db.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('首次插入生成稳定 id 并读取', () => {
    const row = repo.upsert('skill', 'demo', {
      installedVersion: '1.0.0',
      installedChecksum: 'abc',
      installedAt: '2026-09-10T00:00:00.000Z',
    })
    expect(row.id).toBe('skill:demo')
    const got = repo.get('skill', 'demo')
    expect(got?.installed_version).toBe('1.0.0')
    expect(got?.installed_checksum).toBe('abc')
  })

  it('二次 upsert 只更新传入字段，未传字段保留', () => {
    repo.upsert('skill', 'demo', {
      installedVersion: '1.0.0',
      installedChecksum: 'aaa',
      installedAt: '2026-09-10T00:00:00.000Z',
    })
    // 发布锚点写入：不影响安装锚点
    repo.upsert('skill', 'demo', {
      publishedVersion: '1.0.1',
      publishedChecksum: 'bbb',
      publishedAt: '2026-09-10T01:00:00.000Z',
    })
    const row = repo.get('skill', 'demo')
    expect(row?.installed_version).toBe('1.0.0')
    expect(row?.published_version).toBe('1.0.1')
    // 安装锚点更新：不影响发布锚点
    repo.upsert('skill', 'demo', {
      installedVersion: '1.0.1',
      installedChecksum: 'bbb',
    })
    const row2 = repo.get('skill', 'demo')
    expect(row2?.installed_version).toBe('1.0.1')
    expect(row2?.published_version).toBe('1.0.1')
    expect(row2?.installed_at).toBe('2026-09-10T00:00:00.000Z')
  })

  it('listByType 过滤 + deleteByAsset 清理', () => {
    repo.upsert('skill', 'a', { installedVersion: '1.0.0' })
    repo.upsert('skill', 'b', { installedVersion: '1.0.0' })
    repo.upsert('workflow', 'a', { installedVersion: '1.0.0' })
    expect(repo.listByType('skill').map((r) => r.slug).sort()).toEqual(['a', 'b'])
    expect(repo.listByType('workflow').map((r) => r.slug)).toEqual(['a'])
    expect(repo.deleteByAsset('skill', 'a')).toBe(true)
    expect(repo.get('skill', 'a')).toBeUndefined()
    // 同名不同类型不受影响
    expect(repo.get('workflow', 'a')).toBeDefined()
  })
})
