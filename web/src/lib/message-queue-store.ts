import type { AttachmentMetadata } from '@/types/api'

export interface QueuedMessage {
    localId: string
    text: string
    attachments?: AttachmentMetadata[]
    createdAt: number
    phase: 'queued' | 'paused'
}

interface SessionQueueState {
    items: QueuedMessage[]
    inFlightLocalId: string | null
}

type Listener = () => void

const queues = new Map<string, SessionQueueState>()
const listeners = new Map<string, Set<Listener>>()

function getOrCreate(sessionId: string): SessionQueueState {
    let state = queues.get(sessionId)
    if (!state) {
        state = { items: [], inFlightLocalId: null }
        queues.set(sessionId, state)
    }
    return state
}

function notify(sessionId: string): void {
    const subs = listeners.get(sessionId)
    if (subs) {
        for (const fn of subs) fn()
    }
}

export function enqueue(sessionId: string, message: Omit<QueuedMessage, 'phase'>): void {
    const state = getOrCreate(sessionId)
    state.items.push({ ...message, phase: 'queued' })
    notify(sessionId)
}

export function peek(sessionId: string): QueuedMessage | null {
    const state = queues.get(sessionId)
    if (!state || state.items.length === 0) return null
    return state.items[0]
}

export function dequeue(sessionId: string): QueuedMessage | null {
    const state = queues.get(sessionId)
    if (!state || state.items.length === 0) return null
    const item = state.items.shift()!
    notify(sessionId)
    return item
}

export function cancel(sessionId: string, localId: string): void {
    const state = queues.get(sessionId)
    if (!state) return
    state.items = state.items.filter(m => m.localId !== localId)
    notify(sessionId)
}

export function clearAll(sessionId: string): QueuedMessage[] {
    const state = queues.get(sessionId)
    if (!state) return []
    const removed = [...state.items]
    state.items = []
    notify(sessionId)
    return removed
}

export function pauseQueue(sessionId: string): void {
    const state = queues.get(sessionId)
    if (!state) return
    for (const item of state.items) {
        if (item.phase === 'queued') item.phase = 'paused'
    }
    notify(sessionId)
}

export function resumeQueue(sessionId: string): void {
    const state = queues.get(sessionId)
    if (!state) return
    for (const item of state.items) {
        if (item.phase === 'paused') item.phase = 'queued'
    }
    notify(sessionId)
}

export function setInFlight(sessionId: string, localId: string | null): void {
    const state = getOrCreate(sessionId)
    state.inFlightLocalId = localId
    notify(sessionId)
}

const EMPTY_STATE: SessionQueueState = { items: [], inFlightLocalId: null }

export function getState(sessionId: string): SessionQueueState {
    return queues.get(sessionId) ?? EMPTY_STATE
}

export function getQueuedCount(sessionId: string): number {
    const state = queues.get(sessionId)
    return state?.items.length ?? 0
}

export function hasPausedItems(sessionId: string): boolean {
    const state = queues.get(sessionId)
    return state?.items.some(m => m.phase === 'paused') ?? false
}

export function moveSession(fromSessionId: string, toSessionId: string): void {
    const state = queues.get(fromSessionId)
    if (!state) return
    queues.set(toSessionId, state)
    queues.delete(fromSessionId)
    // Move listeners too
    const subs = listeners.get(fromSessionId)
    if (subs) {
        listeners.set(toSessionId, subs)
        listeners.delete(fromSessionId)
    }
    notify(toSessionId)
}

export function subscribe(sessionId: string, callback: Listener): () => void {
    let subs = listeners.get(sessionId)
    if (!subs) {
        subs = new Set()
        listeners.set(sessionId, subs)
    }
    subs.add(callback)
    return () => {
        subs!.delete(callback)
        if (subs!.size === 0) listeners.delete(sessionId)
    }
}
