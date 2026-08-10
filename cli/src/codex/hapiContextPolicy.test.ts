import { describe, expect, it } from 'vitest';
import {
    applyHapiCodexContextCatalogPolicy,
    buildCodexAppServerArgs,
    HAPI_CODEX_CONTEXT_DEFAULTS
} from './hapiContextPolicy';

describe('buildCodexAppServerArgs', () => {
    it('applies the shared HAPI context policy before starting app-server', () => {
        expect(HAPI_CODEX_CONTEXT_DEFAULTS).toEqual({
            contextWindow: 372_000,
            autoCompactTokenLimit: 330_000,
            autoCompactTokenLimitScope: 'total'
        });
        expect(buildCodexAppServerArgs('/tmp/hapi model catalog.json')).toEqual([
            '-c',
            'model_catalog_json="/tmp/hapi model catalog.json"',
            '-c',
            'model_context_window=372000',
            '-c',
            'model_auto_compact_token_limit=330000',
            '-c',
            'model_auto_compact_token_limit_scope="total"',
            'app-server'
        ]);
    });

    it('keeps working without a prepared model catalog', () => {
        expect(buildCodexAppServerArgs()).not.toContain('model_catalog_json');
    });
});

describe('applyHapiCodexContextCatalogPolicy', () => {
    it('raises only the Sol catalog cap so Codex can honor the 372K override', () => {
        const result = applyHapiCodexContextCatalogPolicy({
            fetched_at: 'preserved',
            models: [{
                slug: 'gpt-5.6-sol',
                context_window: 272_000,
                max_context_window: 272_000,
                effective_context_window_percent: 95
            }, {
                slug: 'gpt-5.6-terra',
                context_window: 272_000,
                max_context_window: 272_000
            }]
        });

        expect(result).toEqual({
            fetched_at: 'preserved',
            models: [{
                slug: 'gpt-5.6-sol',
                context_window: 372_000,
                max_context_window: 372_000,
                effective_context_window_percent: 95
            }, {
                slug: 'gpt-5.6-terra',
                context_window: 272_000,
                max_context_window: 272_000
            }]
        });
    });

    it('preserves larger user values and rejects malformed catalogs', () => {
        expect(applyHapiCodexContextCatalogPolicy({
            models: [{
                slug: 'gpt-5.6-sol',
                context_window: 1_000_000,
                max_context_window: 1_000_000
            }]
        })?.models[0]).toMatchObject({
            context_window: 1_000_000,
            max_context_window: 1_000_000
        });
        expect(applyHapiCodexContextCatalogPolicy({ models: [null] })).toBeNull();
        expect(applyHapiCodexContextCatalogPolicy({})).toBeNull();
    });
});
