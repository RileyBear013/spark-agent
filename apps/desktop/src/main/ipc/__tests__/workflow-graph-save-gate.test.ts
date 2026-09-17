/**
 * 工作流保存闸门集成回归（workflow:create / workflow:update 共用闸门）。
 *
 * review 要求的集成测试：不只测 schema 单元行为，而是用真实数据回放完整闸门——
 * ① UI 官方模板（WORKFLOW_TEMPLATES，「新建工作流」实际经 workflow:create 落库的
 *    数据）必须通过形状+拓扑双闸门；
 * ② skill 产物 JSON 回放：该目录在 PR #187 分支（feat/builtin-spark-workflow-
 *    generator），两 PR 合入 master 后本用例自动激活全量回放；
 * ③ 混合 UI 字段 / 运行时覆盖字段 / 多层嵌套 loop 的存量形态必须通过（防误杀）；
 * ④ 未知字段与循环依赖必须被拒（防松动）；
 * ⑤ handler 接线静态断言（与 ipc-handlers.test.ts 同款源码扫描思路）：
 *    两个保存 handler 必须真实调用两个闸门。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKFLOW_TEMPLATES } from '../../../renderer/design/views/workflow/workflow-templates.js'
import { assertWorkflowGraphSchema, assertWorkflowGraphValid } from '../workflow-graph-gate.js'

const SKILL_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'resources',
  'skills',
  'spark-workflow-generator',
)
const MAIN_IPC_INDEX = join(__dirname, '..', 'index.ts')

type Json = Record<string, unknown>

/** 从 skill 产物 JSON 提取全部 graph（支持模板外壳 / 裸 graph / UI 导入包裹三种形态）。 */
const extractGraphs = (raw: string): Json[] => {
  const data = JSON.parse(raw) as Json
  if (Array.isArray(data.workflows)) {
    return (data.workflows as Json[]).map((entry) => entry.graph as Json)
  }
  if (data.graph != null) return [data.graph as Json]
  return [data]
}

const listJsonFiles = (dir: string): string[] =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(dir, name))

const expectBothGatesPass = (graph: unknown, label: string): void => {
  expect(() => assertWorkflowGraphSchema(graph), label).not.toThrow()
  expect(() => assertWorkflowGraphValid(graph), label).not.toThrow()
}

describe('workflow save gate — integration replay', () => {
  it('every official UI template passes both gates (real workflow:create traffic)', () => {
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThan(0)
    for (const template of WORKFLOW_TEMPLATES) {
      expectBothGatesPass(template.graph, `template ${template.id}`)
    }
  })

  describe.skipIf(!existsSync(SKILL_DIR))('official skill artifact replay', () => {
    // skill 产物随 PR #187 合入后出现在本分支；届时 templates/ 与 demos/ 的每个
    // graph（含 UI 导入包裹格式）都要通过保存闸门。
    it('every skill template passes both gates', () => {
      for (const file of listJsonFiles(join(SKILL_DIR, 'templates'))) {
        for (const graph of extractGraphs(readFileSync(file, 'utf8'))) {
          expectBothGatesPass(graph, file)
        }
      }
    })

    it('every skill demo passes both gates, including the wrapped import format', () => {
      for (const file of listJsonFiles(join(SKILL_DIR, 'demos'))) {
        for (const graph of extractGraphs(readFileSync(file, 'utf8'))) {
          expectBothGatesPass(graph, file)
        }
      }
    })
  })

  it('legacy graph mixing UI fields, runtime overrides and nested loops passes both gates', () => {
    // 存量兼容：真实保存数据混合 UI 写入字段（value/prompt/outputKey）、运行时覆盖
    // 字段（agentAdapter/reasoningEffort/disabledSkillIds）与多层嵌套 loop。
    // 内层 loop 以 outputKey: 'verdict' 声明外层 breakCondition 引用的状态键。
    const legacy: Json = {
      orientation: 'vertical',
      nodes: [
        {
          id: 'n-input',
          kind: 'input',
          title: '读取需求',
          x: 0,
          y: 0,
          config: {
            prompt: '读取需求',
            value: '固定输入',
            objective: '结构化拆解目标',
            constraint: ['约束 A'],
            outputKey: 'requirement',
          },
        },
        {
          id: 'n-agent',
          kind: 'agent',
          title: '实现',
          x: 0,
          y: 0,
          config: {
            prompt: '实现',
            agentAdapter: 'codex',
            reasoningEffort: 'medium',
            disabledSkillIds: [],
            outputKey: 'impl',
          },
        },
        {
          id: 'n-loop',
          kind: 'loop',
          title: '迭代',
          x: 0,
          y: 0,
          config: {
            maxIterations: 3,
            breakCondition: { op: 'equals', key: 'verdict', value: 'pass' },
            body: {
              nodes: [
                {
                  id: 'n-inner-loop',
                  kind: 'loop',
                  title: '内层迭代',
                  x: 0,
                  y: 0,
                  config: {
                    outputKey: 'verdict',
                    maxIterations: 2,
                    body: {
                      nodes: [
                        {
                          id: 'n-review',
                          kind: 'review',
                          title: '内层复核',
                          x: 0,
                          y: 0,
                          config: { prompt: '复核', outputKey: 'inner' },
                        },
                      ],
                      edges: [],
                    },
                  },
                },
              ],
              edges: [],
            },
          },
        },
      ],
      edges: [
        { id: 'e1', from: 'n-input', to: 'n-agent' },
        { id: 'e2', from: 'n-agent', to: 'n-loop' },
      ],
    }
    expectBothGatesPass(legacy, 'legacy graph')
  })

  it('rejects unknown config fields with a readable error (guard against loosening)', () => {
    const bad: Json = {
      nodes: [{ id: 'n1', kind: 'loop', title: 'x', x: 0, y: 0, config: { maxIteration: 5 } }],
      edges: [],
    }
    expect(() => assertWorkflowGraphSchema(bad)).toThrow(/工作流图校验失败/)
    expect(() => assertWorkflowGraphSchema(bad)).toThrow(/maxIteration/)
  })

  it('rejects cyclic graphs before persistence (topology gate)', () => {
    const cyclic: Json = {
      nodes: [
        { id: 'a', kind: 'agent', title: '甲', x: 0, y: 0, config: {} },
        { id: 'b', kind: 'agent', title: '乙', x: 0, y: 0, config: {} },
      ],
      edges: [
        { id: 'e1', from: 'a', to: 'b' },
        { id: 'e2', from: 'b', to: 'a' },
      ],
    }
    expect(() => assertWorkflowGraphValid(cyclic)).toThrow(/循环依赖/)
  })

  it('workflow:create / workflow:update handlers are wired to both gates', () => {
    const src = readFileSync(MAIN_IPC_INDEX, 'utf8')
    for (const channel of ['workflow:create', 'workflow:update']) {
      const start = src.indexOf(`typedIpcHandle('${channel}'`)
      expect(start, `handler for ${channel} not found`).toBeGreaterThan(-1)
      const body = src.slice(start, start + 600)
      expect(body, channel).toContain('assertWorkflowGraphSchema(graph)')
      expect(body, channel).toContain('assertWorkflowGraphValid(graph)')
    }
  })
})
