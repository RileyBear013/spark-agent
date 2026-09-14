# 团队注册中心与资产共享方案（Team Registry Sharing）

> 状态: 实施中 | 最后核对: 2026-09-14

## v2.5 商店迁入拓展中心、服务端分页与分享包完备化（2026-09-14）

- **商店入口迁入拓展中心**：团队商店从侧栏独立入口移入 McpView（拓展中心）新页签，
  App.tsx 路由深链同步，侧栏入口移除、角标迁至拓展中心项——商店与 MCP/自定义工具/
  连接器同属资源类聚合，侧栏收敛。
- **服务端分页**：Nacos 列资产接口带 page/pageSize/search，nacos-client 三个 list
  方法（资产/agentspecs/MCP）改分页返回 `{items, total}`（total 探测不到时以当页
  条数兜底）；agentspecs 按 `spark-<type>-` 命名前缀 blur 过滤；asset-service/
  skill-registry/IPC 协议与 Handler 透传分页参数。商店 UI 按类目独立分页（每页 24），
  「全部」视图聚合五类第一页——替代此前进店即 10 个 IPC 并发全量拉取，防大店爆内存。
- **工作流分享包 v2**：manifest 增 agents 分区（确定性 ID + agentIdMap 引用改写），
  导入端物化 Agent、失败回滚、卸载联动清理；collectGraphDependencies 补收直连
  MCP 节点引用（此前既不随包也不进 unresolved 的缺口）；模型/Provider 绑定转
  unresolved 提示（密钥不可导出，至少可见）；schemaVersion 同时接受 v1/v2 旧包；
  导入预览 UI 增 Agent 区块、provider 文案与创建计数 toast。全新 Spark 导入
  .sparkflow 即具备随包 Agent/MCP/技能能力。
- **应用分享包 V2 完整化**：`.sparkapp` 包增 v2 段——V2 多文件项目文件（草稿与
  发布制品内容寻址文件）、发布版本关联、连接槽绑定与 V2 身份字段；导入端按
  draft/published 分路还原并清理孤儿关联；导出 capabilities 扫描纳入 V2 文本，
  修正 V2 场景误导性「空草稿」警告。修复此前 V2 应用导出 source 全空的缺口，
  分享包即完整当前应用。
- **验证**：四包 typecheck 0 错误；workflow-bundle + team-registry 定向 30/30、
  storage sub-app 24/24、SubAppShareService 11/11（含 V2 round-trip）、storage
  全量 426 用例（1 个 session-collaboration 用例并行跑超时，单独重跑 14/14 通过，
  判定为资源竞争偶发）；四包 lint 0 错误，改动文件无非空断言/未用告警残留，
  TeamStoreView 的 effect 内 setState 告警沿用 master 旧版同款惯用写法；
  McpView.test 的 @lobehub/ui fluent-emoji 目录解析失败为 worktree 环境性预存
  问题（master 同样失败），与本次改动无关。

## v2.4 团队商店上传入口与分类分节排版（2026-09-13，`59d7226c`）

- **商店内上传入口**：头部「上传共享」打开发布抽屉——三类页签（工作流/应用/助手）
  列出本地资产（`workflow:list` / `agent:list` / `sub-app:list`），行内一键发布
  （复用 `team-registry:publish-asset`），结果区展示新版本号与捆绑 warnings；
  同名同类标注「已在团队 vX」（slug 由名称确定派生，同名即同条目）；V2 多文件
  应用与已归档应用禁发并显示原因。此前发布只能绕道各管理页卡片菜单，商店页
  没有上传口，双向闭环缺了「传」的一侧。
- **分类分节排版**：「全部」视图按 应用→工作流→助手→技能→MCP 分节渲染
  （小节标题+计数+各自网格，空分类不出节），替代五类混排；类型徽标改彩色
  胶囊（与图标同色系）、版本号加重、卡片网格最小列宽 280→300。
- **e2e 对齐**（`8c11dc25`）：原测试 3/4 引用已移除的「团队源」Tab 与 MCP 团队
  区块，改为覆盖商店页（页签/卡片/详情抽屉）与上传面板（三类页签/本地列表）。

## 发布前全面校验与 master 合并（2026-09-13，`758611f2..2c4cc86d` + 两次合并）

- **规范债清偿**：M2 内联在超限 `ipc/index.ts`（10518 行）的 20 个 team-registry 通道
  抽至 `registerTeamRegistryIpc.ts`（单例经 deps 注入，行为不变）。
- **测试基建**：`pnpm test:unit` Windows 可用化（`scripts/run-unit-tests.mjs`——
  win32 走 Electron 运行时顺序执行不动 ABI 文件，posix 沿用 .sh 流程）；
  全量首跑暴露并修复：`__tests__/services/team-registry.test.ts` 两个过期断言
  （publishConfig form 编码、六态 v2.1 规则）、`SubAppsView.test.tsx` 因发布弹窗
  需 ToastProvider 与组件化 Modal mock、`ipc-handlers.test.ts` 完整性清单缺
  team-registry/workflow-bundle（后者为 master 侧漏更，master 上同样失败）。
- **master 合并**（62+5 提交）：唯一手工冲突为 agent-runtime 桶文件（双方追加
  导出，取并集）；迁移撞号守卫二次拦截（master 占 098/099），team_asset_pins
  改号 100（分支独有未发布，无兼容影响）。
- **验证快照**：四包 typecheck 0 错误；storage 426/426、team-registry 61/61、
  desktop 组件修复文件 15/15、e2e 4/4（真实连接本地补丁容器）；Windows 环境性
  既有失败（EBUSY 临时目录/git spawn 等，分支未触碰文件）如实记录为待专项。
