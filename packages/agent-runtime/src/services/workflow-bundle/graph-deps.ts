/**
 * 工作流图依赖提取与引用改写(含 loop.body 递归)
 */

import type { WorkflowGraph, WorkflowNodeConfig } from '@spark/protocol'

export interface GraphDependencies {
  skillIds: string[]
  mcpServerIds: string[]
  agentIds: string[]
  ruleIds: string[]
  toolIds: string[]
  /** 节点模型绑定引用(providerProfileId+modelId 组合去重);跨环境不可移植,仅供打包端转提示 */
  modelRefs: Array<{ providerProfileId: string | null; modelId: string | null }>
}

function mergeInto(target: GraphDependencies, config: WorkflowNodeConfig): void {
  for (const id of config.skillIds ?? [])
    if (!target.skillIds.includes(id)) target.skillIds.push(id)
  for (const id of config.mcpServerIds ?? [])
    if (!target.mcpServerIds.includes(id)) target.mcpServerIds.push(id)
  for (const id of config.ruleIds ?? []) if (!target.ruleIds.includes(id)) target.ruleIds.push(id)
  for (const id of config.toolIds ?? []) if (!target.toolIds.includes(id)) target.toolIds.push(id)
  if (
    typeof config.agentId === 'string' &&
    config.agentId.length > 0 &&
    !target.agentIds.includes(config.agentId)
  ) {
    target.agentIds.push(config.agentId)
  }
  // 确定性 MCP 直调节点(toolSource='mcp')按 toolServerId 引用 MCP 服务器;
  // 不收集会导致该服务器既不随包也不进 unresolved,导入后 preflight 才报缺。
  if (
    config.toolSource === 'mcp' &&
    typeof config.toolServerId === 'string' &&
    config.toolServerId.length > 0 &&
    !target.mcpServerIds.includes(config.toolServerId)
  ) {
    target.mcpServerIds.push(config.toolServerId)
  }
  // 节点模型绑定是跨环境不可移植引用,收集后由打包端转 unresolved 提示。
  const modelId = typeof config.modelId === 'string' ? config.modelId : null
  const providerProfileId =
    typeof config.providerProfileId === 'string' ? config.providerProfileId : null
  if (modelId != null || providerProfileId != null) {
    const exists = target.modelRefs.some(
      (ref) => ref.modelId === modelId && ref.providerProfileId === providerProfileId,
    )
    if (!exists) target.modelRefs.push({ providerProfileId, modelId })
  }
}

function emptyDeps(): GraphDependencies {
  return {
    skillIds: [],
    mcpServerIds: [],
    agentIds: [],
    ruleIds: [],
    toolIds: [],
    modelRefs: [],
  }
}

/** 深度收集一张图(含 loop.body 嵌套体)的全部外部依赖引用。 */
export function collectGraphDependencies(graph: WorkflowGraph): GraphDependencies {
  const deps = emptyDeps()
  const walk = (g: WorkflowGraph) => {
    for (const node of g.nodes ?? []) {
      const config = (node.config ?? {}) as WorkflowNodeConfig
      mergeInto(deps, config)
      if (config.body != null) walk(config.body)
    }
  }
  walk(graph)
  return deps
}

function rewriteConfig(config: WorkflowNodeConfig, mapping: RewriteMapping): WorkflowNodeConfig {
  const next: WorkflowNodeConfig = { ...config }
  if (Array.isArray(config.skillIds)) {
    next.skillIds = config.skillIds.map((id) => mapping.skillIdMap.get(id) ?? id)
  }
  if (Array.isArray(config.mcpServerIds)) {
    next.mcpServerIds = config.mcpServerIds.map((id) => mapping.mcpServerIdMap.get(id) ?? id)
  }
  if (mapping.agentIdMap != null && typeof config.agentId === 'string' && config.agentId) {
    next.agentId = mapping.agentIdMap.get(config.agentId) ?? config.agentId
  }
  if (config.body != null) {
    next.body = rewriteGraphReferences(config.body, mapping)
  }
  return next
}

export interface RewriteMapping {
  /** 原技能 ID → 新技能 ID(bundle:<bundleId>:<slug>) */
  skillIdMap: Map<string, string>
  /** 原 MCP 服务器 ID → 新 mcp_servers 行 ID */
  mcpServerIdMap: Map<string, string>
  /** 原 Agent ID → 新 agents 行 ID（团队自包含包用；可选，缺省不改写） */
  agentIdMap?: Map<string, string>
}

/** 返回改写后的图(深拷贝变化部分;不动原对象)。 */
export function rewriteGraphReferences(
  graph: WorkflowGraph,
  mapping: RewriteMapping,
): WorkflowGraph {
  return {
    ...graph,
    nodes: (graph.nodes ?? []).map((node) => ({
      ...node,
      config: rewriteConfig((node.config ?? {}) as WorkflowNodeConfig, mapping),
    })),
    edges: graph.edges ?? [],
  }
}
