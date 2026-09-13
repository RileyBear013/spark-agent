# 团队注册中心（Nacos）共享方案 — Skills / MCP / 工作流 / 子应用的推拉与版本管理

> 状态: 实施中 | 最后核对: 2026-09-13

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
- **工作流 / 子应用 / 平台 Agent：配置中心信封**（无匹配的原生类型）——`group=SPARK_TEAM`，
  `dataId=<assetType>/<slug>`，`spark.team.asset.v1` 信封（semver + checksum）。
  Nacos 配置中心原生保留每次发布的 revision 历史，构成版本链。
  平台 Agent **不走**原生 Agent 资源的原因见下节：SparkWork Agent 是配置型
  （prompt + 技能/MCP/工作流/模型绑定），无网络端点，不满足 A2A AgentCard 的
  可调用服务语义，硬套会产生假 URL 污染公司的 A2A 服务注册表。

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

### 本地跟踪表 `team_asset_pins`（migration 098）

记录每项团队资产的安装/发布锚点：asset_type、slug、installed_version、installed_checksum、
installed_at、published_version、published_checksum、published_at。
「可更新」徽标 = pins 与远端信封比对，不需要扫全量文件。

### 安全边界

- token/密码只进 keystore，永不进聊天、日志与 IPC 响应（config-get 只回 `hasPassword`）。
- 推送前在 UI 展示变更摘要（版本、文件数、checksum）；写团队注册中心的操作一律经用户点击触发。
- 团队注册中心写操作失败显式报错，不做静默重试写。

## Nacos 原生资源全貌与「是否需要改 Nacos」评估（2026-09-11 第二轮真机联调）

控制台菜单 + API 实测确认，该 Nacos（v3.3.0-SNAPSHOT，standalone）原生支持五类 AI 资源：

| 原生资源 | 状态 | 数据模型（实测） | 对 SparkWork 资产的适配判定 |
|---|---|---|---|
| Skill | 稳定（new） | SKILL.md frontmatter + zip 多文件 + 版本生命周期 + 下载量 | ✅ 技能直用（M1.5 已实现） |
| Prompt | 稳定（new） | prompt 模板资源（列表端点已通，未深探） | 预留：平台 Prompt 模板共享可用（暂无此需求） |
| Agent | 稳定 | **A2A 0.3 AgentCard 注册**：元数据（name/展示名/图标/标签/provider/扩展字段）→ 版本 → 多协议配置（完整 AgentCard 粘贴，自动生成声明端点）；`callInterfaces[].nativeDescriptor` 即完整 A2A Card；运行时端点挂 naming 服务（group `agent-endpoints`，服务名 `rad-<agentName>-<protocol>`），声明端点 + 运行时端点双源（`endpointSourceOrder`） | ❌ 平台 Agent 不适配：SparkWork Agent 是配置型（prompt + 绑定），无网络端点、无可调用接口；A2A 资源是给「独立运行、可被发现的 Agent 服务」用的。平台 Agent 共享走配置中心信封 |
| AgentSpec | Beta | **AGENTS.md + 资源文件**的包格式（与 SKILL.md 包完全同构），版本生命周期（draft→submit→publish→online 已实测 200）、上传、下载量统计、权限管理 | ◐ 可选增强：把平台 Agent 定义导出为 AGENTS.md 包发布（跨平台可读——Claude Code 等也认 AGENTS.md），白拿版本管理/下载量；Beta 阶段不作为依赖，列为后期可选项 |
| MCP | 稳定 | serverSpecification + 生命周期 | ✅ MCP 直用（M2 已实现） |

端点形态补充（agentspec 实测）：生命周期动作用「集合层 + query 参数」形态——
`POST /v3/console/ai/agentspecs/submit|publish|online?namespaceId&agentSpecName&version`（form/空体均可，200），
删除 `DELETE /v3/console/ai/agentspecs?agentSpecName=&namespaceId=`（200）；
与 skill/mcp 的「资源层 + form」形态并存，客户端按资源类型分别适配。

**配置中心单条大小上限（实测）**：100KB / 512KB / 1MB 写入成功；2MB → `413 Content Too Large`。
结论：子应用快照（发布巡检中心 v20 源码数百 KB）整包可存；超限时先 gzip+base64
（HTML 压缩比 4~8x，净效果仍缩小），再不够则按调研结论引入 MinIO 存字节。

### 结论：不需要改 Nacos 源码（fork 成本 > 收益）

用户已确认该 Nacos 为闲置服务器上的自部署开源版、允许调整，但评估后**建议不改源码**：

1. **四类资产都有合适的存储**：技能/MCP 有原生类型（含版本、审核、下载量、共享范围），
   工作流/子应用/Agent 用配置中心信封（原生 revision 历史即版本链 + listen 推送 + 命名空间隔离）。
2. **原生类型的真正价值是生态语义**（A2A 互通、跨系统 MCP 发现），工作流/子应用/平台 Agent
   是 SparkWork 私有概念，无跨系统互通需求——为它们在 Nacos 加自定义资源类型，收益只有
   「控制台里能看到」，而团队真正的店面是 SparkWork 客户端的团队商店聚合页（M4）。
3. **fork 长期负债**：3.3.0-SNAPSHOT 本身是快照版；改源码意味着自编译部署 + 每次升级 rebase
   补丁，运维成本持续，与「闲置服务器轻量共用」的定位不符。

允许调整的正确用法（均为**配置/部署层调整**，非改码）：若子应用包超 1MB 上限，调
Nacos 配置大小参数（`nacos.config` 相关 max content 配置）或按上文 gzip 方案；auth 接入
公司统一认证、standalone 升集群，均属部署演进，随时可做、不影响客户端协议。



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
大小限制（实测 2026-09-11：单条 1MB 可写 / 2MB 报 413；客户端信封上限收紧到 900KB），超限资产暂不支持（V2 多文件应用明确报错），后续可选 gzip+base64 或 MinIO；工作流/Agent 配置体量小，配置
中心足够。店面体验按原方案做在 Electron 客户端（团队商店聚合页）。

## 分期

| 期 | 内容 | 状态 |
|---|---|---|
| M1 | 配置 UI + Nacos 客户端 + 技能推拉 + 版本比对 + pins 表 | 已完成（技能推拉已按 M1.5 重构为原生 zip API） |
| M1.5 | 技能推拉重构为原生 AI Skill zip 上传/下载（替代配置中心信封载荷） | 已完成（2026-09-11，真机探针通过） |
| M2 | MCP 发布/安装（映射 AI MCP 资源，payload 结构已实测） | 已完成（2026-09-11，真机探针通过） |
| M3 | 工作流团队库 + 平台 Agent 团队库（信封通道，assetType 增 agent 枚举） | 已完成（2026-09-11，真机探针通过） |
| M3.5（可选） | 平台 Agent 导出为 AGENTS.md 包发布到原生 AgentSpec（Beta，跨平台可读） | 待评估 |
| M4 | 子应用团队库（V1 单文件草稿快照 payload）+ 各管理页团队区块 + 设置页五类资产总览 | 已完成（2026-09-11，真机探针通过；V2 多文件应用暂不支持，明确报错） |
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

## M3/M4 实施与真机记录（2026-09-11）

### 交付

- **agent-runtime**：`team-registry/asset-service.ts` 新增 `TeamAssetService`——信封型资产
  （workflow / agent / app）的发布（默认 patch+1、防版本回退）、安装/更新（端口落地 + pins
  锚点）、列表与六态更新比对（复用 `classifyTeamAssetState`）。本地落地经 `TeamAssetPort`
  接口由 desktop 主进程适配（workflow→WorkflowRepository / agent→AgentRepository /
  app→SubAppRepository），agent 安装后的 RuntimeComposition 刷新与 configChanged 广播在
  handler 层补触发。`slugifyAssetName`：纯 ASCII 名干净归一；含中文的名字走
  「ASCII 残段 + sha256 前 8 位」防塌缩（「数据分析Agent」「报表Agent」不同 slug）。
- **协议**：`team-registry:list-assets / publish-asset / install-asset / list-asset-updates`
  四通道（DTO 含 assetType 联合类型）。
- **desktop**：`registerTeamAssetIpc.ts` 独立注册模块（不往 10k 行的 ipc/index.ts 加代码）；
  工作流安装图校验复用 `assertWorkflowGraphValid` 闭包（deps 注入）；Agent 载荷与
  `agent:export-to-file` 的 AgentExportPayload 单条目形状一致（与文件导入互认）；子应用安装
  经 `SubAppRepository.importApp`（releases 为空 → 落成草稿，需对方确认发布），更新走
  `updateDraft`（CAS 保护）。
- **UI**：`TeamAssetMarket.tsx` 通用组件（TeamAssetSection 浏览/安装/更新 + 发布弹窗）接入
  三处——Workflows 列表页（卡片菜单「发布到团队」+「团队工作流」区块）、Agent 管理页（同）、
  子应用页（同）；设置 → 团队注册中心新增五类资产「可更新」总览条（技能/MCP 复用既有更新
  通道）。

### 真机探针抓出的三个 bug（均已修复并回归）

1. **Nacos dataId 禁止 `/`**（HTTP 400 code 20002）：M1 设计的
   `<assetType>/<slug>` 寻址在真机上不成立。实测 `:` `_` `.` 合法，定
   `<assetType>:<slug>`；`config-history` 通道同步修正。
2. **配置中心写端点是 form 编码**：`publishConfig` 原用 JSON body，服务端报
   Required parameter（code 10000）——与 AI 写端点同形态，改 form 后真机写入/回读成功。
3. **CJK 名塌缩**：`团队探针Agent` 原 slug 规则推出 `agent`，所有「XX agent」命名互相
   覆盖；改为「ASCII 残段 + 名称哈希」。

### 验证（2026-09-11）

- agent-runtime / protocol / desktop 三包 typecheck 0 错误；改动面 lint 0 errors。
- 聚焦单测 29/29 通过（含 asset-service 8 项：发布递增/防回退/中文 slug/安装锚点/校验/
  更新/六态/未配置降级）。
- 真机探针（`TEAM_REGISTRY_LIVE=1 asset-service-live.test.ts`）1/1 通过：三类资产发布 →
  回读 checksum → 防回退 → patch+1 → 独立「第二机器」安装/更新 → up-to-date /
  remote-newer / local-modified 判定 → 严格清理（清理失败显式报错），注册中心还原为空。
- 未验证：UI 端到端点击（typecheck + 组件模式与 M1/M2 已验证组件同构）；子应用 V2 多文件
  团队共享（明确报错，未实现）。

### 已知行为约定

- 信封安装「新建」一律落草稿/禁用态（工作流 draft、子应用草稿），由使用者确认后启用；
  「更新」只覆盖内容字段，保留本地运行状态（status/enabled）。
- Agent 载荷不含 mcpServerIds（与文件导出一致：MCP id 是机器本地概念）；skillIds/ruleIds/
  workflowId 随包共享但依赖对方机器存在同 id 资产，发布弹窗有提示。
- 配置中心信封上限 900KB（留余量于实测 1MB）；超限报错提示后续 gzip/MinIO 方向。


## AgentSpec 原生承载迁移（2026-09-11 下午）

> 状态: 已落地（本分支） | 最后核对: 2026-09-11

用户裁决：工作流 / 平台 Agent / 子应用要像 Skill/MCP 一样在 Nacos 控制台有原生管理页，
而不是配置中心里的裸 JSON。承载资源选定为 Nacos 原生 **AgentSpec**（Beta）：
包格式 manifest.json + 资源文件 zip，控制台有独立管理页（版本生命周期 / 共享范围 /
下载统计），与 Skill 管理页同级的体验。

### 真机契约（192.168.163.174 测试机，全部实测）

| 项 | 结论 |
|---|---|
| 条目身份 | 服务端以 manifest 的 `worker.suggested_name` 为身份（≠ manifest.name 时条目建到 suggested_name 名下，按 name 回读 404）——两者必须同值 |
| 版本号 | **服务端自分配** 0.0.N 单调递增；上传包里的 manifest.version 不生效（仅展示） |
| 上传 | POST /v3/console/ai/agentspecs/upload（multipart file+namespaceId）；条目不存在时自动创建（create 端点在当前 SNAPSHOT 上 500，无需依赖） |
| 冲突 | 存在 editing/reviewing 版本时拒绝再传（code 20005）——生命周期走完才能发下一版 |
| 生命周期 | submit → publish → online（POST + query 参数）；终态 online |
| 共享范围 | PUT /agentspecs/scope（form：agentSpecName/scope）设 PUBLIC |
| 内容回读 | GET /agentspecs/version 返回 manifest 原文 + 全部资源内容（资源键转义 /→_ 、.→__，以 resourceIdentifier/name 还原）——**上游无 zip 下载端点**（develop 分支源码核实），内容回读即安装/比对依据 |
| x-spark 扩展 | manifest 自定义字段服务端原样保留，携带信封元数据（checksum/slug/assetType） |

### 实现要点

- `agentspec.ts`：信封 ⇄ zip 编解码；agentSpecName = `spark-<资产类型>-<slug>`；
  版本以服务端分配为准（envelopeFromAgentSpecVersion 用 detail.version 优先）
- `asset-service.ts`：三类资产运输从配置中心切到 AgentSpec；发布链路
  upload → 回读 editingVersion → submit → publish → online → PUBLIC → pins；
  防回退由服务端版本单调性天然保证（opts.version 仅回显 warning）
- 信封形状（spark.team.asset.v1）/ 六态判定 / pins 锚点 / IPC / UI 全部不变——纯运输层替换
- 迁移：5 条资产（1 工作流 + 4 应用）已重发为原生 AgentSpec（PUBLIC，v0.0.2，
  checksum 字节级校验通过），5 条 SPARK_TEAM 裸配置已删除清零
- 已知边界：V2 多文件子应用不支持（发布入口明确报错）；上游 AgentSpec 为 Beta

## 2026-09-12 追加：包格式 v2（AGENTS.md 完整介绍）与 Nacos 控制台补丁

用户实测反馈：控制台 AgentSpec 详情页「AGENTS.md 预览区空白（暂无内容）」、资源文件
只有文件名没有内容、工作流/应用/助手混在一个列表、卡片介绍被截断。逐项核查与处理：

### 1. 包格式 v2（buildAgentSpecPackage）
- 控制台预览区**只渲染名为 `AGENTS.md` 的资源文件**（真机实测，manifest.json 不进预览）。
  包内新增 `AGENTS.md`：完整未截断介绍 + 元数据表（类型/团队版本/发布者/更新时间/
  校验/安装名称）+ 包内文件说明 + 安装方式，控制台以 markdown 完整渲染。
- `manifest.json`（含 x-spark）与 `payload.json` 不变；checksum 仅覆盖 payload，
  AGENTS.md 不影响信封指纹与 pins 连续性。
- 5 条资产已删除旧条目并以 v2 格式重新发布（全新 0.0.1，PUBLIC）；回读三方校验：
  pins.published_checksum == 远端 x-spark.checksum == payload 重算 checksum，逐条一致。

### 2. Nacos 控制台补丁（console-ui-next 分叉，基线 3.3.0-beta-develop）
分叉位置 `D:\harness平台\nacos-console-fork\nacos`（稀疏克隆）。改动：
- **分类展示**：侧边栏新增「Spark 团队资产」分组（Spark 应用 / Spark 工作流 / Spark 助手，
  深链 `/agentspec?category=app|workflow|agent`）；列表页新增分类 tab（带计数），
  基于 `spark-<category>-` 命名前缀客户端过滤（服务端 pageSize=500 全量拉取）；
  卡片增加分类角标与图标、介绍 clamp-2→3。侧边栏 navTo/isActive 改为查询参数感知。
- **文件查看器**：上游 ResourceViewer（文件树 + Monaco + 每文件复制/下载）在本环境
  挂载时容器 0 尺寸导致编辑器卡 5px 不渲染；修复为宿主 ResizeObserver 测量显式像素
  高度 + onMount 多时机强制 layout()。真机验证 manifest.json 全文渲染、文件可切换。
- 兼容性：console-ui-next 的 API 层与本服务器（3.3.0-SNAPSHOT）端点一致，实测可用；
  构建产物 `spark-console-next-patch.zip`（108 文件，STORE zip，内容字节级明文验证），
  部署方式见交付说明（替换 nacos 部署目录 console 模块 static/next 后重启）。
- 残留边界：上游无 zip 下载端点（安装走版本内容回读，不受影响）；「助手」类资产
  尚未发布过条目（客户端已支持 agent 类型发布，发布后自动归入对应分类）。

### 3. 2026-09-12 追加：v2.1 自包含捆绑（空机器可运行）

用户要求：上传内容必须全面——工作流/应用安装包要**自包含**，对方在「什么技能、
MCP、Agent 都没有」的空机器上一键安装即可运行，不依赖本地环境。

**载荷扩展**（信封 schema 不变，payload 增加可选 `bundle` 字段）：
- `TeamBundleSpec = { skills[], mcps[], agents[], unresolved[] }`
- `skills[]`：完整文件内联（utf8 文本直存 / 二进制 base64 保真）+ 目录 sha256
  + SkillLoader manifest + 原始字节数；路径排序 canonical 化（两侧 checksum 可比）
- `mcps[]`：密钥脱敏为 `{{secret:path}}` 占位符 + requiredSecrets 清单
- `agents[]`：被引用的平台 Agent 定义（级联其技能/MCP）
- `unresolved[]`：跨环境不可移植项（规则/自定义工具/绑定工作流）与收集失败项
  （目录超限/缺失），安装侧显式 warning，不静默

**收集与物化**（`team-bundle.ts`）：
- 收集（发布方）：图依赖收集（技能/MCP/Agent 级联）→ 内联打包；内建技能静默
  跳过；分级上限（单技能 2000 文件 / 单文件 4MB / 单技能 20MB / 单资产 24MB），
  超限按体积降级为 unresolved，保证发布永远可完成。
- 物化（接收方，`TeamBundleInstaller`）：确定性 bundleId `team-<assetType>-<slug>`
  幂等替换——技能落 `_bundles/<bundleId>/<slug>/`（id `bundle:<bundleId>:<slug>`，
  sha256 校验）、MCP 落禁用行（bundle_id 标记，更新保留接收方已补密钥）、Agent
  以 `team-agent-<bundleId>-<sha8>` 确定性 id 停用落位（更新保留运行状态）、
  登记 `workflow_bundles` 行（复用工作流包管理 UI 的卸载/校验/激活 MCP）；
  主资产落位失败时尽力回滚新建项。

**引用改写**：安装后图引用（skillIds/mcpServerIds/agentId，含 loop.body 递归）
统一改写为本地 id（`rewriteGraphReferences` 扩展可选 agentIdMap，向后兼容）。

**六态判定适配**：捆绑资产的本地 payload（引用已改写）与远端信封逐字节不可比，
 pins.installedChecksum 改记「安装完成时的本地载荷 checksum」（剔除 bundle 的
 归一化口径 `computeNormalizedPayloadChecksum`）；分类器新增规则——本地未被改动
 且版本一致即 up-to-date（AgentSpec 服务端版本号每次发布必递增，「同版本内容
 不同」形态不可达，规则安全）。捆绑内容不参与本地一致性判定（随安装整体更新）。

**传输上限实测**：~2.7MB base64 载荷（zip ~3.6MB）真机上传/回读完整（checksum
一致），TEAM_ASSET_LIMITS.maxEnvelopeBytes 由 900KB（配置中心时代遗留）提升至
40MB，分级约束由 TEAM_BUNDLE_LIMITS 承担。

**全量重发**：正式版 9 工作流 + 4 个 V1 应用以 v2.1 载荷全部重新发布（PUBLIC，
服务端自增版本），逐条回读校验 checksum 与捆绑清单。依赖收集确认：9 个工作流
均为内联 prompt 的 agent 节点流（零外部引用，天然自包含）；「发布巡检中心」
HTML 源码扫描发现引用 hq-static-db，自动随包捆绑 1 个脱敏 MCP 配置。


## v2.2 版本管理加深（2026-09-12）

状态行：已落地（真机探针通过）。

- **安装历史版本/回滚**：installFromTeam 支持 opts.version（信封三资产 / 技能 / MCP 全覆盖），
  指定版本必须落在已发布版本集合内（draft/不存在版本明确拒绝）；缺省仍为最新已发布。
- **版本列表**：TeamAssetService.listTeamAssetVersions + team-registry:list-{asset,skill,mcp}-versions
  三个通道；统一 listInstallableTeamVersions（online/publish 终态，semver 降序）。
- **UI**：TeamVersionsModal（三市场组件共用）——条目「版本」按钮 → 版本列表（状态/作者/当前版本标注）
  → 逐版本安装/回滚；回滚后六态判定显示「可更新」（回归最新一键完成）。
- **发布弹窗修正**：信封资产发布弹窗移除版本号输入（AgentSpec 由服务端自分配 0.0.N，
  输入不生效）；技能/MCP 发布弹窗保留版本输入（其协议版本生效）。
- **真机形态补记**：MCP allVersions 行无 status，以 release_date 有值为已发布信号
  （normalizeMcpDetail 合成 published）；MCP 版本级详情端点 /v3/console/ai/mcp/version
  返回该版本 serverSpecification（安装历史版本的内容源）。
- **验证**：单测 43/43；真机探针 2/2（工作流四版本发布→指定 0.0.1 安装→remote-newer→
  重装最新 up-to-date；MCP 两版本发布→版本列表→版本详情回读→指定 0.0.1 安装→pins 校验）。


## v2.3 团队商店（2026-09-13）

状态行：已落地（typecheck/lint 通过，真机点验待预览实例重建后进行）。

- **动机**：旧入口是「管理视角」的堆叠——工作流/Agent/子应用页顶部折叠区块 +
  MCP 页区块 + 技能商店第三个 Tab，入口分散、无搜索、无筛选、简介不可读。
  按用户裁决改为「商店视角」：唯一常驻入口，消费侧聚合。
- **TeamStoreView**：搜索（防抖，名称/简介/发布者）+ 分类页签（全部/应用/工作流/
  助手/技能/MCP，带计数）+ 状态筛选 chips（可更新/未安装/已安装/需注意——
  需注意聚合 local-modified / remote-missing / version-equal-content-differs / local-newer）
  + 排序（最新/名称）+ 卡片网格（类型彩色图标与徽标、版本、发布者、相对时间、
  两行简介、MCP 协议、技能下载量）+ 详情抽屉（完整简介、元数据表、
  安装/重装/版本历史入口）+ 可更新横幅（一键全部更新，逐项容错计数汇报）。
- **侧栏角标**：useTeamStoreBadge（独立小模块，避免 App 静态拖入 lazy 的商店视图）
  —— 五类 remote-newer 总数，90s 轮询 + 窗口聚焦刷新，未配置恒为 0。
- **入口**：侧栏共享资源区「团队商店」（SHARED_RESOURCE_IDS + NAV_ITEMS + ViewId
  team-store + i18n nav.teamStore）；设置 → 团队注册中心新增「打开团队商店」。
- **清理**：移除三个管理页的 TeamAssetSection、MCP 页 TeamMcpSection、
  技能商店「团队源」Tab（TabType/isSkillStoreTab 同步收紧）；发布弹窗
  （TeamAssetPublishModal / McpTeamPublishModal / PublishSkillToTeamModal）全部保留。
- **纯 UI 层**：零后端/协议改动；已知限制——卡片不展示捆绑内容计数
  （list 通道无 bundle 明细，需后续 detail 通道）。
- **验证**：desktop typecheck 0 错误；改动面 lint 0 errors（18 个 warning 均为
  仓库既有 react-hooks/set-state-in-effect 风格类）；UI 点验依赖预览实例重建。
