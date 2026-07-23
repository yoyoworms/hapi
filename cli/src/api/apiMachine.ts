/**
 * WebSocket client for machine/runner communication with hapi-hub
 */

import { io, type Socket } from 'socket.io-client'
import { readdir, realpath, stat } from 'node:fs/promises'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'
import type { ClientToServerEvents, ServerToClientEvents, Update, UpdateMachineBody } from '@hapi/protocol'
import {
    AddCodexApiEndpointRequestSchema,
    ArchiveCodexSessionRpcRequestSchema,
    CodexAccountLoginStatusResponseSchema,
    CodexAccountsResponseSchema,
    ListCodexSessionsRpcRequestSchema,
    type ArchiveCodexSessionRpcResponse,
    type CodexAccountLoginStatusResponse,
    type CodexAccountLoginStartResponse,
    type CodexAccountsResponse,
    type ListCodexSessionsRpcResponse,
    type MachineDirectoryEntry,
    type MachineListDirectoryResponse,
    type PathExistsResponse
} from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RunnerState, Machine, MachineMetadata } from './types'
import { RunnerStateSchema, MachineMetadataSchema } from './types'
import { backoff } from '@/utils/time'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { RpcHandlerManager } from './rpc/RpcHandlerManager'
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers'
import {
    listOpencodeModelsForCwd,
    type ListOpencodeModelsForCwdRequest,
    type ListOpencodeModelsForCwdResponse
} from '../modules/common/opencodeModels'
import {
    listGrokModelsForCwd,
    type ListGrokModelsForCwdRequest,
    type ListGrokModelsForCwdResponse
} from '../modules/common/grokModels'
import type { SpawnSessionOptions, SpawnSessionResult } from '../modules/common/rpcTypes'
import { applyVersionedAck } from './versionedUpdate'
import { archiveLocalCodexSession, listLocalCodexSessionSummaries, listLocalCodexSessionsWithMessagesByIds } from '../modules/common/codexSessions'
import { buildSocketIoExtraHeaderOptions } from './hubExtraHeaders'
import { collectMachineHealth } from '@/utils/machineHealth'
import { inspectCursorChatStore } from '@/cursor/cursorChatStoreStatus'
import type { CursorChatStoreStatus } from '@hapi/protocol/apiTypes'
import { codexAccountManager } from '@/codex/codexAccountManager'

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>
    stopSession: (sessionId: string) => boolean
    requestShutdown: () => void
}

interface PathExistsRequest {
    paths: string[]
}

interface ListMachineDirectoryRequest {
    path: string
}

interface CursorChatStoreStatusRequest {
    workspacePath: string
    cursorSessionId: string
    homeDir?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

export function normalizeWindowsDriveRoot(path: string): string {
    return /^[A-Za-z]:$/.test(path) ? `${path}\\` : path
}

function canonicalRealpathSync(path: string): string {
    return normalizeWindowsDriveRoot(realpathSync.native(path))
}

function normalizeWorkspaceRoots(paths?: string[]): string[] | undefined {
    if (!paths?.length) {
        return undefined
    }

    const normalized = Array.from(new Set(paths.map((path) => {
        try {
            return canonicalRealpathSync(path)
        } catch {
            return normalizeWindowsDriveRoot(resolvePath(path))
        }
    })))

    return normalized.length > 0 ? normalized : undefined
}

function workspaceRootsEqual(left?: string[], right?: string[]): boolean {
    const normalizedLeft = left ?? []
    const normalizedRight = right ?? []
    if (normalizedLeft.length !== normalizedRight.length) {
        return false
    }

    return normalizedLeft.every((value, index) => value === normalizedRight[index])
}

function formatWorkspaceRoots(paths?: string[]): string {
    return paths?.length ? paths.join(', ') : '(none)'
}

type CachedOAuthUsage = { data: Record<string, unknown>; fetchedAt: number }

let cachedOAuthUsage: CachedOAuthUsage | null = null
const OAUTH_USAGE_CACHE_TTL_MS = 30 * 60 * 1000

const MACOS_USAGE_CREDENTIALS_SERVICE = 'Claude Code-credentials'
const CCSTATUSLINE_USAGE_CACHE_FILE = join(homedir(), '.cache', 'ccstatusline', 'usage.json')

type UsageFetchResult = { ok: true; data: Record<string, unknown> } | { ok: false; retryable: boolean }

function parseUsageAccessToken(raw: string | null): string | null {
    if (!raw) return null
    try {
        const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } }
        const token = parsed.claudeAiOauth?.accessToken
        return typeof token === 'string' && token.length > 0 ? token : null
    } catch {
        return null
    }
}

function readMacKeychainSecret(service: string): string | null {
    try {
        const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
        return execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'ignore']
        }).trim()
    } catch {
        return null
    }
}

function listMacKeychainCredentialCandidates(): string[] {
    if (process.platform !== 'darwin') return []
    try {
        const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
        const rawDump = execFileSync('security', ['dump-keychain'], {
            encoding: 'utf-8',
            timeout: 8000,
            maxBuffer: 8 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'ignore']
        })
        const services: string[] = []
        const seen = new Set<string>()
        const re = /"svce"<blob>="([^"]+)"/g
        let match: RegExpExecArray | null
        while ((match = re.exec(rawDump)) !== null) {
            const service = match[1]
            if (!service.startsWith(MACOS_USAGE_CREDENTIALS_SERVICE)) continue
            if (seen.has(service)) continue
            seen.add(service)
            services.push(service)
        }
        return services
    } catch {
        return []
    }
}

function readUsageTokenFromCredentialsFile(): string | null {
    const candidates = [
        process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json') : null,
        join(homedir(), '.claude', '.credentials.json')
    ].filter((path): path is string => Boolean(path))
    for (const filePath of candidates) {
        try {
            if (!existsSync(filePath)) continue
            const token = parseUsageAccessToken(readFileSync(filePath, 'utf-8'))
            if (token) return token
        } catch {}
    }
    return null
}

function getUsageTokens(): string[] {
    const tokens: string[] = []
    const seen = new Set<string>()
    const add = (token: string | null) => {
        if (!token || seen.has(token)) return
        seen.add(token)
        tokens.push(token)
    }

    if (process.platform === 'darwin') {
        add(parseUsageAccessToken(readMacKeychainSecret(MACOS_USAGE_CREDENTIALS_SERVICE)))
        for (const service of listMacKeychainCredentialCandidates()) {
            add(parseUsageAccessToken(readMacKeychainSecret(service)))
        }
    }
    add(readUsageTokenFromCredentialsFile())
    return tokens
}

function readCcstatuslineUsageCache(): Record<string, unknown> | null {
    try {
        if (!existsSync(CCSTATUSLINE_USAGE_CACHE_FILE)) return null
        const parsed = JSON.parse(readFileSync(CCSTATUSLINE_USAGE_CACHE_FILE, 'utf-8')) as Record<string, unknown>
        const sessionUsage = typeof parsed.sessionUsage === 'number' ? parsed.sessionUsage : null
        const sessionResetAt = typeof parsed.sessionResetAt === 'string' ? parsed.sessionResetAt : null
        const weeklyUsage = typeof parsed.weeklyUsage === 'number' ? parsed.weeklyUsage : null
        const weeklyResetAt = typeof parsed.weeklyResetAt === 'string' ? parsed.weeklyResetAt : null
        if (sessionUsage === null && weeklyUsage === null) return null
        return {
            five_hour: sessionUsage === null ? null : { utilization: sessionUsage, resets_at: sessionResetAt },
            seven_day: weeklyUsage === null ? null : { utilization: weeklyUsage, resets_at: weeklyResetAt },
            seven_day_opus: null,
            seven_day_sonnet: null,
            extra_usage: {
                is_enabled: typeof parsed.extraUsageEnabled === 'boolean' ? parsed.extraUsageEnabled : false,
                monthly_limit: typeof parsed.extraUsageLimit === 'number' ? parsed.extraUsageLimit : null,
                used_credits: typeof parsed.extraUsageUsed === 'number' ? parsed.extraUsageUsed : null,
                utilization: typeof parsed.extraUsageUtilization === 'number' ? parsed.extraUsageUtilization : null
            }
        }
    } catch {
        return null
    }
}

async function fetchOAuthUsageWithToken(token: string): Promise<UsageFetchResult> {
    try {
        const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
                'anthropic-beta': 'oauth-2025-04-20'
            },
            signal: AbortSignal.timeout(10_000)
        })
        if (!resp.ok) {
            return { ok: false, retryable: resp.status === 401 || resp.status === 403 || resp.status === 429 }
        }
        const data = await resp.json()
        if (!data || typeof data !== 'object') return { ok: false, retryable: true }
        return { ok: true, data: data as Record<string, unknown> }
    } catch {
        return { ok: false, retryable: true }
    }
}


export class ApiMachineClient {
    private socket!: Socket<ServerToClientEvents, ClientToServerEvents>
    private keepAliveInterval: NodeJS.Timeout | null = null
    private keepAliveStartTimeout: ReturnType<typeof setTimeout> | null = null
    private rpcHandlerManager: RpcHandlerManager

    private readonly normalizedWorkspaceRoots: string[] | undefined

    constructor(
        private readonly token: string,
        private readonly machine: Machine,
        private readonly workspaceRoots?: string[]
    ) {
        // Realpath roots once so all subsequent comparisons are against
        // canonical, symlink-resolved locations. Falls back to lexical
        // resolution if realpath fails so we still get protection.
        this.normalizedWorkspaceRoots = normalizeWorkspaceRoots(workspaceRoots)

        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            logger: (msg, data) => logger.debug(msg, data)
        })

        registerCommonHandlers(this.rpcHandlerManager, getInvokedCwd())

        this.rpcHandlerManager.registerHandler<PathExistsRequest, PathExistsResponse>(RPC_METHODS.PathExists, async (params) => {
            const rawPaths = Array.isArray(params?.paths) ? params.paths : []
            const uniquePaths = Array.from(new Set(rawPaths.filter((path): path is string => typeof path === 'string')))
            const exists: Record<string, boolean> = {}

            await Promise.all(uniquePaths.map(async (path) => {
                const trimmed = path.trim()
                if (!trimmed) return
                try {
                    const stats = await stat(trimmed)
                    exists[trimmed] = stats.isDirectory()
                } catch {
                    exists[trimmed] = false
                }
            }))

            return { exists }
        })

        this.rpcHandlerManager.registerHandler('getOAuthUsage', async () => {
            const now = Date.now()
            if (cachedOAuthUsage && now - cachedOAuthUsage.fetchedAt < OAUTH_USAGE_CACHE_TTL_MS) {
                return cachedOAuthUsage.data
            }

            try {
                const tokens = getUsageTokens()
                for (const token of tokens) {
                    const result = await fetchOAuthUsageWithToken(token)
                    if (result.ok) {
                        const enriched = {
                            ...result.data,
                            accountLabel: null
                        }
                        cachedOAuthUsage = { data: enriched, fetchedAt: now }
                        return enriched
                    }
                    if (!result.retryable) break
                }

                const ccstatuslineCache = readCcstatuslineUsageCache()
                if (ccstatuslineCache) {
                    cachedOAuthUsage = { data: ccstatuslineCache, fetchedAt: now }
                    return ccstatuslineCache
                }

                return cachedOAuthUsage?.data ?? null
            } catch {
                return readCcstatuslineUsageCache() ?? cachedOAuthUsage?.data ?? null
            }
        })

        this.rpcHandlerManager.registerHandler<CursorChatStoreStatusRequest, CursorChatStoreStatus>(
            RPC_METHODS.CursorChatStoreStatus,
            async (params) => {
                const recordedHome = typeof params?.homeDir === 'string' ? params.homeDir.trim() : ''
                return await inspectCursorChatStore({
                    home: recordedHome || homedir(),
                    workspacePath: typeof params?.workspacePath === 'string' ? params.workspacePath : '',
                    cursorSessionId: typeof params?.cursorSessionId === 'string' ? params.cursorSessionId : ''
                })
            }
        )

        this.rpcHandlerManager.registerHandler<ListMachineDirectoryRequest, MachineListDirectoryResponse>(RPC_METHODS.ListMachineDirectory, async (params) => {
            if (!this.normalizedWorkspaceRoots?.length) {
                return { success: false, error: 'Workspace browsing is not enabled for this machine' }
            }

            const rawPath = typeof params?.path === 'string' ? params.path.trim() : ''
            if (!rawPath) {
                return { success: false, error: 'Path is required' }
            }

            const targetPath = await this.resolveForWorkspaceCheck(rawPath)
            if (!this.isWithinWorkspaceRoots(targetPath)) {
                return { success: false, error: 'Path is outside workspace roots' }
            }

            try {
                const dirStat = await stat(targetPath)
                if (!dirStat.isDirectory()) {
                    return { success: false, error: 'Path is not a directory' }
                }

                const dirEntries = await readdir(targetPath, { withFileTypes: true })
                const entries: MachineDirectoryEntry[] = []

                await Promise.all(dirEntries.map(async (entry) => {
                    if (entry.name.startsWith('.')) return

                    const fullPath = join(targetPath, entry.name)
                    let type: 'file' | 'directory' | 'other' = 'other'
                    let size: number | undefined
                    let modified: number | undefined
                    let isGitRepo = false

                    if (entry.isDirectory()) {
                        type = 'directory'
                        try {
                            const gitStat = await stat(join(fullPath, '.git'))
                            isGitRepo = gitStat.isDirectory() || gitStat.isFile()
                        } catch {
                            // not a git repo
                        }
                    } else if (entry.isFile()) {
                        type = 'file'
                    }

                    if (!entry.isSymbolicLink()) {
                        try {
                            const stats = await stat(fullPath)
                            size = stats.size
                            modified = stats.mtime.getTime()
                        } catch {
                            // ignore stat errors
                        }
                    }

                    entries.push({ name: entry.name, type, size, modified, isGitRepo })
                }))

                entries.sort((a, b) => {
                    if (a.type === 'directory' && b.type !== 'directory') return -1
                    if (a.type !== 'directory' && b.type === 'directory') return 1
                    return a.name.localeCompare(b.name)
                })

                return { success: true, entries }
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : 'Failed to list directory' }
            }
        })

        // OpenCode model discovery spawns an `opencode acp` subprocess scoped to the
        // requested cwd, so it must obey the same workspace-root containment as
        // `list-directory` and `spawn-happy-session`. Re-register the handler that
        // `registerCommonHandlers` installed unguarded with a guarded version that
        // resolves symlinks and rejects paths outside the configured root before
        // delegating to the lower-level probe. This intentionally overwrites the
        // earlier registration on the same scoped method name.
        this.rpcHandlerManager.registerHandler<ListOpencodeModelsForCwdRequest, ListOpencodeModelsForCwdResponse>(
            RPC_METHODS.ListOpencodeModelsForCwd,
            async (params) => {
                const rawCwd = typeof params?.cwd === 'string' ? params.cwd.trim() : ''
                if (!rawCwd) {
                    return { success: false, error: 'cwd is required' }
                }

                const resolvedCwd = await this.resolveForWorkspaceCheck(rawCwd)
                if (!this.isWithinWorkspaceRoots(resolvedCwd)) {
                    return { success: false, error: 'Path is outside workspace roots' }
                }

                return await listOpencodeModelsForCwd(resolvedCwd)
            }
        )

        this.rpcHandlerManager.registerHandler<ListGrokModelsForCwdRequest, ListGrokModelsForCwdResponse>(
            RPC_METHODS.ListGrokModelsForCwd,
            async (params) => {
                const rawCwd = typeof params?.cwd === 'string' ? params.cwd.trim() : ''
                if (!rawCwd) return { success: false, error: 'cwd is required' }

                const resolvedCwd = await this.resolveForWorkspaceCheck(rawCwd)
                if (!this.isWithinWorkspaceRoots(resolvedCwd)) {
                    return { success: false, error: 'Path is outside workspace roots' }
                }

                return await listGrokModelsForCwd(resolvedCwd)
            }
        )

        this.rpcHandlerManager.registerHandler<unknown, ListCodexSessionsRpcResponse>(
            RPC_METHODS.ListCodexSessions,
            async (params) => {
                const parsed = ListCodexSessionsRpcRequestSchema.safeParse(params)
                if (!parsed.success) return { success: false, error: 'Invalid Codex sessions request' }
                const rawCwd = typeof parsed.data.cwd === 'string' ? parsed.data.cwd.trim() : ''
                if (rawCwd) {
                    const resolvedCwd = await this.resolveForWorkspaceCheck(rawCwd)
                    if (!this.isWithinWorkspaceRoots(resolvedCwd)) {
                        return { success: false, error: 'Path is outside workspace roots' }
                    }
                }
                const requestedIds = parsed.data.sessionIds
                    ? new Set(parsed.data.sessionIds)
                    : null
                const allSessions = requestedIds
                    ? listLocalCodexSessionsWithMessagesByIds(requestedIds)
                    : listLocalCodexSessionSummaries()
                const sessions = []
                for (const session of allSessions) {
                    if (await this.isCodexSessionWithinWorkspaceRoots(session)) {
                        sessions.push(session)
                    }
                }
                return { success: true, sessions }
            }
        )

        this.rpcHandlerManager.registerHandler<unknown, ArchiveCodexSessionRpcResponse>(
            RPC_METHODS.ArchiveCodexSession,
            async (params) => {
                const parsed = ArchiveCodexSessionRpcRequestSchema.safeParse(params)
                if (!parsed.success) return { success: false, error: 'Invalid Codex archive request' }
                const sessionId = parsed.data.sessionId.trim()
                return await archiveLocalCodexSession(sessionId, {
                    canArchive: (session) => this.isCodexSessionWithinWorkspaceRoots(session)
                })
            }
        )

        this.rpcHandlerManager.registerHandler<unknown, CodexAccountsResponse>(
            RPC_METHODS.ListCodexAccounts,
            async () => CodexAccountsResponseSchema.parse(await codexAccountManager.listAccounts())
        )

        this.rpcHandlerManager.registerHandler<unknown, CodexAccountLoginStartResponse>(
            RPC_METHODS.StartCodexAccountLogin,
            async () => await codexAccountManager.startLogin()
        )

        this.rpcHandlerManager.registerHandler<unknown, CodexAccountLoginStatusResponse>(
            RPC_METHODS.GetCodexAccountLoginStatus,
            async (params) => {
                const attemptId = asRecord(params)?.attemptId
                if (typeof attemptId !== 'string' || !attemptId.trim()) {
                    return {
                        success: false,
                        status: 'not_found',
                        error: 'Codex login attempt id is required'
                    }
                }
                return CodexAccountLoginStatusResponseSchema.parse(
                    codexAccountManager.getLoginStatus(attemptId)
                )
            }
        )

        this.rpcHandlerManager.registerHandler<unknown, CodexAccountsResponse>(
            RPC_METHODS.AddCodexApiEndpoint,
            async (params) => {
                const parsed = AddCodexApiEndpointRequestSchema.safeParse(params)
                if (!parsed.success) {
                    throw new Error(parsed.error.issues[0]?.message ?? 'Invalid Codex API endpoint')
                }
                return CodexAccountsResponseSchema.parse(
                    await codexAccountManager.addApiEndpoint(parsed.data)
                )
            }
        )

        this.rpcHandlerManager.registerHandler<unknown, CodexAccountsResponse>(
            RPC_METHODS.SetDefaultCodexAccount,
            async (params) => {
                const accountId = asRecord(params)?.accountId
                if (typeof accountId !== 'string' || !accountId.trim()) {
                    throw new Error('Codex account id is required')
                }
                return CodexAccountsResponseSchema.parse(
                    await codexAccountManager.setDefaultAccount(accountId)
                )
            }
        )

        this.rpcHandlerManager.registerHandler<unknown, CodexAccountsResponse>(
            RPC_METHODS.RemoveCodexAccount,
            async (params) => {
                const accountId = asRecord(params)?.accountId
                if (typeof accountId !== 'string' || !accountId.trim()) {
                    throw new Error('Codex account id is required')
                }
                return CodexAccountsResponseSchema.parse(
                    await codexAccountManager.removeAccount(accountId)
                )
            }
        )
    }

    private async isCodexSessionWithinWorkspaceRoots(session: { cwd?: string | null }): Promise<boolean> {
        if (!this.normalizedWorkspaceRoots?.length) return true
        const cwd = session.cwd?.trim()
        if (!cwd) return false
        const resolvedCwd = await this.resolveForWorkspaceCheck(cwd)
        return this.isWithinWorkspaceRoots(resolvedCwd)
    }

    private isWithinWorkspaceRoots(absolutePath: string): boolean {
        if (!this.normalizedWorkspaceRoots?.length) return true
        return this.normalizedWorkspaceRoots.some((workspaceRoot) => {
            const rel = relative(workspaceRoot, absolutePath)
            return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
        })
    }

    /**
     * Canonicalize a path for workspace-root containment checks. Resolves
     * symlinks via realpath so a symlink such as `/safe/out -> /etc` cannot
     * be used to escape the configured root with a lexical-only check.
     *
     * If the path doesn't exist (e.g. a session is being spawned in a
     * directory we'll create), walks up to the nearest existing ancestor
     * and realpaths *that*, joining the missing tail back on. This way the
     * check still runs against the real on-disk location once any
     * intermediate symlink in the parent chain has been resolved.
     */
    private async resolveForWorkspaceCheck(path: string): Promise<string> {
        const absolute = resolvePath(path)
        try {
            return normalizeWindowsDriveRoot(await realpath(absolute))
        } catch {
            const missing: string[] = []
            let cursor = absolute
            while (cursor !== dirname(cursor)) {
                missing.unshift(basename(cursor))
                cursor = dirname(cursor)
                try {
                    return join(normalizeWindowsDriveRoot(await realpath(cursor)), ...missing)
                } catch {
                    // keep walking to the nearest existing parent
                }
            }
            return normalizeWindowsDriveRoot(absolute)
        }
    }

    setRPCHandlers({ spawnSession, stopSession, requestShutdown }: MachineRpcHandlers): void {
        this.rpcHandlerManager.registerHandler(RPC_METHODS.SpawnHappySession, async (params: any) => {
            const { directory, sessionId, existingSessionId, resumeSessionId, continueLatest, machineId, approvedNewDirectoryCreation, agent, model, effort, modelReasoningEffort, yolo, permissionMode, serviceTier, codexAccountId, codexSourceAccountId, token, sessionType, worktreeName, sandbox } = params || {}

            if (!directory) {
                throw new Error('Directory is required')
            }

            const resolvedDirectory = await this.resolveForWorkspaceCheck(directory)
            if (!this.isWithinWorkspaceRoots(resolvedDirectory)) {
                return { type: 'error', errorMessage: 'Directory is outside this machine\'s workspace roots' }
            }

            const result = await spawnSession({
                directory,
                sessionId,
                existingSessionId,
                resumeSessionId,
                continueLatest,
                machineId,
                approvedNewDirectoryCreation,
                agent,
                model,
                effort,
                modelReasoningEffort,
                yolo,
                permissionMode,
                serviceTier,
                codexAccountId,
                codexSourceAccountId,
                token,
                sessionType,
                worktreeName,
                sandbox
            })

            switch (result.type) {
                case 'success':
                    return { type: 'success', sessionId: result.sessionId }
                case 'requestToApproveDirectoryCreation':
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory }
                case 'error':
                    return { type: 'error', errorMessage: result.errorMessage }
            }
        })

        this.rpcHandlerManager.registerHandler(RPC_METHODS.StopSession, (params: any) => {
            const { sessionId } = params || {}
            if (!sessionId) {
                throw new Error('Session ID is required')
            }

            const success = stopSession(sessionId)
            if (!success) {
                throw new Error('Session not found or failed to stop')
            }

            return { message: 'Session stopped' }
        })

        this.rpcHandlerManager.registerHandler(RPC_METHODS.StopRunner, () => {
            setTimeout(() => requestShutdown(), 100)
            return { message: 'Runner stop request acknowledged' }
        })
    }

    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.metadata)

            const answer = await this.socket.emitWithAck('machine-update-metadata', {
                machineId: this.machine.id,
                metadata: updated,
                expectedVersion: this.machine.metadataVersion
            }) as unknown

            applyVersionedAck(answer, {
                valueKey: 'metadata',
                parseValue: (value) => {
                    const parsed = MachineMetadataSchema.safeParse(value)
                    return parsed.success ? parsed.data : null
                },
                applyValue: (value) => {
                    this.machine.metadata = value
                },
                applyVersion: (version) => {
                    this.machine.metadataVersion = version
                },
                logInvalidValue: (context, version) => {
                    const suffix = context === 'success' ? 'ack' : 'version-mismatch ack'
                    logger.debug(`[API MACHINE] Ignoring invalid metadata value from ${suffix}`, { version })
                },
                invalidResponseMessage: 'Invalid machine-update-metadata response',
                errorMessage: 'Machine metadata update failed',
                versionMismatchMessage: 'Metadata version mismatch'
            })
        })
    }

    async updateRunnerState(handler: (state: RunnerState | null) => RunnerState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.runnerState)

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                runnerState: updated,
                expectedVersion: this.machine.runnerStateVersion
            }) as unknown

            applyVersionedAck(answer, {
                valueKey: 'runnerState',
                parseValue: (value) => {
                    const parsed = RunnerStateSchema.safeParse(value)
                    return parsed.success ? parsed.data : null
                },
                applyValue: (value) => {
                    this.machine.runnerState = value
                },
                applyVersion: (version) => {
                    this.machine.runnerStateVersion = version
                },
                logInvalidValue: (context, version) => {
                    const suffix = context === 'success' ? 'ack' : 'version-mismatch ack'
                    logger.debug(`[API MACHINE] Ignoring invalid runnerState value from ${suffix}`, { version })
                },
                invalidResponseMessage: 'Invalid machine-update-state response',
                errorMessage: 'Machine state update failed',
                versionMismatchMessage: 'Runner state version mismatch'
            })
        })
    }

    connect(): void {
        this.socket = io(`${configuration.apiUrl}/cli`, {
            transports: ['websocket'],
            auth: {
                token: this.token,
                clientType: 'machine-scoped' as const,
                machineId: this.machine.id,
                clientTime: Date.now()
            },
            path: '/socket.io/',
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            ...buildSocketIoExtraHeaderOptions()
        })

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to bot')
            this.rpcHandlerManager.onSocketConnect(this.socket)
            this.updateRunnerState((state) => ({
                ...(state ?? {}),
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.runnerState?.httpPort,
                startedAt: Date.now()
            })).catch((error) => {
                logger.debug('[API MACHINE] Failed to update runner state on connect', error)
            })

            const hubWorkspaceRoots = this.machine.metadata?.workspaceRoots
            const desiredWorkspaceRoots = this.workspaceRoots
            if (!workspaceRootsEqual(desiredWorkspaceRoots, hubWorkspaceRoots)) {
                if (desiredWorkspaceRoots?.length) {
                    console.log(`[HAPI] Syncing workspace roots to hub: ${formatWorkspaceRoots(desiredWorkspaceRoots)} (current hub value: ${formatWorkspaceRoots(hubWorkspaceRoots)})`)
                } else {
                    console.log(`[HAPI] Clearing workspace roots on hub (was: ${formatWorkspaceRoots(hubWorkspaceRoots)})`)
                }
                this.updateMachineMetadata((current) => {
                    const base = current ?? this.machine.metadata
                    if (!base) {
                        return { workspaceRoots: desiredWorkspaceRoots } as MachineMetadata
                    }
                    if (desiredWorkspaceRoots?.length) {
                        return { ...base, workspaceRoots: desiredWorkspaceRoots }
                    }
                    const { workspaceRoots: _workspaceRoots, ...rest } = base
                    return rest as MachineMetadata
                }).then(() => {
                    console.log(`[HAPI] Workspace roots synced: ${formatWorkspaceRoots(this.machine.metadata?.workspaceRoots)}`)
                }).catch((error) => {
                    console.error('[HAPI] Failed to sync workspace roots:', error instanceof Error ? error.message : error)
                })
            } else if (desiredWorkspaceRoots?.length) {
                console.log(`[HAPI] Workspace roots already up to date on hub: ${formatWorkspaceRoots(desiredWorkspaceRoots)}`)
            }

            this.startKeepAlive()
        })

        this.socket.on('disconnect', () => {
            logger.debug('[API MACHINE] Disconnected from bot')
            this.rpcHandlerManager.onSocketDisconnect()
            this.stopKeepAlive()
        })

        this.socket.on('rpc-request', async (data: { method: string; params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data))
        })

        this.socket.on('update', (data: Update) => {
            if (data.body.t !== 'update-machine') {
                return
            }

            const update = data.body as UpdateMachineBody
            if (update.machineId !== this.machine.id) {
                return
            }

            if (update.metadata) {
                const parsed = MachineMetadataSchema.safeParse(update.metadata.value)
                if (parsed.success) {
                    this.machine.metadata = parsed.data
                } else {
                    logger.debug('[API MACHINE] Ignoring invalid metadata update', { version: update.metadata.version })
                }
                this.machine.metadataVersion = update.metadata.version
            }

            if (update.runnerState) {
                const next = update.runnerState.value
                if (next == null) {
                    this.machine.runnerState = null
                } else {
                    const parsed = RunnerStateSchema.safeParse(next)
                    if (parsed.success) {
                        this.machine.runnerState = parsed.data
                    } else {
                        logger.debug('[API MACHINE] Ignoring invalid runnerState update', { version: update.runnerState.version })
                    }
                }
                this.machine.runnerStateVersion = update.runnerState.version
            }
        })

        this.socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${error.message}`)
        })

        this.socket.on('error', (payload) => {
            logger.debug('[API MACHINE] Socket error:', payload)
        })
    }

    private startKeepAlive(): void {
        this.stopKeepAlive()
        const emitAlive = () => {
            this.socket.emit('machine-alive', {
                machineId: this.machine.id,
                time: Date.now(),
                health: collectMachineHealth()
            })
        }
        // Prime CPU sampling so the first heartbeat already includes CPU %.
        collectMachineHealth()
        this.keepAliveStartTimeout = setTimeout(() => {
            this.keepAliveStartTimeout = null
            emitAlive()
            this.keepAliveInterval = setInterval(emitAlive, 20_000)
        }, 50)
    }

    private stopKeepAlive(): void {
        if (this.keepAliveStartTimeout) {
            clearTimeout(this.keepAliveStartTimeout)
            this.keepAliveStartTimeout = null
        }
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval)
            this.keepAliveInterval = null
        }
    }

    shutdown(): void {
        this.stopKeepAlive()
        if (this.socket) {
            this.socket.close()
        }
    }
}
