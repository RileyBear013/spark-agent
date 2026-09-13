-- 098: 团队注册中心资产锚点表（team_asset_pins）
-- 记录每项从团队 Nacos 注册中心安装/发布的资产的版本锚点，
-- 用于「可更新」比对（pins vs 远端信封），无需扫描全量文件。
CREATE TABLE IF NOT EXISTS team_asset_pins (
  id TEXT PRIMARY KEY,             -- '<assetType>:<slug>'
  asset_type TEXT NOT NULL,        -- skill | mcp | workflow | app
  slug TEXT NOT NULL,
  installed_version TEXT,
  installed_checksum TEXT,
  installed_at TEXT,
  published_version TEXT,
  published_checksum TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_asset_pins_unique
  ON team_asset_pins(asset_type, slug);
