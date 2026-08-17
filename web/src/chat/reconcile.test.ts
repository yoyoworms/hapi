import { describe, expect, it } from 'vitest'
import type { AgentTextBlock } from './types'
import { reconcileChatBlocks } from './reconcile'

function textBlock(phase: AgentTextBlock['phase']): AgentTextBlock {
    return {
        kind: 'agent-text',
        id: 'agent-text-1',
        localId: null,
        createdAt: 1,
        text: 'Progress update',
        phase
    }
}

describe('reconcileChatBlocks', () => {
    it('treats the agent message phase as render-significant', () => {
        const previous = textBlock('commentary')
        const next = textBlock('final_answer')

        const reconciled = reconcileChatBlocks([next], new Map([[previous.id, previous]]))

        expect(reconciled.blocks[0]).toBe(next)
        expect(reconciled.blocks[0]).not.toBe(previous)
    })
})
