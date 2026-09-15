/**
 * 工作流包导出 — 收集工作流及其技能/MCP 依赖,密钥脱敏,打包为 .sparkflow
 */

import { writeFile } from 'fs/promises'
import { basename } from 'path'
import {
  WORKFLOW_BUNDLE_SCHEMA_VERSION,
  WorkflowBundleManifestSchema,
  type WorkflowBundleManifest,
  type WorkflowBundleSkillEntry,
  type WorkflowBundleMcpEntry,
  type WorkflowBundleAgentEntry,
  type WorkflowBundleAgentFile,
  type WorkflowBundleUnresolvedDependency,
  type WorkflowBundleVerificationCheck,
  type WorkflowBundleVerificationStatus,
} from '@spark/protocol'
import type { WorkflowGraph } from '@spark/protocol'
import type {
  AgentItem,
  AgentRepository,
  McpServerRepository,
  SkillRepository,
  WorkflowRepository,
} from '@spark/storage'
import { collectGraphDependencies } from './graph-deps.js'
import { redactMcpConfig } from './secret-redact.js'
import {
  collectDirectory,
  directoryEntriesToZip,
  hashDirectoryEntries,
  sha256Hex,
  zipEntries,
} from './bundle-fs.js'

export interface ExportBundleParams {
  workflowIds: string[]
  outputPath: string
  name?: string
}

export interface ExportBundleResult {
  outputPath: string
  manifest: WorkflowBundleManifest
  sizeBytes: number
}

/** 包内目录名安全化:仅字母数字 . _ -,其余替换为 -,截断防超长。 */
export function slugify(input: string, fallback = 'item'): string {
  const slug = input
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-]+$/g, '')
    .slice(0, 60)
  return slug.length > 0 ? slug : fallback
}

/** 分配不重复的 slug:命中已有集合时追加 -2/-3… */
function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base)
    return base
  }
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}

export class WorkflowBundleExporter {
  constructor(
    private readonly workflowRepo: WorkflowRepository,
    private readonly skillRepo: SkillRepository,
    private readonly mcpRepo: McpServerRepository,
    private readonly agentRepo: AgentRepository,
  ) {}

  async exportBundle(params: ExportBundleParams): Promise<ExportBundleResult> {
    const allUserWorkflows = this.workflowRepo
      .list({ includeArchived: true })
      .filter((w) => w.bundleId == null)
    const targets =
      params.workflowIds.length > 0
        ? params.workflowIds.map((id) => {
            const item = this.workflowRepo.get(id)
            if (item == null) throw new Error(`工作流不存在: ${id}`)
            if (item.bundleId != null) {
              throw new Error(`工作流「${item.name}」来自工作流包,不能再次打包导出`)
            }
            return item
          })
        : allUserWorkflows
    if (targets.length === 0) throw new Error('没有可导出的工作流')

    const checks: WorkflowBundleVerificationCheck[] = []
    const unresolved: WorkflowBundleUnresolvedDependency[] = []
    const skillEntries: WorkflowBundleSkillEntry[] = []
    const mcpEntries: WorkflowBundleMcpEntry[] = []
    const agentEntries: WorkflowBundleAgentEntry[] = []
    const zip: Record<string, Uint8Array> = {}
    const takenSkillSlugs = new Set<string>()
    const takenMcpRefIds = new Set<string>()

    // —— 逐工作流:图解析 + 依赖收集 + 写入容器 ——
    const aggregatedSkillIds = new Set<string>()
    const aggregatedMcpIds = new Set<string>()
    const aggregatedAgentIds = new Set<string>()
    const aggregatedRuleIds = new Set<string>()
    const aggregatedToolIds = new Set<string>()
    const aggregatedModelRefs: Array<{
      providerProfileId: string | null
      modelId: string | null
    }> = []
    targets.forEach((workflow, index) => {
      const graph = workflow.graph as unknown as WorkflowGraph
      if (graph == null || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        throw new Error(`工作流「${workflow.name}」的流程图结构无效,无法导出`)
      }
      const deps = collectGraphDependencies(graph)
      for (const id of deps.skillIds) aggregatedSkillIds.add(id)
      for (const id of deps.mcpServerIds) aggregatedMcpIds.add(id)
      for (const id of deps.agentIds) aggregatedAgentIds.add(id)
      for (const id of deps.ruleIds) aggregatedRuleIds.add(id)
      for (const id of deps.toolIds) aggregatedToolIds.add(id)
      for (const ref of deps.modelRefs) aggregatedModelRefs.push(ref)

      const file = `workflows/${index}.json`
      zip[file] = new TextEncoder().encode(
        JSON.stringify(
          {
            name: workflow.name,
            description: workflow.description,
            status: workflow.status,
            tags: workflow.tags,
            graph,
          },
          null,
          2,
        ),
      )
      checks.push({ id: `graph:${workflow.id}`, ok: true, level: 'info', message: workflow.name })
    })

    // —— Agent 级联(v2 起随包携带):先收集 Agent 自身的技能/MCP 依赖,再统一打包 ——
    const agentRows = new Map<string, AgentItem>()
    for (const agentId of aggregatedAgentIds) {
      const row = this.agentRepo.get(agentId)
      if (row == null) {
        unresolved.push({
          type: 'agent',
          name: agentId,
          hint: 'Agent 在当前环境未找到,导入后需手动创建或重新绑定',
        })
        continue
      }
      for (const id of row.skillIds) aggregatedSkillIds.add(id)
      for (const id of row.disabledSkillIds) aggregatedSkillIds.add(id)
      for (const id of row.mcpServerIds) aggregatedMcpIds.add(id)
      agentRows.set(agentId, row)
      if (row.modelId != null || row.providerProfileId != null) {
        aggregatedModelRefs.push({
          providerProfileId: row.providerProfileId ?? null,
          modelId: row.modelId ?? null,
        })
      }
    }

    // —— 技能打包:builtin 不打包(目标环境必有);其余按 root_path 目录打包 ——
    for (const skillId of aggregatedSkillIds) {
      if (skillId.startsWith('builtin:')) continue
      const row = this.skillRepo.get(skillId)
      if (row == null) {
        unresolved.push({
          type: 'skill',
          name: skillId,
          hint: '技能在当前环境未找到,导入后需手动补齐',
        })
        continue
      }
      if (row.root_path.startsWith('builtin://')) continue
      try {
        const entries = await collectDirectory(row.root_path)
        // 随包携带 DB manifest_json(SkillLoader 定义来源),导入时原样落库
        const skillManifestJson = row.manifest_json || '{}'
        const skillManifest = JSON.parse(skillManifestJson) as unknown
        if (
          skillManifest == null ||
          typeof skillManifest !== 'object' ||
          Array.isArray(skillManifest)
        ) {
          throw new Error('技能 manifest 必须是 JSON 对象')
        }
        entries.set('.spark-skill-manifest.json', new TextEncoder().encode(skillManifestJson))
        const slug = uniqueSlug(
          slugify(row.name || basename(row.root_path), 'skill'),
          takenSkillSlugs,
        )
        const dirHash = hashDirectoryEntries(entries)
        Object.assign(zip, directoryEntriesToZip(entries, `skills/${slug}`))
        skillEntries.push({
          slug,
          path: `skills/${slug}`,
          sha256: dirHash,
          originSkillId: skillId,
        })
      } catch (err) {
        unresolved.push({
          type: 'skill',
          name: skillId,
          hint: `技能目录打包失败(${err instanceof Error ? err.message : String(err)}),导入后需手动处理`,
        })
        checks.push({
          id: `skill:${skillId}`,
          ok: false,
          level: 'warn',
          message: '技能目录打包失败',
        })
      }
    }

    // —— MCP:查行 + 脱敏 + 写配置文件 ——
    for (const serverId of aggregatedMcpIds) {
      const row = this.mcpRepo.get(serverId)
      if (row == null) {
        unresolved.push({
          type: 'mcp',
          name: serverId,
          hint: 'MCP 配置在当前环境未找到,导入后需手动添加',
        })
        continue
      }
      let parsedConfig: unknown
      try {
        parsedConfig = JSON.parse(row.config_json) as unknown
      } catch {
        unresolved.push({
          type: 'mcp',
          name: serverId,
          hint: 'MCP 配置不是有效 JSON,未随包导出',
        })
        checks.push({
          id: `mcp:${serverId}`,
          ok: false,
          level: 'warn',
          message: 'MCP 配置 JSON 无效',
        })
        continue
      }
      if (parsedConfig == null || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
        unresolved.push({
          type: 'mcp',
          name: serverId,
          hint: 'MCP 配置必须是 JSON 对象,未随包导出',
        })
        checks.push({
          id: `mcp:${serverId}`,
          ok: false,
          level: 'warn',
          message: 'MCP 配置结构无效',
        })
        continue
      }
      const { config, secrets } = redactMcpConfig(JSON.stringify(parsedConfig))
      const refId = uniqueSlug(slugify(row.name, 'mcp'), takenMcpRefIds)
      const file = `mcp/${refId}.json`
      const transport =
        typeof config.transport === 'string'
          ? config.transport
          : typeof (config as { type?: unknown }).type === 'string'
            ? (config as { type: string }).type
            : 'stdio'
      zip[file] = new TextEncoder().encode(JSON.stringify(config, null, 2))
      mcpEntries.push({
        refId,
        name: row.name,
        transport: transport === 'http' || transport === 'sse' ? transport : 'stdio',
        file,
        requiredSecrets: secrets,
        originServerId: serverId,
      })
    }

    // —— Agent 打包(v2):可移植字段写入 agents/<n>.json,导入端创建并改写引用 ——
    let agentIndex = 0
    for (const [agentId, row] of agentRows) {
      const agentFile: WorkflowBundleAgentFile = {
        name: row.name,
        description: row.description,
        prompt: row.prompt,
        agentAdapter: row.agentAdapter,
        permissionMode: row.permissionMode,
        reasoningEffort: row.reasoningEffort,
        ...(row.modelId != null ? { modelId: row.modelId } : {}),
        ...(row.providerProfileId != null ? { providerProfileId: row.providerProfileId } : {}),
        skillIds: [...row.skillIds],
        disabledSkillIds: [...row.disabledSkillIds],
        mcpServerIds: [...row.mcpServerIds],
        hookConfig: row.hookConfig,
        metadata: row.metadata,
      }
      const file = `agents/${agentIndex}.json`
      zip[file] = new TextEncoder().encode(JSON.stringify(agentFile, null, 2))
      agentEntries.push({ file, name: row.name, originAgentId: agentId })
      agentIndex += 1
    }

    // —— 跨环境不可移植项显式声明 ——
    const seenModelRefs = new Set<string>()
    for (const ref of aggregatedModelRefs) {
      const key = `${ref.providerProfileId ?? ''}|${ref.modelId ?? ''}`
      if (seenModelRefs.has(key)) continue
      seenModelRefs.add(key)
      unresolved.push({
        type: 'provider',
        name: ref.modelId ?? ref.providerProfileId ?? '模型绑定',
        hint: '节点/Agent 的模型绑定不随包迁移(供应商配置与密钥保留在本机),导入后请重新选择模型',
      })
    }
    for (const ruleId of aggregatedRuleIds) {
      unresolved.push({ type: 'rule', name: ruleId, hint: '规则不随包迁移,导入后需重新选择' })
    }
    for (const toolId of aggregatedToolIds) {
      unresolved.push({
        type: 'tool',
        name: toolId,
        hint: '自定义工具不随包迁移,内置工具不受影响,导入后请核对',
      })
    }

    // —— manifest + checksums ——
    const manifestInput = {
      schemaVersion: WORKFLOW_BUNDLE_SCHEMA_VERSION,
      name: params.name?.trim() || `workflows-${new Date().toISOString().slice(0, 10)}`,
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      workflows: targets.map((workflow, index) => ({
        file: `workflows/${index}.json`,
        name: workflow.name,
      })),
      skills: skillEntries,
      mcpServers: mcpEntries,
      agents: agentEntries,
      unresolved,
      verification: {
        status: resolveExportStatus(checks, unresolved),
        checks,
      },
    }
    const manifest = WorkflowBundleManifestSchema.parse(manifestInput)
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2))
    const checksumEntries: Record<string, Uint8Array> = { 'manifest.json': manifestBytes, ...zip }
    const checksums = {
      algorithm: 'sha256' as const,
      files: Object.fromEntries(
        Object.entries(checksumEntries).map(([p, content]) => [p, sha256Hex(content)]),
      ),
    }
    const finalZip: Record<string, Uint8Array> = {
      ...zip,
      'manifest.json': manifestBytes,
      'checksums.json': new TextEncoder().encode(JSON.stringify(checksums, null, 2)),
    }
    const bytes = zipEntries(finalZip)
    await writeFile(params.outputPath, bytes)
    return { outputPath: params.outputPath, manifest, sizeBytes: bytes.byteLength }
  }
}

function resolveExportStatus(
  checks: WorkflowBundleVerificationCheck[],
  unresolved: WorkflowBundleUnresolvedDependency[],
): WorkflowBundleVerificationStatus {
  if (checks.some((c) => !c.ok && c.level === 'error')) return 'failed'
  if (checks.some((c) => !c.ok) || unresolved.length > 0) return 'warned'
  return 'passed'
}
