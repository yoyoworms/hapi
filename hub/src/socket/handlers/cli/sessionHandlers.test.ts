import { describe, expect, it } from 'bun:test'
import { Store, type StoredSession } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { CliSocketWithData } from '../../socketTypes'
import { registerSessionHandlers } from './sessionHandlers'

class FakeSocket {
    readonly data: Record<string, unknown> = {}
    readonly roomEvents: Array<{ room: string; event: string; data: unknown }> = []
    private readonly handlers = new Map<string, (...args: unknown[]) => void>()

    on(event: string, handler: (...args: unknown[]) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    to(room: string): { emit: (event: string, data: unknown) => void } {
        return {
            emit: (event: string, data: unknown) => {
                this.roomEvents.push({ room, event, data })
            }
        }
    }

    trigger(event: string, data?: unknown, ack?: () => void): void {
        const handler = this.handlers.get(event)
        if (!handler) return
        handler(data, ack)
    }
}

function redundantGoalStatusContent(message: string): unknown {
    return {
        role: 'agent',
        content: {
            id: `event-${message}`,
            type: 'event',
            data: { type: 'message', message }
        }
    }
}

describe('cli session handlers', () => {
    it('emits ready events to the webapp notification pipeline without storing them', () => {
        const socket = new FakeSocket()
        const events: SyncEvent[] = []
        let addMessageCalls = 0
        let acked = false

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store: {
                messages: {
                    addMessage() {
                        addMessageCalls += 1
                        throw new Error('ready event should not be stored')
                    }
                }
            } as unknown as Store,
            resolveSessionAccess: () => ({
                ok: true,
                value: { namespace: 'default' } as StoredSession
            }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => {
                events.push(event)
            }
        })

        const content = {
            role: 'agent',
            content: {
                id: 'ready-1',
                type: 'event',
                data: { type: 'ready' }
            }
        }

        socket.trigger('message', {
            sid: 'session-1',
            message: content
        }, () => {
            acked = true
        })

        expect(acked).toBe(true)
        expect(addMessageCalls).toBe(0)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                seq: null,
                localId: null,
                content
            }
        })
    })

    it('drops redundant goal status events before persistence and broadcast', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('goal-status-session', {}, null, 'default')
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => {
                webEvents.push(event)
            }
        })

        socket.trigger('message', {
            sid: session.id,
            message: redundantGoalStatusContent('Goal active · 8016 tokens')
        })

        expect(store.messages.getMessages(session.id)).toHaveLength(0)
        expect(socket.roomEvents).toHaveLength(0)
        expect(webEvents).toHaveLength(0)
    })
})
