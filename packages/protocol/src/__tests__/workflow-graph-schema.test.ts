import { describe, expect, it } from 'vitest'
import {
  WorkflowGraphSchema,
  WorkflowNodeKindSchema,
  formatWorkflowGraphIssues,
} from '../workflow-graph-schema.js'

type GraphInput = Parameters<typeof WorkflowGraphSchema.parse>[0]

/** 最小合法节点工厂。 */
const node = (kind: string, config: Record<string, unknown> = {}) => ({
  id: `n-${kind}`,
  kind,
  title: kind,
  x: 0,
  y: 0,
  config,
})

const baseGraph = (nodes: unknown[], edges: unknown[] = []) => ({ nodes, edges })

/** 线性图：形状对照 workflow-templates.ts 官方模板（input → agent → artifact）。 */
const linearGraph = {
  nodes: [
    node('input', { prompt: '读取需求。', outputKey: 'requirement', retryCount: 1 }),
    node('agent', { prompt: '按需求实现。', outputKey: 'impl', skillIds: ['skill-a'] }),
    node('artifact', { prompt: '整理交付。', outputKey: 'deliverable', exportPath: 'out/a.md' }),
  ],
  edges: [
    { id: 'e1', from: 'n-input', to: 'n-agent' },
    { id: 'e2', from: 'n-agent', to: 'n-artifact' },
  ],
}

/** loop 图：形状对照 workflow-templates.ts「迭代润色」模板（含递归 body 与退出条件）。 */
const loopGraph = {
  nodes: [
    node('input', { prompt: '给出一稿初稿目标。', outputKey: 'goal' }),
    node('loop', {
      prompt: '重复执行循环体，直到评审通过。',
      outputKey: 'final_draft',
      maxIterations: 5,
      loopVar: '__loop_index',
      resultKey: 'draft',
      collectAll: false,
      breakCondition: { op: 'equals', key: 'verdict', value: 'pass' },
      body: {
        nodes: [
          node('review', { prompt: '生成改进稿。', outputKey: 'draft' }),
          node('review', { prompt: "只输出 'pass' 或 'retry'。", outputKey: 'verdict' }),
        ],
        edges: [{ id: 'e-b1', from: 'n-review', to: 'n-review-2' }],
      },
    }),
    node('artifact', { prompt: '交付最终稿。', outputKey: 'deliverable' }),
  ],
  edges: [
    { id: 'e1', from: 'n-input', to: 'n-loop' },
    { id: 'e2', from: 'n-loop', to: 'n-artifact' },
  ],
}

const parse = (value: GraphInput) => WorkflowGraphSchema.safeParse(value)

/** 断言失败并把首条 issue 的 path/message 关键词对上（保证报错可定位）。 */
const expectIssue = (value: GraphInput, opts: { path?: string; message?: string } = {}): void => {
  const result = parse(value)
  expect(result.success).toBe(false)
  if (result.success) return
  const first = result.error.issues[0]
  if (first == null) throw new Error('校验失败但未返回 issue')
  if (opts.path != null) {
    expect(first.path.join('.')).toContain(opts.path)
  }
  if (opts.message != null) {
    expect(first.message).toContain(opts.message)
  }
}

describe('WorkflowGraphSchema', () => {
  it('accepts all 13 node kinds with minimal configs', () => {
    const kinds = WorkflowNodeKindSchema.options
    expect(kinds).toHaveLength(13)
    const result = parse(baseGraph(kinds.map((kind) => node(kind))))
    expect(result.success).toBe(true)
  })

  it('accepts a linear template-shaped graph', () => {
    expect(parse(linearGraph).success).toBe(true)
  })

  it('accepts a loop template-shaped graph with recursive body', () => {
    expect(parse(loopGraph).success).toBe(true)
  })

  it('accepts the UI-only value field on input and route nodes', () => {
    // value 未在 WorkflowNodeConfig TS 类型中声明，但编辑器实际写入
    // （input 静态值 / route 固定分支）——白名单必须收录，否则存量全被误杀。
    const result = parse(
      baseGraph([
        node('input', { value: '固定输入', execution: 'static' }),
        node('route', {
          routeOptions: [{ value: 'deep', label: '深度' }],
          value: 'deep',
          execution: 'static',
        }),
      ]),
    )
    expect(result.success).toBe(true)
  })

  it('accepts vertical orientation', () => {
    expect(parse({ ...baseGraph([]), orientation: 'vertical' }).success).toBe(true)
  })

  it('rejects unknown node kind', () => {
    expectIssue(baseGraph([node('transformer')]), { path: 'kind' })
  })

  it('rejects misspelled config keys (strict whitelist)', () => {
    // P0 核心拦截：LLM 把 maxIterations 拼成 maxIteration 时明确报错，不再静默丢弃。
    // 注：zod v4 未知键的 path 停在 config 层，键名在 message 里。
    expectIssue(baseGraph([node('loop', { maxIteration: 5 })]), {
      path: 'config',
      message: 'maxIteration',
    })
  })

  it('rejects wrong config value types', () => {
    expectIssue(baseGraph([node('loop', { maxIterations: '5' })]), {
      path: 'config.maxIterations',
    })
  })

  it('rejects retryCount above the runtime cap of 3', () => {
    expectIssue(baseGraph([node('agent', { retryCount: 4 })]), { path: 'config.retryCount' })
  })

  it('rejects maxIterations above the hard cap of 50', () => {
    expectIssue(baseGraph([node('loop', { maxIterations: 51 })]), {
      path: 'config.maxIterations',
    })
  })

  it('rejects invalid break conditions', () => {
    expectIssue(baseGraph([node('loop', { breakCondition: { op: 'gt', key: 'v' } })]), {
      path: 'config.breakCondition',
    })
    expectIssue(baseGraph([node('loop', { breakCondition: { op: 'equals', key: 'verdict' } })]), {
      path: 'config.breakCondition',
    })
  })

  it('rejects route options without a value', () => {
    expectIssue(baseGraph([node('route', { routeOptions: [{ label: '深度' }] })]), {
      path: 'config.routeOptions',
    })
  })

  it('rejects invalid nodes nested inside loop body with a body-aware path', () => {
    const bad = {
      nodes: [
        node('loop', {
          body: baseGraph([node('input', { retryCount: 99 })]),
        }),
      ],
      edges: [],
    }
    expectIssue(bad, { path: 'nodes.0.config.body' })
  })

  it('accepts dangling edges — topology is owned by assertWorkflowGraphValid, not schema', () => {
    // 分层固化：schema 只管形状；from/to 引用存在性由 main 进程拓扑层负责。
    const result = parse(
      baseGraph([node('input')], [{ id: 'e1', from: 'n-input', to: 'ghost-node' }]),
    )
    expect(result.success).toBe(true)
  })

  it('rejects empty node ids', () => {
    expectIssue(baseGraph([{ ...node('input'), id: '' }]), { path: 'id' })
  })

  it('formats issues as readable path: message text', () => {
    const result = parse(baseGraph([node('loop', { maxIteration: 5 })]))
    expect(result.success).toBe(false)
    if (result.success) return
    const text = formatWorkflowGraphIssues(result.error.issues)
    expect(text).toContain('nodes.0.config')
    expect(text).toContain('maxIteration')
    expect(text).toContain(':')
  })
})
