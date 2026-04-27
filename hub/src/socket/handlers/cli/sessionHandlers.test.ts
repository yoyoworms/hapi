import { describe, expect, it } from 'bun:test'
import type { Store, StoredSession } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { CliSocketWithData } from '../../socketTypes'
import { registerSessionHandlers } from './sessionHandlers'

class FakeSocket {
    readonly data: Record<string, unknown> = {}
    private readonly handlers = new Map<string, (...args: unknown[]) => void>()

    on(event: string, handler: (...args: unknown[]) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    to(): { emit: () => void } {
        return { emit: () => {} }
    }

    trigger(event: string, data?: unknown, ack?: () => void): void {
        const handler = this.handlers.get(event)
        if (!handler) return
        handler(data, ack)
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
})
