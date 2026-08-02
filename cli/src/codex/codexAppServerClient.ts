import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { logger } from '@/ui/logger';
import { JsonLineParser } from '@/utils/jsonLineParser';
import { killProcessByChildProcess } from '@/utils/process';
import type {
    CollaborationModeListResponse,
    InitializeParams,
    InitializeResponse,
    ModelListParams,
    ModelListResponse,
    ThreadStartParams,
    ThreadStartResponse,
    ThreadResumeParams,
    ThreadResumeResponse,
    ThreadForkParams,
    ThreadForkResponse,
    TurnStartParams,
    TurnStartResponse,
    TurnSteerParams,
    TurnSteerResponse,
    TurnInterruptParams,
    TurnInterruptResponse,
    ThreadRollbackParams,
    ThreadRollbackResponse,
    ThreadCompactStartParams,
    ThreadCompactStartResponse,
    ThreadGoalSetParams,
    ThreadGoalSetResponse,
    ThreadGoalGetParams,
    ThreadGoalGetResponse,
    ThreadGoalClearParams,
    ThreadGoalClearResponse,
    ExperimentalFeatureEnablementSetParams,
    ExperimentalFeatureEnablementSetResponse,
    GetAccountRateLimitsResponse,
    GetAccountResponse,
    LoginAccountParams,
    LoginAccountResponse
} from './appServerTypes';

type JsonRpcLiteRequest = {
    id: number;
    method: string;
    params?: unknown;
};

type JsonRpcLiteNotification = {
    method: string;
    params?: unknown;
};

type JsonRpcLiteResponse = {
    id: number | string | null;
    result?: unknown;
    error?: {
        code?: number;
        message: string;
        data?: unknown;
    };
};

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function createAbortError(): Error {
    const error = new Error('Request aborted');
    error.name = 'AbortError';
    return error;
}

type CodexCommandCandidate = {
    command: string;
    source: 'desktop' | 'path';
    version: number[] | null;
};

function parseCodexVersion(output: string): number[] | null {
    const match = /(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]+)?/u.exec(output);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function getCodexVersion(command: string): number[] | null {
    try {
        const output = execFileSync(command, ['--version'], {
            encoding: 'utf8',
            timeout: 3_000,
            stdio: ['ignore', 'pipe', 'ignore']
        });
        return parseCodexVersion(output);
    } catch {
        return null;
    }
}

function compareVersion(a: number[] | null, b: number[] | null): number {
    if (!a && !b) return 0;
    if (a && !b) return 1;
    if (!a && b) return -1;
    for (let index = 0; index < 3; index += 1) {
        const diff = (a?.[index] ?? 0) - (b?.[index] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function resolveCodexAppServerCommand(): string {
    if (process.env.HAPI_CODEX_APP_SERVER_BIN) {
        return process.env.HAPI_CODEX_APP_SERVER_BIN;
    }

    const candidates: CodexCommandCandidate[] = [{
        command: 'codex',
        source: 'path',
        version: getCodexVersion('codex')
    }];

    if (process.platform === 'darwin') {
        const desktopCodex = '/Applications/Codex.app/Contents/Resources/codex';
        if (existsSync(desktopCodex)) {
            candidates.push({
                command: desktopCodex,
                source: 'desktop',
                version: getCodexVersion(desktopCodex)
            });
        }
    }

    // 中文注释：Codex Desktop 与 npm CLI 都可能写 thread-store；恢复时选择版本更新的 app-server，
    // 避免旧 CLI 读取新 rollout 格式失败。版本相同优先 Desktop，和用户看到的 Codex.app 保持一致。
    const best = candidates.sort((left, right) => {
        const versionDiff = compareVersion(right.version, left.version);
        if (versionDiff !== 0) return versionDiff;
        if (left.source === right.source) return 0;
        return left.source === 'desktop' ? -1 : 1;
    })[0];

    logger.debug('[CodexAppServer] Resolved codex command', {
        selected: best.command,
        candidates: candidates.map((candidate) => ({
            command: candidate.command,
            source: candidate.source,
            version: candidate.version?.join('.') ?? null
        }))
    });
    return best.command;
}

export const HAPI_CODEX_CONTEXT_DEFAULTS = {
    contextWindow: 350_000,
    autoCompactTokenLimit: 320_000,
    autoCompactTokenLimitScope: 'total'
} as const;

const HAPI_CODEX_CONTEXT_CATALOG_MODELS = new Set([
    'gpt-5.6-sol'
]);

type CodexModelCatalog = {
    models: Array<Record<string, unknown>>;
    [key: string]: unknown;
};

function parseCodexModelCatalog(value: unknown): CodexModelCatalog | null {
    const catalog = asRecord(value);
    if (!catalog || !Array.isArray(catalog.models)) {
        return null;
    }
    const models = catalog.models.filter((model): model is Record<string, unknown> => (
        Boolean(model) && typeof model === 'object' && !Array.isArray(model)
    ));
    if (models.length !== catalog.models.length) {
        return null;
    }
    return {
        ...catalog,
        models
    };
}

function atLeast(value: unknown, minimum: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(value, minimum)
        : minimum;
}

/**
 * Codex clamps `model_context_window` to the selected model catalog entry's
 * `max_context_window`. The account catalog currently advertises 272K for Sol,
 * so a CLI `-c model_context_window=350000` override alone still resolves to
 * 272K (258.4K after Codex's 95% effective-window reserve).
 *
 * Keep the complete account catalog and only raise metadata for models covered
 * by HAPI's explicit context policy. Larger user-provided values are preserved.
 */
export function applyHapiCodexContextCatalogPolicy(value: unknown): CodexModelCatalog | null {
    const catalog = parseCodexModelCatalog(value);
    if (!catalog) {
        return null;
    }
    return {
        ...catalog,
        models: catalog.models.map((model) => {
            if (
                typeof model.slug !== 'string'
                || !HAPI_CODEX_CONTEXT_CATALOG_MODELS.has(model.slug)
            ) {
                return model;
            }
            return {
                ...model,
                context_window: atLeast(
                    model.context_window,
                    HAPI_CODEX_CONTEXT_DEFAULTS.contextWindow
                ),
                max_context_window: atLeast(
                    model.max_context_window,
                    HAPI_CODEX_CONTEXT_DEFAULTS.contextWindow
                )
            };
        })
    };
}

function loadCodexModelCatalog(
    codexCommand: string,
    environment: Record<string, string>,
    codexHome: string
): unknown {
    try {
        const output = execFileSync(codexCommand, ['debug', 'models'], {
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: 16 * 1024 * 1024,
            env: environment,
            stdio: ['ignore', 'pipe', 'ignore']
        });
        return JSON.parse(output);
    } catch (error) {
        logger.debug('[CodexAppServer] Failed to read effective catalog from `codex debug models`', error);
    }

    try {
        return JSON.parse(readFileSync(join(codexHome, 'models_cache.json'), 'utf8'));
    } catch (error) {
        logger.debug('[CodexAppServer] Failed to read cached Codex model catalog', error);
        return null;
    }
}

function prepareHapiCodexModelCatalog(
    codexCommand: string,
    environment: Record<string, string>
): string | null {
    const codexHome = resolve(environment.CODEX_HOME?.trim() || join(homedir(), '.codex'));
    const source = loadCodexModelCatalog(codexCommand, environment, codexHome);
    const catalog = applyHapiCodexContextCatalogPolicy(source);
    if (!catalog) {
        return null;
    }

    const contents = `${JSON.stringify(catalog)}\n`;
    const digest = createHash('sha256').update(contents).digest('hex').slice(0, 16);
    const directory = join(codexHome, '.hapi', 'model-catalogs');
    const path = join(directory, `context-${HAPI_CODEX_CONTEXT_DEFAULTS.contextWindow}-${digest}.json`);
    try {
        mkdirSync(directory, { recursive: true });
        if (!existsSync(path)) {
            writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx' });
        }
        return path;
    } catch (error) {
        // Another concurrent app-server may have created the same content path.
        if (existsSync(path)) {
            return path;
        }
        logger.debug('[CodexAppServer] Failed to prepare HAPI model catalog', error);
        return null;
    }
}

export function buildCodexAppServerArgs(modelCatalogPath?: string | null): string[] {
    return [
        ...(modelCatalogPath
            ? [
                '-c',
                `model_catalog_json=${JSON.stringify(modelCatalogPath)}`
            ]
            : []),
        '-c',
        `model_context_window=${HAPI_CODEX_CONTEXT_DEFAULTS.contextWindow}`,
        '-c',
        `model_auto_compact_token_limit=${HAPI_CODEX_CONTEXT_DEFAULTS.autoCompactTokenLimit}`,
        '-c',
        `model_auto_compact_token_limit_scope=${JSON.stringify(HAPI_CODEX_CONTEXT_DEFAULTS.autoCompactTokenLimitScope)}`,
        'app-server'
    ];
}

export class CodexAppServerClient extends JsonLineParser {
    private process: ChildProcessWithoutNullStreams | null = null;
    private connected = false;
    private nextId = 1;
    private readonly pending = new Map<number, PendingRequest>();
    private readonly requestHandlers = new Map<string, RequestHandler>();
    private notificationHandler: ((method: string, params: unknown) => void) | null = null;
    private stderrHandler: ((text: string) => void) | null = null;
    private protocolError: Error | null = null;

    static readonly DEFAULT_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;

    constructor(private readonly options: { env?: Record<string, string> } = {}) {
        super();
    }

    setStderrHandler(handler: ((text: string) => void) | null): void {
        this.stderrHandler = handler;
    }

    async connect(): Promise<void> {
        if (this.connected) {
            return;
        }

        const codexCommand = resolveCodexAppServerCommand();
        logger.debug(`[CodexAppServer] Starting ${codexCommand} app-server`);
        const inheritedEnv = Object.keys(process.env).reduce((acc, key) => {
            const value = process.env[key];
            if (typeof value === 'string') acc[key] = value;
            return acc;
        }, {} as Record<string, string>);
        const environment = {
            ...inheritedEnv,
            ...this.options.env
        };
        const modelCatalogPath = prepareHapiCodexModelCatalog(codexCommand, environment);
        // Runtime overrides keep every HAPI Codex identity on the same context
        // policy without modifying the user's standalone ~/.codex config.
        this.process = spawn(codexCommand, buildCodexAppServerArgs(modelCatalogPath), {
            env: environment,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
            windowsHide: process.platform === 'win32'
        });

        this.process.stdout.setEncoding('utf8');
        this.process.stdout.on('data', (chunk) => this.feed(chunk));

        this.process.stderr.setEncoding('utf8');
        this.process.stderr.on('data', (chunk) => {
            const text = chunk.toString().trim();
            if (text.length > 0) {
                logger.debug(`[CodexAppServer][stderr] ${text}`);
                this.stderrHandler?.(text);
            }
        });

        this.process.on('exit', (code, signal) => {
            const message = `Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
            logger.debug(message);
            this.rejectAllPending(new Error(message));
            this.connected = false;
            this.resetParserState();
            this.process = null;
        });

        this.process.on('error', (error) => {
            logger.debug('[CodexAppServer] Process error', error);
            const message = error instanceof Error ? error.message : String(error);
            this.rejectAllPending(new Error(
                `Failed to spawn codex app-server: ${message}. Is it installed and on PATH?`,
                { cause: error }
            ));
            this.connected = false;
            this.resetParserState();
            this.process = null;
        });

        this.connected = true;
        logger.debug('[CodexAppServer] Connected');
    }

    setNotificationHandler(handler: ((method: string, params: unknown) => void) | null): void {
        this.notificationHandler = handler;
    }

    registerRequestHandler(method: string, handler: RequestHandler): void {
        this.requestHandlers.set(method, handler);
    }

    async initialize(params: InitializeParams): Promise<InitializeResponse> {
        const response = await this.sendRequest('initialize', params, { timeoutMs: 30_000 });
        this.sendNotification('initialized');
        return response as InitializeResponse;
    }

    async listModels(params?: ModelListParams): Promise<ModelListResponse> {
        const response = await this.sendRequest('model/list', params ?? {}, {
            timeoutMs: 30_000
        });
        return response as ModelListResponse;
    }

    async loginAccount(params: LoginAccountParams): Promise<LoginAccountResponse> {
        const response = await this.sendRequest('account/login/start', params, {
            timeoutMs: 30_000
        });
        return response as LoginAccountResponse;
    }

    async cancelAccountLogin(loginId: string): Promise<void> {
        await this.sendRequest('account/login/cancel', { loginId }, {
            timeoutMs: 30_000
        });
    }

    async readAccount(options?: { refreshToken?: boolean }): Promise<GetAccountResponse> {
        const response = await this.sendRequest('account/read', {
            refreshToken: options?.refreshToken ?? false
        }, {
            timeoutMs: 30_000
        });
        return response as GetAccountResponse;
    }

    async readAccountRateLimits(): Promise<GetAccountRateLimitsResponse> {
        const response = await this.sendRequest('account/rateLimits/read', {}, {
            timeoutMs: 30_000
        });
        return response as GetAccountRateLimitsResponse;
    }

    async listCollaborationModes(): Promise<CollaborationModeListResponse> {
        const response = await this.sendRequest('collaborationMode/list', {}, {
            timeoutMs: 30_000
        });
        return response as CollaborationModeListResponse;
    }

    async setExperimentalFeatureEnablement(
        params: ExperimentalFeatureEnablementSetParams
    ): Promise<ExperimentalFeatureEnablementSetResponse> {
        const response = await this.sendRequest('experimentalFeature/enablement/set', params, {
            timeoutMs: 30_000
        });
        return response as ExperimentalFeatureEnablementSetResponse;
    }

    async startThread(params: ThreadStartParams, options?: { signal?: AbortSignal }): Promise<ThreadStartResponse> {
        const response = await this.sendRequest('thread/start', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as ThreadStartResponse;
    }

    async resumeThread(params: ThreadResumeParams, options?: { signal?: AbortSignal }): Promise<ThreadResumeResponse> {
        const response = await this.sendRequest('thread/resume', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as ThreadResumeResponse;
    }

    async forkThread(params: ThreadForkParams, options?: { signal?: AbortSignal }): Promise<ThreadForkResponse> {
        const response = await this.sendRequest('thread/fork', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as ThreadForkResponse;
    }

    async startTurn(params: TurnStartParams, options?: { signal?: AbortSignal }): Promise<TurnStartResponse> {
        const response = await this.sendRequest('turn/start', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as TurnStartResponse;
    }

    async steerTurn(params: TurnSteerParams, options?: { signal?: AbortSignal }): Promise<TurnSteerResponse> {
        const response = await this.sendRequest('turn/steer', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as TurnSteerResponse;
    }

    async interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
        const response = await this.sendRequest('turn/interrupt', params, {
            timeoutMs: 30_000
        });
        return response as TurnInterruptResponse;
    }

    /**
     * Deprecated upstream, but still required to match Codex's native
     * safety-buffering retry flow. Keep the protocol call isolated here so it
     * can be replaced when app-server exposes a successor.
     */
    async rollbackThread(params: ThreadRollbackParams): Promise<ThreadRollbackResponse> {
        const response = await this.sendRequest('thread/rollback', params, {
            timeoutMs: 30_000
        });
        return response as ThreadRollbackResponse;
    }

    async compactThread(
        params: ThreadCompactStartParams,
        options?: { signal?: AbortSignal }
    ): Promise<ThreadCompactStartResponse> {
        const response = await this.sendRequest('thread/compact/start', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as ThreadCompactStartResponse;
    }

    async setThreadGoal(
        params: ThreadGoalSetParams,
        options?: { signal?: AbortSignal }
    ): Promise<ThreadGoalSetResponse> {
        const response = await this.sendRequest('thread/goal/set', params, {
            signal: options?.signal,
            timeoutMs: 30_000
        });
        return response as ThreadGoalSetResponse;
    }

    async getThreadGoal(
        params: ThreadGoalGetParams,
        options?: { signal?: AbortSignal }
    ): Promise<ThreadGoalGetResponse> {
        const response = await this.sendRequest('thread/goal/get', params, {
            signal: options?.signal,
            timeoutMs: 30_000
        });
        return response as ThreadGoalGetResponse;
    }

    async clearThreadGoal(
        params: ThreadGoalClearParams,
        options?: { signal?: AbortSignal }
    ): Promise<ThreadGoalClearResponse> {
        const response = await this.sendRequest('thread/goal/clear', params, {
            signal: options?.signal,
            timeoutMs: 30_000
        });
        return response as ThreadGoalClearResponse;
    }

    async disconnect(): Promise<void> {
        if (!this.connected) {
            return;
        }

        const child = this.process;
        this.process = null;

        try {
            child?.stdin.end();
            if (child) {
                await killProcessByChildProcess(child);
            }
        } catch (error) {
            logger.debug('[CodexAppServer] Error while stopping process', error);
        } finally {
            this.rejectAllPending(new Error('Codex app-server disconnected'));
            this.connected = false;
            this.resetParserState();
        }

        logger.debug('[CodexAppServer] Disconnected');
    }

    private async sendRequest(
        method: string,
        params?: unknown,
        options?: { signal?: AbortSignal; timeoutMs?: number }
    ): Promise<unknown> {
        if (!this.connected) {
            await this.connect();
        }

        const id = this.nextId++;
        const payload: JsonRpcLiteRequest = {
            id,
            method,
            params
        };

        const timeoutMs = options?.timeoutMs ?? CodexAppServerClient.DEFAULT_TIMEOUT_MS;

        return new Promise((resolve, reject) => {
            let timeout: ReturnType<typeof setTimeout> | null = null;
            let aborted = false;

            const cleanup = () => {
                if (timeout) {
                    clearTimeout(timeout);
                }
                if (options?.signal) {
                    options.signal.removeEventListener('abort', onAbort);
                }
            };

            const onAbort = () => {
                if (aborted) return;
                aborted = true;
                this.pending.delete(id);
                cleanup();
                reject(createAbortError());
            };

            if (options?.signal) {
                if (options.signal.aborted) {
                    onAbort();
                    return;
                }
                options.signal.addEventListener('abort', onAbort, { once: true });
            }

            if (Number.isFinite(timeoutMs)) {
                timeout = setTimeout(() => {
                    if (this.pending.has(id)) {
                        this.pending.delete(id);
                        cleanup();
                        reject(new Error(`Codex app-server request '${method}' timed out after ${timeoutMs}ms`));
                    }
                }, timeoutMs);
                timeout.unref();
            }

            this.pending.set(id, {
                resolve: (value) => {
                    cleanup();
                    resolve(value);
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                },
                cleanup
            });

            this.writePayload(payload);
        });
    }

    private sendNotification(method: string, params?: unknown): void {
        const payload: JsonRpcLiteNotification = { method, params };
        this.writePayload(payload);
    }

    protected handleLine(line: string): void {
        if (this.protocolError) {
            return;
        }

        let message: Record<string, unknown> | null = null;
        try {
            const parsed = JSON.parse(line);
            message = asRecord(parsed);
            if (!message) {
                logger.debug('[CodexAppServer] Ignoring non-object JSON from stdout', { line });
                return;
            }
        } catch (error) {
            const protocolError = new Error('Failed to parse JSON from codex app-server');
            this.protocolError = protocolError;
            logger.debug('[CodexAppServer] Failed to parse JSON line', { line, error });
            this.rejectAllPending(protocolError);
            this.process?.stdin.end();
            return;
        }

        if (typeof message.method === 'string') {
            const method = message.method;
            const params = 'params' in message ? message.params : null;

            if ('id' in message && message.id !== undefined) {
                const requestId = message.id;
                void this.handleIncomingRequest({
                    id: requestId,
                    method,
                    params
                });
                return;
            }

            this.notificationHandler?.(method, params ?? null);
            return;
        }

        if ('id' in message) {
            this.handleResponse(message as JsonRpcLiteResponse);
        }
    }

    private async handleIncomingRequest(request: { id: unknown; method: string; params?: unknown }): Promise<void> {
        const responseId = typeof request.id === 'number' || typeof request.id === 'string'
            ? request.id
            : null;
        const handler = this.requestHandlers.get(request.method);

        if (!handler) {
            this.writePayload({
                id: responseId,
                error: {
                    code: -32601,
                    message: `Method not found: ${request.method}`
                }
            } satisfies JsonRpcLiteResponse);
            return;
        }

        try {
            const result = await handler(request.params ?? null);
            this.writePayload({
                id: responseId,
                result
            } satisfies JsonRpcLiteResponse);
        } catch (error) {
            this.writePayload({
                id: responseId,
                error: {
                    code: -32603,
                    message: error instanceof Error ? error.message : 'Internal error'
                }
            } satisfies JsonRpcLiteResponse);
        }
    }

    private handleResponse(response: JsonRpcLiteResponse): void {
        if (response.id === null || response.id === undefined) {
            logger.debug('[CodexAppServer] Received response without id');
            return;
        }

        if (typeof response.id !== 'number') {
            logger.debug('[CodexAppServer] Received response with non-numeric id', response.id);
            return;
        }

        const pending = this.pending.get(response.id);
        if (!pending) {
            logger.debug('[CodexAppServer] Received response with no pending request', response.id);
            return;
        }

        this.pending.delete(response.id);

        if (response.error) {
            pending.reject(new Error(response.error.message));
            return;
        }

        pending.resolve(response.result);
    }

    private writePayload(payload: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteResponse): void {
        const serialized = JSON.stringify(payload);
        this.process?.stdin.write(`${serialized}\n`);
    }

    private resetParserState(): void {
        this.reset();
        this.protocolError = null;
    }

    private rejectAllPending(error: Error): void {
        for (const { reject, cleanup } of this.pending.values()) {
            cleanup();
            reject(error);
        }
        this.pending.clear();
    }
}
