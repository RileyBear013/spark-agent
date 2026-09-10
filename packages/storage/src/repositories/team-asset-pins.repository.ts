/**
 * @module repositories/team-asset-pins
 *
 * 团队注册中心资产锚点表 — 记录每项团队资产的安装/发布版本锚点
 *
 * 「可更新」判定 = pins 锚点 vs 远端资产信封（version/checksum），
 * 不需要扫描本地全量文件；本地是否被改过用 installed_checksum 与磁盘
 * 重算的 checksum 比对（由上层服务负责重算）。
 */

import { BaseRepository } from './base.repository.js'
import type { SparkDatabase } from '../database.js'

export interface TeamAssetPinRow {
  id: string
  asset_type: string
  slug: string
  installed_version: string | null
  installed_checksum: string | null
  installed_at: string | null
  published_version: string | null
  published_checksum: string | null
  published_at: string | null
  created_at: string
  updated_at: string
}

export interface TeamAssetPinUpsertFields {
  installedVersion?: string | null
  installedChecksum?: string | null
  installedAt?: string | null
  publishedVersion?: string | null
  publishedChecksum?: string | null
  publishedAt?: string | null
}

export class TeamAssetPinsRepository extends BaseRepository {
  constructor(db: SparkDatabase) {
    super(db, 'team_asset_pins')
  }

  list(): TeamAssetPinRow[] {
    return this.raw
      .prepare('SELECT * FROM team_asset_pins ORDER BY updated_at DESC')
      .all() as TeamAssetPinRow[]
  }

  listByType(assetType: string): TeamAssetPinRow[] {
    return this.raw
      .prepare('SELECT * FROM team_asset_pins WHERE asset_type = ? ORDER BY updated_at DESC')
      .all(assetType) as TeamAssetPinRow[]
  }

  get(assetType: string, slug: string): TeamAssetPinRow | undefined {
    return this.raw
      .prepare('SELECT * FROM team_asset_pins WHERE asset_type = ? AND slug = ?')
      .get(assetType, slug) as TeamAssetPinRow | undefined
  }

  /**
   * 按 (asset_type, slug) 幂等 upsert；只更新调用方传入的字段。
   * 首次插入时 id 取 '<assetType>:<slug>'，保证跨机器一致、可读可追溯。
   */
  upsert(assetType: string, slug: string, fields: TeamAssetPinUpsertFields): TeamAssetPinRow {
    const now = new Date().toISOString()
    const existing = this.get(assetType, slug)
    if (existing == null) {
      this.raw
        .prepare(
          `INSERT INTO team_asset_pins
             (id, asset_type, slug, installed_version, installed_checksum, installed_at,
              published_version, published_checksum, published_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `${assetType}:${slug}`,
          assetType,
          slug,
          fields.installedVersion ?? null,
          fields.installedChecksum ?? null,
          fields.installedAt ?? null,
          fields.publishedVersion ?? null,
          fields.publishedChecksum ?? null,
          fields.publishedAt ?? null,
          now,
          now,
        )
      return this.get(assetType, slug)!
    }

    const sets: string[] = ['updated_at = ?']
    const vals: unknown[] = [now]
    const columnMap: Array<[keyof TeamAssetPinUpsertFields, string]> = [
      ['installedVersion', 'installed_version'],
      ['installedChecksum', 'installed_checksum'],
      ['installedAt', 'installed_at'],
      ['publishedVersion', 'published_version'],
      ['publishedChecksum', 'published_checksum'],
      ['publishedAt', 'published_at'],
    ]
    for (const [field, column] of columnMap) {
      if (fields[field] !== undefined) {
        sets.push(`${column} = ?`)
        vals.push(fields[field] ?? null)
      }
    }
    this.raw
      .prepare(`UPDATE team_asset_pins SET ${sets.join(', ')} WHERE asset_type = ? AND slug = ?`)
      .run(...vals, assetType, slug)
    return this.get(assetType, slug)!
  }

  deleteByAsset(assetType: string, slug: string): boolean {
    const result = this.raw
      .prepare('DELETE FROM team_asset_pins WHERE asset_type = ? AND slug = ?')
      .run(assetType, slug)
    return result.changes > 0
  }
}
