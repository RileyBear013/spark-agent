/**
 * 工作流保存闸门（workflow:create / workflow:update 共用）。
 *
 * 职责边界（三层校验并存、互不替代）：
 * - assertWorkflowGraphSchema：形状层——kind 枚举、config 字段白名单（strict）、
 *   边条件结构、递归循环体；规则定义在 @spark/protocol 的 WorkflowGraphSchema。
 * - assertWorkflowGraphValid：拓扑层——规范化 + 环检测 + 边条件引用检测。
 * - normalizeWorkflowGraph（executor 内部）：运行时容错——旧数据兜底，静默降级。
 *
 * 从 ipc/index.ts 抽出为独立模块：handler 只保留接线，闸门行为可被
 * __tests__/workflow-graph-save-gate.test.ts 用真实数据（官方模板/demo/存量形态）
 * 直接回归。
 */
import { WorkflowGraphSchema, formatWorkflowGraphIssues } from '@spark/protocol'
import {
  detectWorkflowConditionReferenceErrors,
  detectWorkflowGraphCycles,
  formatWorkflowConditionReferenceError,
  formatWorkflowCycleError,
  normalizeWorkflowGraph,
} from '@spark/agent-runtime'

/** 保存前形状校验（M1 第 0 步）：LLM 拼错的 kind、字段名、值类型在此明确拒绝。 */
export function assertWorkflowGraphSchema(graph: unknown): void {
  if (graph == null) return
  const parsed = WorkflowGraphSchema.safeParse(graph)
  if (!parsed.success) {
    throw new Error(`工作流图校验失败：${formatWorkflowGraphIssues(parsed.error.issues)}`)
  }
}

/**
 * 保存前拓扑校验：环图在运行时只能以 workflow_deadlock 失败（英文裸 node id 报错），
 * 这里在持久化前用拓扑排序即时拦截，报错带节点标题便于用户定位。
 */
export function assertWorkflowGraphValid(graph: unknown): void {
  if (graph == null) return
  const normalized = normalizeWorkflowGraph(graph as Parameters<typeof normalizeWorkflowGraph>[0])
  const cycleReports = detectWorkflowGraphCycles(normalized)
  if (cycleReports.length > 0) throw new Error(formatWorkflowCycleError(cycleReports))
  const referenceReports = detectWorkflowConditionReferenceErrors(normalized)
  if (referenceReports.length > 0) {
    throw new Error(formatWorkflowConditionReferenceError(referenceReports))
  }
}
