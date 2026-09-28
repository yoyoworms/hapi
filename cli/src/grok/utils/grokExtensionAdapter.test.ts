import { describe, expect, it, vi } from 'vitest'
import type { ApiSessionClient } from '@/api/apiSession'
import type { AgentState } from '@/api/types'
import type { AcpSdkBackend } from '@/agent/backends/acp'
import { GrokExtensionAdapter } from './grokExtensionAdapter'

type ExtensionHandler = (params: unknown, requestId: string | number | null) => Promise<unknown>

function createHarness() {
    const handlers = new Map<string, ExtensionHandler>()
    let state: AgentState = { requests: {}, completedRequests: {} }
    const session = {
        updateAgentState(handler: (current: AgentState) => AgentState) {
            state = handler(state)
        }
    } as unknown as ApiSessionClient
    const backend = {
        registerExtensionRequestHandler(method: string, handler: ExtensionHandler) {
            handlers.set(method, handler)
        }
    } as unknown as AcpSdkBackend

    const onPlanAccepted = vi.fn()
    return {
        adapter: new GrokExtensionAdapter(session, backend, onPlanAccepted),
        handlers,
        getState: () => state,
        onPlanAccepted
    }
}

describe('GrokExtensionAdapter', () => {
    it('answers Grok questions using question text keys', async () => {
        const { adapter, handlers, getState } = createHarness()
        const pending = handlers.get('_x.ai/ask_user_question')!({
            toolCallId: 'ask-1',
            questions: [{
                question: 'Pick one',
                options: [{ label: 'A' }, { label: 'B' }]
            }]
        }, null)

        expect(getState().requests?.['ask-1']?.tool).toBe('AskUserQuestion')
        expect(await adapter.handlePermissionResponse({
            id: 'ask-1',
            approved: true,
            answers: { '0': ['B'] }
        })).toBe(true)
        await expect(pending).resolves.toEqual({
            outcome: 'accepted',
            answers: { 'Pick one': ['B'] },
            partial_answers: false
        })
    })

    it('exposes plan content and returns Grok approved outcome', async () => {
        const { adapter, handlers, getState, onPlanAccepted } = createHarness()
        const pending = handlers.get('_x.ai/exit_plan_mode')!({
            toolCallId: 'plan-1',
            planContent: '# Plan'
        }, null)

        expect(getState().requests?.['plan-1']).toMatchObject({
            tool: 'exit_plan_mode',
            arguments: { plan: '# Plan' }
        })
        await adapter.handlePermissionResponse({
            id: 'plan-1',
            approved: true,
            decision: 'approved'
        })
        await expect(pending).resolves.toEqual({ outcome: 'approved' })
        expect(onPlanAccepted).toHaveBeenCalledOnce()
    })

    it('cancels pending extension requests without leaving the agent blocked', async () => {
        const { adapter, handlers, getState } = createHarness()
        const pending = handlers.get('_x.ai/ask_user_question')!({
            toolCallId: 'ask-cancel',
            questions: []
        }, null)

        await adapter.cancelAll('Session ended')
        await expect(pending).resolves.toEqual({ outcome: 'chat_about_this' })
        expect(getState().requests).toEqual({})
        expect(getState().completedRequests?.['ask-cancel']).toMatchObject({
            status: 'canceled',
            decision: 'abort',
            reason: 'Session ended'
        })
    })

    it('ignores unrelated permission ids', async () => {
        const { adapter } = createHarness()
        await expect(adapter.handlePermissionResponse({
            id: 'other',
            approved: true
        })).resolves.toBe(false)
    })
})
