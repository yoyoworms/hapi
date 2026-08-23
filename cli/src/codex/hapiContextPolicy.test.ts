import { describe, expect, it } from 'vitest';
import {
    addHapiCodexModelVariants,
    applyHapiCodexContextCatalogPolicy,
    buildHapiCodexModelContextArgs,
    buildHapiCodexModelContextConfig,
    buildCodexAppServerArgs,
    HAPI_CODEX_CONTEXT_DEFAULTS,
    HAPI_CODEX_SOL_ONE_MILLION_MODEL_ID,
    resolveHapiCodexModel
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
    it('keeps the historical 372K default while raising Sol max capacity for the 1M variant', () => {
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
                max_context_window: 1_000_000,
                effective_context_window_percent: 95
            }, {
                slug: 'gpt-5.6-terra',
                context_window: 372_000,
                max_context_window: 372_000
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

describe('HAPI Sol model variant', () => {
    it('adds a selectable 1M row while preserving the base model as default', () => {
        const models = addHapiCodexModelVariants([{
            id: 'gpt-5.6-sol',
            displayName: 'GPT-5.6-Sol',
            isDefault: true,
            supportedReasoningEfforts: ['low']
        }]);

        expect(models).toEqual([
            expect.objectContaining({ id: 'gpt-5.6-sol', isDefault: true }),
            expect.objectContaining({
                id: HAPI_CODEX_SOL_ONE_MILLION_MODEL_ID,
                displayName: 'GPT-5.6-Sol (1M)',
                isDefault: false,
                supportedReasoningEfforts: ['low']
            })
        ]);
    });

    it('maps the virtual row to upstream Sol and per-thread context settings', () => {
        expect(resolveHapiCodexModel(HAPI_CODEX_SOL_ONE_MILLION_MODEL_ID)).toEqual({
            model: 'gpt-5.6-sol',
            contextWindow: 1_000_000,
            autoCompactTokenLimit: 900_000,
            autoCompactTokenLimitScope: 'total'
        });
        expect(buildHapiCodexModelContextConfig(HAPI_CODEX_SOL_ONE_MILLION_MODEL_ID)).toEqual({
            model_context_window: 1_000_000,
            model_auto_compact_token_limit: 900_000,
            model_auto_compact_token_limit_scope: 'total'
        });
        expect(buildHapiCodexModelContextArgs(HAPI_CODEX_SOL_ONE_MILLION_MODEL_ID)).toEqual([
            '-c', 'model_context_window=1000000',
            '-c', 'model_auto_compact_token_limit=900000',
            '-c', 'model_auto_compact_token_limit_scope="total"'
        ]);
        expect(buildHapiCodexModelContextConfig('gpt-5.6-sol')).toEqual({
            model_context_window: 372_000,
            model_auto_compact_token_limit: 330_000,
            model_auto_compact_token_limit_scope: 'total'
        });
    });
});
