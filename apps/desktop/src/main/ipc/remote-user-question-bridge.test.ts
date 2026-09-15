import { describe, expect, it } from 'vitest'
import type { UserQuestionPrompt, UserQuestionRequest } from '@spark/protocol'
import {
  RemoteUserQuestionBridge,
  buildRemoteQuestionAnswer,
  formatRemoteQuestionMessage,
  parseRemoteQuestionReply,
  type RemoteQuestionBridgeDeps,
  type RemoteQuestionTarget,
} from './remote-user-question-bridge.js'

const choiceQuestion: UserQuestionPrompt = {
  header: '包管理器',
  question: '使用哪个包管理器？',
  options: [
    { label: 'pnpm', description: '速度快，磁盘占用小' },
    { label: 'npm', description: '兼容性最好' },
  ],
}

const textQuestion: UserQuestionPrompt = {
  header: '备注',
  question: '还有什么补充？',
  type: 'text',
}

function buildRequest(overrides?: Partial<UserQuestionRequest>): UserQuestionRequest {
  return {
    sessionId: 'session-1',
    questionId: 'question-1',
    createdAt: '2026-09-14T00:00:00.000Z',
    questions: [choiceQuestion, textQuestion],
    ...overrides,
  }
}

type Harness = {
  bridge: RemoteUserQuestionBridge
  sent: Array<{ target: RemoteQuestionTarget; text: string }>
  resolved: Array<{ sessionId: string; questionId: string; answers: Record<string, unknown> }>
}

function buildHarness(resolveResult = true): Harness {
  const sent: Harness['sent'] = []
  const resolved: Harness['resolved'] = []
  const deps: RemoteQuestionBridgeDeps = {
    resolveQuestion: async (sessionId, questionId, answers) => {
      resolved.push({ sessionId, questionId, answers })
      return resolveResult
    },
    sendReply: async (target, text) => {
      sent.push({ target, text })
    },
  }
  return { bridge: new RemoteUserQuestionBridge(deps), sent, resolved }
}

const target: RemoteQuestionTarget = { connectionId: 'connection-1', externalId: 'message-9' }

describe('formatRemoteQuestionMessage', () => {
  it('renders choice questions with numbered options and reply guidance', () => {
    const text = formatRemoteQuestionMessage(choiceQuestion, 0, 2)
    expect(text).toContain('第 1/2 问')
    expect(text).toContain('【包管理器】')
    expect(text).toContain('使用哪个包管理器？')
    expect(text).toContain('1. pnpm — 速度快，磁盘占用小')
    expect(text).toContain('2. npm — 兼容性最好')
    expect(text).toContain('回复编号')
    expect(text).toContain('「跳过」')
  })

  it('renders text questions without option lists', () => {
    const text = formatRemoteQuestionMessage(textQuestion, 1, 2)
    expect(text).toContain('第 2/2 问')
    expect(text).toContain('请直接回复文字内容。')
    expect(text).not.toContain('1. ')
  })

  it('omits the progress counter for single-question requests', () => {
    const text = formatRemoteQuestionMessage(textQuestion, 0, 1)
    expect(text).toContain('❓ Agent 需要您的回复')
    expect(text).not.toContain('第 1/1 问')
  })
})

describe('parseRemoteQuestionReply', () => {
  const choice = choiceQuestion

  it('maps numeric replies onto options', () => {
    expect(parseRemoteQuestionReply('2', choice)).toEqual({
      kind: 'answer',
      selectedOptions: [{ label: 'npm', description: '兼容性最好' }],
      text: '',
    })
  })

  it('maps comma-separated numeric replies for multi-select', () => {
    const parsed = parseRemoteQuestionReply('1, 2', choice)
    expect(parsed.kind).toBe('answer')
    if (parsed.kind === 'answer') expect(parsed.selectedOptions).toHaveLength(2)
  })

  it('matches option labels case-insensitively', () => {
    const parsed = parseRemoteQuestionReply('PNPM', choice)
    expect(parsed.kind).toBe('answer')
    if (parsed.kind === 'answer') expect(parsed.selectedOptions[0]?.label).toBe('pnpm')
  })

  it('falls back to free text when nothing matches', () => {
    expect(parseRemoteQuestionReply('用 yarn 吧', choice)).toEqual({
      kind: 'answer',
      selectedOptions: [],
      text: '用 yarn 吧',
    })
  })

  it('recognizes skip and cancel keywords', () => {
    expect(parseRemoteQuestionReply('跳过', choice).kind).toBe('skip')
    expect(parseRemoteQuestionReply('skip', choice).kind).toBe('skip')
    expect(parseRemoteQuestionReply('取消', choice).kind).toBe('cancel')
  })

  it('treats any text as the answer for text questions', () => {
    const parsed = parseRemoteQuestionReply('先修问答，再升级', textQuestion)
    expect(parsed).toEqual({ kind: 'answer', selectedOptions: [], text: '先修问答，再升级' })
  })
})

describe('buildRemoteQuestionAnswer', () => {
  it('mirrors the renderer answer structure for choice picks', () => {
    const answer = buildRemoteQuestionAnswer(choiceQuestion, 0, {
      kind: 'answer',
      selectedOptions: [{ label: 'pnpm', value: 'pnpm@9' }],
      text: '',
    })
    expect(answer).toMatchObject({
      index: 0,
      id: 'question-1',
      header: '包管理器',
      question: '使用哪个包管理器？',
      type: 'single_choice',
      skipped: false,
      answer: 'pnpm@9',
      optionLabel: 'pnpm',
      optionValue: 'pnpm@9',
    })
  })

  it('keeps free text on choice questions as the answer with otherText', () => {
    const answer = buildRemoteQuestionAnswer(choiceQuestion, 0, {
      kind: 'answer',
      selectedOptions: [],
      text: '用 yarn 吧',
    })
    expect(answer).toMatchObject({ answer: '用 yarn 吧', otherText: '用 yarn 吧' })
    expect(answer).not.toHaveProperty('optionLabel')
  })

  it('marks skipped answers explicitly', () => {
    const answer = buildRemoteQuestionAnswer(choiceQuestion, 0, { kind: 'skip' })
    expect(answer).toMatchObject({ skipped: true, answer: '用户选择跳过' })
  })
})

describe('RemoteUserQuestionBridge', () => {
  it('forwards the first question and walks through multi-question requests sequentially', async () => {
    const harness = buildHarness()
    expect(harness.bridge.hasPending('session-1')).toBe(false)
    harness.bridge.forwardQuestion(buildRequest(), target)
    expect(harness.bridge.hasPending('session-1')).toBe(true)
    expect(harness.sent).toHaveLength(1)
    expect(harness.sent[0]?.text).toContain('第 1/2 问')

    expect(await harness.bridge.consumeInbound('session-1', '1')).toBe(true)
    expect(harness.sent).toHaveLength(2)
    expect(harness.sent[1]?.text).toContain('已记录第 1 问')
    expect(harness.sent[1]?.text).toContain('第 2/2 问')
    expect(harness.resolved).toHaveLength(0)

    expect(await harness.bridge.consumeInbound('session-1', '先修问答，再升级')).toBe(true)
    expect(harness.resolved).toHaveLength(1)
    const payload = harness.resolved[0]?.answers
    expect(payload?.questionCount).toBe(2)
    expect(payload?.answeredCount).toBe(2)
    expect(payload?.answers).toMatchObject([
      { index: 0, answer: 'pnpm', optionLabel: 'pnpm' },
      { index: 1, type: 'text', answer: '先修问答，再升级', text: '先修问答，再升级' },
    ])
    expect(harness.sent.at(-1)?.text).toContain('已收到全部回答')
    expect(harness.bridge.hasPending('session-1')).toBe(false)
  })

  it('resolves a single-question request immediately', async () => {
    const harness = buildHarness()
    harness.bridge.forwardQuestion(
      buildRequest({ questions: [textQuestion] }),
      target,
    )
    expect(await harness.bridge.consumeInbound('session-1', '没有了')).toBe(true)
    expect(harness.resolved).toHaveLength(1)
    expect(harness.resolved[0]?.answers.answers).toMatchObject([
      { answer: '没有了', text: '没有了' },
    ])
  })

  it('resolves with cancelled payload when the remote user cancels', async () => {
    const harness = buildHarness()
    harness.bridge.forwardQuestion(buildRequest(), target)
    expect(await harness.bridge.consumeInbound('session-1', '取消')).toBe(true)
    expect(harness.resolved).toHaveLength(1)
    expect(harness.resolved[0]?.answers).toMatchObject({ cancelled: true })
    expect(harness.sent.at(-1)?.text).toContain('已取消')
    expect(harness.bridge.hasPending('session-1')).toBe(false)
  })

  it('treats skipped questions as skipped answers in the final payload', async () => {
    const harness = buildHarness()
    harness.bridge.forwardQuestion(
      buildRequest({ questions: [choiceQuestion] }),
      target,
    )
    await harness.bridge.consumeInbound('session-1', '跳过')
    expect(harness.resolved[0]?.answers).toMatchObject({
      questionCount: 1,
      answeredCount: 0,
      answers: [{ skipped: true, answer: '用户选择跳过' }],
    })
  })

  it('notifies the remote side when the question is settled locally first', () => {
    const harness = buildHarness()
    harness.bridge.forwardQuestion(buildRequest(), target)
    harness.bridge.notifyClosed(buildRequest(), 'answered')
    expect(harness.sent.at(-1)?.text).toContain('已在桌面端作答')
    expect(harness.bridge.hasPending('session-1')).toBe(false)
  })

  it('stays silent on close when the bridge already settled the question remotely', async () => {
    const harness = buildHarness()
    harness.bridge.forwardQuestion(
      buildRequest({ questions: [textQuestion] }),
      target,
    )
    await harness.bridge.consumeInbound('session-1', '好的')
    const sentAfterRemoteSettle = harness.sent.length
    harness.bridge.notifyClosed(buildRequest(), 'answered')
    expect(harness.sent).toHaveLength(sentAfterRemoteSettle)
  })

  it('reports an expired question when resolve returns false', async () => {
    const harness = buildHarness(false)
    harness.bridge.forwardQuestion(
      buildRequest({ questions: [textQuestion] }),
      target,
    )
    await harness.bridge.consumeInbound('session-1', '好的')
    expect(harness.sent.at(-1)?.text).toContain('已失效')
  })

  it('ignores inbound messages when no question is bridged for the session', async () => {
    const harness = buildHarness()
    expect(await harness.bridge.consumeInbound('session-1', '1')).toBe(false)
    expect(harness.sent).toHaveLength(0)
    expect(harness.resolved).toHaveLength(0)
  })

  it('refreshes the reply target on reattach without losing progress', async () => {
    const harness = buildHarness()
    harness.bridge.forwardQuestion(buildRequest(), target)
    await harness.bridge.consumeInbound('session-1', '1')
    const refreshedTarget: RemoteQuestionTarget = {
      connectionId: 'connection-1',
      externalId: 'message-42',
    }
    harness.bridge.forwardQuestion(buildRequest(), refreshedTarget)
    expect(harness.sent.at(-1)?.target.externalId).toBe('message-42')
    // reattach 重发的是当前待答的第 2 问，而不是从头再来。
    expect(harness.sent.at(-1)?.text).toContain('第 2/2 问')
  })
})
