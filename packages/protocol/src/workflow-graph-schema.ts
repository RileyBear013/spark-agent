/**
 * WorkflowGraph 运行时校验 schema（M1 第 0 步）
 *
 * 职责边界（三层校验并存、互不替代）：
 * - 本文件（IPC 保存闸门）：只管「形状」——kind 枚举、config 字段白名单（strict，
 *   拒未知键/类型错/超界）、边条件结构、递归循环体。未知 kind 与拼错字段在落库前
 *   被明确拒绝，不再静默降级。
 * - assertWorkflowGraphValid（main/ipc）：拓扑层——规范化 + 环检测 + 条件引用检测。
 * - normalizeWorkflowGraph（workflow-executor）：运行时容错——旧数据兜底，静默降级。
 *
 * 设计取舍：
 * - config 不做 per-kind 字段排斥：编辑器切换节点类型时不清理旧字段（残留字段在
 *   存量数据中普遍存在），strict 排斥会误杀合法保存。kind↔字段组合的语义检查留给
 *   workflow_validate 以 lint 形式提示。
 * - 白名单 = UI 检查器实际写入字段的并集（含 WorkflowNodeConfig TS 类型未声明的
 *   value：input 静态值 / route 固定分支）。
 * - 特有字段一律 optional：官方模板的 route 不带 routeOptions、verify 不带
 *   verifyCommands，presence 强制会击穿存量模板。
 */
import { z } from 'zod'
import type { z as zod } from 'zod'

/** 与 protocol 的 WorkflowNodeKind 一致（ipc/index.ts L3421）。 */
export const WorkflowNodeKindSchema = z.enum([
  'input',
  'plan',
  'route',
  'agent',
  'subagent',
  'skill',
  'tool',
  'mcp',
  'approval',
  'verify',
  'review',
  'artifact',
  'loop',
])

/** 编排方向：仅 vertical 时持久化，horizontal 省略（ipc/index.ts L3516）。 */
export const WorkflowOrientationSchema = z.enum(['horizontal', 'vertical'])

/** 边条件 5 操作符（WorkflowEdgeCondition），按 op 可辨识联合。 */
export const WorkflowEdgeConditionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('exists'), key: z.string() }),
  z.object({
    op: z.literal('equals'),
    key: z.string(),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.object({
    op: z.literal('not_equals'),
    key: z.string(),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.object({ op: z.literal('truthy'), key: z.string() }),
  z.object({ op: z.literal('falsy'), key: z.string() }),
])

/** route 分支声明：value 为运行时唯一被接受的输出值。 */
export const WorkflowRouteOptionSchema = z.object({
  value: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
})

// ─── config 字段级规则（全部 optional；边界值取自运行时/编辑器既有约束） ───

/** loop 最大迭代：运行时硬上限 50（workflow-executor.ts WORKFLOW_LOOP_HARD_CAP）。 */
const MAX_LOOP_ITERATIONS = 50
/** 节点重试：UI 与运行时上限均为 3。 */
const MAX_RETRY_COUNT = 3
/** subagent 并发：UI 上限 8。 */
const MAX_PARALLELISM = 8
/** prompt 防爆炸宽松上限（约 5 万汉字），远高于任何合理提示词。 */
const MAX_PROMPT_LENGTH = 100_000
/** 规模防爆炸上限（宽松值，远超实际编排规模；对齐 canvas 图 500/2000 的思路）。 */
const MAX_NODES = 1_000
const MAX_EDGES = 5_000

/**
 * 节点 config：全部已知字段的并集白名单 + strict（未知键报错）。
 * 各字段类型与 WorkflowNodeConfig（ipc/index.ts L3442）对齐；value 为 UI 实际
 * 写入但 TS 类型未声明的隐藏字段（input 静态值 / route 固定分支）。
 */
const WorkflowNodeConfigSchemaBase = z
  .object({
    // ── 通用（Inspector 所有节点共享） ──
    prompt: z.string().max(MAX_PROMPT_LENGTH).optional(),
    role: z.string().optional(),
    modelId: z.string().nullable().optional(),
    providerProfileId: z.string().nullable().optional(),
    skillIds: z.array(z.string()).optional(),
    ruleIds: z.array(z.string()).optional(),
    outputKey: z.string().optional(),
    retryCount: z.number().int().min(0).max(MAX_RETRY_COUNT).optional(),
    // ── input / route：value（TS 类型未声明，UI 在用） ──
    value: z.string().optional(),
    // ── 执行模式（input/plan/skill/review/artifact；route 固定分支隐式管理） ──
    execution: z.enum(['auto', 'static']).optional(),
    // ── agent / subagent ──
    agentId: z.string().nullable().optional(),
    parallelism: z.number().int().min(1).max(MAX_PARALLELISM).optional(),
    toolIds: z.array(z.string()).optional(),
    // ── tool / mcp 确定性调用 ──
    toolSource: z.enum(['mcp', 'builtin', 'platform']).nullable().optional(),
    toolServerId: z.string().nullable().optional(),
    toolName: z.string().nullable().optional(),
    toolArgs: z.record(z.string(), z.unknown()).optional(),
    mcpServerIds: z.array(z.string()).optional(),
    // ── verify ──
    verifyCommands: z.array(z.string()).optional(),
    // ── artifact ──
    exportPath: z.string().optional(),
    // ── loop ──
    body: z.lazy(() => WorkflowGraphSchema).optional(),
    maxIterations: z.number().int().min(1).max(MAX_LOOP_ITERATIONS).optional(),
    loopVar: z.string().optional(),
    resultKey: z.string().optional(),
    collectAll: z.boolean().optional(),
    breakCondition: WorkflowEdgeConditionSchema.optional(),
    // ── route ──
    routeOptions: z.array(WorkflowRouteOptionSchema).optional(),
  })
  .strict()

/** 递归引用 loop.body：用 z.lazy 打破类型循环（v1 嵌套 loop 由编辑器限制，schema 不禁）。 */
export const WorkflowGraphSchema: zod.ZodType<WorkflowGraphShape> = z.lazy(() =>
  z.object({
    nodes: z
      .array(
        z.object({
          id: z.string().min(1),
          kind: WorkflowNodeKindSchema,
          title: z.string().max(500),
          x: z.number().finite(),
          y: z.number().finite(),
          config: WorkflowNodeConfigSchemaBase,
        }),
      )
      .max(MAX_NODES),
    edges: z
      .array(
        z.object({
          id: z.string().min(1),
          from: z.string().min(1),
          to: z.string().min(1),
          condition: WorkflowEdgeConditionSchema.optional(),
        }),
      )
      .max(MAX_EDGES),
    orientation: WorkflowOrientationSchema.optional(),
  }),
)

/** schema 的静态形状（与 ipc/index.ts 的 WorkflowGraph 等价，避免跨模块类型循环导入）。 */
type WorkflowGraphShape = {
  nodes: Array<{
    id: string
    kind: z.infer<typeof WorkflowNodeKindSchema>
    title: string
    x: number
    y: number
    config: Record<string, unknown>
  }>
  edges: Array<{
    id: string
    from: string
    to: string
    condition?: z.infer<typeof WorkflowEdgeConditionSchema> | undefined
  }>
  orientation?: z.infer<typeof WorkflowOrientationSchema> | undefined
}

/**
 * 把 zod issues 格式化为可读诊断文本（取前 5 条）。
 * 供 IPC handler 抛错与 workflow_validate 的 diagnostics 回喂共用。
 */
export function formatWorkflowGraphIssues(issues: zod.core.$ZodIssue[]): string {
  const MAX_REPORTED = 5
  return issues
    .slice(0, MAX_REPORTED)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('；')
}
