import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@spark/protocol'
import { SessionService } from '../../services/session.service.js'

type GoalStatus =
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cleared'
  | 'stopped_by_budget'
  | 'pending_contract'
type ProgressStatus = GoalStatus | 'continue' | 'blocked'
type GoalProgressEntry = {
  iteration: number
  phase: 'review' | 'act' | 'validate'
  status: ProgressStatus
  summary: string
  evidence?: string[]
  nextStep?: string
  validation?: Record<string, unknown>
  createdAt: string
}
type StoredGoal = {
  id: string
  sessionId: string
  objective: string
  successCriteria: string[]
  constraints: string[]
  validation: { commands?: string[]; checklist?: string[] }
  budget: {
    maxIterations?: number
    maxRuntimeMinutes?: number
    maxBudgetUsd?: number
    maxConsecutiveFailures?: number
    noProgressLimit?: number
  }
  progressLog: GoalProgressEntry[]
  status: GoalStatus
  mode: 'spark-loop' | 'codex-native'
  createdAt: string
  updatedAt: string
}

const state = vi.hoisted(() => ({
  goals: new Map<string, StoredGoal>(),
  usageBySession: new Map<string, { totalCostUsd: number; recordCount: number }>(),
  events: [] as AgentEvent[],
}))

vi.mock('@spark/shared/keystore', () => ({
  getSecret: vi.fn(async () => 'test-key'),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  makeKeystoreRef: (provider: string, id: string) => `${provider}-${id}`,
  maskSecret: (secret: string) => `${secret.slice(0, 4)}****`,
}))

vi.mock('@spark/storage', () => {
  const cloneGoal = (goal: StoredGoal): StoredGoal => ({
    ...goal,
    successCriteria: [...goal.successCriteria],
    constraints: [...goal.constraints],
    validation: { ...goal.validation },
    budget: { ...goal.budget },
    progressLog: goal.progressLog.map((entry) => ({ ...entry })),
  })

  class GoalRepository {
    getCurrent(sessionId: string): StoredGoal | null {
      const goal = Array.from(state.goals.values()).find(
        (item) =>
          item.sessionId === sessionId &&
          ['active', 'paused', 'stopped_by_budget', 'pending_contract'].includes(item.status),
      )
      return goal == null ? null : cloneGoal(goal)
    }

    updateStatus(id: string, status: GoalStatus): StoredGoal | null {
      const goal = state.goals.get(id)
      if (goal == null) return null
      goal.status = status
      goal.updatedAt = '2026-06-30T10:00:00.000Z'
      return cloneGoal(goal)
    }

    appendProgress(
      id: string,
      entry: Omit<GoalProgressEntry, 'createdAt'> & { createdAt?: string },
    ): StoredGoal | null {
      const goal = state.goals.get(id)
      if (goal == null) return null
      goal.progressLog.push({ ...entry, createdAt: entry.createdAt ?? '2026-06-30T10:00:00.000Z' })
      return cloneGoal(goal)
    }
  }

  class UsageLedgerRepository {
    getSessionUsage(sessionId: string) {
      const usage = state.usageBySession.get(sessionId) ?? { totalCostUsd: 0, recordCount: 0 }
      return {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalCostUsd: usage.totalCostUsd,
        recordCount: usage.recordCount,
      }
    }
  }

  class EventRepository {
    insert(params: { eventJson: string }): void {
      state.events.push(JSON.parse(params.eventJson) as AgentEvent)
    }

    countBySession(): number {
      return 0
    }
    nextSeqBySession(): number {
      return state.events.reduce((max, event) => Math.max(max, event.seq), -1) + 1
    }
    // 预算周期起点要读 goal_resumed 事件，这里按 eventType 过滤返回已 emit 的事件行，
    // 与真实仓储的 queried 行为对齐（未指定 eventType 时返回全部）。
    queryBySession(params?: { eventType?: string }): { events: unknown[]; hasMore: boolean } {
      const eventType = params?.eventType
      const events = state.events
        .filter((event) => eventType == null || event.type === eventType)
        .map((event) => ({ event_json: JSON.stringify(event), event_type: event.type }))
      return { events, hasMore: false }
    }
    queryStreamEventsByTurn(): unknown[] {
      return []
    }
    queryDialogueEvents(): unknown[] {
      return []
    }
    queryDialogueEventsAfterSeq(): unknown[] {
      return []
    }
    countDialogueEventsAfterSeq(): number {
      return 0
    }
    getLatestByTypeAndJsonValue(): null {
      return null
    }
    deleteOrphanedSessionEventsBatch(): number {
      return 0
    }
  }

  class EmptyRepository {
    list(): unknown[] {
      return []
    }
    listAll(): unknown[] {
      return []
    }
    findByScope(): unknown[] {
      return []
    }
    get(): null {
      return null
    }
    markStaleAsFailed(): number {
      return 0
    }
  }

  class SessionRepository extends EmptyRepository {
    updateStatus(): void {}
  }

  return {
    EventRepository,
    ProviderProfileRepository: EmptyRepository,
    RulesRepository: EmptyRepository,
    SessionRepository,
    WorkspaceRepository: EmptyRepository,
    McpServerRepository: EmptyRepository,
    SettingsRepository: EmptyRepository,
    SkillRepository: EmptyRepository,
    ContextPreferenceRepository: EmptyRepository,
    AgentRepository: EmptyRepository,
    WorkflowRepository: EmptyRepository,
    TeamDispatchRepository: EmptyRepository,
    TurnRequestRepository: class {
      listRecoverable(): unknown[] {
        return []
      }
    },
    TeamDefinitionRepository: EmptyRepository,
    MediaModelManifestRepository: EmptyRepository,
    UsageLedgerRepository,
    GoalRepository,
    ConnectorConnectionRepository: EmptyRepository,
    MemoryRepository: EmptyRepository,
  }
})

vi.mock('../../sdk/index.js', () => ({
  loadSdkMcpFactory: vi.fn(async () => null),
  isSDKAvailable: vi.fn(async () => true),
  getResumeCircuitBreaker: vi.fn(() => ({
    canAttempt: () => true,
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
  })),
  ClaudeSDKExecutor: class {},
  CodexCliExecutor: class {},
  CodexOpenAIExecutor: class {},
  CodexSdkExecutor: class {},
  CodexAppServerExecutor: class {},
}))

class TestSessionService extends SessionService {
  override recoverInterruptedSessions(): { recovered: number } {
    return { recovered: 0 }
  }
}

function seedGoal(patch: Partial<StoredGoal> = {}): StoredGoal {
  const goal: StoredGoal = {
    id: patch.id ?? 'goal-1',
    sessionId: patch.sessionId ?? 'session-1',
    objective: patch.objective ?? 'Ship the goal',
    successCriteria: patch.successCriteria ?? ['done'],
    constraints: patch.constraints ?? [],
    validation: patch.validation ?? {},
    budget: patch.budget ?? {},
    progressLog: patch.progressLog ?? [],
    status: patch.status ?? 'active',
    mode: patch.mode ?? 'spark-loop',
    createdAt: patch.createdAt ?? '2026-06-30T10:00:00.000Z',
    updatedAt: patch.updatedAt ?? '2026-06-30T10:00:00.000Z',
  }
  state.goals.set(goal.id, goal)
  return goal
}

function createService() {
  const emitted: AgentEvent[] = []
  const service = new TestSessionService({} as never, (event) => emitted.push(event))
  // 显式声明参数元组：预算用例需要读取 startTurn 收到的迭代 prompt。
  const startTurn = vi.fn(
    async (_sessionId: string, _turnId: string, _prompt: string, ..._rest: unknown[]) => undefined,
  )
  ;(service as unknown as { startTurn: typeof startTurn }).startTurn = startTurn
  const startGoalLoop = (
    service as unknown as { startGoalLoop(sessionId: string): Promise<void> }
  ).startGoalLoop.bind(service)
  return { service, emitted, startTurn, startGoalLoop }
}

describe('SessionService goal loop budget enforcement', () => {
  beforeEach(() => {
    state.goals.clear()
    state.usageBySession.clear()
    state.events.length = 0
    vi.useRealTimers()
  })

  it('stops before another turn when the usage ledger reaches maxBudgetUsd', async () => {
    seedGoal({ budget: { maxBudgetUsd: 1.25 } })
    state.usageBySession.set('session-1', { totalCostUsd: 1.25, recordCount: 3 })
    const { startGoalLoop, startTurn } = createService()

    await startGoalLoop('session-1')

    expect(state.goals.get('goal-1')?.status).toBe('stopped_by_budget')
    expect(state.goals.get('goal-1')?.progressLog).toHaveLength(0)
    expect(startTurn).not.toHaveBeenCalled()
    expect(state.events).toContainEqual(
      expect.objectContaining({
        type: 'goal_budget_stopped',
        status: 'stopped_by_budget',
        summary: expect.stringContaining('budget'),
      }),
    )
  })

  it('stops before another turn when elapsed runtime reaches maxRuntimeMinutes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-30T10:30:00.000Z'))
    seedGoal({
      createdAt: '2026-06-30T10:00:00.000Z',
      budget: { maxRuntimeMinutes: 30 },
    })
    const { startGoalLoop, startTurn } = createService()

    await startGoalLoop('session-1')

    expect(state.goals.get('goal-1')?.status).toBe('stopped_by_budget')
    expect(state.goals.get('goal-1')?.progressLog).toHaveLength(0)
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('stops before another turn after maxConsecutiveFailures trailing failed or blocked entries', async () => {
    seedGoal({
      budget: { maxConsecutiveFailures: 2 },
      progressLog: [
        {
          iteration: 1,
          phase: 'validate',
          status: 'continue',
          summary: 'Earlier progress',
          createdAt: '2026-06-30T10:00:00.000Z',
        },
        {
          iteration: 2,
          phase: 'validate',
          status: 'failed',
          summary: 'Validation failed',
          createdAt: '2026-06-30T10:01:00.000Z',
        },
        {
          iteration: 3,
          phase: 'validate',
          status: 'blocked',
          summary: 'Paused by blocker',
          createdAt: '2026-06-30T10:02:00.000Z',
        },
      ],
    })
    const { startGoalLoop, startTurn } = createService()

    await startGoalLoop('session-1')

    expect(state.goals.get('goal-1')?.status).toBe('stopped_by_budget')
    expect(state.goals.get('goal-1')?.progressLog).toHaveLength(3)
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('stops before another turn after noProgressLimit trailing continue entries without evidence or next-step change', async () => {
    seedGoal({
      budget: { noProgressLimit: 2 },
      progressLog: [
        {
          iteration: 1,
          phase: 'act',
          status: 'continue',
          summary: 'Made a change',
          evidence: ['file.ts'],
          nextStep: 'Run tests',
          createdAt: '2026-06-30T10:00:00.000Z',
        },
        {
          iteration: 2,
          phase: 'review',
          status: 'continue',
          summary: 'Still reviewing',
          nextStep: 'Run tests',
          createdAt: '2026-06-30T10:01:00.000Z',
        },
        {
          iteration: 3,
          phase: 'review',
          status: 'continue',
          summary: 'Still reviewing',
          nextStep: 'Run tests',
          createdAt: '2026-06-30T10:02:00.000Z',
        },
      ],
    })
    const { startGoalLoop, startTurn } = createService()

    await startGoalLoop('session-1')

    expect(state.goals.get('goal-1')?.status).toBe('stopped_by_budget')
    expect(state.goals.get('goal-1')?.progressLog).toHaveLength(3)
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('starts another turn without appending a placeholder progress entry when all budgets are below limit', async () => {
    seedGoal({
      budget: {
        maxIterations: 3,
        maxBudgetUsd: 1,
        maxRuntimeMinutes: 60,
        maxConsecutiveFailures: 2,
        noProgressLimit: 2,
      },
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      progressLog: [
        {
          iteration: 1,
          phase: 'validate',
          status: 'continue',
          summary: 'Found next work',
          evidence: ['test'],
          nextStep: 'Implement',
          createdAt: '2026-06-30T10:00:00.000Z',
        },
      ],
    })
    state.usageBySession.set('session-1', { totalCostUsd: 0.5, recordCount: 1 })
    const { startGoalLoop, startTurn, emitted } = createService()

    await startGoalLoop('session-1')

    expect(state.goals.get('goal-1')?.status).toBe('active')
    // 启动阶段只发事件、不写占位进度：progressLog 仍只含真实条目，迭代计数不再双倍。
    expect(state.goals.get('goal-1')?.progressLog).toHaveLength(1)
    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(startTurn).toHaveBeenCalledWith(
      'session-1',
      expect.any(String),
      expect.any(String),
      {
        turnSource: 'goal_iteration',
        userMessageVisibility: 'hidden',
      },
      // runtimePatch：mock SessionRepository.get() 返回 null → undefined
      undefined,
      undefined,
      undefined,
      // goalAttachments：startGoalLoop 未传入且事件存储无 /goal 源消息
      undefined,
    )
    // 启动事件应携带即将开始的轮次号（已完成 1 轮 → 第 2 轮）。
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'goal_progress',
        status: 'active',
        iteration: 2,
      }),
    )
  })

  it('keeps iterating past the legacy 12-round cap when no maxIterations budget is set', async () => {
    // 自决式目标：默认不再按轮次停车，15 轮后仍应派发下一轮。
    const progressLog = Array.from({ length: 15 }, (_, index) => ({
      iteration: index + 1,
      phase: 'act' as const,
      status: 'continue' as const,
      summary: `Step ${index + 1} landed`,
      evidence: [`file-${index + 1}.ts`],
      nextStep: `Handle step ${index + 2}`,
      createdAt: '2026-06-30T10:00:00.000Z',
    }))
    seedGoal({
      budget: { maxConsecutiveFailures: 3, noProgressLimit: 3 },
      progressLog,
    })
    const { startGoalLoop, startTurn } = createService()

    await startGoalLoop('session-1')

    expect(state.goals.get('goal-1')?.status).toBe('active')
    expect(startTurn).toHaveBeenCalledTimes(1)
    const prompt = startTurn.mock.calls[0]![2]
    expect(prompt).toContain('Recent progress (iteration 16):')
    expect(prompt).not.toContain('of 12')
  })

  it('still stops before another turn when maxIterations is explicitly configured', async () => {
    seedGoal({
      budget: { maxIterations: 2 },
      progressLog: [
        {
          iteration: 1,
          phase: 'act',
          status: 'continue',
          summary: 'Step 1 landed',
          evidence: ['file-1.ts'],
          createdAt: '2026-06-30T10:00:00.000Z',
        },
        {
          iteration: 2,
          phase: 'act',
          status: 'continue',
          summary: 'Step 2 landed',
          evidence: ['file-2.ts'],
          createdAt: '2026-06-30T10:01:00.000Z',
        },
      ],
    })
    const { startGoalLoop, startTurn } = createService()

    await startGoalLoop('session-1')

    expect(state.goals.get('goal-1')?.status).toBe('stopped_by_budget')
    expect(startTurn).not.toHaveBeenCalled()
    expect(state.events).toContainEqual(
      expect.objectContaining({
        type: 'goal_budget_stopped',
        status: 'stopped_by_budget',
        summary: expect.stringContaining('2 iterations'),
      }),
    )
  })

  it('treats an explicit resume as a fresh budget cycle so a fuse-stopped goal can run again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-30T10:03:00.000Z'))
    seedGoal({
      budget: { noProgressLimit: 2 },
      progressLog: [
        {
          iteration: 1,
          phase: 'act',
          status: 'continue',
          summary: 'Made a change',
          evidence: ['file.ts'],
          nextStep: 'Run tests',
          createdAt: '2026-06-30T10:00:00.000Z',
        },
        {
          iteration: 2,
          phase: 'review',
          status: 'continue',
          summary: 'Still reviewing',
          nextStep: 'Run tests',
          createdAt: '2026-06-30T10:01:00.000Z',
        },
        {
          iteration: 3,
          phase: 'review',
          status: 'continue',
          summary: 'Still reviewing',
          nextStep: 'Run tests',
          createdAt: '2026-06-30T10:02:00.000Z',
        },
      ],
    })
    const { service, startTurn, startGoalLoop } = createService()

    // 熔断停机：同一份 progressLog 直接再跑泵仍会被同一条件停车（停机不自愈）。
    await startGoalLoop('session-1')
    expect(state.goals.get('goal-1')?.status).toBe('stopped_by_budget')
    expect(startTurn).not.toHaveBeenCalled()

    vi.setSystemTime(new Date('2026-07-01T09:00:00.000Z'))
    await service.controlGoal({ sessionId: 'session-1', action: 'resume' })

    // resume 开启新周期：熔断窗口按最近一次 resume 重新起算，目标能继续跑。
    expect(state.goals.get('goal-1')?.status).toBe('active')
    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it('grants a fresh iteration allowance after resume instead of re-stopping on the spent maxIterations', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-30T10:03:00.000Z'))
    seedGoal({
      budget: { maxIterations: 2 },
      progressLog: [
        {
          iteration: 1,
          phase: 'act',
          status: 'continue',
          summary: 'Step 1 landed',
          evidence: ['file-1.ts'],
          createdAt: '2026-06-30T10:00:00.000Z',
        },
        {
          iteration: 2,
          phase: 'act',
          status: 'continue',
          summary: 'Step 2 landed',
          evidence: ['file-2.ts'],
          createdAt: '2026-06-30T10:01:00.000Z',
        },
      ],
    })
    const { service, startTurn, startGoalLoop } = createService()

    // 触顶停机（真实链路：先发出 goal_budget_stopped，再由「继续」开启新周期）。
    await startGoalLoop('session-1')
    expect(state.goals.get('goal-1')?.status).toBe('stopped_by_budget')
    expect(startTurn).not.toHaveBeenCalled()

    vi.setSystemTime(new Date('2026-07-01T09:00:00.000Z'))
    await service.controlGoal({ sessionId: 'session-1', action: 'resume' })

    expect(startTurn).toHaveBeenCalledTimes(1)
    const prompt = startTurn.mock.calls[0]![2]
    // 轮次口径跟随新周期，不再出现「第 3 轮 / 共 2 轮」这种自相矛盾的预算暗示。
    expect(prompt).toContain('Recent progress (iteration 1 of 2')
    expect(prompt).toContain('3 iterations overall across budget cycles')
  })
})
