import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, spawnMock } = vi.hoisted(() => ({
    execFileSyncMock: vi.fn(() => 'codex-cli 1.0.0'),
    spawnMock: vi.fn()
}));

vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return {
        ...actual,
        execFileSync: execFileSyncMock,
        spawn: spawnMock
    };
});

vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return { ...actual, existsSync: vi.fn(() => false) };
});

vi.mock('@/utils/process', () => ({
    killProcessByChildProcess: vi.fn(async () => true)
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() }
}));

import { CodexAppServerClient } from './codexAppServerClient';

function fakeStream(): EventEmitter & { setEncoding: ReturnType<typeof vi.fn> } {
    return Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
}

function fakeChild() {
    return Object.assign(new EventEmitter(), {
        stdin: { end: vi.fn(), write: vi.fn() },
        stdout: fakeStream(),
        stderr: fakeStream()
    });
}

describe('CodexAppServerClient process cwd', () => {
    beforeEach(() => {
        execFileSyncMock.mockClear();
        spawnMock.mockReset();
    });

    it('passes an explicit neutral cwd to the app-server process', async () => {
        spawnMock.mockReturnValue(fakeChild());
        const client = new CodexAppServerClient({
            cwd: '/neutral-home',
            env: { CODEX_HOME: '/tmp/hapi-codex-app-server-test-home' }
        });

        await client.connect();

        expect(spawnMock).toHaveBeenCalledTimes(1);
        const [command, args, options] = spawnMock.mock.calls[0] ?? [];
        expect(command).toBe('codex');
        expect(args?.at(-1)).toBe('app-server');
        expect(args).toContain('model_context_window=1000000');
        expect(options).toEqual(expect.objectContaining({ cwd: '/neutral-home' }));
        await client.disconnect();
    });
});
