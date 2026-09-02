import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@/claude/sdk/types'

const spawnMock = vi.fn()
const killProcessMock = vi.fn(async (child: any) => {
    child.killed = true
    child.stdout.end()
    child.emit('close', 0)
    return true
})

vi.mock('node:child_process', () => ({
    ...require('node:child_process'),
    spawn: spawnMock
}))

vi.mock('@/modules/watcher/awaitFileExist', () => ({
    awaitFileExist: async () => true
}))

vi.mock('@/utils/process', () => ({
    isProcessAlive: () => false,
    isWindows: () => false,
    killProcess: async () => true,
    killProcessByChildProcess: killProcessMock
}))

vi.mock('@/utils/bunRuntime', () => ({
    withBunRuntimeEnv: (env: NodeJS.ProcessEnv) => env
}))

function createFakeChild() {
    const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough
        stdout: PassThrough
        stderr: PassThrough
        killed: boolean
    }

    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    return child
}

afterEach(() => {
    vi.clearAllMocks()
    delete process.env.HAPI_CLAUDE_PATH
})

describe('claudeRemote/query real seam', () => {
    it('feeds the first fork prompt before waiting for the native init event', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'

        let resolveFirstMessage!: (value: { message: string; mode: { permissionMode: 'default' } }) => void
        const firstMessage = new Promise<{ message: string; mode: { permissionMode: 'default' } }>((resolve) => {
            resolveFirstMessage = resolve
        })
        let nextMessageCalls = 0
        const stdinChunks: string[] = []
        child.stdin.on('data', (chunk) => stdinChunks.push(chunk.toString()))
        const found: string[] = []
        const thinking: boolean[] = []

        const { claudeRemote } = await import('./claudeRemote')
        const runPromise = claudeRemote({
            sessionId: null,
            path: process.cwd(),
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: ['--resume', 'source-session', '--fork-session'],
            allowedTools: [],
            hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => {
                nextMessageCalls += 1
                return nextMessageCalls === 1 ? firstMessage : null
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: (sessionId) => found.push(sessionId),
            onThinkingChange: (value) => thinking.push(value),
            onMessage: () => {},
            onCompletionEvent: () => {},
            onSessionReset: () => {}
        })

        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(nextMessageCalls).toBe(1)
        expect(stdinChunks).toEqual([])
        expect(thinking).not.toContain(true)

        resolveFirstMessage({ message: 'first fork prompt', mode: { permissionMode: 'default' } })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(stdinChunks.join('')).toContain('first fork prompt')
        expect(thinking).toContain(true)

        child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'forked-session' }) + '\n')
        child.stdout.write(JSON.stringify({
            type: 'result',
            subtype: 'success',
            num_turns: 1,
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            session_id: 'forked-session'
        }) + '\n')
        await new Promise((resolve) => setTimeout(resolve, 0))
        child.emit('close', 0)

        await expect(runPromise).resolves.toBeUndefined()
        expect(found).toEqual(['forked-session'])
    }, 15_000)

    it('propagates scheduled nextMessage failures through real query prompt plumbing', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'
        const { claudeRemote } = await import('./claudeRemote')

        const received: SDKMessage[] = []
        let nextCallCount = 0

        const runPromise = claudeRemote({
            sessionId: 'session-1',
            path: process.cwd(),
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: [],
            allowedTools: [],
            hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => {
                nextCallCount += 1
                if (nextCallCount === 1) {
                    return { message: 'A', mode: { permissionMode: 'default' } }
                }
                throw new Error('next message failed')
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: (message) => {
                received.push(message)
            },
            onCompletionEvent: () => {},
            onSessionReset: () => {}
        })

        child.stdout.write(JSON.stringify({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'A_1' }]
            }
        }) + '\n')
        child.stdout.write(JSON.stringify({
            type: 'result',
            subtype: 'success',
            num_turns: 1,
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            session_id: 's-1'
        }) + '\n')

        await expect(runPromise).rejects.toThrow('next message failed')
        expect(received.map((message) => message.type)).toEqual(['assistant', 'result'])
    }, 15_000)
})
