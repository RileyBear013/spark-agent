# 团队注册中心（Nacos）共享方案 — Skills / MCP / 工作流 / 子应用的推拉与版本管理

> 状态: 实施中 | 最后核对: 2026-09-11

## 背景与目标

团队内网已部署 Nacos AI 注册中心（v3.3.0-SNAPSHOT，`ai_enabled=true`），当前 Skill / MCP / Prompt
资源全部为空。目标是把 SparkWork 本机的四类资产接入统一的团队注册中心，实现：

1. **配置化连接**：注册中心地址 / 命名空间 / 账号在 Settings 配置，凭据走系统 Keychain（keystore），
   未配置前相关功能不可用但不报错（显式提示「未配置」）。
2. **推（发布）**：本机技能 / MCP / 工作流 / 子应用一键发布到团队注册中心。
3. **拉（安装/更新）**：团队成员从注册中心安装，本地与远端版本比对后提示可更新。
4. **版本管理**：统一资产信封（semver + 内容 checksum 双比对），Nacos 配置中心原生保留发布历史。

## 两侧现状（2026-09-10 探明）

### Nacos 侧（192.168.163.174:8080，读+写端点已真机全链路验证 ✅ 2026-09-11）

#### 认证

- `POST /v3/auth/user/login`（form 编码 `username/password`）→ `accessToken` 在响应顶层，TTL 5h。
- 后续请求带 `Authorization: Bearer <token>` 或 `accessToken` header 均可。

#### Skill 原生 API（全部真机跑通）

| 操作 | 端点 | 说明 |
|---|---|---|
| 列表 | `GET /v3/console/ai/skills/list?pageNo&pageSize&namespaceId` | 返回 name/scope/version 等 |
| 创建草稿 | `POST /v3/console/ai/skills/draft`（form） | 产生 draft 版本 |
| zip 预检 | `POST /v3/console/ai/skills/upload/precheck`（multipart，zip） | 服务端解析 SKILL.md frontmatter 得 name/version |
| zip 上传 | `POST /v3/console/ai/skills/upload`（multipart；overwrite/targetVersion/commitMsg） | 多文件保真入 `resource:{}` |
| 提交审核 | `POST /v3/console/ai/skills/submit`（form） | draft→submit |
| 发布 | `POST /v3/console/ai/skills/publish`（form） | submit→publish |
| 上线 | `POST /v3/console/ai/skills/online`（form） | publish→online |
| 共享范围 | skill 对象 `scope: PRIVATE→PUBLIC` | PUBLIC 才对团队可见 |
| 版本下载 | `GET /v3/console/ai/skills/version/download?...` | 返回 zip blob，拉侧直接用 |
| 删除 | `DELETE /v3/console/ai/skills?skillName=&namespaceId=` | 清理探针已验证 |

#### MCP 原生 API（全部真机跑通；console 前端即此套）

| 操作 | 端点 | 说明 |
|---|---|---|
| 列表 | `GET /v3/console/ai/mcp/list?namespaceId&search=blur&pageNo&pageSize&username` | **必须带 `search`**，否则触发版本 join 异常 |
| 详情/版本 | `GET /v3/console/ai/mcp?mcpName&version&namespaceId`、`GET .../versions`、`GET .../version` | |
| 创建草稿 | `POST /v3/console/ai/mcp/draft`（form：`mcpName/namespaceId/version/serverSpecification[/toolSpecification/resourceSpecification]`） | |
| 更新草稿 | `PUT /v3/console/ai/mcp/draft` | |
| 提交/发布/上线 | `POST /v3/console/ai/mcp/submit|publish|force-publish|online|offline|redraft`（form） | 生命周期同 skill |
| 删除 | `DELETE /v3/console/ai/mcp?mcpName=&namespaceId=` | 按 name 删（孤儿行也可删） |

`serverSpecification`（控制台生成的标准形态，Stdio 型实测）：

```jsonc
{
  "name": "…", "version": "1.0.0", "protocol": "stdio", "frontProtocol": "stdio",
  "enabled": true, "status": "active", "capabilities": [], "description": "…",
  "localServerConfig": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-echo"] },
  "remoteServerConfig": null,     // 远程型填：{ exportPath } + endpointSpecification
  "versionDetail": { "version": "1.0.0", "is_latest": null, "release_date": null }
}
```

远程型 endpointSpecification 三种形态（控制台源码证实）：

```jsonc
{ "type": "DIRECT", "data": { "transportProtocol": "http", "address": "10.x.x.x", "port": "8080" } }
{ "type": "REF",    "data": { "serviceName": "…", "groupName": "DEFAULT_GROUP", "namespaceId": "public", "transportProtocol": "http" } }
{ "type": "DIRECT", "data": { "address": "host", "port": "443", "transportProtocol": "https" } }  // URL 解析形态，配 remoteServerConfig.exportPath
```

#### ⚠️ 已知坑（客户端必须防御）

- **失败草稿留孤儿行**：`createDraft` 若 spec 校验不过，server 行已建、version 行缺失，
  且**整个 `/mcp/list` 被卡死**（全员 404）。客户端创建后必须立即回读校验，失败即按
  `mcpName` 删除清理（DELETE 对孤儿行有效，已实测）。
- 写端点一律 **form 编码**（`application/x-www-form-urlencoded` / multipart），不是 JSON body。
- token 过期后需重登；无 refresh token。

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

### 存储映射策略（2026-09-11 联调后修正）

- **技能：完全走原生 AI Skill API**（真机验证后确定的更优路径）——推 = zip 上传
  （服务端解析 frontmatter 元数据 + 多文件 `resource:{}` 保真），拉 = 版本下载接口直接取
  zip，版本历史 = 原生 versions 列表。**不再**用配置中心信封存技能载荷；
  M1 已实现的信封推拉在 M1.5 重构为原生 API。
- **MCP：完全走原生 AI MCP 资源**——`serverSpecification` 与本地 config_json 结构吻合，
  M2 按上表已验证的 draft→publish→online 链路实现。
- **工作流 / 子应用：配置中心信封**（无原生类型）——`group=SPARK_TEAM`，
  `dataId=<assetType>/<slug>`，`spark.team.asset.v1` 信封（semver + checksum）。
  Nacos 配置中心原生保留每次发布的 revision 历史，构成版本链。

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

## 替代方案调研结论（2026-09-11，Docker 自部署资产商店）

对 GitHub 可自部署候选做了维护度与能力核实，**结论：不做整体替换，Nacos 为骨干**。
没有任何单一项目覆盖技能/MCP/工作流/子应用四类资产；最接近的候选各有硬伤：

| 候选 | 结论 | 关键事实 |
|---|---|---|
| modelcontextprotocol/registry（官方 MCP Registry） | 不引入 | 只存 server.json 元数据不分发包体；Nacos MCP 可与其格式互通 |
| iflytek/skillhub（Astron SkillHub） | 观察（不立即引入） | 5.1k★ 活跃、semver+审核+评分+下载量、中文文档；但仅 Skills，引入会让存储真相与 Nacos 分叉 |
| agentregistry（CNCF Sandbox 提案中） | 观察 | 唯一异构统一店面（六类资源），但 pre-1.0、v0.4 刚经历破坏性重构，缺工作流/子应用 kind |
| artifacthub/hub | 排除 | 索引模型不支持直推；需 K8s+PostgreSQL+OpenSearch，部署过重 |
| Harbor+ORAS / Gitea / Verdaccio | 排除 | 只有"字节桶"语义，无领域模型无店面；Electron 集成成本高收益低 |
| Smithery / Glama / mcp-get | 排除 | 闭源 SaaS / 已归档 |

补充：**MinIO（S3）作为可选字节存储**——子应用 HTML 快照可能超出 Nacos 配置中心单条
大小限制，M4 实施时若超限则字节进 MinIO、元数据仍进 Nacos；工作流 JSON 体量小，配置
中心足够。店面体验按原方案做在 Electron 客户端（团队商店聚合页）。

## 分期

| 期 | 内容 | 状态 |
|---|---|---|
| M1 | 配置 UI + Nacos 客户端 + 技能推拉 + 版本比对 + pins 表 | 代码完成；写链路已真机验证；**待按原生 zip API 重构推拉（M1.5）** |
| M1.5 | 技能推拉重构为原生 AI Skill zip 上传/下载（替代配置中心信封载荷） | 已完成（2026-09-11，真机探针通过） |
| M2 | MCP 发布/安装（映射 AI MCP 资源，payload 结构已实测） | 已完成（2026-09-11，真机探针通过） |
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

- ~~Nacos v3 console 写端点的精确请求字段未实测~~ → **已解决（2026-09-11 真机全链路验证）**，
  端点/编码/字段结构见上文 API 表。
- ~~AI Skill 条目的 `skillSpecification` 结构未核实~~ → **已解决**：原生 zip 上传链路
  （precheck→upload→submit→publish→online→download）全部跑通，技能推拉直接用原生 API。
- 技能载荷含二进制/大文件的封顶策略：单文件 ≤1MB、总包 ≤5MB，超限在发布前拦截并提示
  （原生 zip 上传同样适用此预检）。
- **孤儿行防御**：MCP/Skill 创建失败可能留下无版本的孤儿行并卡死列表（MCP 已实测复现），
  客户端创建后必须回读校验，失败即按 name 删除清理。

## M1.5 / M2 实施记录（2026-09-11）

- **客户端能力**：NacosClient 支持登录（v3/auth/user/login，token 顶层返回）、form/multipart/
  二进制三种载荷；原生 Skill API（precheck/upload/submit/publish/online/scope/download/delete）
  与原生 MCP API（list/get/draft/submit/publish/online/delete）。
- **zip 零依赖**：team-registry/zip.ts 手写 STORE 构造 + STORE/DEFLATE 解析
  （node:zlib inflateRawSync），确定性输出；stripZipCommonRoot 处理服务端下载包的
  `<skillName>/` 顶层目录包裹。
- **发布链路**（技能）：frontmatter 写版本 → zip → precheck（校验 skillName/targetVersion
  与本地意图一致）→ upload（exists 时 overwrite）→ submit → publish → online（降级 warning）→
  scope=PUBLIC（失败降级 warning 并在结果中展示）。
- **MCP 链路**：draft → 回读校验（孤儿行防御，失败即删）→ submit → publish → online；
  本地 config_json ↔ serverSpecification 双向映射（stdio/http/sse，mcp-mapping.ts）。
- **M2 UI**：MCP 管理页卡片「发布到团队」入口 + 顶部「团队 MCP」折叠区块（安装/更新徽标）；
  发布确认弹窗列出敏感命名变量键（只报键名不报值）。
- **IPC**：team-registry:list-mcp / publish-mcp / install-mcp / list-mcp-updates。

## 真机联调记录（2026-09-11）

- 登录：`v3/auth/user/login`（form），accessToken TTL 5h；测试机凭据 nacos/nacos（测试环境）。
- Skill：zip（SKILL.md + 附属资源）上传 → 服务端解析 frontmatter name/version →
  submit → publish → online → scope 改 PUBLIC → 版本下载 zip 字节级保真 → 全链路 ✅。
- MCP：控制台同款 draft→submit→publish→online ✅；最终状态 online、列表可见 ✅。
- 孤儿行：伪造 serverSpecification 的 createDraft 复现「server 行存在 + version 行缺失 →
  /mcp/list 全员 404」，按 mcpName DELETE 清理后恢复 ✅。
- 探针数据（spark-probe-zip / spark-probe-test / spark-probe-mcp）验证后已全部删除，
  注册中心还原为空。

### M1.5/M2 集成探针补充（2026-09-11，vitest TEAM_REGISTRY_LIVE=1，2/2 通过）

- **登录响应**：accessToken 在顶层（与 globalAdmin/username/tokenTtl 平级），data 为空对象。
- **技能下载 zip**：内容为 DEFLATE 压缩且带 `<skillName>/` 顶层目录——安装/解析侧必须
  stripZipCommonRoot（上传平铺 zip 服务端可正常解析）。
- **MCP 详情**：版本列表字段是 `allVersions`（元素无 status，状态在 /mcp/versions）；
  spec 字段平铺在 data 顶层（protocol/localServerConfig/remoteServerConfig...），
  `serverSpecification` 键不存在——客户端做了双形态兼容。
- **MCP 列表**：条目主键是 `name`（非 mcpName）；已发布最高版本在 `latestPublishedVersion`
  （草稿态为 null），`version` 是当前编辑版本。
- 探针（spark-live-probe / spark-live-probe-mcp / diag 用例）用后即删，已验证清理。
- 未决：本地 vitest 全量受环境牵制（better-sqlite3 于当日 09:02 被 Electron ABI 重编译，
  Node 侧 SQLite 测试挂载失败；属环境状态非代码回归），本次验证范围为 team-registry /
  skill-registry 非 DB 单测 21/21 与真机探针 2/2。

### UI 自查与合并验证（2026-09-11 晚）

- **e2e 走查**（`apps/desktop/e2e/team-registry.ui.e2e.ts`，隔离 profile 生产模式，4/4 通过）：
  1. 设置 → 团队注册中心分区渲染（未配置降级态 + 四输入框 + 按钮可见）；
  2. 真实保存配置并连接测试（直连测试机，~220ms 返回「已保存并连接成功」）；
  3. 技能商店 → 团队源 Tab：配置后空态（不再是「尚未配置」），真实拉取列表；
  4. MCP 管理 → 团队 MCP 折叠区块：真实拉取「0 个共享」→ 展开后空态可见。
- **行为发现**：钥匙串凭据是机器级（跨 profile），`hasPassword=true` 时密码框占位符变为
  「已保存（留空保持不变，输入则更新）」——新 profile 未配置但机器已存过密码即如此显示，
  属预期行为；e2e 按结构定位密码框，不依赖占位符。
- **合并 master（141 提交）冲突解析**：
  - HistoryImport/ZCode：取 master 侧（`zcodeCliStore`/`zcodeV2Parser` 更新且带修复）；
    我方 `ba9eed7b` 平行实现（`zcodeStore`/`zcodeParser`）已无引用，随合并移除；
    `docs/design/history-import-experience.md` 随 master 删除；
  - `ensure-native-electron.mjs`：取 master 侧（sha256 指纹 + 真实加载验证 + vendor prebuilds 链路，
    与 master 的 sqlite-abi.sh 工具链配套）；我方 c4eec01d 的同类修复被其演进版取代；
  - `ipc/index.ts` 手工融合：master 全部新增通道 + team-registry 全部通道/服务工厂/导入；
  - **迁移撞号**：master 已占用 093（unified_tool_invocations），我方 team_asset_pins
    迁移改号为 098；该迁移从未随版本发布，无兼容性影响（master 侧迁移编号唯一性断言拦下）。
- **合并后验证**：全仓 `pnpm -r typecheck` 0 错误；聚焦单测 21（team-registry）+ 3（pins，
  Electron-as-Node 跑）全部通过；重建产物明文；e2e 4/4 通过。
- **导航备注**：侧边栏 MCP 管理入口的实际可访问名是「扩展中心」（`nav.extensions`），
  i18n 的 `nav.mcp`（「连接器」）不用于该侧边栏按钮。
