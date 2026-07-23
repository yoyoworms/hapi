import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    CodexAccountManager,
    SYSTEM_CODEX_ACCOUNT_ID
} from './codexAccountManager';
import type {
    GetAccountRateLimitsResponse,
    GetAccountResponse
} from './appServerTypes';

type NotificationHandler = ((method: string, params: unknown) => void) | null;

class FakeAuthClient {
    notificationHandler: NotificationHandler = null;
    authenticated = false;
    disconnected = false;

    constructor(
        readonly homeDir: string,
        private readonly systemHomeDir: string
    ) {
        this.authenticated = homeDir === systemHomeDir;
    }

    setNotificationHandler(handler: NotificationHandler): void {
        this.notificationHandler = handler;
    }

    async initialize(): Promise<void> {}

    async loginAccount(): Promise<{
        type: 'chatgptDeviceCode';
        loginId: string;
        verificationUrl: string;
        userCode: string;
    }> {
        return {
            type: 'chatgptDeviceCode',
            loginId: 'upstream-login',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'ABCD-1234'
        };
    }

    async cancelAccountLogin(): Promise<void> {}

    async readAccount(): Promise<GetAccountResponse> {
        return {
            account: this.authenticated
                ? {
                    type: 'chatgpt',
                    email: this.homeDir === this.systemHomeDir
                        ? 'system@example.com'
                        : 'managed@example.com',
                    planType: 'plus'
                }
                : null,
            requiresOpenaiAuth: true
        };
    }

    async readAccountRateLimits(): Promise<GetAccountRateLimitsResponse> {
        return {
            rateLimits: {
                primary: { usedPercent: 25, resetsAt: 123 },
                secondary: { usedPercent: 50, resetsAt: 456 }
            }
        };
    }

    async disconnect(): Promise<void> {
        this.disconnected = true;
    }

    completeLogin(): void {
        this.authenticated = true;
        this.notificationHandler?.('account/login/completed', {
            loginId: 'upstream-login',
            success: true,
            error: null
        });
    }
}

async function waitForCompleted(manager: CodexAccountManager, attemptId: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const status = manager.getLoginStatus(attemptId);
        if (status.status === 'completed') return;
        if (status.status === 'error') throw new Error(status.error);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for fake account login');
}

describe('CodexAccountManager', () => {
    const cleanupPaths: string[] = [];

    afterEach(async () => {
        await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
            recursive: true,
            force: true
        })));
    });

    it('keeps the system account separate and stores managed accounts under HAPI_HOME', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'hapi-codex-accounts-'));
        cleanupPaths.push(rootDir);
        const systemHomeDir = join(rootDir, 'system-codex-home');
        await mkdir(systemHomeDir);
        const clients: FakeAuthClient[] = [];
        const manager = new CodexAccountManager({
            rootDir,
            systemHomeDir,
            clientFactory: (homeDir) => {
                const client = new FakeAuthClient(homeDir, systemHomeDir);
                clients.push(client);
                return client;
            }
        });

        const initial = await manager.listAccounts();
        expect(initial.defaultAccountId).toBe(SYSTEM_CODEX_ACCOUNT_ID);
        expect(initial.accounts).toEqual([
            expect.objectContaining({
                id: SYSTEM_CODEX_ACCOUNT_ID,
                kind: 'system',
                label: 'system@example.com',
                authenticated: true
            })
        ]);

        const login = await manager.startLogin();
        expect(login).toMatchObject({
            success: true,
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'ABCD-1234'
        });
        const loginClient = clients.at(-1);
        expect(loginClient).toBeDefined();
        await writeFile(join(loginClient!.homeDir, 'auth.json'), '{}');
        loginClient!.completeLogin();
        await waitForCompleted(manager, login.attemptId!);

        const completed = manager.getLoginStatus(login.attemptId!);
        expect(completed).toMatchObject({
            success: true,
            status: 'completed',
            account: {
                id: login.accountId,
                label: 'managed@example.com',
                kind: 'managed',
                authenticated: true
            }
        });

        const resolved = await manager.resolveAccount(login.accountId);
        expect(resolved).toMatchObject({
            id: login.accountId,
            kind: 'managed',
            label: 'managed@example.com'
        });
        expect(resolved.homeDir.startsWith(join(rootDir, 'codex-accounts'))).toBe(true);

        const afterDefault = await manager.setDefaultAccount(login.accountId!);
        expect(afterDefault.defaultAccountId).toBe(login.accountId);
        expect(afterDefault.accounts.find((account) => account.id === login.accountId)?.isDefault).toBe(true);

        const afterRemove = await manager.removeAccount(login.accountId!);
        expect(afterRemove.defaultAccountId).toBe(SYSTEM_CODEX_ACCOUNT_ID);
        expect(afterRemove.accounts.map((account) => account.id)).toEqual([SYSTEM_CODEX_ACCOUNT_ID]);
    });

    it('never resolves an unknown managed account', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'hapi-codex-accounts-'));
        cleanupPaths.push(rootDir);
        const systemHomeDir = join(rootDir, 'system-codex-home');
        await mkdir(systemHomeDir);
        const manager = new CodexAccountManager({
            rootDir,
            systemHomeDir,
            clientFactory: (homeDir) => new FakeAuthClient(homeDir, systemHomeDir)
        });

        await expect(manager.resolveAccount('00000000-0000-0000-0000-000000000000'))
            .rejects.toThrow('not available');
        await expect(manager.removeAccount(SYSTEM_CODEX_ACCOUNT_ID))
            .rejects.toThrow('cannot be removed');
    });

    it('stores custom API credentials only in the isolated runner home', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'hapi-codex-accounts-'));
        cleanupPaths.push(rootDir);
        const systemHomeDir = join(rootDir, 'system-codex-home');
        await mkdir(systemHomeDir);
        const manager = new CodexAccountManager({
            rootDir,
            systemHomeDir,
            clientFactory: (homeDir) => new FakeAuthClient(homeDir, systemHomeDir)
        });

        const result = await manager.addApiEndpoint({
            label: 'Company proxy',
            baseUrl: 'https://api.example.com/v1/',
            apiKey: 'secret-key',
            model: 'company-model'
        });
        const endpoint = result.accounts.find((account) => account.kind === 'api');
        expect(endpoint).toMatchObject({
            label: 'Company proxy',
            baseUrl: 'https://api.example.com/v1',
            model: 'company-model',
            authenticated: true
        });

        const resolved = await manager.resolveAccount(endpoint!.id);
        expect(resolved).toMatchObject({
            kind: 'api',
            model: 'company-model',
            env: { HAPI_CODEX_API_KEY: 'secret-key' }
        });
        const config = await readFile(join(resolved.homeDir, 'config.toml'), 'utf8');
        expect(config).toContain('model_provider = "hapi_endpoint"');
        expect(config).toContain('wire_api = "responses"');
        expect(config).not.toContain('secret-key');
        expect(await readFile(join(resolved.homeDir, 'api-key'), 'utf8')).toBe('secret-key');
        expect((await stat(join(resolved.homeDir, 'api-key'))).mode & 0o777).toBe(0o600);
    });

    it('copies the exact rollout before switching an existing thread', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'hapi-codex-accounts-'));
        cleanupPaths.push(rootDir);
        const systemHomeDir = join(rootDir, 'system-codex-home');
        const threadId = '11111111-2222-3333-4444-555555555555';
        const sourceDirectory = join(systemHomeDir, 'sessions', '2026', '07', '23');
        await mkdir(sourceDirectory, { recursive: true });
        await writeFile(
            join(sourceDirectory, `rollout-2026-07-23T00-00-00-${threadId}.jsonl`),
            '{"type":"session_meta"}\n'
        );
        const manager = new CodexAccountManager({
            rootDir,
            systemHomeDir,
            clientFactory: (homeDir) => new FakeAuthClient(homeDir, systemHomeDir)
        });
        const result = await manager.addApiEndpoint({
            label: 'Fallback',
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'secret-key',
            model: 'fallback-model'
        });
        const targetId = result.accounts.find((account) => account.kind === 'api')!.id;

        const migratedPath = await manager.prepareSessionSwitch('system', targetId, threadId);
        expect(migratedPath).toContain(join('sessions', 'hapi-migrated', threadId));
        expect(await readFile(migratedPath!, 'utf8')).toBe('{"type":"session_meta"}\n');
    });

    it('does not overwrite a corrupted account registry', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'hapi-codex-accounts-'));
        cleanupPaths.push(rootDir);
        const systemHomeDir = join(rootDir, 'system-codex-home');
        await mkdir(systemHomeDir);
        await writeFile(join(rootDir, 'codex-accounts.json'), '{not-json');
        const manager = new CodexAccountManager({
            rootDir,
            systemHomeDir,
            clientFactory: (homeDir) => new FakeAuthClient(homeDir, systemHomeDir)
        });

        await expect(manager.setDefaultAccount(SYSTEM_CODEX_ACCOUNT_ID))
            .rejects.toThrow('Failed to read the local Codex account registry');
    });
});
