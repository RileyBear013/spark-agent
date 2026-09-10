# 团队注册中心（Nacos）共享方案 — Skills / MCP / 工作流 / 子应用的推拉与版本管理

> 状态: 实施中 | 最后核对: 2026-09-10

## 背景与目标

团队内网已部署 Nacos AI 注册中心（v3.3.0-SNAPSHOT，`ai_enabled=true`），当前 Skill / MCP / Prompt
资源全部为空。目标是把 SparkWork 本机的四类资产接入统一的团队注册中心，实现：

1. **配置化连接**：注册中心地址 / 命名空间 / 账号在 Settings 配置，凭据走系统 Keychain（keystore），
   未配置前相关功能不可用但不报错（显式提示「未配置」）。
2. **推（发布）**：本机技能 / MCP / 工作流 / 子应用一键发布到团队注册中心。
3. **拉（安装/更新）**：团队成员从注册中心安装，本地与远端版本比对后提示可更新。
4. **版本管理**：统一资产信封（semver + 内容 checksum 双比对），Nacos 配置中心原生保留发布历史。

## 两侧现状（2026-09-10 探明）

### Nacos 侧（192.168.163.174:8080，读端点已实测验证）

| 能力 | 端点 | 验证情况 |
|---|---|---|
| 登录换 token | `POST /v3/auth/login` | 控制台前端使用该链路，`Authorization: Bearer <token>` |
| 配置列表 | `GET /v3/console/cs/config/list` | 已验证（public 命名空间现存 6 条 `nacos.ai.resource.search.*`） |
| 配置发布 | `POST /v3/console/cs/config` | v3 标准发布端点，实施期 dry-run 核实字段 |
| AI Skill 列表 | `GET /v3/console/ai/skills/list` | 已验证（当前为空） |
| AI Skill 详情 | `GET /v3/console/ai/skills?skillName=` | 已验证端点存在 |
| AI Skill 写入 | `POST /v3/console/ai/skills` | 空载荷探测确认端点存在（500=NPE 非路径错误）；字段结构实施期核实 |
| AI MCP 列表/写入 | `GET /v3/console/ai/mcp/list`、`POST /v3/console/ai/mcp` | 同上；POST 要求 `serverSpecification` |

> 实测均为**只读探测 + 空载荷存在性验证**，未写入任何数据。

### SparkWork 侧（代码探明）

| 资产 | 存储 | 版本现状 | 共享缺口 |
|---|---|---|---|
| 技能 | `~userData/skills/<slug>/SKILL.md` + `skills` 表 | frontmatter version | `SkillRegistryAdapter` 是现成扩展点，但注册源硬编码 skillhub/skillsmp |
| MCP | `mcp_servers` 表 | 无版本 | 无分享能力 |
| 工作流 | `workflows` 表 | version 单值，无历史 | 导入裸 JSON 盲加 |
| 子应用 | `sub_app_releases` 不可变快照 | publish/rollback 完整 | 无分享包能力 |
| 凭据先例 | `PlatformCredentialStore` | — | 地址存 settings + 密钥走 keystore，直接套用 |

## 总体架构

```
┌────────────────────────── SparkWork（每台成员机器） ──────────────────────────┐
│  Renderer                                    Main Process                   │
│  ┌────────────────┐   IPC(team-registry:*)  ┌──────────────────────────┐    │
│  │ Settings 团队  │ ──────────────────────▶ │ TeamRegistryService      │    │
│  │ 注册中心配置    │                          │  ├ NacosClient(登录/token)│    │
│  │ 技能商店团队源  │                          │  ├ 资产信封读写+checksum  │    │
│  │ 技能行发布按钮  │                          │  └ TeamAssetPinsRepo     │    │
│  └────────────────┘                          └──────────┬───────────────┘    │
│                                                         │ 复用注入             │
│   SkillRegistryService ◀── nacos-team-adapter（拉侧） ──┘                    │
└─────────────────────────────────────────────────────────┼──────────────────┘
                                                          ▼
                              Nacos AI 注册中心（配置中心 group=SPARK_TEAM）
                              dataId: skill/<slug> · mcp/<id> · workflow/<id> · app/<appId>
                              （信封 JSON，含版本/作者/checksum/文件载荷）
```

### 存储映射策略

- **能用 Nacos 原生 AI 资源的用原生**：MCP → AI MCP 资源（serverSpecification 与本地
  config_json 结构吻合）；技能同时写 AI Skill 条目（发现/元数据）。
- **无原生类型的用配置中心**：工作流 / 子应用 / 技能完整文件载荷 → 配置中心
  `group=SPARK_TEAM`，`dataId=<assetType>/<slug>`，统一资产信封。
- Nacos 配置中心天然保留每次发布的 revision 历史，配合信封内 semver 构成完整版本链。

### 资产信封（spark.team.asset.v1）

```jsonc
{
  "schema": "spark.team.asset.v1",
  "assetType": "skill",            // skill | mcp | workflow | app
  "slug": "release-inspection",    // 稳定标识（安装/更新按此对齐）
  "name": "发布巡检中心",
  "version": "1.4.0",              // semver
  "author": "xiao.li",
  "description": "…",
  "updatedAt": "2026-09-10T12:00:00.000Z",
  "checksum": "sha256:…",          // 对 canonical(payload) 的摘要
  "payload": { /* 资产类型专属：技能=文件树；MCP=config；工作流=graph；应用=快照 */ }
}
```

版本判定（四态）：`up-to-date`（checksum 相同）/ `remote-newer`（semver 远端高）/
`local-modified`（本地内容与安装时 checksum 不一致，已分叉）/ `local-newer`（本地 semver 更高）。

### 本地跟踪表 `team_asset_pins`（migration 093）

记录每项团队资产的安装/发布锚点：asset_type、slug、installed_version、installed_checksum、
installed_at、published_version、published_checksum、published_at。
「可更新」徽标 = pins 与远端信封比对，不需要扫全量文件。

### 安全边界

- token/密码只进 keystore，永不进聊天、日志与 IPC 响应（config-get 只回 `hasPassword`）。
- 推送前在 UI 展示变更摘要（版本、文件数、checksum）；写团队注册中心的操作一律经用户点击触发。
- 团队注册中心写操作失败显式报错，不做静默重试写。

## 分期

| 期 | 内容 | 状态 |
|---|---|---|
| M1 | 配置 UI + Nacos 客户端 + 技能推拉 + 版本比对 + pins 表 | 代码完成（typecheck/lint/单测通过），待真机联调 |
| M2 | MCP 发布/安装（映射 AI MCP 资源） | 待开发 |
| M3 | 工作流团队库（导入升级为按版本 upsert） | 待开发 |
| M4 | 子应用团队库（复用 sub_app_releases 快照作 payload） | 待开发 |
| M5 | 更新提醒（启动/手动刷新比对）→ 实时 listen 推送 | 待开发 |

## M1 实施清单

1. `packages/storage/migrations/093_team_asset_pins.sql` + `TeamAssetPinsRepository`
2. `packages/agent-runtime/src/services/team-registry/`
   - `types.ts`：信封 schema + `compareTeamAsset` 四态判定 + canonical checksum
   - `nacos-client.ts`：登录（token 缓存与过期重登）、配置列表/读/发布、AI skill 列表/读/写
   - `team-registry-config.ts`：settings（category `team-registry`）+ keystore（password）
   - `index.ts`：TeamRegistryService（getConfig/saveConfig/testConnection/listEnvelopes）
3. `skill-registry/nacos-team-adapter.ts`：拉侧适配（search/featured/categories/
   fetchManifest/healthCheck），未配置时 healthCheck 返回 unhealthy、search 返回空
4. `SkillRegistryService` 扩展：
   - 注册源硬编码改表驱动（`REMOTE_ADAPTER_FACTORIES`），纳入 `team`
   - `refreshTeamRegistry()`（配置保存后重建 adapter）
   - `installFromTeam(slug)`（checksum 校验 + 文件树落盘 + DB upsert + pins 记录）
   - `publishToTeam(localSkillId, {version, notes})`（读目录 → 信封 → 发布 → pins 记录，
     附带 best-effort 写 AI Skill 元数据条目）
   - `listTeamUpdates()`（pins vs 远端 → 可更新列表）
5. protocol IPC：`team-registry:config-get/config-save/test-connection/publish-skill/
   install-skill/list-updates/config-history`
6. desktop main：handlers + 服务装配
7. Renderer：Settings「团队注册中心」分区；技能商店团队源；已装技能「发布到团队」

## 验证计划

- 单测：信封 checksum/版本比对四态、NacosClient（mock fetch：登录重试/发布/列表解析）、
  adapter 未配置降级行为、installFromTeam 落盘与 pins 写入
- `pnpm typecheck` + `pnpm lint` + `pnpm test:unit`
- 联调（需用户配合）：Settings 配置真实凭据 → 测试连接 → 发布一个低风险技能 →
  另一台机器/卸载重装拉取 → 版本比对徽标

## 风险与未决

- Nacos v3 console 写端点的精确请求字段未实测（空载荷探测只确认存在）：客户端集中封装
  端点与参数，dry-run 失败时显式透出服务端错误信息，便于现场修正。
- AI Skill 条目的 `skillSpecification` 结构未核实：M1 发布以配置中心信封为准（权威），
  AI 条目 best-effort，失败仅 warn 不阻断。
- 技能载荷含二进制/大文件的封顶策略：单文件 ≤1MB、总包 ≤5MB，超限在发布前拦截并提示。
