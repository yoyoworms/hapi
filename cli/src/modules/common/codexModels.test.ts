import { beforeEach, describe, expect, it, vi } from 'vitest';

const { constructorOptions, listModelsMock } = vi.hoisted(() => ({
    constructorOptions: [] as unknown[],
    listModelsMock: vi.fn()
}));

vi.mock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return { ...actual, homedir: vi.fn(() => '/neutral-home') };
});

vi.mock('@/codex/codexAppServerClient', () => ({
    CodexAppServerClient: class {
        constructor(options: unknown) {
            constructorOptions.push(options);
        }

        async connect(): Promise<void> {}
        async initialize(): Promise<void> {}
        async listModels(): Promise<{ data: unknown[] }> {
            return listModelsMock();
        }
        async disconnect(): Promise<void> {}
    }
}));

import { listCodexModels, _resetCodexModelsCacheForTests } from './codexModels';

describe('listCodexModels cwd', () => {
    beforeEach(() => {
        constructorOptions.length = 0;
        listModelsMock.mockReset();
        _resetCodexModelsCacheForTests();
    });

    it('starts discovery from the user home instead of the caller cwd', async () => {
        listModelsMock.mockResolvedValue({ data: [] });

        await listCodexModels();

        expect(constructorOptions).toEqual([{ cwd: '/neutral-home', env: undefined }]);
    });

    it('scopes discovery to the selected account environment', async () => {
        listModelsMock.mockResolvedValue({ data: [] });

        await listCodexModels(false, {
            CODEX_HOME: '/managed/codex-home',
            OPENAI_API_KEY: 'test-key'
        });

        expect(constructorOptions).toEqual([{
            cwd: '/neutral-home',
            env: {
                CODEX_HOME: '/managed/codex-home',
                OPENAI_API_KEY: 'test-key'
            }
        }]);
    });

    it('keeps model caches isolated across selected accounts', async () => {
        listModelsMock
            .mockResolvedValueOnce({ data: [{ id: 'account-a-model' }] })
            .mockResolvedValueOnce({ data: [{ id: 'account-b-model' }] });

        const accountA = { CODEX_HOME: '/managed/account-a', OPENAI_API_KEY: 'key-a' };
        const accountB = { CODEX_HOME: '/managed/account-b', OPENAI_API_KEY: 'key-b' };

        await expect(listCodexModels(false, accountA)).resolves.toEqual([
            expect.objectContaining({ id: 'account-a-model' })
        ]);
        await expect(listCodexModels(false, accountA)).resolves.toEqual([
            expect.objectContaining({ id: 'account-a-model' })
        ]);
        await expect(listCodexModels(false, accountB)).resolves.toEqual([
            expect.objectContaining({ id: 'account-b-model' })
        ]);

        expect(constructorOptions).toHaveLength(2);
        expect(listModelsMock).toHaveBeenCalledTimes(2);
    });

    it('caches the model list within the TTL so repeat calls skip the app-server spawn', async () => {
        listModelsMock.mockResolvedValue({
            data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true }]
        });

        const first = await listCodexModels();
        const second = await listCodexModels();

        expect(first).toEqual([expect.objectContaining({
            id: 'gpt-6-astra',
            displayName: 'GPT-6 Astra (1M)',
            isDefault: false
        }), expect.objectContaining({
            id: 'gpt-5.6-sol',
            displayName: 'GPT-5.6-Sol',
            isDefault: true
        }), expect.objectContaining({
            id: 'gpt-5.6-sol[1m]',
            displayName: 'GPT-5.6-Sol (1M)',
            isDefault: false
        })]);
        expect(second).toEqual(first);
        expect(constructorOptions).toHaveLength(1);
        expect(listModelsMock).toHaveBeenCalledTimes(1);
    });

    it('keeps visible and hidden model lists in separate cache slots', async () => {
        listModelsMock.mockResolvedValue({ data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' }] });

        await listCodexModels(false);
        await listCodexModels(false);
        await listCodexModels(true);
        await listCodexModels(true);

        expect(constructorOptions).toHaveLength(2);
    });

    it('coalesces concurrent requests into a single app-server spawn', async () => {
        let resolveList: (value: { data: unknown[] }) => void = () => undefined;
        listModelsMock.mockImplementationOnce(
            () => new Promise((res) => { resolveList = res; })
        );

        const inflight1 = listCodexModels();
        const inflight2 = listCodexModels();

        // Allow the microtasks to schedule the first request before resolving it.
        await new Promise((resolve) => setImmediate(resolve));
        resolveList({ data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' }] });

        const [first, second] = await Promise.all([inflight1, inflight2]);

        expect(constructorOptions).toHaveLength(1);
        expect(listModelsMock).toHaveBeenCalledTimes(1);
        expect(first).toEqual(second);
        expect(first).toHaveLength(3);
    });

    it('expires the cache after the TTL so a later call respawns the app-server', async () => {
        vi.useFakeTimers();
        try {
            listModelsMock.mockResolvedValue({ data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' }] });

            await listCodexModels();
            expect(constructorOptions).toHaveLength(1);

            vi.advanceTimersByTime(5 * 60_000 + 1);
            await listCodexModels();
            expect(constructorOptions).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not cache empty or failed results', async () => {
        listModelsMock.mockResolvedValue({ data: [] });
        await listCodexModels();
        await listCodexModels();
        expect(constructorOptions).toHaveLength(2);

        listModelsMock.mockRejectedValue(new Error('app-server exploded'));
        await expect(listCodexModels()).rejects.toThrow('app-server exploded');
        await expect(listCodexModels()).rejects.toThrow('app-server exploded');
        expect(constructorOptions).toHaveLength(4);
    });
});
