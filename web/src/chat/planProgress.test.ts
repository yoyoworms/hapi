import { describe, expect, it } from 'vitest'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import {
    extractPlanSnapshot,
    getLatestPlanProgress,
    getPersistedPlanProgress
} from '@/chat/planProgress'

function makePlanBlock(id: string, input: unknown, result?: unknown): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        tool: {
            id,
            name: 'update_plan',
            state: 'completed',
            input,
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            result
        },
        children: []
    }
}

describe('extractPlanSnapshot', () => {
    it('keeps the explanation and normalizes current plan steps', () => {
        expect(extractPlanSnapshot({
            explanation: 'Checking the reconnect path.',
            plan: [
                { step: 'Reproduce', status: 'completed' },
                { step: 'Patch', status: 'inProgress' },
                { step: 123, status: 'pending' },
            ]
        }, null)).toEqual({
            explanation: 'Checking the reconnect path.',
            steps: [
                { step: 'Reproduce', status: 'completed' },
                { step: 'Patch', status: 'in_progress' },
            ]
        })
    })
})

describe('getLatestPlanProgress', () => {
    it('reports completed count and the active step from the latest plan', () => {
        const blocks: ChatBlock[] = [
            makePlanBlock('plan-1', {
                plan: [{ step: 'Old task', status: 'in_progress' }]
            }),
            makePlanBlock('plan-2', {
                plan: [
                    { step: 'Inspect', status: 'completed' },
                    { step: 'Implement', status: 'in_progress' },
                    { step: 'Verify', status: 'pending' },
                ]
            })
        ]

        expect(getLatestPlanProgress(blocks)).toMatchObject({
            completed: 1,
            total: 3,
            currentStep: 'Implement',
            isComplete: false
        })
    })

    it('marks a fully completed plan', () => {
        const progress = getLatestPlanProgress([
            makePlanBlock('plan-1', {
                plan: [
                    { step: 'Inspect', status: 'completed' },
                    { step: 'Verify', status: 'completed' },
                ]
            })
        ])

        expect(progress).toMatchObject({
            completed: 2,
            total: 2,
            currentStep: null,
            isComplete: true
        })
    })
})

describe('getPersistedPlanProgress', () => {
    it('restores progress when the plan card is outside the loaded message window', () => {
        expect(getPersistedPlanProgress([
            { id: '1', content: 'Inspect', priority: 'medium', status: 'completed' },
            { id: '2', content: 'Implement', priority: 'medium', status: 'in_progress' },
            { id: '3', content: 'Verify', priority: 'medium', status: 'pending' },
        ])).toMatchObject({
            completed: 1,
            total: 3,
            currentStep: 'Implement',
            isComplete: false
        })
    })
})
