import { describe, expect, it } from 'vitest'
import { assertWorkflowGraphValid } from './workflow-graph-guard.js'

function agent(id: string, outputKey?: string) {
  return {
    id,
    kind: 'agent',
    title: id,
    config: outputKey == null ? {} : { outputKey },
  }
}

describe('assertWorkflowGraphValid', () => {
  it('accepts a well-formed graph and tolerates a missing graph', () => {
    expect(() => assertWorkflowGraphValid(null)).not.toThrow()
    expect(() =>
      assertWorkflowGraphValid({
        nodes: [agent('a', 'brief'), agent('b')],
        edges: [{ id: 'e1', from: 'a', to: 'b' }],
      }),
    ).not.toThrow()
  })

  // 未知 kind 会被 normalizeWorkflowGraph 静默降级成 agent 节点，必须在这里拦下来，
  // 否则图里写着 output 也会入库，直到会话挂载预检才报 unsupported_node_kind。
  it('rejects node kinds the runtime does not declare', () => {
    expect(() =>
      assertWorkflowGraphValid({
        nodes: [
          { id: 'post-push-check', kind: 'verify', title: '推送后复核', config: {} },
          { id: 'release-output', kind: 'output', title: '发布结果', config: {} },
        ],
        edges: [{ id: 'e1', from: 'post-push-check', to: 'release-output' }],
      }),
    ).toThrow(/节点「发布结果」使用了不支持的节点类型「output」/)
  })

  it('rejects unknown kinds nested in a loop body', () => {
    expect(() =>
      assertWorkflowGraphValid({
        nodes: [
          {
            id: 'loop-1',
            kind: 'loop',
            title: '迭代润色',
            config: { body: { nodes: [{ id: 'inner', kind: 'output', title: '内层输出' }], edges: [] } },
          },
        ],
        edges: [],
      }),
    ).toThrow(/主图 › 迭代润色 循环体的节点「内层输出」使用了不支持的节点类型「output」/)
  })

  it('rejects cyclic graphs before they can deadlock at runtime', () => {
    expect(() =>
      assertWorkflowGraphValid({
        nodes: [agent('a', 'brief'), agent('b')],
        edges: [
          { id: 'e1', from: 'a', to: 'b' },
          { id: 'e2', from: 'b', to: 'a' },
        ],
      }),
    ).toThrow(/循环依赖/)
  })

  it('rejects conditions that reference undeclared state keys', () => {
    expect(() =>
      assertWorkflowGraphValid({
        nodes: [agent('a', 'brief'), agent('b')],
        edges: [{ id: 'e1', from: 'a', to: 'b', condition: { op: 'equals', key: 'verdict', value: 'pass' } }],
      }),
    ).toThrow(/verdict/)
  })
})
