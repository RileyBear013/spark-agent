import { afterEach, describe, expect, it } from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import {
  DEFAULT_BACKUP_MAX_AGE_DAYS,
  DEFAULT_MAX_DATABASE_BACKUPS,
  ensurePreMigrationBackup,
  restoreDatabaseBackup,
  type DatabaseBackupSnapshot,
} from '../DatabaseBackupService.js'

const DAY_MS = 24 * 60 * 60 * 1000

const roots: string[] = []

function requireSnapshot(
  snapshot: DatabaseBackupSnapshot | null,
): asserts snapshot is DatabaseBackupSnapshot {
  expect(snapshot).not.toBeNull()
  if (snapshot == null) throw new Error('Expected a database backup snapshot')
}

const fakeOnlineBackup = async (
  sourcePath: string,
  destinationPath: string,
  onProgress?: (progress: {
    totalPages: number
    completedPages: number
    remainingPages: number
    percent: number
  }) => void,
): Promise<void> => {
  onProgress?.({ totalPages: 10, completedPages: 4, remainingPages: 6, percent: 40 })
  copyFileSync(sourcePath, destinationPath)
  onProgress?.({ totalPages: 10, completedPages: 10, remainingPages: 0, percent: 100 })
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'spark-db-backup-'))
  roots.push(root)
  return root
}

function createLegacyBackup(backupRoot: string, name: string, mtime: Date): void {
  const directory = join(backupRoot, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'manifest.json'), '{}', 'utf8')
  writeFileSync(join(directory, 'spark.db'), 'legacy payload', 'utf8')
  utimesSync(directory, mtime, mtime)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('DatabaseBackupService', () => {
  it('creates one coherent database snapshot once per app version', async () => {
    const root = tempRoot()
    const databasePath = join(root, 'spark.db')
    writeFileSync(databasePath, 'database-v1')

    const first = await ensurePreMigrationBackup({
      databasePath,
      backupRoot: join(root, 'backups'),
      appVersion: '0.8.0',
      now: new Date('2026-07-26T00:00:00.000Z'),
      backupDatabase: fakeOnlineBackup,
    })
    writeFileSync(databasePath, 'database-after-migration')
    const second = await ensurePreMigrationBackup({
      databasePath,
      backupRoot: join(root, 'backups'),
      appVersion: '0.8.0',
      backupDatabase: fakeOnlineBackup,
    })

    expect(first?.createdThisStartup).toBe(true)
    expect(second?.createdThisStartup).toBe(false)
    requireSnapshot(first)
    expect(readFileSync(join(first.directory, 'spark.db'), 'utf8')).toBe('database-v1')
    expect(first.files).toEqual(['spark.db'])
  })

  it('forwards real backup page progress to the caller', async () => {
    const root = tempRoot()
    const databasePath = join(root, 'spark.db')
    writeFileSync(databasePath, 'database')
    const progress: number[] = []

    await ensurePreMigrationBackup({
      databasePath,
      backupRoot: join(root, 'backups'),
      appVersion: '0.8.0',
      backupDatabase: fakeOnlineBackup,
      onProgress: ({ percent }) => progress.push(percent),
    })

    expect(progress).toEqual([40, 100])
  })

  it('uses SQLite Online Backup to merge WAL data into one readable snapshot', async () => {
    const root = tempRoot()
    const databasePath = join(root, 'spark.db')
    const source = new BetterSqlite3(databasePath)
    source.pragma('journal_mode = WAL')
    source.exec('CREATE TABLE records (value TEXT NOT NULL)')
    source.prepare('INSERT INTO records (value) VALUES (?)').run('from-wal')
    const progress: number[] = []

    const snapshot = await ensurePreMigrationBackup({
      databasePath,
      backupRoot: join(root, 'backups'),
      appVersion: '0.8.2',
      onProgress: ({ percent }) => progress.push(percent),
    })
    source.close()

    requireSnapshot(snapshot)
    expect(readdirSync(snapshot.directory).sort()).toEqual(['manifest.json', 'spark.db'])
    const backup = new BetterSqlite3(join(snapshot.directory, 'spark.db'), {
      readonly: true,
    })
    expect(backup.prepare('SELECT value FROM records').get()).toEqual({ value: 'from-wal' })
    backup.close()
    expect(snapshot.files).toEqual(['spark.db'])
    expect(progress.at(-1)).toBe(100)
  })

  it('does not let a progress observer break a valid recovery snapshot', async () => {
    const root = tempRoot()
    const databasePath = join(root, 'spark.db')
    const source = new BetterSqlite3(databasePath)
    source.exec('CREATE TABLE records (value TEXT NOT NULL)')
    source.prepare('INSERT INTO records (value) VALUES (?)').run('safe')
    source.close()

    const snapshot = await ensurePreMigrationBackup({
      databasePath,
      backupRoot: join(root, 'backups'),
      appVersion: '0.8.3',
      onProgress: () => {
        throw new Error('renderer unavailable')
      },
    })

    requireSnapshot(snapshot)
    expect(snapshot.createdThisStartup).toBe(true)
    expect(existsSync(join(snapshot.directory, 'spark.db'))).toBe(true)
  })

  it('restores the exact pre-migration database set after a failed upgrade', async () => {
    const root = tempRoot()
    const databasePath = join(root, 'spark.db')
    writeFileSync(databasePath, 'healthy')
    const snapshot = await ensurePreMigrationBackup({
      databasePath,
      backupRoot: join(root, 'backups'),
      appVersion: '0.8.1',
      backupDatabase: fakeOnlineBackup,
    })
    writeFileSync(databasePath, 'partially-migrated')
    writeFileSync(`${databasePath}-shm`, 'stale')

    requireSnapshot(snapshot)
    await restoreDatabaseBackup(snapshot)

    expect(readFileSync(databasePath, 'utf8')).toBe('healthy')
    expect(existsSync(`${databasePath}-shm`)).toBe(false)
  })

  it('prunes backups beyond the retention count, keeping the newest ones', async () => {
    const root = tempRoot()
    const backupRoot = join(root, 'backups')
    const databasePath = join(root, 'spark.db')
    writeFileSync(databasePath, 'database')
    const now = new Date()
    createLegacyBackup(backupRoot, 'pre-migration-v0.11.5', new Date(now.getTime() - 10 * DAY_MS))
    createLegacyBackup(backupRoot, 'pre-migration-v0.11.8', new Date(now.getTime() - 5 * DAY_MS))
    createLegacyBackup(backupRoot, 'pre-migration-v0.11.9', new Date(now.getTime() - 1 * DAY_MS))

    await ensurePreMigrationBackup({
      databasePath,
      backupRoot,
      appVersion: '0.11.12',
      now,
      backupDatabase: fakeOnlineBackup,
    })

    expect(readdirSync(backupRoot).sort()).toEqual([
      'pre-migration-v0.11.12',
      'pre-migration-v0.11.9',
    ])
    expect(DEFAULT_MAX_DATABASE_BACKUPS).toBe(2)
  })

  it('prunes backups older than the retention window even below the count limit', async () => {
    const root = tempRoot()
    const backupRoot = join(root, 'backups')
    const databasePath = join(root, 'spark.db')
    writeFileSync(databasePath, 'database')
    const now = new Date()
    createLegacyBackup(
      backupRoot,
      'pre-migration-v0.8.5',
      new Date(now.getTime() - (DEFAULT_BACKUP_MAX_AGE_DAYS + 1) * DAY_MS),
    )

    await ensurePreMigrationBackup({
      databasePath,
      backupRoot,
      appVersion: '0.11.12',
      now,
      backupDatabase: fakeOnlineBackup,
    })

    expect(readdirSync(backupRoot)).toEqual(['pre-migration-v0.11.12'])
  })

  it('recycles stale .tmp- leftovers but keeps recent ones from concurrent startups', async () => {
    const root = tempRoot()
    const backupRoot = join(root, 'backups')
    const databasePath = join(root, 'spark.db')
    writeFileSync(databasePath, 'database')
    const now = new Date()
    const staleTmp = join(backupRoot, 'pre-migration-v0.8.5.tmp-48766-1785157236939')
    mkdirSync(staleTmp, { recursive: true })
    utimesSync(staleTmp, new Date(now.getTime() - 3 * DAY_MS), new Date(now.getTime() - 3 * DAY_MS))
    const freshTmp = join(backupRoot, 'pre-migration-v0.11.12.tmp-3002-1787799995248')
    mkdirSync(freshTmp, { recursive: true })

    await ensurePreMigrationBackup({
      databasePath,
      backupRoot,
      appVersion: '0.11.12',
      now,
      backupDatabase: fakeOnlineBackup,
    })

    const remaining = readdirSync(backupRoot).sort()
    expect(remaining).toContain('pre-migration-v0.11.12')
    expect(remaining).toContain('pre-migration-v0.11.12.tmp-3002-1787799995248')
    expect(remaining).not.toContain('pre-migration-v0.8.5.tmp-48766-1785157236939')
  })

  it('prunes stale backups even when the current version snapshot is reused', async () => {
    const root = tempRoot()
    const backupRoot = join(root, 'backups')
    const databasePath = join(root, 'spark.db')
    writeFileSync(databasePath, 'database')
    await ensurePreMigrationBackup({
      databasePath,
      backupRoot,
      appVersion: '0.11.12',
      backupDatabase: fakeOnlineBackup,
    })
    const now = new Date()
    createLegacyBackup(
      backupRoot,
      'pre-migration-v0.9.0',
      new Date(now.getTime() - (DEFAULT_BACKUP_MAX_AGE_DAYS + 5) * DAY_MS),
    )

    await ensurePreMigrationBackup({
      databasePath,
      backupRoot,
      appVersion: '0.11.12',
      now,
      backupDatabase: fakeOnlineBackup,
    })

    expect(readdirSync(backupRoot)).toEqual(['pre-migration-v0.11.12'])
  })
})
