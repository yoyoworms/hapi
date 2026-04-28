/**
 * WebSocket client for machine/runner communication with hapi-hub
 */

import { io, type Socket } from 'socket.io-client'
import { stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'
import type { Update, UpdateMachineBody } from '@hapi/protocol'
import type { RunnerState, Machine, MachineMetadata } from './types'
import { RunnerStateSchema, MachineMetadataSchema } from './types'
import { backoff } from '@/utils/time'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { RpcHandlerManager } from './rpc/RpcHandlerManager'
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers'
import type { SpawnSessionOptions, SpawnSessionResult } from '../modules/common/rpcTypes'
import { applyVersionedAck } from './versionedUpdate'

interface ServerToRunnerEvents {
    update: (data: Update) => void
    'rpc-request': (data: { method: string; params: string }, callback: (response: string) => void) => void
    error: (data: { message: string }) => void
}

interface RunnerToServerEvents {
    'machine-alive': (data: { machineId: string; time: number }) => void
    'machine-update-metadata': (data: { machineId: string; metadata: unknown; expectedVersion: number }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number
        metadata: unknown | null
    } | {
        result: 'success'
        version: number
        metadata: unknown | null
    }) => void) => void
    'machine-update-state': (data: { machineId: string; runnerState: unknown | null; expectedVersion: number }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number
        runnerState: unknown | null
    } | {
        result: 'success'
        version: number
        runnerState: unknown | null
    }) => void) => void
    'rpc-register': (data: { method: string }) => void
    'rpc-unregister': (data: { method: string }) => void
}

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>
    stopSession: (sessionId: string) => boolean
    requestShutdown: () => void
}

interface PathExistsRequest {
    paths: string[]
}

interface PathExistsResponse {
    exists: Record<string, boolean>
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
    private socket!: Socket<ServerToRunnerEvents, RunnerToServerEvents>
    private keepAliveInterval: NodeJS.Timeout | null = null
    private rpcHandlerManager: RpcHandlerManager

    constructor(
        private readonly token: string,
        private readonly machine: Machine
    ) {
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            logger: (msg, data) => logger.debug(msg, data)
        })

        registerCommonHandlers(this.rpcHandlerManager, getInvokedCwd())

        this.rpcHandlerManager.registerHandler<PathExistsRequest, PathExistsResponse>('path-exists', async (params) => {
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
    }

    setRPCHandlers({ spawnSession, stopSession, requestShutdown }: MachineRpcHandlers): void {
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            const { directory, sessionId, resumeSessionId, machineId, approvedNewDirectoryCreation, agent, model, effort, modelReasoningEffort, yolo, token, sessionType, worktreeName, sandbox } = params || {}

            if (!directory) {
                throw new Error('Directory is required')
            }

            const result = await spawnSession({
                directory,
                sessionId,
                resumeSessionId,
                machineId,
                approvedNewDirectoryCreation,
                agent,
                model,
                effort,
                modelReasoningEffort,
                yolo,
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

        this.rpcHandlerManager.registerHandler('stop-session', (params: any) => {
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

        this.rpcHandlerManager.registerHandler('stop-runner', () => {
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
            reconnectionDelayMax: 5000
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
        // Send immediately on connect/reconnect so hub marks machine active right away
        this.socket.emit('machine-alive', {
            machineId: this.machine.id,
            time: Date.now()
        })
        this.keepAliveInterval = setInterval(() => {
            this.socket.emit('machine-alive', {
                machineId: this.machine.id,
                time: Date.now()
            })
        }, 20_000)
    }

    private stopKeepAlive(): void {
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
