import {
  detectWorkflowConditionReferenceErrors,
  detectWorkflowGraphCycles,
  detectWorkflowUnsupportedNodeKinds,
  formatWorkflowConditionReferenceError,
  formatWorkflowCycleError,
  formatWorkflowUnsupportedNodeKindError,
  normalizeWorkflowGraph,
} from '@spark/agent-runtime'

/**
 * 工作流图写入前的静态校验，`workflow:create` / `workflow:update` 与团队资产安装工作流
 * 共用同一实现。
 *
 * 覆盖三类运行期才会暴露、且届时报错难以定位的问题：
 * - 未知节点类型：`normalizeWorkflowGraph` 会把未知 kind 静默降级成 `agent` 节点，
 *   图里写着 `output` 却按 agent 跑，直到会话挂载预检才以 unsupported_node_kind 暴露；
 * - 环：运行时只能以 workflow_deadlock 失败，报错是英文裸 node id；
 * - 条件引用：条件/退出条件引用了没有任何节点声明的状态键。
 *
 * 全部在持久化前拦截，报错带节点标题便于用户定位。
 */
export function assertWorkflowGraphValid(graph: unknown): void {
  if (graph == null) return
  const graphInput = graph as Parameters<typeof normalizeWorkflowGraph>[0]
  const unsupportedKinds = detectWorkflowUnsupportedNodeKinds(graphInput)
  if (unsupportedKinds.length > 0) {
    throw new Error(formatWorkflowUnsupportedNodeKindError(unsupportedKinds))
  }
  const normalized = normalizeWorkflowGraph(graphInput)
  const cycleReports = detectWorkflowGraphCycles(normalized)
  if (cycleReports.length > 0) throw new Error(formatWorkflowCycleError(cycleReports))
  const referenceReports = detectWorkflowConditionReferenceErrors(normalized)
  if (referenceReports.length > 0) {
    throw new Error(formatWorkflowConditionReferenceError(referenceReports))
  }
}
