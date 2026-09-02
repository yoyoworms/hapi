import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    addHapiCodexModelVariants,
    applyHapiCodexContextCatalogPolicy,
    codexEndpointNeedsInlineTools,
    buildHapiCodexModelContextArgs,
    buildHapiCodexModelContextConfig,
    buildCodexAppServerArgs,
    HAPI_CODEX_CONTEXT_DEFAULTS,
    HAPI_CODEX_SOL_ONE_MILLION_MODEL_ID,
    resolveHapiCodexModel
} from './hapiContextPolicy';

describe('buildCodexAppServerArgs', () => {
    it('loads the HAPI catalog without globally overriding every model context', () => {
        expect(HAPI_CODEX_CONTEXT_DEFAULTS).toEqual({
            contextWindow: 372_000,
            autoCompactTokenLimit: 330_000,
            autoCompactTokenLimitScope: 'total'
        });
        expect(buildCodexAppServerArgs('/tmp/hapi model catalog.json')).toEqual([
            '-c',
            'model_catalog_json="/tmp/hapi model catalog.json"',
            'app-server'
        ]);
    });

    it('keeps working without a prepared model catalog', () => {
        expect(buildCodexAppServerArgs()).not.toContain('model_catalog_json');
    });
});

describe('applyHapiCodexContextCatalogPolicy', () => {
    it('extends only Sol while preserving other upstream model contexts', () => {
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
        expect(buildHapiCodexModelContextConfig(null)).toEqual({
            model_context_window: 372_000,
            model_auto_compact_token_limit: 330_000,
            model_auto_compact_token_limit_scope: 'total'
        });
        expect(resolveHapiCodexModel('gpt-5.6-terra')).toEqual({
            model: 'gpt-5.6-terra'
        });
        expect(buildHapiCodexModelContextConfig('gpt-5.6-terra')).toEqual({});
    });
});

describe('inline tool fallback for third-party Codex endpoints', () => {
    const writeCodexHome = (configToml: string): string => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-codex-home-'));
        writeFileSync(join(home, 'config.toml'), configToml, 'utf8');
        return home;
    };

    it('detects a relay endpoint that cannot inject server-side tools', () => {
        const home = writeCodexHome([
            'model = "gpt-5.6-sol"',
            'model_provider = "hapi_endpoint"',
            '',
            '[model_providers.hapi_endpoint]',
            'base_url = "https://relay.example.com/v1"',
            'wire_api = "responses"'
        ].join('\n'));

        expect(codexEndpointNeedsInlineTools(home)).toBe(true);
    });

    it('leaves the official endpoint on the responses-lite path', () => {
        const official = writeCodexHome([
            'model_provider = "openai"',
            '',
            '[model_providers.openai]',
            'base_url = "https://api.openai.com/v1"'
        ].join('\n'));
        const defaultProvider = writeCodexHome('model = "gpt-5.6-sol"');

        expect(codexEndpointNeedsInlineTools(official)).toBe(false);
        expect(codexEndpointNeedsInlineTools(defaultProvider)).toBe(false);
        expect(codexEndpointNeedsInlineTools(join(tmpdir(), 'hapi-codex-home-missing'))).toBe(false);
    });

    it('ignores a base_url that belongs to an unselected provider', () => {
        const home = writeCodexHome([
            'model_provider = "openai"',
            '',
            '[model_providers.relay]',
            'base_url = "https://relay.example.com/v1"'
        ].join('\n'));

        expect(codexEndpointNeedsInlineTools(home)).toBe(false);
    });

    it('forces inline instructions and tools for the GPT-5.6 family', () => {
        const result = applyHapiCodexContextCatalogPolicy({
            models: [{
                slug: 'gpt-5.6-sol',
                context_window: 272_000,
                max_context_window: 272_000,
                use_responses_lite: true,
                tool_mode: 'code_mode_only'
            }, {
                slug: 'gpt-5.5',
                context_window: 272_000,
                max_context_window: 272_000,
                use_responses_lite: false,
                tool_mode: null
            }]
        }, { inlineTools: true });

        expect(result?.models).toEqual([{
            slug: 'gpt-5.6-sol',
            context_window: 372_000,
            max_context_window: 1_000_000,
            use_responses_lite: false,
            tool_mode: null
        }, {
            slug: 'gpt-5.5',
            context_window: 272_000,
            max_context_window: 272_000,
            use_responses_lite: false,
            tool_mode: null
        }]);
    });

    it('leaves the catalog request shape untouched by default', () => {
        const result = applyHapiCodexContextCatalogPolicy({
            models: [{
                slug: 'gpt-5.6-sol',
                context_window: 272_000,
                max_context_window: 272_000,
                use_responses_lite: true,
                tool_mode: 'code_mode_only'
            }]
        });

        expect(result?.models[0]).toMatchObject({
            use_responses_lite: true,
            tool_mode: 'code_mode_only'
        });
    });
});
