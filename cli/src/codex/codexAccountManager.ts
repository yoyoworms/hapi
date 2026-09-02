import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

import type {
    AddCodexApiEndpointRequest,
    CodexAccountLoginStartResponse,
    CodexAccountLoginStatusResponse,
    CodexAccountSummary,
    CodexAccountsResponse
} from '@hapi/protocol/apiTypes';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { CodexAppServerClient } from './codexAppServerClient';
import { HAPI_CODEX_SOL_MODEL_ID } from './hapiContextPolicy';
import { sanitizeCodexSessionEnvironment } from './codexProcessEnvironment';
import type { GetAccountRateLimitsResponse, GetAccountResponse } from './appServerTypes';

export const SYSTEM_CODEX_ACCOUNT_ID = 'system';

type StoredCodexAccount = {
    id: string;
    label: string;
    kind?: 'managed' | 'api';
    planType?: string | null;
    baseUrl?: string;
    model?: string;
    createdAt: number;
};

type CodexAccountRegistry = {
    version: 1;
    defaultAccountId: string;
    accounts: StoredCodexAccount[];
};

type LoginAttempt = {
    id: string;
    accountId: string;
    homeDir: string;
    client: CodexAuthClient;
    upstreamLoginId: string;
    status: 'pending' | 'completed' | 'error';
    account?: CodexAccountSummary;
    error?: string;
    settling: boolean;
    timeout: ReturnType<typeof setTimeout>;
};

export type ResolvedCodexAccount = {
    id: string;
    label: string;
    kind: 'system' | 'managed' | 'api';
    homeDir: string;
    env?: Record<string, string>;
    model?: string;
};

interface CodexAuthClient {
    setNotificationHandler(handler: ((method: string, params: unknown) => void) | null): void;
    initialize(params: {
        clientInfo: { name: string; title: string; version: string };
        capabilities: { experimentalApi: boolean } | null;
    }): Promise<unknown>;
    loginAccount(params: { type: 'chatgptDeviceCode' }): Promise<{
        type: 'chatgptDeviceCode' | 'chatgpt';
        loginId: string;
        verificationUrl?: string;
        userCode?: string;
    }>;
    cancelAccountLogin(loginId: string): Promise<void>;
    readAccount(options?: { refreshToken?: boolean }): Promise<GetAccountResponse>;
    readAccountRateLimits(): Promise<GetAccountRateLimitsResponse>;
    disconnect(): Promise<void>;
}

type CodexAccountManagerOptions = {
    rootDir?: string;
    systemHomeDir?: string;
    clientFactory?: (homeDir: string) => CodexAuthClient;
};

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const FINISHED_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const API_KEY_FILE = 'api-key';
const API_KEY_ENV = 'HAPI_CODEX_API_KEY';

function expandHome(path: string): string {
    const expanded = path.replace(/^~(?=$|[\\/])/, homedir());
    return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function getSystemCodexHome(): string {
    const configured = sanitizeCodexSessionEnvironment(process.env).CODEX_HOME?.trim();
    return configured ? expandHome(configured) : join(homedir(), '.codex');
}

function defaultRegistry(): CodexAccountRegistry {
    return {
        version: 1,
        defaultAccountId: SYSTEM_CODEX_ACCOUNT_ID,
        accounts: []
    };
}

function parseRegistry(value: unknown): CodexAccountRegistry {
    if (!value || typeof value !== 'object') return defaultRegistry();
    const record = value as Record<string, unknown>;
    const accounts = Array.isArray(record.accounts)
        ? record.accounts.flatMap((candidate): StoredCodexAccount[] => {
            if (!candidate || typeof candidate !== 'object') return [];
            const account = candidate as Record<string, unknown>;
            if (
                typeof account.id !== 'string'
                || typeof account.label !== 'string'
                || typeof account.createdAt !== 'number'
            ) {
                return [];
            }
            return [{
                id: account.id,
                label: account.label,
                kind: account.kind === 'api' ? 'api' : 'managed',
                planType: typeof account.planType === 'string' ? account.planType : null,
                baseUrl: typeof account.baseUrl === 'string' ? account.baseUrl : undefined,
                model: typeof account.model === 'string' ? account.model : undefined,
                createdAt: account.createdAt
            }];
        })
        : [];
    const requestedDefault = typeof record.defaultAccountId === 'string'
        ? record.defaultAccountId
        : SYSTEM_CODEX_ACCOUNT_ID;
    return {
        version: 1,
        defaultAccountId: requestedDefault === SYSTEM_CODEX_ACCOUNT_ID
            || accounts.some((account) => account.id === requestedDefault)
            ? requestedDefault
            : SYSTEM_CODEX_ACCOUNT_ID,
        accounts
    };
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function parseLoginCompleted(params: unknown): { loginId: string | null; success: boolean; error?: string } | null {
    const record = asRecord(params);
    if (!record || typeof record.success !== 'boolean') return null;
    return {
        loginId: typeof record.loginId === 'string' ? record.loginId : null,
        success: record.success,
        error: typeof record.error === 'string' ? record.error : undefined
    };
}

function parseAccountIdentity(response: GetAccountResponse): {
    authenticated: boolean;
    label?: string;
    planType?: string | null;
} {
    const account = response.account;
    if (!account || account.type !== 'chatgpt') {
        return { authenticated: false };
    }
    return {
        authenticated: true,
        label: typeof account.email === 'string' && account.email.trim()
            ? account.email.trim()
            : undefined,
        planType: typeof account.planType === 'string' ? account.planType : null
    };
}

function parseLimit(value: unknown): { usedPercent?: number | null; resetsAt?: number | null } | null {
    const record = asRecord(value);
    if (!record) return null;
    return {
        usedPercent: typeof record.usedPercent === 'number' ? record.usedPercent : null,
        resetsAt: typeof record.resetsAt === 'number' ? record.resetsAt : null
    };
}

function escapeTomlString(value: string): string {
    return JSON.stringify(value);
}

const LEGACY_MANAGED_CONTEXT_KEYS = new Set([
    'model_context_window',
    'model_auto_compact_token_limit',
    'model_auto_compact_token_limit_scope'
]);

async function normalizeManagedAccountConfig(
    homeDir: string,
    kind: 'managed' | 'api'
): Promise<void> {
    const path = join(homeDir, 'config.toml');
    let contents: string;
    try {
        contents = await readFile(path, 'utf8');
    } catch {
        return;
    }

    const hadTrailingNewline = contents.endsWith('\n');
    const lines = contents.split(/\r?\n/).filter((line) => {
        const key = line.split('=', 1)[0]?.trim();
        return !key || !LEGACY_MANAGED_CONTEXT_KEYS.has(key);
    });
    if (hadTrailingNewline && lines.at(-1) === '') lines.pop();
    if (kind === 'managed' && !lines.some((line) => /^\s*model\s*=/.test(line))) {
        const insertAt = lines[0]?.trimStart().startsWith('#') ? 1 : 0;
        lines.splice(insertAt, 0, `model = ${escapeTomlString(HAPI_CODEX_SOL_MODEL_ID)}`);
    }
    const normalized = `${lines.join('\n')}${hadTrailingNewline ? '\n' : ''}`;
    if (normalized === contents) return;
    await writeFile(path, normalized, { encoding: 'utf8', mode: 0o600 });
    await chmod(path, 0o600).catch(() => {});
}

async function findTranscriptPath(root: string, sessionId: string): Promise<string | null> {
    const candidates: Array<{ path: string; mtimeMs: number }> = [];
    const visit = async (directory: string): Promise<void> => {
        let entries: import('node:fs').Dirent[];
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(fullPath);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !entry.name.includes(sessionId)) {
                continue;
            }
            const fileStat = await stat(fullPath).catch(() => null);
            if (fileStat) candidates.push({ path: fullPath, mtimeMs: fileStat.mtimeMs });
        }
    };
    await visit(root);
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.path ?? null;
}

export class CodexAccountManager {
    private readonly rootDir: string;
    private readonly accountsDir: string;
    private readonly registryFile: string;
    private readonly systemHomeDir: string;
    private readonly clientFactory: (homeDir: string) => CodexAuthClient;
    private readonly attempts = new Map<string, LoginAttempt>();
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(options: CodexAccountManagerOptions = {}) {
        this.rootDir = options.rootDir ?? configuration.happyHomeDir;
        this.accountsDir = join(this.rootDir, 'codex-accounts');
        this.registryFile = join(this.rootDir, 'codex-accounts.json');
        this.systemHomeDir = options.systemHomeDir ?? getSystemCodexHome();
        this.clientFactory = options.clientFactory
            ?? ((homeDir) => new CodexAppServerClient({ env: { CODEX_HOME: homeDir } }));
    }

    async listAccounts(): Promise<CodexAccountsResponse> {
        const registry = await this.readRegistry();
        const systemStored: StoredCodexAccount = {
            id: SYSTEM_CODEX_ACCOUNT_ID,
            label: 'System default',
            createdAt: 0
        };
        const summaries = await Promise.all([
            this.probeAccount(systemStored, 'system', this.systemHomeDir, registry.defaultAccountId),
            ...registry.accounts.map((account) => this.probeAccount(
                account,
                account.kind === 'api' ? 'api' : 'managed',
                this.getManagedHome(account.id),
                registry.defaultAccountId
            ))
        ]);
        return {
            success: true,
            accounts: summaries,
            defaultAccountId: registry.defaultAccountId
        };
    }

    async startLogin(): Promise<CodexAccountLoginStartResponse> {
        const accountId = randomUUID();
        const attemptId = randomUUID();
        const homeDir = this.getManagedHome(accountId);
        await mkdir(homeDir, { recursive: true, mode: 0o700 });
        await chmod(homeDir, 0o700).catch(() => {});
        await writeFile(
            join(homeDir, 'config.toml'),
            [
                '# Managed by HAPI. This account is isolated from the system Codex login.',
                `model = ${escapeTomlString(HAPI_CODEX_SOL_MODEL_ID)}`,
                'cli_auth_credentials_store = "file"',
                ''
            ].join('\n'),
            { encoding: 'utf8', mode: 0o600 }
        );

        const client = this.clientFactory(homeDir);
        try {
            await client.initialize({
                clientInfo: {
                    name: 'hapi',
                    title: 'HAPI',
                    version: configuration.currentCliVersion
                },
                capabilities: { experimentalApi: true }
            });

            const response = await client.loginAccount({ type: 'chatgptDeviceCode' });
            if (
                response.type !== 'chatgptDeviceCode'
                || !response.verificationUrl
                || !response.userCode
            ) {
                throw new Error('Codex did not return a device-code login');
            }

            const timeout = setTimeout(() => {
                void this.failAttempt(attemptId, 'Codex account login timed out');
            }, LOGIN_TIMEOUT_MS);
            timeout.unref();

            const attempt: LoginAttempt = {
                id: attemptId,
                accountId,
                homeDir,
                client,
                upstreamLoginId: response.loginId,
                status: 'pending',
                settling: false,
                timeout
            };
            this.attempts.set(attemptId, attempt);
            client.setNotificationHandler((method, params) => {
                if (method !== 'account/login/completed') return;
                const completed = parseLoginCompleted(params);
                if (!completed || completed.loginId !== response.loginId) return;
                if (completed.success) {
                    void this.completeAttempt(attemptId);
                } else {
                    void this.failAttempt(attemptId, completed.error ?? 'Codex account login failed');
                }
            });

            return {
                success: true,
                attemptId,
                accountId,
                verificationUrl: response.verificationUrl,
                userCode: response.userCode
            };
        } catch (error) {
            await client.disconnect().catch(() => {});
            await rm(homeDir, { recursive: true, force: true }).catch(() => {});
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    getLoginStatus(attemptId: string): CodexAccountLoginStatusResponse {
        const attempt = this.attempts.get(attemptId);
        if (!attempt) {
            return {
                success: false,
                status: 'not_found',
                error: 'Codex account login attempt not found'
            };
        }
        if (attempt.status === 'completed' && attempt.account) {
            return { success: true, status: 'completed', account: attempt.account };
        }
        if (attempt.status === 'error') {
            return {
                success: false,
                status: 'error',
                error: attempt.error ?? 'Codex account login failed'
            };
        }
        return { success: true, status: 'pending' };
    }

    async addApiEndpoint(input: AddCodexApiEndpointRequest): Promise<CodexAccountsResponse> {
        const baseUrl = new URL(input.baseUrl);
        if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
            throw new Error('Codex API base URL must use http or https');
        }

        const accountId = randomUUID();
        const homeDir = this.getManagedHome(accountId);
        const normalizedBaseUrl = baseUrl.toString().replace(/\/$/, '');
        await mkdir(homeDir, { recursive: true, mode: 0o700 });
        await chmod(homeDir, 0o700).catch(() => {});
        try {
            await writeFile(join(homeDir, API_KEY_FILE), input.apiKey.trim(), {
                encoding: 'utf8',
                mode: 0o600
            });
            await writeFile(
                join(homeDir, 'config.toml'),
                [
                    '# Managed by HAPI. The API key is stored only on this runner.',
                    `model = ${escapeTomlString(input.model.trim())}`,
                    'model_provider = "hapi_endpoint"',
                    '',
                    '[model_providers.hapi_endpoint]',
                    `name = ${escapeTomlString(input.label.trim())}`,
                    `base_url = ${escapeTomlString(normalizedBaseUrl)}`,
                    `env_key = ${escapeTomlString(API_KEY_ENV)}`,
                    'wire_api = "responses"',
                    'requires_openai_auth = true',
                    ''
                ].join('\n'),
                { encoding: 'utf8', mode: 0o600 }
            );
            await this.mutateRegistry((registry) => {
                registry.accounts.push({
                    id: accountId,
                    label: input.label.trim(),
                    kind: 'api',
                    baseUrl: normalizedBaseUrl,
                    model: input.model.trim(),
                    createdAt: Date.now()
                });
            });
        } catch (error) {
            await rm(homeDir, { recursive: true, force: true }).catch(() => {});
            throw error;
        }
        return await this.listAccounts();
    }

    async setDefaultAccount(accountId: string): Promise<CodexAccountsResponse> {
        if (accountId !== SYSTEM_CODEX_ACCOUNT_ID) {
            const registry = await this.readRegistry();
            const account = registry.accounts.find((candidate) => candidate.id === accountId);
            if (!account) {
                throw new Error('Codex account not found');
            }
            const credentialFile = account.kind === 'api' ? API_KEY_FILE : 'auth.json';
            if (!existsSync(join(this.getManagedHome(accountId), credentialFile))) {
                throw new Error('Selected Codex account is not authenticated');
            }
        }
        await this.mutateRegistry((registry) => {
            if (
                accountId !== SYSTEM_CODEX_ACCOUNT_ID
                && !registry.accounts.some((account) => account.id === accountId)
            ) {
                throw new Error('Codex account not found');
            }
            registry.defaultAccountId = accountId;
        });
        return await this.listAccounts();
    }

    async removeAccount(accountId: string): Promise<CodexAccountsResponse> {
        if (accountId === SYSTEM_CODEX_ACCOUNT_ID) {
            throw new Error('The system Codex account cannot be removed from HAPI');
        }
        let removed = false;
        await this.mutateRegistry((registry) => {
            const next = registry.accounts.filter((account) => account.id !== accountId);
            removed = next.length !== registry.accounts.length;
            registry.accounts = next;
            if (registry.defaultAccountId === accountId) {
                registry.defaultAccountId = SYSTEM_CODEX_ACCOUNT_ID;
            }
        });
        if (!removed) throw new Error('Codex account not found');
        await rm(this.getManagedHome(accountId), { recursive: true, force: true });
        return await this.listAccounts();
    }

    async resolveAccount(accountId?: string): Promise<ResolvedCodexAccount> {
        const registry = await this.readRegistry();
        const selectedId = accountId?.trim() || registry.defaultAccountId;
        if (selectedId === SYSTEM_CODEX_ACCOUNT_ID) {
            return {
                id: SYSTEM_CODEX_ACCOUNT_ID,
                label: 'System default',
                kind: 'system',
                homeDir: this.systemHomeDir
            };
        }
        const account = registry.accounts.find((candidate) => candidate.id === selectedId);
        if (!account) throw new Error('Selected Codex account is not available on this runner');
        const homeDir = this.getManagedHome(account.id);
        const kind = account.kind === 'api' ? 'api' : 'managed';
        await normalizeManagedAccountConfig(homeDir, kind);
        const credentialFile = kind === 'api' ? API_KEY_FILE : 'auth.json';
        if (!existsSync(join(homeDir, credentialFile))) {
            throw new Error('Selected Codex account is not authenticated');
        }
        if (kind === 'api') {
            const apiKey = (await readFile(join(homeDir, API_KEY_FILE), 'utf8')).trim();
            if (!apiKey) throw new Error('Selected Codex API endpoint has no API key');
            return {
                id: account.id,
                label: account.label,
                kind,
                homeDir,
                env: { [API_KEY_ENV]: apiKey },
                model: account.model
            };
        }
        return {
            id: account.id,
            label: account.label,
            kind,
            homeDir
        };
    }

    /**
     * Resolve the account that actually owns an existing Codex rollout.
     *
     * Older runners could inherit a managed CODEX_HOME while recording the
     * session as "system". Prefer the recorded account when it contains the
     * rollout; otherwise recover only when exactly one other local account
     * contains the requested thread.
     */
    async resolveAccountForResume(
        accountId: string | undefined,
        sessionId: string
    ): Promise<ResolvedCodexAccount> {
        const requested = await this.resolveAccount(accountId);
        const requestedPath = await findTranscriptPath(
            join(requested.homeDir, 'sessions'),
            sessionId
        );
        if (requestedPath) return requested;

        const registry = await this.readRegistry();
        const candidateIds = [
            SYSTEM_CODEX_ACCOUNT_ID,
            ...registry.accounts.map((account) => account.id)
        ].filter((candidateId) => candidateId !== requested.id);
        const matches: ResolvedCodexAccount[] = [];

        for (const candidateId of candidateIds) {
            let candidate: ResolvedCodexAccount;
            try {
                candidate = await this.resolveAccount(candidateId);
            } catch {
                continue;
            }
            const transcriptPath = await findTranscriptPath(
                join(candidate.homeDir, 'sessions'),
                sessionId
            );
            if (transcriptPath) matches.push(candidate);
        }

        if (matches.length === 1) {
            const recovered = matches[0]!;
            logger.debug('[CodexAccountManager] Recovered mismatched resume account metadata', {
                sessionId,
                recordedAccountId: requested.id,
                actualAccountId: recovered.id
            });
            return recovered;
        }
        if (matches.length > 1) {
            throw new Error(
                `Codex conversation ${sessionId} exists in multiple local accounts; select the account explicitly`
            );
        }
        return requested;
    }

    async prepareSessionSwitch(
        sourceAccountId: string,
        targetAccountId: string,
        sessionId: string
    ): Promise<string | null> {
        if (sourceAccountId === targetAccountId) return null;
        const [source, target] = await Promise.all([
            this.resolveAccount(sourceAccountId),
            this.resolveAccount(targetAccountId)
        ]);
        const sourcePath = await findTranscriptPath(join(source.homeDir, 'sessions'), sessionId);
        if (!sourcePath) {
            // Legacy metadata may name the wrong source even though the exact
            // conversation already belongs to the explicitly selected target.
            const existingTargetPath = await findTranscriptPath(
                join(target.homeDir, 'sessions'),
                sessionId
            );
            if (existingTargetPath) return existingTargetPath;
            throw new Error(`Codex conversation ${sessionId} was not found in account ${source.label}`);
        }

        const destinationDirectory = join(target.homeDir, 'sessions', 'hapi-migrated', sessionId);
        await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
        const destinationPath = join(destinationDirectory, basename(sourcePath));
        const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
        await copyFile(sourcePath, temporaryPath);
        await chmod(temporaryPath, 0o600).catch(() => {});
        await rename(temporaryPath, destinationPath);
        return destinationPath;
    }

    private async completeAttempt(attemptId: string): Promise<void> {
        const attempt = this.attempts.get(attemptId);
        if (!attempt || attempt.settling || attempt.status !== 'pending') return;
        attempt.settling = true;
        try {
            const accountResponse = await attempt.client.readAccount({ refreshToken: false });
            const identity = parseAccountIdentity(accountResponse);
            if (!identity.authenticated) {
                throw new Error('Codex login completed without an authenticated ChatGPT account');
            }
            const stored: StoredCodexAccount = {
                id: attempt.accountId,
                label: identity.label ?? `Codex account ${attempt.accountId.slice(0, 8)}`,
                kind: 'managed',
                planType: identity.planType,
                createdAt: Date.now()
            };
            await this.mutateRegistry((registry) => {
                registry.accounts = [
                    ...registry.accounts.filter((account) => account.id !== stored.id),
                    stored
                ];
            });
            const registry = await this.readRegistry();
            const limits = await attempt.client.readAccountRateLimits().catch(() => null);
            attempt.account = {
                id: stored.id,
                label: stored.label,
                kind: 'managed',
                isDefault: stored.id === registry.defaultAccountId,
                authenticated: true,
                planType: stored.planType ?? null,
                primaryLimit: parseLimit(limits?.rateLimits?.primary),
                secondaryLimit: parseLimit(limits?.rateLimits?.secondary)
            };
            attempt.status = 'completed';
            attempt.error = undefined;
            this.scheduleAttemptCleanup(attempt);
        } catch (error) {
            attempt.status = 'error';
            attempt.error = error instanceof Error ? error.message : String(error);
            await rm(attempt.homeDir, { recursive: true, force: true }).catch(() => {});
            this.scheduleAttemptCleanup(attempt);
        } finally {
            attempt.settling = false;
            clearTimeout(attempt.timeout);
            await attempt.client.disconnect().catch(() => {});
        }
    }

    private async failAttempt(attemptId: string, message: string): Promise<void> {
        const attempt = this.attempts.get(attemptId);
        if (!attempt || attempt.status !== 'pending' || attempt.settling) return;
        attempt.settling = true;
        try {
            attempt.status = 'error';
            attempt.error = message;
            clearTimeout(attempt.timeout);
            await attempt.client.cancelAccountLogin(attempt.upstreamLoginId).catch(() => {});
            await attempt.client.disconnect().catch(() => {});
            await rm(attempt.homeDir, { recursive: true, force: true }).catch(() => {});
            this.scheduleAttemptCleanup(attempt);
        } finally {
            attempt.settling = false;
        }
    }

    private scheduleAttemptCleanup(attempt: LoginAttempt): void {
        const cleanup = setTimeout(() => {
            this.attempts.delete(attempt.id);
        }, FINISHED_ATTEMPT_TTL_MS);
        cleanup.unref();
    }

    private async probeAccount(
        account: StoredCodexAccount,
        kind: 'system' | 'managed' | 'api',
        homeDir: string,
        defaultAccountId: string
    ): Promise<CodexAccountSummary> {
        if (kind !== 'system') {
            await normalizeManagedAccountConfig(homeDir, kind);
        }
        if (kind === 'api') {
            return {
                id: account.id,
                label: account.label,
                kind,
                isDefault: account.id === defaultAccountId,
                authenticated: existsSync(join(homeDir, API_KEY_FILE)),
                baseUrl: account.baseUrl,
                model: account.model
            };
        }
        const client = this.clientFactory(homeDir);
        try {
            await client.initialize({
                clientInfo: {
                    name: 'hapi',
                    title: 'HAPI',
                    version: configuration.currentCliVersion
                },
                capabilities: { experimentalApi: true }
            });
            const identity = parseAccountIdentity(await client.readAccount({ refreshToken: false }));
            let limits: GetAccountRateLimitsResponse | null = null;
            if (identity.authenticated) {
                limits = await client.readAccountRateLimits().catch(() => null);
            }
            return {
                id: account.id,
                label: identity.label ?? account.label,
                kind,
                isDefault: account.id === defaultAccountId,
                authenticated: identity.authenticated,
                planType: identity.planType ?? account.planType ?? null,
                primaryLimit: parseLimit(limits?.rateLimits?.primary),
                secondaryLimit: parseLimit(limits?.rateLimits?.secondary)
            };
        } catch (error) {
            logger.debug('[CodexAccountManager] Failed to inspect account', {
                accountId: account.id,
                error: error instanceof Error ? error.message : String(error)
            });
            return {
                id: account.id,
                label: account.label,
                kind,
                isDefault: account.id === defaultAccountId,
                authenticated: false,
                planType: account.planType ?? null,
                error: error instanceof Error ? error.message : String(error)
            };
        } finally {
            await client.disconnect().catch(() => {});
        }
    }

    private getManagedHome(accountId: string): string {
        if (!/^[0-9a-f-]{36}$/i.test(accountId)) {
            throw new Error('Invalid Codex account id');
        }
        return join(this.accountsDir, accountId);
    }

    private async readRegistry(): Promise<CodexAccountRegistry> {
        try {
            const content = await readFile(this.registryFile, 'utf8');
            return parseRegistry(JSON.parse(content) as unknown);
        } catch (error) {
            const code = asRecord(error)?.code;
            if (code === 'ENOENT') return defaultRegistry();
            logger.debug('[CodexAccountManager] Failed to read registry', error);
            throw new Error('Failed to read the local Codex account registry', { cause: error });
        }
    }

    private async mutateRegistry(mutator: (registry: CodexAccountRegistry) => void): Promise<void> {
        const operation = this.writeQueue.then(async () => {
            const registry = await this.readRegistry();
            mutator(registry);
            await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
            await mkdir(this.accountsDir, { recursive: true, mode: 0o700 });
            const tempFile = `${this.registryFile}.${process.pid}.${randomUUID()}.tmp`;
            await writeFile(tempFile, JSON.stringify(registry, null, 2), {
                encoding: 'utf8',
                mode: 0o600
            });
            await rename(tempFile, this.registryFile);
            await chmod(this.registryFile, 0o600).catch(() => {});
        });
        this.writeQueue = operation.catch(() => {});
        await operation;
    }
}

export const codexAccountManager = new CodexAccountManager();
