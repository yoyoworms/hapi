import { describe, expect, it } from 'bun:test'
import { Store, type StoredSession } from '../../../store'
import { MetadataSchema } from '@hapi/protocol/schemas'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { CliSocketWithData } from '../../socketTypes'
import { registerSessionHandlers } from './sessionHandlers'

class FakeSocket {
    readonly id = 'socket-test'
    readonly data: Record<string, unknown> = {
        runtimeId: 'runtime-test',
        runtimeGeneration: 1
    }
    readonly roomEvents: Array<{ room: string; event: string; data: unknown }> = []
    private readonly handlers = new Map<string, (data: unknown, ack?: (response: unknown) => void) => void>()

    on(event: string, handler: (data: unknown, ack?: (response: unknown) => void) => void): this {
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

    trigger(event: string, data?: unknown, ack?: (response: unknown) => void): void {
        this.handlers.get(event)?.(data, ack)
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
    it('keeps legacy CLI events on the non-authoritative timestamp path', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'legacy-runtime-reopen',
            {
                path: '/tmp/project',
                host: 'localhost',
                lifecycleState: 'archived',
                lifecycleStateSince: Date.now() - 1_000,
                runtimeId: 'runtime-from-newer-cli'
            },
            null,
            'default'
        )
        const socket = new FakeSocket()
        delete socket.data.runtimeId
        delete socket.data.runtimeGeneration
        const alivePayloads: unknown[] = []
        const endPayloads: unknown[] = []
        let metadataGateCalls = 0

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onSessionAlive: (payload) => alivePayloads.push(payload),
            onSessionEnd: (payload) => {
                endPayloads.push(payload)
                return false
            },
            onSessionMetadataUpdateAllowed: () => {
                metadataGateCalls += 1
                return false
            }
        })

        let metadataAck: unknown = null
        const runningSince = Date.now()
        socket.trigger('update-metadata', {
            sid: session.id,
            expectedVersion: session.metadataVersion,
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                lifecycleState: 'running',
                lifecycleStateSince: runningSince
            }
        }, (response) => {
            metadataAck = response
        })
        socket.trigger('session-alive', {
            sid: session.id,
            time: runningSince,
            thinking: false
        })
        socket.trigger('session-end', {
            sid: session.id,
            time: runningSince + 1,
            reason: 'completed'
        })

        expect(metadataGateCalls).toBe(0)
        expect(metadataAck).toEqual(expect.objectContaining({ result: 'success' }))
        expect(store.sessions.getSession(session.id)?.metadata).toEqual(expect.objectContaining({
            lifecycleState: 'running',
            lifecycleStateSince: runningSince
        }))
        expect((store.sessions.getSession(session.id)?.metadata as Record<string, unknown>).runtimeId).toBeUndefined()
        expect(MetadataSchema.safeParse(store.sessions.getSession(session.id)?.metadata).success).toBe(true)
        expect(alivePayloads).toEqual([{
            sid: session.id,
            time: runningSince,
            thinking: false
        }])
        expect(endPayloads).toEqual([{
            sid: session.id,
            time: runningSince + 1,
            reason: 'completed'
        }])
    })

    it('does not sweep queued prompts when a stale session end is rejected', () => {
        const socket = new FakeSocket()
        const endPayloads: unknown[] = []
        let sweepCalls = 0

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store: {} as Store,
            resolveSessionAccess: () => ({
                ok: true,
                value: { namespace: 'default' } as StoredSession
            }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onSessionEnd: (payload) => {
                endPayloads.push(payload)
                return false
            },
            onSweepImmediateQueued: () => {
                sweepCalls += 1
            }
        })

        socket.trigger('session-end', {
            sid: 'session-1',
            time: Date.now(),
            reason: 'completed'
        })

        expect(endPayloads).toEqual([expect.objectContaining({
            sid: 'session-1',
            runtimeId: 'runtime-test',
            runtimeGeneration: 1
        })])
        expect(sweepCalls).toBe(0)
    })

    it('acknowledges but does not persist metadata rejected by runtime ownership', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'ended-runtime-metadata',
            {
                lifecycleState: 'archived',
                archivedBy: 'hub',
                archiveReason: 'Session completed'
            },
            null,
            'default'
        )
        const socket = new FakeSocket()
        let ackResponse: unknown = null

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onSessionMetadataUpdateAllowed: () => false
        })

        socket.trigger('update-metadata', {
            sid: session.id,
            expectedVersion: session.metadataVersion,
            metadata: {
                lifecycleState: 'running',
                lifecycleStateSince: Date.now()
            }
        }, (response) => {
            ackResponse = response
        })

        expect(store.sessions.getSession(session.id)?.metadata).toEqual(expect.objectContaining({
            lifecycleState: 'archived',
            archiveReason: 'Session completed'
        }))
        expect(ackResponse).toEqual(expect.objectContaining({
            result: 'success',
            metadata: expect.objectContaining({ lifecycleState: 'archived' })
        }))
    })

    it('emits ready events to the webapp notification pipeline without storing them', () => {
        const socket = new FakeSocket()
        const events: SyncEvent[] = []
        const activity: Array<{ sessionId: string; updatedAt: number }> = []
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
            },
            onSessionActivity: (sessionId, updatedAt) => {
                activity.push({ sessionId, updatedAt })
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
        expect(activity).toEqual([{
            sessionId: 'session-1',
            updatedAt: expect.any(Number)
        }])
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

    it('persists and broadcasts user-visible message events', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('message-event-session', {}, null, 'default')
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []
        const content = {
            role: 'agent',
            content: {
                id: 'failure-1',
                type: 'event',
                data: {
                    type: 'message',
                    message: 'Task failed: Codex thread entered systemError'
                }
            }
        }

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
            message: content
        })

        expect(store.messages.getMessages(session.id)).toHaveLength(1)
        expect(socket.roomEvents).toHaveLength(1)
        expect(webEvents).toContainEqual(expect.objectContaining({
            type: 'message-received',
            sessionId: session.id,
            message: expect.objectContaining({ content })
        }))
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

    it('clears the previous plan snapshot when queued user messages start a new turn', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('plan-reset-session', {}, null, 'default')
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []
        const planAt = Date.now() - 1_000
        store.sessions.setSessionTodos(session.id, [
            {
                id: 'codex-plan-1',
                content: 'Previous task',
                priority: 'medium',
                status: 'in_progress'
            }
        ], planAt, session.namespace)
        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'Next task' } },
            'local-next'
        )

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

        socket.trigger('messages-consumed', {
            sid: session.id,
            localIds: ['local-next']
        })

        expect(store.sessions.getSession(session.id)?.todos).toEqual([])
        expect(webEvents).toContainEqual({
            type: 'session-updated',
            sessionId: session.id
        })
        expect(webEvents).toContainEqual(expect.objectContaining({
            type: 'messages-consumed',
            sessionId: session.id,
            localIds: ['local-next']
        }))
    })

    it('update-metadata broadcasts the merged value, not the pre-merge payload', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'broadcast-merged',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'broadcast-survives'
            },
            null,
            'default'
        )
        const socket = new FakeSocket()
        const acceptedMetadata: unknown[] = []

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onSessionMetadataUpdated: (payload) => acceptedMetadata.push(payload)
        })

        let ackResponse: unknown = null
        socket.trigger(
            'update-metadata',
            {
                sid: session.id,
                expectedVersion: session.metadataVersion,
                metadata: {
                    lifecycleState: 'archived',
                    archivedBy: 'cli',
                    archiveReason: 'Session crashed'
                }
            },
            (response) => {
                ackResponse = response
            }
        )

        // Ack: success and the version bumps; the persisted value carries the
        // merged metadata so other CLIs can update their cache to the truth.
        const ack = ackResponse as { result: string; version: number; metadata: unknown }
        expect(ack.result).toBe('success')
        const ackMetadata = ack.metadata as Record<string, unknown>
        expect(ackMetadata.cursorSessionId).toBe('broadcast-survives')
        expect(ackMetadata.path).toBe('/tmp/project')
        expect(ackMetadata.runtimeId).toBe('runtime-test')
        expect(acceptedMetadata).toEqual([expect.objectContaining({
            sid: session.id,
            runtimeId: 'runtime-test',
            runtimeGeneration: 1,
            metadata: expect.objectContaining({ runtimeId: 'runtime-test' })
        })])

        // Broadcast: the room event must carry the same merged value.
        const broadcast = socket.roomEvents.find((event) => event.event === 'update')
        expect(broadcast).toBeDefined()
        const broadcastBody = (broadcast?.data as { body: { metadata: { value: Record<string, unknown> } } }).body
        expect(broadcastBody.metadata.value.cursorSessionId).toBe('broadcast-survives')
        expect(broadcastBody.metadata.value.path).toBe('/tmp/project')
        expect(broadcastBody.metadata.value.lifecycleState).toBe('archived')
        expect(broadcastBody.metadata.value.runtimeId).toBe('runtime-test')
    })
})
