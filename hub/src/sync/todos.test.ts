import { describe, expect, it } from 'bun:test'
import { extractTodoWriteTodosFromMessageContent } from './todos'

function codexToolCall(name: string, input: unknown): unknown {
    return {
        role: 'agent',
        content: {
            type: 'codex',
            data: {
                type: 'tool-call',
                name,
                input
            }
        }
    }
}

describe('extractTodoWriteTodosFromMessageContent', () => {
    it('persists Codex update_plan snapshots as session todos', () => {
        expect(extractTodoWriteTodosFromMessageContent(codexToolCall('update_plan', {
            plan: [
                { step: 'Inspect', status: 'completed' },
                { step: 'Implement', status: 'in_progress' },
                { step: 'Verify', status: 'pending' },
            ]
        }))).toEqual([
            {
                id: 'codex-plan-1',
                content: 'Inspect',
                priority: 'medium',
                status: 'completed'
            },
            {
                id: 'codex-plan-2',
                content: 'Implement',
                priority: 'medium',
                status: 'in_progress'
            },
            {
                id: 'codex-plan-3',
                content: 'Verify',
                priority: 'medium',
                status: 'pending'
            }
        ])
    })

    it('ignores malformed Codex plan entries', () => {
        expect(extractTodoWriteTodosFromMessageContent(codexToolCall('update_plan', {
            plan: [
                { step: 'Valid', status: 'pending' },
                { step: 'Bad status', status: 'running' },
                { step: 42, status: 'completed' },
            ]
        }))).toEqual([
            {
                id: 'codex-plan-1',
                content: 'Valid',
                priority: 'medium',
                status: 'pending'
            }
        ])
    })
})
