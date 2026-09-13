import type { HookEventNameV1 } from '@spark/protocol'
import {
  AgentRepository,
  HookBindingRepository,
  HookDefinitionRepository,
  SettingsRepository,
  type SparkDatabase,
} from '@spark/storage'
import { createLogger } from '@spark/shared'
import { computeExecutionHash } from './hook-expression.js'

const log = createLogger('hooks:legacy-migration')

/**
 * 旧通知配置迁移（设计方案 §16）：把 legacy sound/notification 节点转换为
 * Hooks V2 内置定义与 application 绑定，并在同一数据库事务中切换执行所有权。
 *
 * - 幂等：定义使用确定性 ID；所有权标记已是 v2 时整体跳过。
 * - 失败保持 legacy：任一步骤抛错即回滚（事务），旧通知路径不受影响。
 * - permission_request 节点不迁移：plan 审批仍依赖 legacy 触发路径，且 V2 侧
 *   permission.requested 事件已由运行时发射——若迁移会双发通知。
 * - 迁移后 hook:trigger 对 session_end / session_fail / ask_user_question 短路，
 *   由 V2 定义接管；permission_request 继续走 legacy（无双发）。
 */

const OWNERSHIP_CATEGORY = 'hooks-v2'
const OWNERSHIP_KEY = 'ownership'

type LegacyHookNode = 'permission_request' | 'ask_user_question' | 'session_end' | 'session_fail'

interface LegacyHookNodeConfig {
  sound: boolean
  notification: boolean
}

interface LegacyHookConfig {
  enabled: boolean
  nodes: Partial<Record<LegacyHookNode, Partial<LegacyHookNodeConfig>>>
}

/** Agent hook_config_json 解析：与 V1 parseHookConfig 同语义（enabled 默认 false）。 */
function parseAgentHookConfig(value: unknown): LegacyHookConfig | null {
  if (value == null || typeof value !== 'object') return null
  const config = value as Partial<LegacyHookConfig>
  if (config.enabled !== true) return null
  return {
    enabled: true,
    nodes: (config.nodes ?? {}) as LegacyHookConfig['nodes'],
  }
}

/** 迁移映射：V1 节点 → V2 事件（session_fail 拆分为 failed + cancelled）。 */
interface MigrationTarget {
  idSuffix: string
  eventName: HookEventNameV1
  name: string
  /** const 正文（无动态 message 的事件）。 */
  bodyConst?: string
  /** 模板正文（turn.failed/cancelled 携带终态 message）。 */
  bodyTemplate?: string
}

const NODE_MIGRATIONS: Record<
  'ask_user_question' | 'session_end' | 'session_fail',
  MigrationTarget[]
> = {
  ask_user_question: [
    {
      idSuffix: 'ask-user-question',
      eventName: 'question.requested',
      name: '内置迁移 · Agent 提问',
      bodyConst: 'Agent 需要您提供更多信息',
    },
  ],
  session_end: [
    {
      idSuffix: 'session-end',
      eventName: 'turn.completed',
      name: '内置迁移 · 任务完成',
      bodyConst: '当前任务已完成',
    },
  ],
  session_fail: [
    {
      idSuffix: 'session-fail',
      eventName: 'turn.failed',
      name: '内置迁移 · 任务失败',
      bodyTemplate: '${payload.message}',
    },
    {
      idSuffix: 'session-cancel',
      eventName: 'turn.cancelled',
      name: '内置迁移 · 任务取消',
      bodyTemplate: '${payload.message}',
    },
  ],
}

export type HookOwnership = 'legacy' | 'v2'

export interface LegacyMigrationResult {
  ownership: HookOwnership
  /** 本次新建的定义 ID（已存在的确定性 ID 不重复计入）。 */
  createdDefinitionIds: string[]
  skipped: boolean
}

export class HookLegacyMigrationService {
  private readonly settings: SettingsRepository
  private readonly definitions: HookDefinitionRepository
  private readonly bindings: HookBindingRepository
  private readonly agents: AgentRepository

  constructor(private readonly db: SparkDatabase) {
    this.settings = new SettingsRepository(db)
    this.definitions = new HookDefinitionRepository(db)
    this.bindings = new HookBindingRepository(db)
    this.agents = new AgentRepository(db)
  }

  getOwnership(): HookOwnership {
    const value = this.settings.get(OWNERSHIP_CATEGORY, OWNERSHIP_KEY)
    return value === 'v2' ? 'v2' : 'legacy'
  }

  private readLegacyConfig(): LegacyHookConfig | null {
    // 迁移期双读：主进程事实源 hooks/config，回退 renderer 历史写入的 hooks/data。
    const raw = this.settings.get('hooks', 'config') ?? this.settings.get('hooks', 'data')
    if (raw == null || typeof raw !== 'object') return null
    const config = raw as Partial<LegacyHookConfig>
    return {
      enabled: config.enabled ?? true,
      nodes: (config.nodes ?? {}) as LegacyHookConfig['nodes'],
    }
  }

  /**
   * 执行迁移。返回 skipped=true 表示无需迁移（已 v2 / 旧配置未启用）。
   * 任一步骤失败抛错并整体回滚，保持 legacy 所有权。
   */
  migrate(): LegacyMigrationResult {
    if (this.getOwnership() === 'v2') {
      return { ownership: 'v2', createdDefinitionIds: [], skipped: true }
    }
    const legacy = this.readLegacyConfig()
    if (legacy == null || legacy.enabled !== true) {
      return { ownership: 'legacy', createdDefinitionIds: [], skipped: true }
    }

    const created: string[] = []
    const work = (): void => {
      for (const node of Object.keys(NODE_MIGRATIONS) as Array<keyof typeof NODE_MIGRATIONS>) {
        const nodeConfig = legacy.nodes[node]
        const wantSound = nodeConfig?.sound === true
        const wantNotification = nodeConfig?.notification === true
        if (!wantSound && !wantNotification) continue
        for (const target of NODE_MIGRATIONS[node]) {
          if (wantSound) this.ensureDefinition(target, 'sound', created)
          if (wantNotification) this.ensureDefinition(target, 'notification', created)
        }
      }
      this.migrateAgentOverrides()
      // 切换执行所有权：此后 legacy 触发路径对已迁移节点短路，避免双发。
      this.settings.set(OWNERSHIP_CATEGORY, OWNERSHIP_KEY, 'v2')
    }
    this.db.raw.transaction(work)()

    if (created.length > 0) {
      log.info(`legacy hooks migrated to v2: ${created.join(', ')}`)
    }
    return { ownership: 'v2', createdDefinitionIds: created, skipped: false }
  }

  /**
   * Agent 级旧配置（hook_config_json 整体替代应用配置）→ agent 作用域绑定。
   * V2 解析中 agent 绑定优先于 application：配置过 hook 的 Agent 保持其覆盖语义，
   * 未配置的 Agent 继续命中应用级绑定。迁移定义的哈希在建档时不会变化，
   * 直接按当前定义哈希授权/停用。
   */
  private migrateAgentOverrides(): void {
    const agentList = this.agents.list({ includeDisabled: true })
    for (const agent of agentList) {
      const config = parseAgentHookConfig(agent.hookConfig)
      if (config == null || config.enabled !== true) continue
      for (const node of Object.keys(NODE_MIGRATIONS) as Array<keyof typeof NODE_MIGRATIONS>) {
        const nodeConfig = config.nodes[node]
        for (const target of NODE_MIGRATIONS[node]) {
          const kinds: Array<'sound' | 'notification'> = ['sound', 'notification']
          for (const kind of kinds) {
            const definitionId = `builtin-legacy-${target.idSuffix}-${kind}`
            const definition = this.definitions.get(definitionId)
            if (definition == null) continue
            const enabled =
              kind === 'sound' ? nodeConfig?.sound === true : nodeConfig?.notification === true
            this.bindings.upsert({
              hookId: definitionId,
              scopeKind: 'agent',
              scopeId: agent.id,
              enabled,
              state: enabled ? 'active' : 'disabled',
              trustedExecutionHash: enabled ? definition.executionHash : null,
              authorizedEffect: enabled ? `builtin.${kind}` : null,
              authorizedAt: enabled ? new Date().toISOString() : null,
            })
          }
        }
      }
    }
  }

  private ensureDefinition(
    target: MigrationTarget,
    kind: 'sound' | 'notification',
    created: string[],
  ): void {
    const id = `builtin-legacy-${target.idSuffix}-${kind}`
    if (this.definitions.get(id) != null) return
    const input =
      kind === 'sound'
        ? { eventName: target.eventName, action: { type: 'builtin.sound' as const } }
        : {
            eventName: target.eventName,
            action: {
              type: 'builtin.notification' as const,
              ...(target.bodyConst != null
                ? { body: { const: target.bodyConst } }
                : target.bodyTemplate != null
                  ? { body: { template: target.bodyTemplate } }
                  : {}),
            },
          }
    const executionHash = computeExecutionHash({
      eventName: input.eventName,
      action: input.action,
      inputMapping: {},
      timeoutMs: 15_000,
      retryPolicy: { mode: 'unsafe', maxAttempts: 3, backoffMs: 1000 },
      concurrencyPolicy: 'serial_per_session',
    })
    this.definitions.create({
      id,
      name: kind === 'sound' ? `${target.name} · 提示音` : `${target.name} · 系统通知`,
      enabled: true,
      eventName: target.eventName,
      action: input.action,
      inputMapping: {},
      timeoutMs: 15_000,
      retryPolicy: { mode: 'unsafe', maxAttempts: 3, backoffMs: 1000 },
      concurrencyPolicy: 'serial_per_session',
      revision: 1,
      executionHash,
    })
    this.bindings.upsert({
      hookId: id,
      scopeKind: 'application',
      scopeId: '',
      enabled: true,
      state: 'active',
      trustedExecutionHash: executionHash,
      authorizedEffect: `builtin.${kind}`,
      authorizedAt: new Date().toISOString(),
    })
    created.push(id)
  }
}
