import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { EventPublisher } from './eventPublisher'
import { MachineCache } from './machineCache'
import { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

function commitRunningRuntime(
    cache: SessionCache,
    store: Store,
    sessionId: string,
    source: { runtimeId: string; runtimeGeneration: number },
    lifecycleStateSince: number
): void {
    const current = store.sessions.getSession(sessionId)!
    const metadata = {
        ...(current.metadata as Record<string, unknown>),
        lifecycleState: 'running',
        lifecycleStateSince,
        runtimeId: source.runtimeId
    }
    const result = store.sessions.updateSessionMetadata(
        sessionId,
        metadata,
        current.metadataVersion,
        current.namespace
    )
    expect(result.result).toBe('success')
    cache.recordRuntimeMetadataUpdate({
        sid: sessionId,
        metadata: result.result === 'success' ? result.value : metadata,
        ...source
    })
    cache.refreshSession(sessionId)
}

describe('alive incremental events', () => {
    it('includes active=true in session alive updates', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-alive-test',
            { path: '/tmp/project', host: 'localhost' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        events.length = 0
        cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })

        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'session-updated') {
            return
        }

        expect(update.data).toEqual(expect.objectContaining({ active: true }))
    })

    it('emits full active machine object on machine alive', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new MachineCache(store, createPublisher(events))

        const machine = cache.getOrCreateMachine(
            'machine-alive-test',
            { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
            null,
            'default'
        )

        events.length = 0
        cache.handleMachineAlive({ machineId: machine.id, time: Date.now() })

        const update = events.find((event) => event.type === 'machine-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'machine-updated') {
            return
        }

        expect(update.data).toEqual(expect.objectContaining({ id: machine.id, active: true }))
    })

    it('stores health from machine alive and rebroadcasts when it changes', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new MachineCache(store, createPublisher(events))

        const machine = cache.getOrCreateMachine(
            'machine-health-test',
            { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
            null,
            'default'
        )

        events.length = 0
        cache.handleMachineAlive({
            machineId: machine.id,
            time: Date.now(),
            health: {
                collectedAt: Date.now(),
                load1m: 0.4,
                cpuCount: 8,
                memoryPercent: 55
            }
        })

        const updated = cache.getMachine(machine.id)
        expect(updated?.health).toEqual(expect.objectContaining({ load1m: 0.4, cpuCount: 8 }))

        events.length = 0
        cache.handleMachineAlive({
            machineId: machine.id,
            time: Date.now() + 1,
            health: {
                collectedAt: Date.now() + 1,
                load1m: 2.1,
                cpuCount: 8,
                memoryPercent: 80
            }
        })

        const healthUpdate = events.find((event) => event.type === 'machine-updated')
        expect(healthUpdate).toBeDefined()
        if (!healthUpdate || healthUpdate.type !== 'machine-updated' || !healthUpdate.data || typeof healthUpdate.data !== 'object') {
            return
        }
        expect(healthUpdate.data).toEqual(expect.objectContaining({
            health: expect.objectContaining({ load1m: 2.1, memoryPercent: 80 })
        }))
    })

    it('marks session thinking immediately when a user message is accepted by the hub', async () => {
        const store = new Store(':memory:')
        const emittedSocketUpdates: unknown[] = []
        const io = {
            of: () => ({
                to: () => ({
                    emit: (_event: string, payload: unknown) => {
                        emittedSocketUpdates.push(payload)
                    }
                })
            })
        }
        const engine = new SyncEngine(
            store,
            io as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        const events: SyncEvent[] = []
        const unsubscribe = engine.subscribe((event) => {
            events.push(event)
        })

        try {
            const session = engine.getOrCreateSession(
                'session-send-thinking',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                { requests: {}, completedRequests: {} },
                'default'
            )

            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            const activeAtBeforeSend = engine.getSession(session.id)?.activeAt
            events.length = 0

            await engine.sendMessage(session.id, {
                text: 'hello from web',
                sentFrom: 'webapp'
            })

            expect(engine.getSession(session.id)?.thinking).toBe(true)
            expect(engine.getSession(session.id)?.activeAt).toBe(activeAtBeforeSend)
            expect(emittedSocketUpdates.length).toBeGreaterThan(0)

            const update = events.find((event) => {
                return event.type === 'session-updated'
                    && typeof event.data === 'object'
                    && event.data !== null
                    && (event.data as { thinking?: unknown }).thinking === true
            })
            expect(update).toBeDefined()
            if (!update || update.type !== 'session-updated') {
                return
            }

            expect(update.data).toEqual(expect.objectContaining({ thinking: true }))
            expect(update.data).not.toHaveProperty('activeAt')
            expect((update.data as { updatedAt?: unknown }).updatedAt).toEqual(expect.any(Number))
        } finally {
            unsubscribe()
            engine.stop()
        }
    })

    it('does not revive inactive sessions or refresh liveness when marking queued thinking', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now() - 30_000

        const session = cache.getOrCreateSession(
            'session-queued-thinking-inactive',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        cache.handleSessionAlive({ sid: session.id, time: now, thinking: false })
        cache.handleSessionEnd({ sid: session.id, time: now + 1_000 })
        const inactive = cache.getSession(session.id)
        expect(inactive?.active).toBe(false)
        const inactiveActiveAt = inactive?.activeAt

        events.length = 0
        cache.markMessageQueued(session.id, now + 2_000)

        const updated = cache.getSession(session.id)
        expect(updated?.active).toBe(false)
        expect(updated?.thinking).toBe(false)
        expect(updated?.activeAt).toBe(inactiveActiveAt)
        expect(events.find((event) => event.type === 'session-updated')).toBeUndefined()
    })

    it('publishes a complete stopped state when inactivity expiry ends a running task', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()
        const session = cache.getOrCreateSession(
            'session-expire-complete-state',
            { path: '/tmp/project', host: 'localhost' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        cache.handleSessionAlive({ sid: session.id, time: now - 31_000, thinking: true })
        cache.applyBackgroundTaskDelta(session.id, { started: 2, completed: 0 })
        cache.getSession(session.id)!.activeAt = now - 31_000
        events.length = 0

        expect(cache.expireInactive(now)).toEqual([session.id])
        expect(cache.getSession(session.id)).toEqual(expect.objectContaining({
            active: false,
            thinking: false,
            backgroundTaskCount: 0
        }))

        const update = events.find((event) => event.type === 'session-updated')
        expect(update?.type === 'session-updated' ? update.data : null).toEqual({
            active: false,
            thinking: false,
            backgroundTaskCount: 0
        })
    })

    it('reconciles an explicit session end from running to an archived stopped state', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        const now = Date.now()

        try {
            const session = engine.getOrCreateSession(
                'session-explicit-end-archive',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    lifecycleState: 'running',
                    lifecycleStateSince: now - 1_000
                },
                null,
                'default'
            )
            engine.handleSessionAlive({ sid: session.id, time: now - 100, thinking: true })

            engine.handleSessionEnd({ sid: session.id, time: now, reason: 'completed' })

            expect(engine.getSession(session.id)).toEqual(expect.objectContaining({
                active: false,
                thinking: false,
                metadata: expect.objectContaining({
                    lifecycleState: 'archived',
                    archivedBy: 'hub',
                    archiveReason: 'Session completed'
                })
            }))
        } finally {
            engine.stop()
        }
    })

    it('does not let a replayed old session end stop a newer runner generation', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()
        const session = cache.getOrCreateSession(
            'session-stale-explicit-end',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                lifecycleState: 'running',
                lifecycleStateSince: now
            },
            null,
            'default'
        )
        cache.handleSessionAlive({ sid: session.id, time: now, thinking: true })
        events.length = 0

        expect(cache.handleSessionEnd({ sid: session.id, time: now - 60_000 })).toBeNull()
        expect(cache.getSession(session.id)).toEqual(expect.objectContaining({
            active: true,
            thinking: true,
            metadata: expect.objectContaining({ lifecycleState: 'running' })
        }))
        expect(events).toEqual([])
    })

    it('uses runtime ownership instead of cross-host clocks for stale ends', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()
        const session = cache.getOrCreateSession(
            'session-runtime-owner',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )

        expect(cache.handleSessionAlive({
            sid: session.id,
            time: now - 120_000,
            thinking: true,
            runtimeId: 'runtime-b',
            runtimeGeneration: 2
        })).toBe(true)
        events.length = 0

        expect(cache.handleSessionEnd({
            sid: session.id,
            time: now + 60_000,
            runtimeId: 'runtime-a',
            runtimeGeneration: 1
        })).toBeNull()
        expect(cache.getSession(session.id)).toEqual(expect.objectContaining({
            active: true,
            thinking: true
        }))
        expect(events).toEqual([])
    })

    it('does not let an unseen stale runtime steal an active owner after Hub restart', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()
        const session = cache.getOrCreateSession(
            'session-runtime-restart-owner',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        cache.handleSessionAlive({
            sid: session.id,
            time: now,
            thinking: true,
            runtimeId: 'runtime-current',
            runtimeGeneration: 1
        })
        events.length = 0

        expect(cache.handleSessionEnd({
            sid: session.id,
            time: now - 60_000,
            runtimeId: 'runtime-stale',
            runtimeGeneration: 2
        })).toBeNull()
        expect(cache.handleSessionAlive({
            sid: session.id,
            time: now - 59_000,
            thinking: false,
            runtimeId: 'runtime-stale',
            runtimeGeneration: 2
        })).toBe(false)
        expect(cache.getSession(session.id)).toEqual(expect.objectContaining({
            active: true,
            thinking: true
        }))
        expect(events).toEqual([])
    })

    it('does not resurrect an ended runtime, but lets a new runtime take ownership', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()
        const session = cache.getOrCreateSession(
            'session-ended-runtime-owner',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                lifecycleState: 'running',
                lifecycleStateSince: now
            },
            null,
            'default'
        )
        const runtimeA = {
            runtimeId: 'runtime-a',
            runtimeGeneration: 1
        }

        expect(cache.handleSessionAlive({
            sid: session.id,
            time: now,
            thinking: true,
            ...runtimeA
        })).toBe(true)
        expect(cache.handleSessionEnd({
            sid: session.id,
            time: now + 1,
            ...runtimeA
        })).not.toBeNull()
        expect(cache.getSession(session.id)?.active).toBe(false)

        expect(cache.handleSessionAlive({
            sid: session.id,
            time: now + 2,
            thinking: false,
            ...runtimeA
        })).toBe(false)
        expect(cache.getSession(session.id)?.active).toBe(false)

        const runtimeB = {
            runtimeId: 'runtime-b',
            runtimeGeneration: 2
        }
        expect(cache.isRuntimeMetadataUpdateAllowed({
            sid: session.id,
            metadata: {
                lifecycleState: 'running',
                lifecycleStateSince: now + 2,
                runtimeId: runtimeB.runtimeId
            },
            ...runtimeB
        })).toBe(true)
        commitRunningRuntime(cache, store, session.id, runtimeB, now + 2)
        expect(cache.handleSessionAlive({
            sid: session.id,
            time: now - 60_000,
            thinking: false,
            ...runtimeB
        })).toBe(true)
        expect(cache.getSession(session.id)?.active).toBe(true)
    })

    it('does not let an older runtime reclaim the session after a newer owner ended', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()
        const session = cache.getOrCreateSession(
            'session-ended-newer-owner-watermark',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                lifecycleState: 'running',
                lifecycleStateSince: now
            },
            null,
            'default'
        )
        const runtimeB = { runtimeId: 'runtime-b', runtimeGeneration: 2 }

        expect(cache.handleSessionAlive({
            sid: session.id,
            time: now,
            thinking: true,
            ...runtimeB
        })).toBe(true)
        expect(cache.handleSessionEnd({
            sid: session.id,
            time: now + 1,
            ...runtimeB
        })).not.toBeNull()

        const runtimeA = { runtimeId: 'runtime-a', runtimeGeneration: 1 }
        expect(cache.isRuntimeMetadataUpdateAllowed({
            sid: session.id,
            metadata: {
                lifecycleState: 'running',
                lifecycleStateSince: now + 2
            },
            ...runtimeA
        })).toBe(false)
        expect(cache.handleSessionAlive({
            sid: session.id,
            time: now + 2,
            thinking: false,
            ...runtimeA
        })).toBe(false)
        expect(cache.getSession(session.id)?.active).toBe(false)

        const runtimeC = { runtimeId: 'runtime-c', runtimeGeneration: 3 }
        expect(cache.isRuntimeMetadataUpdateAllowed({
            sid: session.id,
            metadata: {
                lifecycleState: 'running',
                lifecycleStateSince: now + 3
            },
            ...runtimeC
        })).toBe(true)
        commitRunningRuntime(cache, store, session.id, runtimeC, now + 3)
        expect(cache.handleSessionAlive({
            sid: session.id,
            time: now + 3,
            thinking: false,
            ...runtimeC
        })).toBe(true)
        expect(cache.getSession(session.id)?.active).toBe(true)
    })

    it('does not let an older runtime reclaim the session after a newer owner expired', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()
        const session = cache.getOrCreateSession(
            'session-expired-newer-owner-watermark',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                lifecycleState: 'running',
                lifecycleStateSince: now - 60_000
            },
            null,
            'default'
        )
        const runtimeB = { runtimeId: 'runtime-b', runtimeGeneration: 2 }

        expect(cache.handleSessionAlive({
            sid: session.id,
            time: now - 31_000,
            thinking: true,
            ...runtimeB
        })).toBe(true)
        cache.getSession(session.id)!.activeAt = now - 31_000
        expect(cache.expireInactive(now)).toEqual([session.id])

        const runtimeA = { runtimeId: 'runtime-a', runtimeGeneration: 1 }
        expect(cache.isRuntimeMetadataUpdateAllowed({
            sid: session.id,
            metadata: {
                lifecycleState: 'running',
                lifecycleStateSince: now + 1
            },
            ...runtimeA
        })).toBe(false)
        expect(cache.handleSessionAlive({
            sid: session.id,
            time: now + 1,
            thinking: false,
            ...runtimeA
        })).toBe(false)
        expect(cache.getSession(session.id)?.active).toBe(false)

        const runtimeC = { runtimeId: 'runtime-c', runtimeGeneration: 3 }
        expect(cache.isRuntimeMetadataUpdateAllowed({
            sid: session.id,
            metadata: {
                lifecycleState: 'running',
                lifecycleStateSince: now + 2
            },
            ...runtimeC
        })).toBe(true)
        commitRunningRuntime(cache, store, session.id, runtimeC, now + 2)
        expect(cache.handleSessionAlive({
            sid: session.id,
            time: now + 2,
            thinking: false,
            ...runtimeC
        })).toBe(true)
        expect(cache.getSession(session.id)?.active).toBe(true)
    })

    it('rejects a late legacy heartbeat after end, but lets a reopened process publish running first', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        const now = Date.now()

        try {
            const session = engine.getOrCreateSession(
                'session-legacy-reopen',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    lifecycleState: 'running',
                    lifecycleStateSince: now
                },
                null,
                'default'
            )

            expect(engine.handleSessionAlive({
                sid: session.id,
                time: now,
                thinking: true
            })).toBe(true)
            expect(engine.handleSessionEnd({
                sid: session.id,
                time: now + 1,
                reason: 'completed'
            })).toBe(true)
            expect(engine.getSession(session.id)).toEqual(expect.objectContaining({
                active: false,
                metadata: expect.objectContaining({ lifecycleState: 'archived' })
            }))

            // A buffered heartbeat from the process that just ended must not
            // create active=true + lifecycleState=archived split brain.
            expect(engine.handleSessionAlive({
                sid: session.id,
                time: now + 2,
                thinking: false
            })).toBe(false)
            expect(engine.getSession(session.id)?.active).toBe(false)

            // Legacy clients have no runtime owner token. Their normal reopen
            // sequence still works because bootstrap writes `running` before
            // the first keepalive.
            const archived = store.sessions.getSession(session.id)!
            const update = store.sessions.updateSessionMetadata(
                session.id,
                {
                    ...(archived.metadata as Record<string, unknown>),
                    lifecycleState: 'running',
                    lifecycleStateSince: now + 3
                },
                archived.metadataVersion,
                archived.namespace
            )
            expect(update.result).toBe('success')
            engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id })

            expect(engine.handleSessionAlive({
                sid: session.id,
                time: now + 3,
                thinking: false
            })).toBe(true)
            expect(engine.getSession(session.id)).toEqual(expect.objectContaining({
                active: true,
                metadata: expect.objectContaining({ lifecycleState: 'running' })
            }))
        } finally {
            engine.stop()
        }
    })

    it('accepts a cold-cache sourced end before the reconnect keepalive', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()
        const session = cache.getOrCreateSession(
            'session-cold-runtime-end',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        cache.markSessionActive(session.id, now - 31_000)
        cache.getSession(session.id)!.activeAt = now - 31_000
        expect(cache.expireInactive(now)).toEqual([session.id])
        const source = { runtimeId: 'runtime-a', runtimeGeneration: 1 }
        expect(cache.handleSessionEnd({ sid: session.id, time: now, ...source })).not.toBeNull()
        expect(cache.handleSessionAlive({
            sid: session.id,
            time: now + 1,
            thinking: false,
            ...source
        })).toBe(false)
        expect(cache.getSession(session.id)?.active).toBe(false)
    })

    it('persists runtime ownership and rejects a mismatched buffered end after Hub restart', () => {
        const store = new Store(':memory:')
        const now = Date.now()
        const initialCache = new SessionCache(store, createPublisher([]))
        const session = initialCache.getOrCreateSession(
            'session-durable-runtime-owner',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                lifecycleState: 'running',
                lifecycleStateSince: now
            },
            null,
            'default'
        )
        const currentRuntime = { runtimeId: 'runtime-current', runtimeGeneration: 1 }

        expect(initialCache.handleSessionAlive({
            sid: session.id,
            time: now,
            thinking: true,
            ...currentRuntime
        })).toBe(true)
        expect(store.sessions.getSession(session.id)?.metadata).toEqual(expect.objectContaining({
            runtimeId: currentRuntime.runtimeId
        }))

        // New SessionCache = Hub process restart: runtimeOwnerBySessionId is
        // empty, but the durable incarnation still identifies the current CLI.
        const restartedCache = new SessionCache(store, createPublisher([]))
        restartedCache.reloadAll()
        expect(restartedCache.handleSessionEnd({
            sid: session.id,
            time: now + 1,
            runtimeId: 'runtime-stale',
            runtimeGeneration: 1
        })).toBeNull()
        expect(restartedCache.handleSessionAlive({
            sid: session.id,
            time: now + 1,
            thinking: false,
            runtimeId: 'runtime-stale',
            runtimeGeneration: 1
        })).toBe(false)
        expect(restartedCache.getSession(session.id)).toEqual(expect.objectContaining({
            active: false,
            metadata: expect.objectContaining({
                lifecycleState: 'running',
                runtimeId: currentRuntime.runtimeId
            })
        }))

        expect(restartedCache.handleSessionEnd({
            sid: session.id,
            time: now + 2,
            runtimeId: currentRuntime.runtimeId,
            runtimeGeneration: 2
        })).not.toBeNull()
    })

    it('rejects legacy alive and end packets after a runtime owner is durable', () => {
        const store = new Store(':memory:')
        const now = Date.now()
        const initialCache = new SessionCache(store, createPublisher([]))
        const session = initialCache.getOrCreateSession(
            'session-durable-owner-legacy-fence',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                lifecycleState: 'running',
                lifecycleStateSince: now
            },
            null,
            'default'
        )
        const owner = { runtimeId: 'runtime-current', runtimeGeneration: 1 }

        expect(initialCache.handleSessionAlive({
            sid: session.id,
            time: now,
            thinking: false,
            ...owner
        })).toBe(true)
        expect(store.sessions.getSession(session.id)?.metadata).toEqual(expect.objectContaining({
            runtimeId: owner.runtimeId
        }))

        // Simulate a Hub restart: the in-memory owner map is empty, so the
        // durable metadata must be sufficient to fence an orphaned old CLI.
        const events: SyncEvent[] = []
        const restartedCache = new SessionCache(store, createPublisher(events))
        restartedCache.reloadAll()
        events.length = 0

        expect(restartedCache.handleSessionAlive({
            sid: session.id,
            time: now + 1,
            thinking: true
        })).toBe(false)
        expect(restartedCache.getSession(session.id)).toEqual(expect.objectContaining({
            active: false,
            thinking: false,
            metadata: expect.objectContaining({
                lifecycleState: 'running',
                runtimeId: owner.runtimeId
            })
        }))
        expect(events).toEqual([])

        // The legitimate owner may reconnect and reclaim liveness; a legacy
        // end still cannot stop it or trigger Hub-side archival.
        expect(restartedCache.handleSessionAlive({
            sid: session.id,
            time: now + 2,
            thinking: true,
            ...owner
        })).toBe(true)
        events.length = 0

        expect(restartedCache.handleSessionEnd({
            sid: session.id,
            time: now + 3
        })).toBeNull()
        expect(restartedCache.getSession(session.id)).toEqual(expect.objectContaining({
            active: true,
            thinking: true,
            metadata: expect.objectContaining({
                lifecycleState: 'running',
                runtimeId: owner.runtimeId
            })
        }))
        expect(events).toEqual([])
    })

    it('does not commit a metadata takeover until the versioned write succeeds', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()
        const session = cache.getOrCreateSession(
            'session-metadata-claim-commit',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                lifecycleState: 'running',
                lifecycleStateSince: now
            },
            null,
            'default'
        )
        const runtimeA = { runtimeId: 'runtime-a', runtimeGeneration: 1 }
        expect(cache.handleSessionAlive({
            sid: session.id,
            time: now,
            thinking: true,
            ...runtimeA
        })).toBe(true)
        expect(cache.handleSessionEnd({ sid: session.id, time: now + 1, ...runtimeA })).not.toBeNull()

        // Gate approval alone represents a write that later returns
        // version-mismatch. It must not advance the ownership watermark to 3.
        expect(cache.isRuntimeMetadataUpdateAllowed({
            sid: session.id,
            metadata: {
                lifecycleState: 'running',
                lifecycleStateSince: now + 3,
                runtimeId: 'runtime-c'
            },
            runtimeId: 'runtime-c',
            runtimeGeneration: 3
        })).toBe(true)

        const runtimeB = { runtimeId: 'runtime-b', runtimeGeneration: 2 }
        expect(cache.isRuntimeMetadataUpdateAllowed({
            sid: session.id,
            metadata: {
                lifecycleState: 'running',
                lifecycleStateSince: now + 2,
                runtimeId: runtimeB.runtimeId
            },
            ...runtimeB
        })).toBe(true)
        commitRunningRuntime(cache, store, session.id, runtimeB, now + 2)
        expect(cache.handleSessionAlive({
            sid: session.id,
            time: now + 2,
            thinking: false,
            ...runtimeB
        })).toBe(true)
        expect(store.sessions.getSession(session.id)?.metadata).toEqual(expect.objectContaining({
            runtimeId: 'runtime-b'
        }))
    })

    it('orders mismatched cold-cache running claims by lifecycle start time', () => {
        const store = new Store(':memory:')
        const initialCache = new SessionCache(store, createPublisher([]))
        const session = initialCache.getOrCreateSession(
            'session-cold-running-claim-order',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                lifecycleState: 'running',
                lifecycleStateSince: 200
            },
            null,
            'default'
        )
        expect(initialCache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: true,
            runtimeId: 'runtime-current',
            runtimeGeneration: 1
        })).toBe(true)

        const restartedCache = new SessionCache(store, createPublisher([]))
        restartedCache.reloadAll()
        expect(restartedCache.isRuntimeMetadataUpdateAllowed({
            sid: session.id,
            metadata: {
                lifecycleState: 'running',
                lifecycleStateSince: 100,
                runtimeId: 'runtime-stale'
            },
            runtimeId: 'runtime-stale',
            runtimeGeneration: 1
        })).toBe(false)
        expect(restartedCache.isRuntimeMetadataUpdateAllowed({
            sid: session.id,
            metadata: {
                lifecycleState: 'running',
                lifecycleStateSince: 200,
                runtimeId: 'runtime-equal'
            },
            runtimeId: 'runtime-equal',
            runtimeGeneration: 2
        })).toBe(false)
        expect(restartedCache.isRuntimeMetadataUpdateAllowed({
            sid: session.id,
            metadata: {
                lifecycleState: 'running',
                lifecycleStateSince: 201,
                runtimeId: 'runtime-new'
            },
            runtimeId: 'runtime-new',
            runtimeGeneration: 3
        })).toBe(true)
    })

    it('does not let an old cold-cache running write revive an archived durable owner', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const session = cache.getOrCreateSession(
            'session-cold-archived-claim-order',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                lifecycleState: 'archived',
                lifecycleStateSince: 200,
                runtimeId: 'runtime-archived'
            },
            null,
            'default'
        )

        expect(cache.isRuntimeMetadataUpdateAllowed({
            sid: session.id,
            metadata: {
                lifecycleState: 'running',
                lifecycleStateSince: 100,
                runtimeId: 'runtime-archived'
            },
            runtimeId: 'runtime-archived',
            runtimeGeneration: 1
        })).toBe(false)
        expect(cache.isRuntimeMetadataUpdateAllowed({
            sid: session.id,
            metadata: {
                lifecycleState: 'running',
                lifecycleStateSince: 100,
                runtimeId: 'runtime-stale'
            },
            runtimeId: 'runtime-stale',
            runtimeGeneration: 1
        })).toBe(false)
        expect(cache.isRuntimeMetadataUpdateAllowed({
            sid: session.id,
            metadata: {
                lifecycleState: 'running',
                lifecycleStateSince: 201,
                runtimeId: 'runtime-new'
            },
            runtimeId: 'runtime-new',
            runtimeGeneration: 2
        })).toBe(true)
    })

    it('rejects an archived idle duplicate end but still clears archived live state', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()
        const runtime = { runtimeId: 'runtime-ended', runtimeGeneration: 1 }
        const session = cache.getOrCreateSession(
            'session-archived-duplicate-end',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                lifecycleState: 'archived',
                lifecycleStateSince: now,
                runtimeId: runtime.runtimeId
            },
            null,
            'default'
        )

        expect(cache.handleSessionEnd({ sid: session.id, time: now + 1, ...runtime })).toBeNull()
        expect(cache.handleSessionEnd({ sid: session.id, time: now + 1 })).toBeNull()

        cache.markSessionActive(session.id, now + 2)
        expect(cache.getSession(session.id)?.active).toBe(true)
        expect(cache.handleSessionEnd({ sid: session.id, time: now + 3, ...runtime })).not.toBeNull()
        expect(cache.getSession(session.id)).toEqual(expect.objectContaining({
            active: false,
            thinking: false,
            backgroundTaskCount: 0,
            metadata: expect.objectContaining({ lifecycleState: 'archived' })
        }))
    })

    it('archives across clock skew and refreshes a no-native-id runtime takeover before alive', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        const now = Date.now()

        try {
            const session = engine.getOrCreateSession(
                'session-runtime-clock-skew-end',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    lifecycleState: 'running',
                    lifecycleStateSince: now + 120_000
                },
                null,
                'default'
            )
            const source = { runtimeId: 'runtime-a', runtimeGeneration: 1 }
            engine.handleSessionAlive({
                sid: session.id,
                time: now,
                thinking: true,
                ...source
            })

            expect(engine.handleSessionEnd({
                sid: session.id,
                time: now - 120_000,
                reason: 'completed',
                ...source
            })).toBe(true)
            expect(engine.getSession(session.id)).toEqual(expect.objectContaining({
                active: false,
                metadata: expect.objectContaining({
                    lifecycleState: 'archived',
                    archiveReason: 'Session completed'
                })
            }))
            expect(engine.isSessionMetadataUpdateAllowed({
                sid: session.id,
                runtimeId: source.runtimeId,
                runtimeGeneration: source.runtimeGeneration,
                metadata: {
                    lifecycleState: 'running',
                    lifecycleStateSince: now + 180_000
                }
            })).toBe(false)
            expect(engine.isSessionMetadataUpdateAllowed({
                sid: session.id,
                runtimeId: source.runtimeId,
                runtimeGeneration: source.runtimeGeneration,
                metadata: {
                    lifecycleState: 'archived',
                    lifecycleStateSince: now + 180_000
                }
            })).toBe(true)

            const runtimeB = { runtimeId: 'runtime-b', runtimeGeneration: 2 }
            const archivedSince = engine.getSession(session.id)?.metadata?.lifecycleStateSince ?? now
            const runtimeBStartedAt = archivedSince + 1
            expect(engine.isSessionMetadataUpdateAllowed({
                sid: session.id,
                ...runtimeB,
                metadata: {
                    lifecycleState: 'running',
                    lifecycleStateSince: runtimeBStartedAt,
                    runtimeId: runtimeB.runtimeId
                }
            })).toBe(true)
            const archived = store.sessions.getSession(session.id)!
            const update = store.sessions.updateSessionMetadata(
                session.id,
                {
                    ...(archived.metadata as Record<string, unknown>),
                    lifecycleState: 'running',
                    lifecycleStateSince: runtimeBStartedAt,
                    runtimeId: runtimeB.runtimeId
                },
                archived.metadataVersion,
                archived.namespace
            )
            expect(update.result).toBe('success')
            void engine.handleSessionMetadataUpdated({
                sid: session.id,
                namespace: archived.namespace,
                metadata: update.result === 'success' ? update.value : null,
                ...runtimeB
            })
            expect(engine.handleSessionAlive({
                sid: session.id,
                time: now - 240_000,
                thinking: false,
                ...runtimeB
            })).toBe(true)
            expect(engine.isSessionMetadataUpdateAllowed({
                sid: session.id,
                runtimeId: source.runtimeId,
                runtimeGeneration: source.runtimeGeneration,
                metadata: {
                    lifecycleState: 'running',
                    lifecycleStateSince: now + 2
                }
            })).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('does not regress end ordering when an older heartbeat arrives late', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()
        const session = cache.getOrCreateSession(
            'session-out-of-order-heartbeat',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )

        cache.handleSessionAlive({ sid: session.id, time: now, thinking: true })
        cache.handleSessionAlive({ sid: session.id, time: now - 1_000, thinking: true })
        events.length = 0

        expect(cache.handleSessionEnd({ sid: session.id, time: now - 500 })).toBeNull()
        expect(cache.getSession(session.id)).toEqual(expect.objectContaining({
            active: true,
            thinking: true
        }))
        expect(events).toEqual([])
    })

    it('accepts a quick end whose client clock trails an optimistic hub activation', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()
        const session = cache.getOrCreateSession(
            'session-spawn-clock-skew',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )

        cache.markSessionActive(session.id, now)
        expect(cache.handleSessionEnd({ sid: session.id, time: now - 500 })).not.toBeNull()
        expect(cache.getSession(session.id)?.active).toBe(false)
    })

    it('keeps lifecycle running on liveness expiry but archives after a valid delayed explicit end', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        const now = Date.now()

        try {
            const session = engine.getOrCreateSession(
                'session-expiry-then-explicit-end',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    lifecycleState: 'running',
                    lifecycleStateSince: now - 40_000
                },
                null,
                'default'
            )
            engine.handleSessionAlive({ sid: session.id, time: now - 31_000, thinking: true })
            const cache = (engine as unknown as { sessionCache: SessionCache }).sessionCache
            cache.getSession(session.id)!.activeAt = now - 31_000
            cache.expireInactive(now)

            expect(engine.getSession(session.id)).toEqual(expect.objectContaining({
                active: false,
                thinking: false,
                metadata: expect.objectContaining({ lifecycleState: 'running' })
            }))

            engine.handleSessionEnd({ sid: session.id, time: now, reason: 'handoff' })
            expect(engine.getSession(session.id)?.metadata).toEqual(expect.objectContaining({
                lifecycleState: 'archived',
                archivedBy: 'hub',
                archiveReason: 'Handed off to local terminal'
            }))
        } finally {
            engine.stop()
        }
    })

    it('keeps queued thinking true across false heartbeats during the grace window', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now() - 30_000

        const session = cache.getOrCreateSession(
            'session-queued-thinking-grace',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        cache.handleSessionAlive({ sid: session.id, time: now, thinking: false })
        cache.markMessageQueued(session.id, now + 10)
        events.length = 0

        const originalNow = Date.now
        Date.now = () => now + 2_000
        try {
            cache.handleSessionAlive({ sid: session.id, time: now + 2_000, thinking: false })
        } finally {
            Date.now = originalNow
        }

        expect(cache.getSession(session.id)?.thinking).toBe(true)
        expect(events.find((event) => event.type === 'session-updated')).toBeUndefined()
    })

    it('clears queued thinking after the grace window expires', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now() - 30_000

        const session = cache.getOrCreateSession(
            'session-queued-thinking-expire',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        cache.handleSessionAlive({ sid: session.id, time: now, thinking: false })
        cache.markMessageQueued(session.id, now + 10)
        events.length = 0

        cache.handleSessionAlive({ sid: session.id, time: now + 16_000, thinking: false })

        expect(cache.getSession(session.id)?.thinking).toBe(false)
        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'session-updated') {
            return
        }
        expect(update.data).toEqual(expect.objectContaining({ thinking: false }))
    })

    it('expires queued thinking against hub time instead of client heartbeat time', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-queued-thinking-clock-skew',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        cache.handleSessionAlive({ sid: session.id, time: now, thinking: false })
        cache.markMessageQueued(session.id, now + 10)
        events.length = 0

        const originalNow = Date.now
        Date.now = () => now + 16_000
        try {
            cache.handleSessionAlive({ sid: session.id, time: now - 60_000, thinking: false })
        } finally {
            Date.now = originalNow
        }

        expect(cache.getSession(session.id)?.thinking).toBe(false)
        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'session-updated') {
            return
        }
        expect(update.data).toEqual(expect.objectContaining({ thinking: false }))
    })
})
