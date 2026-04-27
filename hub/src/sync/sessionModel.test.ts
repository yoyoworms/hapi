import { describe, expect, it } from 'bun:test'
import { toSessionSummary } from '@hapi/protocol'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

function userText(text: string): unknown {
    return {
        role: 'user',
        content: {
            type: 'text',
            text
        },
        meta: {
            sentFrom: 'cli'
        }
    }
}

function codexMessage(data: Record<string, unknown>): unknown {
    return {
        role: 'agent',
        content: {
            type: 'codex',
            data
        },
        meta: {
            sentFrom: 'cli'
        }
    }
}

function messageLabel(content: unknown): string {
    if (!content || typeof content !== 'object') return 'unknown'
    const record = content as Record<string, unknown>
    const inner = record.content
    if (!inner || typeof inner !== 'object') return 'unknown'
    const payload = inner as Record<string, unknown>

    if (payload.type === 'text' && typeof payload.text === 'string') {
        return `${String(record.role)}:${payload.text}`
    }

    if (payload.type === 'codex' && payload.data && typeof payload.data === 'object') {
        const data = payload.data as Record<string, unknown>
        return `codex:${String(data.type)}:${String(data.message ?? data.callId ?? data.delta ?? '')}`
    }

    return 'unknown'
}

describe('session model', () => {
    it('includes explicit model in session summaries', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-summary',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )

        expect(session.model).toBe('gpt-5.4')
        expect(toSessionSummary(session).model).toBe('gpt-5.4')
        expect(toSessionSummary(session).effort).toBeNull()
    })

    it('includes explicit effort in session summaries', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-effort-summary',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet',
            'high'
        )

        expect(session.effort).toBe('high')
        expect(toSessionSummary(session).effort).toBe('high')
    })

    it('preserves model from old session when merging into resumed session', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const oldSession = cache.getOrCreateSession(
            'session-model-old',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )
        const newSession = cache.getOrCreateSession(
            'session-model-new',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const merged = cache.getSession(newSession.id)
        expect(merged?.model).toBe('gpt-5.4')
    })

    it('deduplicates imported Codex history when merging a resumed session', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const oldSession = cache.getOrCreateSession(
            'session-codex-history-old',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                codexSessionId: 'codex-thread-history'
            },
            null,
            'default',
            'gpt-5.4'
        )
        const newSession = cache.getOrCreateSession(
            'session-codex-history-new',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                codexSessionId: 'codex-thread-history'
            },
            null,
            'default'
        )

        store.messages.addMessage(oldSession.id, userText('same prompt'), 'old-user')
        store.messages.addMessage(oldSession.id, codexMessage({
            type: 'message',
            message: 'same answer',
            id: 'old-random-id'
        }))
        store.messages.addMessage(oldSession.id, codexMessage({
            type: 'tool-call-result',
            callId: 'call-1',
            output: 'same tool result',
            id: 'old-random-tool-result-id'
        }))

        store.messages.addMessage(newSession.id, userText('same prompt'), 'new-user')
        store.messages.addMessage(newSession.id, codexMessage({
            type: 'message',
            message: 'same answer',
            id: 'new-random-id'
        }))
        store.messages.addMessage(newSession.id, codexMessage({
            type: 'tool-call-result',
            callId: 'call-1',
            output: 'same tool result',
            id: 'new-random-tool-result-id'
        }))
        store.messages.addMessage(newSession.id, codexMessage({
            type: 'message',
            message: 'new resume answer',
            id: 'new-unique-random-id'
        }))

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        expect(cache.getSession(oldSession.id)).toBeUndefined()

        const mergedMessages = store.messages.getMessages(newSession.id)
        expect(mergedMessages.map((message) => message.seq)).toEqual([1, 2, 3, 4])
        expect(mergedMessages.map((message) => messageLabel(message.content))).toEqual([
            'user:same prompt',
            'codex:message:same answer',
            'codex:tool-call-result:call-1',
            'codex:message:new resume answer'
        ])
    })

    it('deduplicates adjacent imported Codex user messages within one session', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-codex-adjacent-history',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                codexSessionId: 'codex-thread-adjacent'
            },
            null,
            'default'
        )

        const first = store.messages.addMessage(session.id, userText('same prompt'))
        const second = store.messages.addMessage(session.id, userText('same prompt'))
        store.messages.addMessage(session.id, codexMessage({
            type: 'message',
            message: 'same answer',
            id: 'first-random-id'
        }))
        const repeatedLater = store.messages.addMessage(session.id, userText('same prompt'))

        expect(second.id).toBe(first.id)
        expect(repeatedLater.id).not.toBe(first.id)
        expect(store.messages.getMessages(session.id).map((message) => messageLabel(message.content))).toEqual([
            'user:same prompt',
            'codex:message:same answer',
            'user:same prompt'
        ])
    })

    it('merges a terminal-started duplicate when native Codex session id matches', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const oldSession = engine.getOrCreateSession(
                'session-codex-old',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                null,
                'default',
                'gpt-5.4'
            )
            const newSession = engine.getOrCreateSession(
                'session-codex-new',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                null,
                'default'
            )

            await engine.handleSessionMetadataUpdated({
                sid: newSession.id,
                namespace: 'default',
                metadata: newSession.metadata
            })

            expect(engine.getSession(oldSession.id)).toBeUndefined()
            expect(engine.getSession(newSession.id)?.model).toBe('gpt-5.4')
        } finally {
            engine.stop()
        }
    })

    it('persists applied session model updates, including clear-to-auto', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-config',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet'
        )

        cache.applySessionConfig(session.id, { model: 'opus[1m]' })
        expect(cache.getSession(session.id)?.model).toBe('opus[1m]')
        expect(store.sessions.getSession(session.id)?.model).toBe('opus[1m]')

        cache.applySessionConfig(session.id, { model: null })
        expect(cache.getSession(session.id)?.model).toBeNull()
        expect(store.sessions.getSession(session.id)?.model).toBeNull()
    })

    it('persists keepalive model changes, including clearing the model', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-heartbeat',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet'
        )

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            model: null
        })

        expect(cache.getSession(session.id)?.model).toBeNull()
        expect(store.sessions.getSession(session.id)?.model).toBeNull()
    })

    it('persists applied session effort updates, including clear-to-auto', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-effort-config',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet',
            'medium'
        )

        cache.applySessionConfig(session.id, { effort: 'max' })
        expect(cache.getSession(session.id)?.effort).toBe('max')
        expect(store.sessions.getSession(session.id)?.effort).toBe('max')

        cache.applySessionConfig(session.id, { effort: null })
        expect(cache.getSession(session.id)?.effort).toBeNull()
        expect(store.sessions.getSession(session.id)?.effort).toBeNull()
    })

    it('persists keepalive effort changes, including clearing the effort', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-effort-heartbeat',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet',
            'high'
        )

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            effort: null
        })

        expect(cache.getSession(session.id)?.effort).toBeNull()
        expect(store.sessions.getSession(session.id)?.effort).toBeNull()
    })

    it('tracks collaboration mode updates in memory from config and keepalive', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-collaboration-mode',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )

        cache.applySessionConfig(session.id, { collaborationMode: 'plan' })
        expect(cache.getSession(session.id)?.collaborationMode).toBe('plan')

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            collaborationMode: 'default'
        })
        expect(cache.getSession(session.id)?.collaborationMode).toBe('default')
    })

    it('passes the stored model when respawning a resumed session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-model-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                null,
                'default',
                'gpt-5.4'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedModel: string | undefined
            let capturedEffort: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                effort?: string
            ) => {
                capturedModel = model
                capturedEffort = effort
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedModel).toBe('gpt-5.4')
            expect(capturedEffort).toBeUndefined()
        } finally {
            engine.stop()
        }
    })

    it('passes resume session ID to rpc gateway when resuming claude session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-claude-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-1'
                },
                null,
                'default',
                'sonnet'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedResumeSessionId: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: 'simple' | 'worktree',
                _worktreeName?: string,
                resumeSessionId?: string
            ) => {
                capturedResumeSessionId = resumeSessionId
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedResumeSessionId).toBe('claude-session-1')
        } finally {
            engine.stop()
        }
    })
})
