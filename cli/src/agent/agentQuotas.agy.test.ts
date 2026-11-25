import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', async () => ({
    ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
    spawn: spawnMock
}))
vi.mock('./agentAvailability', () => ({
    getAgentAvailability: () => ({ agent: 'agy', available: true })
}))
vi.mock('@/utils/process', () => ({ killProcessByChildProcess: vi.fn(async () => true) }))

import { probeAgyQuota } from './agentQuotas'
import { killProcessByChildProcess } from '@/utils/process'

const usage = JSON.stringify({
    command: {
        name: 'usage',
        data: {
            groups: [{
                name: 'Gemini Models',
                buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.8, reset_time: '2026-12-01T01:00:00Z' }]
            }]
        }
    }
})

function commandOutput(stdout: string, delayMs = 0) {
    const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter()
    })
    const finish = () => {
        child.stdout.emit('data', Buffer.from(stdout))
        child.emit('close', 0)
    }
    if (delayMs) setTimeout(finish, delayMs)
    else queueMicrotask(finish)
    return child
}

describe('Antigravity background quota probes', () => {
    afterEach(() => {
        spawnMock.mockReset()
        vi.mocked(killProcessByChildProcess).mockClear()
        vi.useRealTimers()
    })

    it('queries usage and credits without starting the updater or changing the session environment', async () => {
        spawnMock.mockImplementation((_command, args: string[]) => commandOutput(args[1] === '/usage'
            ? usage
            : JSON.stringify({ command: { name: 'credits', data: { remaining_credits: 1500 } } })))
        const env = { AGY_CLI_DISABLE_AUTO_UPDATE: '0', SSH_TTY: '/dev/pts/1', HAPI_SESSION_ID: 'current-session' }

        const result = await probeAgyQuota(env)

        expect(result.status).toBe('ok')
        expect(result.buckets).toEqual([expect.objectContaining({
            group: 'Gemini Models', window: '5h', usedPercent: 20, remainingPercent: 80,
            resetsAt: Date.parse('2026-12-01T01:00:00Z')
        })])
        expect(result.creditsLabel).toBe('1,500 G1 credits')
        expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([
            ['-p', '/usage', '--output-format', 'json'],
            ['-p', '/credits', '--output-format', 'json']
        ])
        for (const call of spawnMock.mock.calls) {
            expect(call[2]).toMatchObject({
                shell: false,
                windowsHide: process.platform === 'win32',
                env: { AGY_CLI_DISABLE_AUTO_UPDATE: '1', GEMINI_FORCE_FILE_STORAGE: 'true', HAPI_SESSION_ID: 'current-session' }
            })
            expect(call[2].env).not.toHaveProperty('SSH_TTY')
        }
        expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('0')
        expect(env.SSH_TTY).toBe('/dev/pts/1')
    })

    it('keeps usage available when the optional credits command cannot start', async () => {
        spawnMock.mockImplementation((_command, args: string[]) => {
            if (args[1] === '/credits') throw new Error('Credits unavailable')
            return commandOutput(usage)
        })
        const result = await probeAgyQuota({})
        expect(result.status).toBe('ok')
        expect(result.buckets).toHaveLength(1)
        expect(result.creditsLabel).toBeNull()
    })

    it('allows slow AGY startup beyond five seconds while keeping a bounded timeout', async () => {
        vi.useFakeTimers()
        spawnMock.mockImplementation(() => commandOutput(usage, 9_000))
        const result = probeAgyQuota({})
        await vi.advanceTimersByTimeAsync(9_000)
        expect((await result).status).toBe('ok')
        expect(killProcessByChildProcess).not.toHaveBeenCalled()

        spawnMock.mockImplementation(() => Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(), stderr: new EventEmitter()
        }))
        const stalled = probeAgyQuota({})
        await vi.advanceTimersByTimeAsync(15_000)
        expect(await stalled).toMatchObject({ status: 'error', note: 'Antigravity /usage timed out' })
        expect(killProcessByChildProcess).toHaveBeenCalledTimes(2)
    })
})
