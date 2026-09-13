# 团队注册中心与资产共享方案（Team Registry Sharing）

> 状态: 实施中 | 最后核对: 2026-09-13

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
