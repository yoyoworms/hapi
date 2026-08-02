import { describe, expect, it } from 'vitest';
import { sanitizeCodexSessionEnvironment } from './codexProcessEnvironment';

describe('sanitizeCodexSessionEnvironment', () => {
    it('removes a managed HAPI Codex identity and its CODEX_HOME', () => {
        const source: NodeJS.ProcessEnv = {
            CODEX_HOME: '/tmp/hapi-managed-account',
            HAPI_CODEX_ACCOUNT_ID: 'managed-account',
            HAPI_CODEX_ACCOUNT_LABEL: 'managed@example.com',
            HAPI_CODEX_ACCOUNT_KIND: 'managed',
            HAPI_CODEX_API_KEY: 'secret',
            HAPI_CODEX_RESUME_PATH: '/tmp/migrated-thread.jsonl',
            HAPI_CODEX_APP_SERVER_BIN: '/opt/codex',
            KEEP_ME: 'yes'
        };

        const sanitized = sanitizeCodexSessionEnvironment(source);

        expect(sanitized.CODEX_HOME).toBeUndefined();
        expect(sanitized.HAPI_CODEX_ACCOUNT_ID).toBeUndefined();
        expect(sanitized.HAPI_CODEX_ACCOUNT_LABEL).toBeUndefined();
        expect(sanitized.HAPI_CODEX_ACCOUNT_KIND).toBeUndefined();
        expect(sanitized.HAPI_CODEX_API_KEY).toBeUndefined();
        expect(sanitized.HAPI_CODEX_RESUME_PATH).toBeUndefined();
        expect(sanitized.HAPI_CODEX_APP_SERVER_BIN).toBe('/opt/codex');
        expect(sanitized.KEEP_ME).toBe('yes');
        expect(source.CODEX_HOME).toBe('/tmp/hapi-managed-account');
    });

    it('preserves a standalone CODEX_HOME when no HAPI session identity is present', () => {
        const sanitized = sanitizeCodexSessionEnvironment({
            CODEX_HOME: '/tmp/standalone-codex-home'
        });

        expect(sanitized.CODEX_HOME).toBe('/tmp/standalone-codex-home');
    });

    it('does not trust a legacy system label when removing session-only state', () => {
        const sanitized = sanitizeCodexSessionEnvironment({
            CODEX_HOME: '/tmp/custom-system-codex-home',
            HAPI_CODEX_ACCOUNT_ID: 'system',
            HAPI_CODEX_ACCOUNT_LABEL: 'System default',
            HAPI_CODEX_ACCOUNT_KIND: 'system',
            HAPI_CODEX_RESUME_PATH: '/tmp/migrated-thread.jsonl'
        });

        expect(sanitized.CODEX_HOME).toBeUndefined();
        expect(sanitized.HAPI_CODEX_ACCOUNT_ID).toBeUndefined();
        expect(sanitized.HAPI_CODEX_ACCOUNT_LABEL).toBeUndefined();
        expect(sanitized.HAPI_CODEX_ACCOUNT_KIND).toBeUndefined();
        expect(sanitized.HAPI_CODEX_RESUME_PATH).toBeUndefined();
    });
});
