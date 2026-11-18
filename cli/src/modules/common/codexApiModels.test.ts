import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexModelSummary } from '@hapi/protocol/apiTypes';
import { _resetCodexApiModelsCacheForTests, supplementCodexApiModels } from './codexApiModels';

describe('Codex API account model discovery', () => {
    const homes: string[] = [];
    const fetchMock = vi.fn<typeof fetch>();
    const native: CodexModelSummary[] = [{
        id: 'gpt-6-astra', displayName: 'GPT-6 Astra', isDefault: true,
        defaultReasoningEffort: 'high', defaultServiceTier: null,
        supportedReasoningEfforts: ['low', 'high', 'ultra'], serviceTiers: ['priority']
    }];

    async function account(baseUrl = 'https://provider.example/v1', apiKey = 'test-api-key') {
        const home = await mkdtemp(join(tmpdir(), 'hapi-api-models-'));
        homes.push(home);
        await writeFile(join(home, 'config.toml'), [
            'model_provider = "hapi_endpoint"',
            '[model_providers.hapi_endpoint]',
            `base_url = ${JSON.stringify(baseUrl)}`,
            'env_key = "HAPI_CODEX_API_KEY"'
        ].join('\n'));
        return { CODEX_HOME: home, HAPI_CODEX_ACCOUNT_KIND: 'api', HAPI_CODEX_API_KEY: apiKey };
    }

    beforeEach(() => {
        _resetCodexApiModelsCacheForTests();
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(async () => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
    });

    it('adds provider models without duplicating native entries or guessing new capabilities', async () => {
        fetchMock.mockResolvedValue(Response.json({ data: [
            { id: 'gpt-6-astra' }, { id: 'gpt-6.2-astra' }, { id: 'gpt-6.2-astra' },
            { id: 'gpt-6.2-sol' }, { id: 'gpt-image-2.5' }, { id: 'gpt-4o-audio-preview' },
            { id: 'gpt-4o-realtime-preview' }, { id: 'gpt-5.5-openai-compact' },
            { id: '' }, {}, null
        ] }));
        const result = await supplementCodexApiModels(native, await account());

        expect(result.map(model => model.id)).toEqual(['gpt-6-astra', 'gpt-6.2-astra', 'gpt-6.2-sol']);
        expect(result[0]).toBe(native[0]);
        expect(result[1]).toEqual({
            id: 'gpt-6.2-astra', displayName: 'gpt-6.2-astra', isDefault: false,
            defaultReasoningEffort: null, defaultServiceTier: null
        });
        expect(native).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledWith(new URL('https://provider.example/v1/models'), {
            headers: { Authorization: 'Bearer test-api-key', Accept: 'application/json' },
            signal: expect.any(AbortSignal), redirect: 'error'
        });
    });

    it.each(['managed', 'system'])('does not query API providers for a %s account', async kind => {
        expect(await supplementCodexApiModels(native, { HAPI_CODEX_ACCOUNT_KIND: kind })).toBe(native);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not use an inherited key when the selected account has no key', async () => {
        expect(await supplementCodexApiModels(native, await account(undefined, ''))).toBe(native);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('isolates caches by account and invalidates them when credentials or endpoint change', async () => {
        const first = await account();
        const second = await account('https://second.example/v1', 'second-key');
        fetchMock.mockImplementation(async () => Response.json({ data: [{ id: `model-${fetchMock.mock.calls.length}` }] }));

        expect((await supplementCodexApiModels([], first))[0].id).toBe('model-1');
        expect((await supplementCodexApiModels([], second))[0].id).toBe('model-2');
        expect((await supplementCodexApiModels([], first))[0].id).toBe('model-1');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect((await supplementCodexApiModels([], { ...first, HAPI_CODEX_API_KEY: 'rotated-key' }))[0].id).toBe('model-3');
        await writeFile(join(first.CODEX_HOME, 'config.toml'), [
            'model_provider = "hapi_endpoint"', '[model_providers.hapi_endpoint]',
            'base_url = "https://moved.example/v1"', 'env_key = "HAPI_CODEX_API_KEY"'
        ].join('\n'));
        expect((await supplementCodexApiModels([], first))[0].id).toBe('model-4');
    });

    it.each(['http', 'invalid-json', 'malformed', 'timeout'])('keeps native models on %s failure and retries after 30 seconds', async mode => {
        const env = await account();
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        fetchMock.mockImplementation(async () => {
            if (mode === 'timeout') throw new DOMException('Aborted', 'TimeoutError');
            if (mode === 'http') return new Response('unavailable', { status: 404 });
            if (mode === 'invalid-json') return new Response('not JSON');
            return Response.json({ data: null });
        });
        expect(await supplementCodexApiModels(native, env)).toEqual(native);
        await supplementCodexApiModels(native, env);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        clock.mockReturnValue(now + 30_001);
        fetchMock.mockResolvedValue(Response.json({ data: [{ id: 'gpt-6.2-astra' }] }));
        expect((await supplementCodexApiModels(native, env)).map(model => model.id)).toContain('gpt-6.2-astra');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refreshes the provider catalog after five minutes independently of the native cache', async () => {
        const env = await account();
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        fetchMock.mockResolvedValue(Response.json({ data: [{ id: 'gpt-6-astra' }] }));
        await supplementCodexApiModels(native, env);
        clock.mockReturnValue(now + 5 * 60_000 - 1);
        await supplementCodexApiModels(native, env);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        clock.mockReturnValue(now + 5 * 60_000 + 1);
        fetchMock.mockResolvedValue(Response.json({ data: [{ id: 'gpt-6.2-astra' }] }));
        expect((await supplementCodexApiModels(native, env)).map(model => model.id)).toContain('gpt-6.2-astra');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('coalesces concurrent provider requests', async () => {
        const env = await account();
        let finish!: (response: Response) => void;
        fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const first = supplementCodexApiModels(native, env);
        const second = supplementCodexApiModels(native, env);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        finish(Response.json({ data: [{ id: 'gpt-6.2-astra' }] }));
        expect(await first).toEqual(await second);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
