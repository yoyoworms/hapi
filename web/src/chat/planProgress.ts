import { isObject } from '@hapi/protocol'
import type { TodoItem } from '@hapi/protocol/types'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed'

export type PlanStep = {
    step: string
    status: PlanStepStatus
}

export type PlanSnapshot = {
    explanation: string | null
    steps: PlanStep[]
}

export type PlanProgress = PlanSnapshot & {
    completed: number
    total: number
    currentStep: string | null
    isComplete: boolean
}

function normalizeStatus(value: unknown): PlanStepStatus {
    const normalized = typeof value === 'string'
        ? value.trim().toLowerCase().replace(/[\s-]/g, '_')
        : ''
    if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') {
        return 'completed'
    }
    if (normalized === 'in_progress' || normalized === 'inprogress' || normalized === 'active' || normalized === 'running') {
        return 'in_progress'
    }
    return 'pending'
}

function parseSteps(value: unknown): PlanStep[] {
    if (!Array.isArray(value)) return []

    const steps: PlanStep[] = []
    for (const entry of value) {
        if (!isObject(entry) || typeof entry.step !== 'string') continue
        steps.push({
            step: entry.step,
            status: normalizeStatus(entry.status)
        })
    }
    return steps
}

function explanationFrom(value: unknown): string | null {
    if (!isObject(value) || typeof value.explanation !== 'string') return null
    const explanation = value.explanation.trim()
    return explanation.length > 0 ? explanation : null
}

export function extractPlanSnapshot(input: unknown, result: unknown): PlanSnapshot {
    const inputRecord = isObject(input) ? input : null
    const resultRecord = isObject(result) ? result : null
    const source = inputRecord && Object.prototype.hasOwnProperty.call(inputRecord, 'plan')
        ? inputRecord
        : resultRecord

    return {
        explanation: explanationFrom(inputRecord) ?? explanationFrom(resultRecord),
        steps: parseSteps(source?.plan)
    }
}

export function getPlanProgress(block: ToolCallBlock): PlanProgress | null {
    if (block.tool.name !== 'update_plan') return null

    const snapshot = extractPlanSnapshot(block.tool.input, block.tool.result)
    if (snapshot.steps.length === 0) return null

    const completed = snapshot.steps.filter((step) => step.status === 'completed').length
    const currentStep = snapshot.steps.find((step) => step.status === 'in_progress')?.step
        ?? snapshot.steps.find((step) => step.status === 'pending')?.step
        ?? null

    return {
        ...snapshot,
        completed,
        total: snapshot.steps.length,
        currentStep,
        isComplete: completed === snapshot.steps.length
    }
}

export function getLatestPlanProgress(blocks: ChatBlock[]): PlanProgress | null {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index]
        if (block.kind !== 'tool-call' || block.tool.name !== 'update_plan') continue
        return getPlanProgress(block)
    }
    return null
}

export function getPersistedPlanProgress(todos: TodoItem[] | null | undefined): PlanProgress | null {
    if (!todos || todos.length === 0) return null

    const steps = todos.map((todo) => ({
        step: todo.content,
        status: normalizeStatus(todo.status)
    }))
    const completed = steps.filter((step) => step.status === 'completed').length
    const currentStep = steps.find((step) => step.status === 'in_progress')?.step
        ?? steps.find((step) => step.status === 'pending')?.step
        ?? null

    return {
        explanation: null,
        steps,
        completed,
        total: steps.length,
        currentStep,
        isComplete: completed === steps.length
    }
}
