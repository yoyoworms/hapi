import { describe, expect, it, mock } from 'bun:test'
import type { Session } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import {
    AutoArchiveService,
    getAutoArchiveBlockReason,
    type AutoArchiveBlockReason
} from './autoArchive'
import { SyncEngine } from './syncEngine'

const NOW = 1_800_000_000_000
const IDLE_MS = 48 * 60 * 60 * 1_000

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: NOW - IDLE_MS - 10_000,
        updatedAt: NOW - IDLE_MS - 1,
        active: true,
        activeAt: NOW,
        metadata: {
            path: '/tmp/project',
            host: 'localhost',
            startedFromRunner: true,
            startedBy: 'runner',
            lifecycleState: 'running',
            lifecycleStateSince: NOW - IDLE_MS - 10_000
        },
        metadataVersion: 1,
        agentState: { controlledByUser: false, requests: {} },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: NOW,
        backgroundTaskCount: 0,
        todos: [],
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        ...overrides
    }
}

describe('getAutoArchiveBlockReason', () => {
    it('allows a remote runner session idle for the configured threshold', () => {
        expect(getAutoArchiveBlockReason(createSession(), NOW, IDLE_MS, false)).toBeNull()
    })

    it('uses lifecycle restart time as activity so reopened sessions are not immediately archived', () => {
        const session = createSession({
            metadata: {
                ...createSession().metadata!,
                lifecycleStateSince: NOW - 1_000
            }
        })

        expect(getAutoArchiveBlockReason(session, NOW, IDLE_MS, false)).toBe('not-idle-long-enough')
    })

    it('blocks every safety-sensitive session state', () => {
        const cases: Array<[Session, AutoArchiveBlockReason]> = [
            [createSession({ metadata: { path: '/tmp', host: 'local', startedBy: 'terminal', lifecycleState: 'running' } }), 'not-runner-session'],
            [createSession({ metadata: { ...createSession().metadata!, lifecycleState: 'archived' } }), 'not-running'],
            [createSession({ metadata: { ...createSession().metadata!, pinnedAt: NOW } }), 'pinned'],
            [createSession({ agentState: { controlledByUser: true, requests: {} } }), 'local-control'],
            [createSession({ thinking: true }), 'thinking'],
            [createSession({ backgroundTaskCount: 1 }), 'background-tasks'],
            [createSession({ agentState: { controlledByUser: false, requests: { request: { tool: 'Bash', arguments: {} } } } }), 'pending-request'],
            [createSession({ teamState: { teamName: 'team', members: [{ name: 'worker', status: 'active' }] } }), 'active-team-member'],
        ]

        for (const [session, expected] of cases) {
            expect(getAutoArchiveBlockReason(session, NOW, IDLE_MS, false)).toBe(expected)
        }
        expect(getAutoArchiveBlockReason(createSession(), NOW, IDLE_MS, true)).toBe('queued-message')
    })
})

describe('AutoArchiveService', () => {
    it('archives only safe idle sessions and keeps going after a per-session failure', async () => {
        const eligible = createSession({ id: 'eligible' })
        const failed = createSession({ id: 'failed' })
        const pinned = createSession({
            id: 'pinned',
            metadata: { ...createSession().metadata!, pinnedAt: NOW }
        })
        const sessions = [eligible, failed, pinned]
        const archiveSession = mock(async (sessionId: string) => {
            if (sessionId === 'failed') {
                throw new Error('RPC failed')
            }
            return true
        })
        const service = new AutoArchiveService({
            idleHours: 48,
            getSessions: () => sessions,
            getSession: (sessionId) => sessions.find((session) => session.id === sessionId),
            hasQueuedMessages: () => false,
            archiveSession,
            logger: { info: mock(() => {}), warn: mock(() => {}) }
        })

        await expect(service.sweep(NOW)).resolves.toEqual(['eligible'])
        expect(archiveSession).toHaveBeenCalledTimes(2)
        expect(archiveSession).toHaveBeenCalledWith(
            'eligible',
            'Auto-archived after 48 hours of inactivity',
            expect.objectContaining({
                checkedAt: NOW,
                idleMs: IDLE_MS,
                updatedAt: eligible.updatedAt
            })
        )
    })

    it('does nothing when disabled', async () => {
        const archiveSession = mock(async () => true)
        const service = new AutoArchiveService({
            idleHours: 0,
            getSessions: () => [createSession()],
            getSession: () => createSession(),
            hasQueuedMessages: () => false,
            archiveSession
        })

        await expect(service.sweep(NOW)).resolves.toEqual([])
        expect(archiveSession).not.toHaveBeenCalled()
    })
})

describe('SyncEngine auto-archive integration', () => {
    it('kills the runner with the automatic reason and persists archived metadata', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
            { autoArchiveIdleHours: 48 }
        )
        const killSession = mock(async (_sessionId: string, _reason?: string) => {})
        ;(engine as unknown as {
            rpcGateway: { killSession: typeof killSession }
        }).rpcGateway.killSession = killSession

        try {
            const session = engine.getOrCreateSession(
                'auto-archive-integration',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    startedFromRunner: true,
                    startedBy: 'runner',
                    lifecycleState: 'running',
                    lifecycleStateSince: NOW
                },
                { controlledByUser: false, requests: {} },
                'default'
            )

            await expect(engine.runAutoArchiveSweep(NOW + IDLE_MS)).resolves.toEqual([session.id])
            expect(killSession).toHaveBeenCalledWith(
                session.id,
                'Auto-archived after 48 hours of inactivity'
            )
            expect(engine.getSession(session.id)?.metadata).toEqual(expect.objectContaining({
                lifecycleState: 'archived',
                archivedBy: 'hub',
                archiveReason: 'Auto-archived after 48 hours of inactivity'
            }))
        } finally {
            engine.stop()
        }
    })

    it('skips kill when a message starts after the sweep guard was captured', async () => {
        const store = new Store(':memory:')
        const io = {
            of: () => ({
                to: () => ({ emit: () => {} })
            })
        }
        const engine = new SyncEngine(
            store,
            io as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
            { autoArchiveIdleHours: 48 }
        )
        const killSession = mock(async () => {})
        let releaseFlush!: () => void
        const flushMessages = mock(async () => await new Promise<void>((resolve) => {
            releaseFlush = resolve
        }))
        const gateway = (engine as unknown as {
            rpcGateway: {
                killSession: typeof killSession
                flushMessages: typeof flushMessages
            }
        }).rpcGateway
        gateway.killSession = killSession
        gateway.flushMessages = flushMessages

        try {
            const created = engine.getOrCreateSession(
                'auto-archive-message-race',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    startedFromRunner: true,
                    startedBy: 'runner',
                    lifecycleState: 'running',
                    lifecycleStateSince: NOW - IDLE_MS - 10_000
                },
                { controlledByUser: false, requests: {} },
                'default'
            )
            const before = engine.getSession(created.id)!
            const lastActivityAt = Math.max(
                before.createdAt,
                before.updatedAt,
                before.metadata?.lifecycleStateSince ?? 0
            )
            const guard = {
                checkedAt: lastActivityAt + IDLE_MS + 1,
                idleMs: IDLE_MS,
                updatedAt: before.updatedAt,
                metadataVersion: before.metadataVersion,
                agentStateVersion: before.agentStateVersion
            }

            // sendMessage records activity synchronously before awaiting this
            // deliberately stalled flush, making the final archive guard see it.
            const originalNow = Date.now
            Date.now = () => before.updatedAt + 1
            let pendingSend: Promise<void>
            try {
                pendingSend = engine.sendMessage(created.id, {
                    text: 'arrived during sweep',
                    localId: 'race-message',
                    sentFrom: 'webapp'
                })
            } finally {
                Date.now = originalNow
            }

            const archived = await (engine as unknown as {
                archiveSessionIfStillIdle: (
                    sessionId: string,
                    reason: string,
                    candidateGuard: typeof guard
                ) => Promise<boolean>
            }).archiveSessionIfStillIdle(created.id, 'automatic', guard)

            expect(archived).toBe(false)
            expect(killSession).not.toHaveBeenCalled()

            releaseFlush()
            await pendingSend!
            expect(store.messages.getMessages(created.id).some((message) =>
                message.localId === 'race-message'
            )).toBe(true)
        } finally {
            releaseFlush?.()
            engine.stop()
        }
    })

    it('refuses a new message after the final gate reserves the session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never,
            { autoArchiveIdleHours: 48 }
        )
        let releaseKill!: () => void
        const killSession = mock(async () => await new Promise<void>((resolve) => {
            releaseKill = resolve
        }))
        ;(engine as unknown as {
            rpcGateway: { killSession: typeof killSession }
        }).rpcGateway.killSession = killSession

        try {
            const created = engine.getOrCreateSession(
                'auto-archive-reservation',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    startedFromRunner: true,
                    startedBy: 'runner',
                    lifecycleState: 'running',
                    lifecycleStateSince: NOW - IDLE_MS - 10_000
                },
                { controlledByUser: false, requests: {} },
                'default'
            )
            const before = engine.getSession(created.id)!
            const lastActivityAt = Math.max(
                before.createdAt,
                before.updatedAt,
                before.metadata?.lifecycleStateSince ?? 0
            )
            const guard = {
                checkedAt: lastActivityAt + IDLE_MS + 1,
                idleMs: IDLE_MS,
                updatedAt: before.updatedAt,
                metadataVersion: before.metadataVersion,
                agentStateVersion: before.agentStateVersion
            }
            const archivePromise = (engine as unknown as {
                archiveSessionIfStillIdle: (
                    sessionId: string,
                    reason: string,
                    candidateGuard: typeof guard
                ) => Promise<boolean>
            }).archiveSessionIfStillIdle(created.id, 'automatic', guard)

            await Promise.resolve()
            expect(killSession).toHaveBeenCalledTimes(1)
            expect((engine as unknown as { autoArchivingSessionIds: Set<string> })
                .autoArchivingSessionIds.has(created.id)).toBe(true)
            await expect(engine.sendMessage(created.id, {
                text: 'too late',
                localId: 'late-message',
                sentFrom: 'webapp'
            })).rejects.toThrow('Session is being auto-archived')
            expect(store.messages.getMessages(created.id)).toEqual([])

            releaseKill()
            await expect(archivePromise).resolves.toBe(true)
        } finally {
            releaseKill?.()
            engine.stop()
        }
    })
})
