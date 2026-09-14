// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useNewSessionWorkflowDraft } from './useNewSessionWorkflowDraft'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Probe(props: { sessionId: string | null }): React.JSX.Element {
  const draft = useNewSessionWorkflowDraft(props.sessionId)
  return (
    <button
      type="button"
      onClick={() => draft.setBinding({ mode: 'override', workflowId: 'workflow-a' })}
    >
      {draft.binding?.mode ?? 'empty'}
    </button>
  )
}

describe('useNewSessionWorkflowDraft', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('clears the draft after a reset event or persisted session transition', async () => {
    await act(async () => root.render(<Probe sessionId={null} />))
    await act(async () => container.querySelector('button')?.click())
    expect(container.textContent).toBe('override')

    await act(async () => window.dispatchEvent(new CustomEvent('spark:composer:reset-draft')))
    expect(container.textContent).toBe('empty')

    await act(async () => container.querySelector('button')?.click())
    await act(async () => root.render(<Probe sessionId="session-a" />))
    expect(container.textContent).toBe('empty')
  })
})
