import { randomUUID } from 'node:crypto'
import type { ApiSessionClient } from '@/api/apiSession'
import type { AgentState } from '@/api/types'
import type { AcpSdkBackend } from '@/agent/backends/acp'
import { asString, isObject } from '@hapi/protocol'
import { logger } from '@/ui/logger'

type PendingExtensionRequest = {
    tool: 'AskUserQuestion' | 'exit_plan_mode'
    arguments: Record<string, unknown>
    respond: (result: unknown) => void
}

export type GrokPermissionResponse = {
    id: string
    approved: boolean
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    answers?: Record<string, string[]>
}

export class GrokExtensionAdapter {
    private readonly pending = new Map<string, PendingExtensionRequest>()

    constructor(
        private readonly session: ApiSessionClient,
        private readonly backend: AcpSdkBackend,
        private readonly onPlanAccepted?: () => void
    ) {
        this.backend.registerExtensionRequestHandler('_x.ai/ask_user_question', async (params) => (
            await this.handleBlockingRequest('AskUserQuestion', params)
        ))
        this.backend.registerExtensionRequestHandler('_x.ai/exit_plan_mode', async (params) => (
            await this.handleBlockingRequest('exit_plan_mode', normalizePlanArguments(params))
        ))
    }

    handlePermissionResponse = async (response: GrokPermissionResponse): Promise<boolean> => {
        const pending = this.pending.get(response.id)
        if (!pending) return false

        this.pending.delete(response.id)
        const decision = response.decision ?? (response.approved ? 'approved' : 'denied')

        if (pending.tool === 'AskUserQuestion') {
            pending.respond(decision === 'approved' || decision === 'approved_for_session'
                ? {
                    outcome: 'accepted',
                    answers: formatAnswers(pending.arguments, response.answers),
                    partial_answers: false
                }
                : { outcome: decision === 'abort' ? 'chat_about_this' : 'skip_interview' })
        } else {
            if (decision === 'approved' || decision === 'approved_for_session') {
                this.onPlanAccepted?.()
            }
            pending.respond({
                outcome: decision === 'approved' || decision === 'approved_for_session'
                    ? 'approved'
                    : decision === 'abort'
                        ? 'abandoned'
                        : 'cancelled'
            })
        }

        this.completeRequest(response.id, pending, response, decision)
        return true
    }

    async cancelAll(reason: string): Promise<void> {
        const entries = Array.from(this.pending.entries())
        this.pending.clear()
        for (const [id, pending] of entries) {
            pending.respond(pending.tool === 'exit_plan_mode'
                ? { outcome: 'abandoned' }
                : { outcome: 'chat_about_this' })
            this.completeRequest(id, pending, {
                id,
                approved: false,
                decision: 'abort'
            }, 'abort', reason)
        }
    }

    private async handleBlockingRequest(
        tool: PendingExtensionRequest['tool'],
        params: unknown
    ): Promise<unknown> {
        const argumentsValue = isObject(params) ? params : {}
        const requestId = asString(argumentsValue.toolCallId) ?? `grok-${randomUUID()}`

        return await new Promise<unknown>((respond) => {
            this.pending.set(requestId, {
                tool,
                arguments: argumentsValue,
                respond
            })
            this.session.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [requestId]: {
                        tool,
                        arguments: argumentsValue,
                        createdAt: Date.now()
                    }
                }
            } satisfies AgentState))
            logger.debug(`[grok-acp] Extension request queued: ${tool} (${requestId})`)
        })
    }

    private completeRequest(
        id: string,
        pending: PendingExtensionRequest,
        response: GrokPermissionResponse,
        decision: NonNullable<GrokPermissionResponse['decision']>,
        reason?: string
    ): void {
        this.session.updateAgentState((currentState) => {
            const request = currentState.requests?.[id]
            const { [id]: _, ...remaining } = currentState.requests ?? {}
            return {
                ...currentState,
                requests: remaining,
                completedRequests: {
                    ...currentState.completedRequests,
                    [id]: {
                        tool: pending.tool,
                        arguments: pending.arguments,
                        createdAt: request?.createdAt ?? Date.now(),
                        completedAt: Date.now(),
                        status: response.approved ? 'approved' : decision === 'abort' ? 'canceled' : 'denied',
                        decision,
                        reason,
                        answers: response.answers
                    }
                }
            } satisfies AgentState
        })
    }
}

function normalizePlanArguments(params: unknown): Record<string, unknown> {
    if (!isObject(params)) return {}
    const plan = asString(params.planContent)
    return plan ? { ...params, plan } : params
}

function formatAnswers(
    params: Record<string, unknown>,
    answers: Record<string, string[]> | undefined
): Record<string, string[]> {
    const result: Record<string, string[]> = {}
    const questions = Array.isArray(params.questions) ? params.questions : []

    questions.forEach((entry, index) => {
        if (!isObject(entry)) return
        const question = asString(entry.question)
        if (!question) return
        const selected = answers?.[String(index)] ?? answers?.[question]
        if (selected) result[question] = selected
    })

    return result
}
