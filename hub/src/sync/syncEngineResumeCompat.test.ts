import { describe, expect, it } from 'bun:test'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'

function createEngine(): { store: Store; engine: SyncEngine } {
    const store = new Store(':memory:')
    const engine = new SyncEngine(
        store,
        {} as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )
    return { store, engine }
}

function addOnlineMachine(engine: SyncEngine): void {
    engine.getOrCreateMachine(
        'machine-1',
        { host: 'localhost', platform: 'linux', happyCliVersion: '1.0.0' },
        null,
        'default'
    )
    engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
}

function addCodexMessage(store: Store, sessionId: string, data: Record<string, unknown>): void {
    store.messages.addMessage(sessionId, {
        role: 'agent',
        content: { type: 'codex', data }
    })
}

describe('resume compatibility', () => {
    it('restarts an active Codex session and forwards token plus source/target accounts', async () => {
        const { engine } = createEngine()
        try {
            const session = engine.getOrCreateSession(
                'active-codex-account-switch',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: '11111111-1111-4111-8111-111111111111',
                    codexAccountId: 'source-account'
                },
                null,
                'default'
            )
            addOnlineMachine(engine)
            engine.handleSessionAlive({ sid: session.id, time: Date.now() })

            let killedSessionId: string | undefined
            let spawnArgs: unknown[] = []
            ;(engine as any).rpcGateway.killSession = async (id: string) => {
                killedSessionId = id
            }
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnArgs = args
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default', {
                resumeWithSessionId: '22222222-2222-4222-8222-222222222222',
                codexAccountId: 'target-account'
            })

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(killedSessionId).toBe(session.id)
            expect(spawnArgs[8]).toBe('22222222-2222-4222-8222-222222222222')
            expect(spawnArgs[18]).toBeUndefined()
            expect(spawnArgs[19]).toBe('target-account')
            expect(spawnArgs[20]).toBe('source-account')
        } finally {
            engine.stop()
        }
    })

    it('keeps the stored Codex account without marking a cross-account switch', async () => {
        const { engine } = createEngine()
        try {
            const session = engine.getOrCreateSession(
                'inactive-codex-same-account',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: '33333333-3333-4333-8333-333333333333',
                    codexAccountId: 'stored-account'
                },
                null,
                'default'
            )
            addOnlineMachine(engine)

            let spawnArgs: unknown[] = []
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnArgs = args
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            expect(await engine.resumeSession(session.id, 'default')).toEqual({
                type: 'success',
                sessionId: session.id
            })
            expect(spawnArgs[19]).toBe('stored-account')
            expect(spawnArgs[20]).toBeUndefined()
        } finally {
            engine.stop()
        }
    })

    it('accepts an explicit native token when the HAPI row has no stored agent id', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession(
                'codex-explicit-token-without-metadata-id',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex'
                },
                null,
                'default'
            )
            // A non-empty transcript rules out the separate never-started
            // fresh-spawn fallback; the explicit token must carry the resume.
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'existing conversation' }
            })
            addOnlineMachine(engine)

            let resumeSessionId: unknown
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                resumeSessionId = args[8]
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            expect(await engine.resumeSession(session.id, 'default', {
                resumeWithSessionId: '88888888-8888-4888-8888-888888888888'
            })).toEqual({ type: 'success', sessionId: session.id })
            expect(resumeSessionId).toBe('88888888-8888-4888-8888-888888888888')
        } finally {
            engine.stop()
        }
    })

    it('uses native continue only for a never-started flavor that supports it', async () => {
        const { engine } = createEngine()
        try {
            const session = engine.getOrCreateSession(
                'never-started-claude-continue',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude'
                },
                null,
                'default'
            )
            addOnlineMachine(engine)

            let spawnArgs: unknown[] = []
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnArgs = args
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            expect(await engine.resumeSession(session.id, 'default')).toEqual({
                type: 'success',
                sessionId: session.id
            })
            expect(spawnArgs[8]).toBeUndefined()
            expect(spawnArgs[18]).toBe(true)
        } finally {
            engine.stop()
        }
    })
})

describe('legacy Codex resume-id recovery', () => {
    it('recovers an unscoped output id only when a newer child names the same parent', () => {
        const { store, engine } = createEngine()
        try {
            const threadId = '44444444-4444-4444-8444-444444444444'
            const session = engine.getOrCreateSession(
                'legacy-codex-valid-pair',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )
            addCodexMessage(store, session.id, { output: { threadId } })
            addCodexMessage(store, session.id, {
                threadId: '55555555-5555-4555-8555-555555555555',
                scopeRole: 'child',
                scope: { role: 'child', parentThreadId: threadId }
            })

            const result = engine.resolveLocalResumeTarget(session.id, 'default')
            expect(result.type).toBe('success')
            if (result.type === 'success') expect(result.target.agentSessionId).toBe(threadId)
            expect(engine.getSession(session.id)?.metadata?.codexSessionId).toBe(threadId)
        } finally {
            engine.stop()
        }
    })

    it('rejects invalid or mismatched legacy Codex thread ids', () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession(
                'legacy-codex-invalid-pair',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )
            addCodexMessage(store, session.id, { output: { threadId: 'not-a-thread-id' } })
            addCodexMessage(store, session.id, {
                scopeRole: 'child',
                scope: {
                    role: 'child',
                    parentThreadId: '66666666-6666-4666-8666-666666666666'
                }
            })

            expect(engine.resolveLocalResumeTarget(session.id, 'default')).toMatchObject({
                type: 'error',
                code: 'resume_unavailable'
            })
        } finally {
            engine.stop()
        }
    })

    it('does not match a legacy pair across an explicit context-reset boundary', () => {
        const { store, engine } = createEngine()
        try {
            const threadId = '77777777-7777-4777-8777-777777777777'
            const session = engine.getOrCreateSession(
                'legacy-codex-reset-boundary',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )
            addCodexMessage(store, session.id, { output: { threadId } })
            store.messages.addMessage(session.id, {
                role: 'agent',
                content: {
                    type: 'event',
                    data: { type: 'message', message: 'Context was reset' }
                }
            })
            addCodexMessage(store, session.id, {
                scopeRole: 'child',
                scope: { role: 'child', parentThreadId: threadId }
            })

            expect(engine.resolveLocalResumeTarget(session.id, 'default')).toMatchObject({
                type: 'error',
                code: 'resume_unavailable'
            })
        } finally {
            engine.stop()
        }
    })
})
