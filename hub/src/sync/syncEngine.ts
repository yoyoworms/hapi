/**
 * Sync Engine for HAPI Telegram Bot (Direct Connect)
 *
 * In the direct-connect architecture:
 * - hapi-hub is the hub (Socket.IO + REST)
 * - hapi CLI connects directly to the hub (no relay)
 * - No E2E encryption; data is stored as JSON in SQLite
 */

import { isKnownFlavor, type LocalResumeTarget, type ResumableSession } from '@hapi/protocol'
import type { SlashCommandsResponse } from '@hapi/protocol/apiTypes'
import type { AgentAccountStatus, AgentFlavor, CodexCollaborationMode, DecryptedMessage, PermissionMode, Session, SyncEvent } from '@hapi/protocol/types'
import { MetadataSchema } from '@hapi/protocol/schemas'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { Server } from 'socket.io'
import type { Store, CancelQueuedMessageResult } from '../store'
import type { RpcRegistry } from '../socket/rpcRegistry'
import type { SSEManager } from '../sse/sseManager'
import { EventPublisher, type SyncEventListener } from './eventPublisher'
import { MachineCache, type Machine } from './machineCache'
import { MessageService } from './messageService'
import {
    RpcGateway,
    type RpcCodexModel,
    type RpcCommandResponse,
    type RpcDeleteUploadResponse,
    type RpcGeneratedImageResponse,
    type RpcListDirectoryResponse,
    type RpcListCodexModelsResponse,
    type RpcListCursorModelsResponse,
    type RpcListOpencodeModelsResponse,
    type RpcCursorModel,
    type RpcOpencodeModel,
    type RpcPathExistsResponse,
    type RpcReadFileResponse,
    type RpcUploadFileResponse
} from './rpcGateway'
import { SessionCache } from './sessionCache'

export type { Session, SyncEvent } from '@hapi/protocol/types'
export type { Machine } from './machineCache'
export type { SyncEventListener } from './eventPublisher'
export type {
    RpcCodexModel,
    RpcCommandResponse,
    RpcDeleteUploadResponse,
    RpcGeneratedImageResponse,
    RpcListDirectoryResponse,
    RpcListCodexModelsResponse,
    RpcListCursorModelsResponse,
    RpcListOpencodeModelsResponse,
    RpcCursorModel,
    RpcOpencodeModel,
    RpcPathExistsResponse,
    RpcReadFileResponse,
    RpcUploadFileResponse
} from './rpcGateway'

export type ResumeSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'resume_unavailable' | 'resume_failed' }

function getNativeAgentSessionId(metadata: {
    claudeSessionId?: string
    codexSessionId?: string
    geminiSessionId?: string
    opencodeSessionId?: string
    cursorSessionId?: string
}): string | null {
    return metadata.codexSessionId
        ?? metadata.claudeSessionId
        ?? metadata.geminiSessionId
        ?? metadata.opencodeSessionId
        ?? metadata.cursorSessionId
        ?? null
}

export type LocalResumeTargetResult =
    | { type: 'success'; target: LocalResumeTarget }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'resume_unavailable' }

export type LocalHandoffResult =
    | { type: 'success' }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'already_local' | 'handoff_failed' }

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function normalizeUserMessageText(value: string): string | undefined {
    const text = value.trim().replace(/\s+/g, ' ')
    return text.length > 0 ? text : undefined
}

function extractUserMessageText(content: unknown): string | undefined {
    if (typeof content === 'string') {
        return normalizeUserMessageText(content)
    }

    if (Array.isArray(content)) {
        const parts = content
            .map((block) => {
                const record = asRecord(block)
                return record?.type === 'text' && typeof record.text === 'string'
                    ? record.text
                    : null
            })
            .filter((text): text is string => text !== null)
        return normalizeUserMessageText(parts.join(' '))
    }

    const record = asRecord(content)
    if (record?.type === 'text' && typeof record.text === 'string') {
        return normalizeUserMessageText(record.text)
    }

    return undefined
}

function extractClaudeUserMessageTextFromAgentOutput(content: unknown): string | undefined {
    const record = asRecord(content)
    if (record?.type !== 'output') return undefined

    const data = asRecord(record.data)
    if (data?.type !== 'user') return undefined

    const message = asRecord(data.message)
    if (message?.role !== 'user') return undefined

    return extractUserMessageText(message.content)
}

export class SyncEngine {
    private readonly eventPublisher: EventPublisher
    private readonly sessionCache: SessionCache
    private readonly machineCache: MachineCache
    private readonly messageService: MessageService
    private readonly rpcGateway: RpcGateway
    private inactivityTimer: NodeJS.Timeout | null = null

    constructor(
        private readonly store: Store,
        io: Server,
        rpcRegistry: RpcRegistry,
        sseManager: SSEManager
    ) {
        this.eventPublisher = new EventPublisher(sseManager, (event) => this.resolveNamespace(event))
        this.sessionCache = new SessionCache(store, this.eventPublisher)
        this.machineCache = new MachineCache(store, this.eventPublisher)
        this.messageService = new MessageService(
            store,
            io,
            this.eventPublisher,
            (sessionId, updatedAt) => this.recordSessionActivity(sessionId, updatedAt)
        )
        this.rpcGateway = new RpcGateway(io, rpcRegistry)
        this.reloadAll()
        this.inactivityTimer = setInterval(() => this.expireInactive(), 5_000)
    }

    stop(): void {
        if (this.inactivityTimer) {
            clearInterval(this.inactivityTimer)
            this.inactivityTimer = null
        }
    }

    subscribe(listener: SyncEventListener): () => void {
        return this.eventPublisher.subscribe(listener)
    }

    private resolveNamespace(event: SyncEvent): string | undefined {
        if (event.namespace) {
            return event.namespace
        }
        if ('sessionId' in event) {
            return this.getSession(event.sessionId)?.namespace
        }
        if ('machineId' in event) {
            return this.machineCache.getMachine(event.machineId)?.namespace
        }
        return undefined
    }

    getSessions(): Session[] {
        return this.sessionCache.getSessions()
    }

    getSessionsByNamespace(namespace: string): Session[] {
        return this.sessionCache.getSessionsByNamespace(namespace)
    }

    getFutureScheduledMessageCounts(sessionIds: string[], now: number = Date.now()): Map<string, number> {
        return this.store.messages.countFutureScheduledBySessionIds(sessionIds, now)
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessionCache.getSession(sessionId) ?? this.sessionCache.refreshSession(sessionId) ?? undefined
    }

    getSessionByNamespace(sessionId: string, namespace: string): Session | undefined {
        const session = this.sessionCache.getSessionByNamespace(sessionId, namespace)
            ?? this.sessionCache.refreshSession(sessionId)
        if (!session || session.namespace !== namespace) {
            return undefined
        }
        return session
    }

    resolveSessionAccess(
        sessionId: string,
        namespace: string
    ): { ok: true; sessionId: string; session: Session } | { ok: false; reason: 'not-found' | 'access-denied' } {
        return this.sessionCache.resolveSessionAccess(sessionId, namespace)
    }

    getActiveSessions(): Session[] {
        return this.sessionCache.getActiveSessions()
    }

    getMachines(): Machine[] {
        return this.machineCache.getMachines()
    }

    getMachinesByNamespace(namespace: string): Machine[] {
        return this.machineCache.getMachinesByNamespace(namespace)
    }

    getMachine(machineId: string): Machine | undefined {
        return this.machineCache.getMachine(machineId)
    }

    getMachineByNamespace(machineId: string, namespace: string): Machine | undefined {
        return this.machineCache.getMachineByNamespace(machineId, namespace)
    }

    async getUsage(namespace: string): Promise<unknown> {
        const machines = this.machineCache.getOnlineMachinesByNamespace(namespace)
        if (machines.length === 0) {
            console.log('[usage] no machines online')
            return null
        }
        // Try each online machine until one succeeds
        for (const machine of machines) {
            try {
                console.log(`[usage] calling getOAuthUsage on machine ${machine.id}`)
                const result = await this.rpcGateway.getOAuthUsage(machine.id)
                if (result) {
                    console.log(`[usage] result: ok`)
                    return result
                }
            } catch (err) {
                console.log(`[usage] error on ${machine.id}: ${err instanceof Error ? err.message : String(err)}`)
            }
        }
        return null
    }

    getOnlineMachines(): Machine[] {
        return this.machineCache.getOnlineMachines()
    }

    getOnlineMachinesByNamespace(namespace: string): Machine[] {
        return this.machineCache.getOnlineMachinesByNamespace(namespace)
    }

    getMessagesPage(
        sessionId: string,
        options: { limit: number; before?: { at: number; seq: number } | null }
    ): {
        messages: DecryptedMessage[]
        page: {
            limit: number
            nextBeforeSeq: number | null
            nextBeforeAt: number | null
            hasMore: boolean
        }
    } {
        return this.messageService.getMessagesPage(sessionId, options)
    }

    getDeliverableMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number; now: number }): DecryptedMessage[] {
        return this.messageService.getDeliverableMessagesAfter(sessionId, options)
    }

    /** Fork's incremental-sync path: returns messages with seq > afterSeq, including
     *  scheduled rows that haven't matured yet. Backed by `getDeliverableMessagesAfter`
     *  using `now = Date.now()` so future-scheduled rows are excluded for the CLI
     *  backfill semantics; web's afterSeq sync still surfaces queued/scheduled rows
     *  via the dedicated uninvoked-local query elsewhere. */
    getMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number }): DecryptedMessage[] {
        return this.messageService.getDeliverableMessagesAfter(sessionId, {
            afterSeq: options.afterSeq,
            limit: options.limit,
            now: Date.now()
        })
    }

    handleRealtimeEvent(event: SyncEvent): void {
        if (event.type === 'session-updated' && event.sessionId) {
            // Snapshot agent session IDs before refresh — safe because JS is single-threaded
            // and refreshSession replaces the Map entry with a new object.
            const before = this.sessionCache.getSession(event.sessionId)
            this.sessionCache.refreshSession(event.sessionId)
            const after = this.sessionCache.getSession(event.sessionId)
            if (after?.metadata && !this.hasSameAgentSessionIds(before?.metadata ?? null, after.metadata)) {
                void this.sessionCache.deduplicateByAgentSessionId(event.sessionId).catch(() => {
                    // best-effort: dedup failure is harmless, web-side safety net hides remaining duplicates
                })
            }
            return
        }

        if (event.type === 'machine-updated' && event.machineId) {
            this.machineCache.refreshMachine(event.machineId)
            return
        }

        if (event.type === 'message-received' && event.sessionId) {
            if (!this.getSession(event.sessionId)) {
                this.sessionCache.refreshSession(event.sessionId)
            }
        }

        this.eventPublisher.emit(event)
    }

    handleSessionAlive(payload: {
        sid: string
        time: number
        thinking?: boolean
        mode?: 'local' | 'remote'
        permissionMode?: PermissionMode
        model?: string | null
        modelReasoningEffort?: string | null
        effort?: string | null
        collaborationMode?: CodexCollaborationMode
    }): void {
        this.sessionCache.handleSessionAlive(payload)
        this.triggerDedupIfNeeded(payload.sid)
    }

    handleSessionEnd(payload: { sid: string; time: number; reason?: 'completed' | 'terminated' | 'error' }): void {
        this.sessionCache.handleSessionEnd(payload)
        this.eventPublisher.emit({
            type: 'session-ended',
            sessionId: payload.sid,
            reason: payload.reason
        })
        // Retry dedup now that this session is inactive — a prior dedup may have
        // skipped it because it was still active at the time.
        this.triggerDedupIfNeeded(payload.sid)
    }

    handleBackgroundTaskDelta(sessionId: string, delta: { started: number; completed: number }): void {
        this.sessionCache.applyBackgroundTaskDelta(sessionId, delta)
    }

    recordSessionActivity(sessionId: string, updatedAt: number): void {
        this.sessionCache.recordSessionActivity(sessionId, updatedAt)
    }

    handleSessionUsage(payload: {
        sid: string
        totalCostUsd: number
        totalInputTokens: number
        totalOutputTokens: number
    }): void {
        this.sessionCache.handleSessionUsage(payload)
    }

    handleSessionAccountStatus(payload: { sid: string; accountStatus: AgentAccountStatus }): void {
        this.sessionCache.handleSessionAccountStatus(payload)
    }

    async handleSessionMetadataUpdated(payload: { sid: string; namespace: string; metadata: unknown }): Promise<void> {
        const currentMetadata = MetadataSchema.safeParse(payload.metadata)
        if (!currentMetadata.success) {
            return
        }

        const nativeSessionId = getNativeAgentSessionId(currentMetadata.data)
        if (!nativeSessionId) {
            return
        }

        const current = this.store.sessions.getSessionByNamespace(payload.sid, payload.namespace)
        if (!current) {
            return
        }

        const duplicates = this.store.sessions.getSessionsByNamespace(payload.namespace)
            .filter((session) => {
                if (session.id === payload.sid) {
                    return false
                }
                const metadata = MetadataSchema.safeParse(session.metadata)
                if (!metadata.success) {
                    return false
                }
                return getNativeAgentSessionId(metadata.data) === nativeSessionId
            })
            .sort((left, right) => left.updatedAt - right.updatedAt)

        for (const duplicate of duplicates) {
            try {
                await this.sessionCache.mergeSessions(duplicate.id, current.id, payload.namespace)
            } catch (error) {
                console.warn('[SyncEngine] Failed to merge duplicate native agent session', error)
            }
        }
    }

    handleMachineAlive(payload: { machineId: string; time: number }): void {
        this.machineCache.handleMachineAlive(payload)
    }

    private expireInactive(): void {
        const expired = this.sessionCache.expireInactive()
        // Sort by most recent first so dedup keeps the newest session when multiple
        // duplicates for the same agent thread expire in the same sweep.
        const sorted = expired
            .map((id) => this.sessionCache.getSession(id))
            .filter((s): s is NonNullable<typeof s> => s != null)
            .sort((a, b) => (b.activeAt - a.activeAt) || (b.updatedAt - a.updatedAt))
        for (const session of sorted) {
            this.triggerDedupIfNeeded(session.id)
        }
        this.machineCache.expireInactive()
        // Piggybacked on the inactivity tick; not a logical part of expireInactive
        // but shares its 5s cadence (avoids a second timer).
        this.messageService.releaseMatureScheduledMessages(Date.now())
    }

    private reloadAll(): void {
        this.sessionCache.reloadAll()
        this.machineCache.reloadAll()
    }

    getOrCreateSession(
        tag: string,
        metadata: unknown,
        agentState: unknown,
        namespace: string,
        model?: string,
        effort?: string,
        modelReasoningEffort?: string
    ): Session {
        return this.sessionCache.getOrCreateSession(tag, metadata, agentState, namespace, model, effort, modelReasoningEffort)
    }

    getOrCreateMachine(id: string, metadata: unknown, runnerState: unknown, namespace: string): Machine {
        return this.machineCache.getOrCreateMachine(id, metadata, runnerState, namespace)
    }

    async sendMessage(
        sessionId: string,
        payload: {
            text: string
            localId?: string | null
            attachments?: Array<{
                id: string
                filename: string
                mimeType: string
                size: number
                path: string
                previewUrl?: string
            }>
            sentFrom?: 'telegram-bot' | 'webapp'
            scheduledAt?: number | null
        }
    ): Promise<void> {
        // Flush CLI's outgoing message queue before storing the user message.
        // This ensures any pending assistant responses get a lower seq number
        // than the new user message, preventing the "reply appears after next
        // message" ordering issue visible in the web UI.
        await this.rpcGateway.flushMessages(sessionId)
        await this.messageService.sendMessage(sessionId, payload)
        this.sessionCache.markMessageQueued(sessionId)
        this.sessionCache.recordSessionActivity(sessionId, Date.now())
    }

    async cancelQueuedMessage(
        sessionId: string,
        messageId: string
    ): Promise<CancelQueuedMessageResult> {
        return this.messageService.cancelQueuedMessage(sessionId, messageId)
    }

    sweepImmediateQueuedOnSessionEnd(sessionId: string, invokedAt: number): void {
        this.messageService.sweepImmediateQueuedOnSessionEnd(sessionId, invokedAt)
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        mode?: PermissionMode,
        allowTools?: string[],
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
        answers?: Record<string, string[]> | Record<string, { answers: string[] }>
    ): Promise<void> {
        await this.rpcGateway.approvePermission(sessionId, requestId, mode, allowTools, decision, answers)
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    ): Promise<void> {
        await this.rpcGateway.denyPermission(sessionId, requestId, decision)
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.rpcGateway.abortSession(sessionId)
    }

    async archiveSession(sessionId: string): Promise<void> {
        await this.rpcGateway.killSession(sessionId)
        this.handleSessionEnd({ sid: sessionId, time: Date.now() })
    }

    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.rpcGateway.switchSession(sessionId, to)
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        await this.sessionCache.renameSession(sessionId, name)
    }

    async pinSession(sessionId: string, pinned: boolean): Promise<void> {
        await this.sessionCache.pinSession(sessionId, pinned)
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.sessionCache.deleteSession(sessionId)
    }

    async applySessionConfig(
        sessionId: string,
        config: {
            permissionMode?: PermissionMode
            model?: string | null
            modelReasoningEffort?: string | null
            effort?: string | null
            collaborationMode?: CodexCollaborationMode
        }
    ): Promise<void> {
        const session = this.sessionCache.getSession(sessionId)
        if (!session?.active) {
            // For inactive sessions, update the in-memory cache directly without
            // an RPC call — the CLI is not running yet. The updated value will be
            // passed to the spawned process when the session is resumed.
            this.sessionCache.applySessionConfig(sessionId, config)
            return
        }

        const result = await this.rpcGateway.requestSessionConfig(sessionId, config)
        if (!result || typeof result !== 'object') {
            throw new Error('Invalid response from session config RPC')
        }
        const obj = result as {
            applied?: {
                permissionMode?: Session['permissionMode']
                model?: Session['model']
                modelReasoningEffort?: Session['modelReasoningEffort']
                effort?: Session['effort']
                collaborationMode?: Session['collaborationMode']
            }
        }
        const applied = obj.applied
        if (!applied || typeof applied !== 'object') {
            throw new Error('Missing applied session config')
        }

        // Legacy CLI returns `modelMode` instead of `model` and strips the [1m]
        // suffix; backfill from the request before the strict key check below.
        if (applied.model === undefined && config.model !== undefined) {
            applied.model = config.model
        }
        const requestedKeys = Object.keys(config) as Array<keyof typeof config>
        for (const key of requestedKeys) {
            if (!(key in applied)) {
                throw new Error(`Session did not apply ${key}`)
            }
        }

        this.sessionCache.applySessionConfig(sessionId, applied)
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent: AgentFlavor = 'claude',
        model?: string,
        modelReasoningEffort?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        resumeSessionId?: string,
        effort?: string,
        sandbox?: boolean,
        continueLatest?: boolean,
        permissionMode?: PermissionMode
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        return await this.rpcGateway.spawnSession(
            machineId,
            directory,
            agent,
            model,
            modelReasoningEffort,
            yolo,
            sessionType,
            worktreeName,
            resumeSessionId,
            effort,
            sandbox,
            continueLatest,
            permissionMode
        )
    }

    private findTargetMachine(onlineMachines: Array<{ id: string; metadata?: { host?: string } | null }>, metadata: { machineId?: string; host?: string }) {
        if (metadata.machineId) {
            const exact = onlineMachines.find((machine) => machine.id === metadata.machineId)
            if (exact) return exact
        }
        if (metadata.host) {
            const hostMatch = onlineMachines.find((machine) => machine.metadata?.host === metadata.host)
            if (hostMatch) return hostMatch
        }
        return null
    }

    private resolveFlavor(session: Session): AgentFlavor {
        const flavor = session.metadata?.flavor
        return isKnownFlavor(flavor) ? flavor : 'claude'
    }

    private resolveAgentResumeId(session: Session, namespace: string): string | null {
        const metadata = session.metadata
        if (!metadata) {
            return null
        }

        const flavor = this.resolveFlavor(session)
        if (flavor === 'codex') return metadata.codexSessionId ?? null
        if (flavor === 'gemini') return metadata.geminiSessionId ?? null
        if (flavor === 'opencode') return metadata.opencodeSessionId ?? null
        if (flavor === 'cursor') return metadata.cursorSessionId ?? null
        if (flavor === 'kimi') return metadata.kimiSessionId ?? null

        return metadata.claudeSessionId ?? this.recoverClaudeSessionIdFromMessages(session.id, namespace)
    }

    resolveLocalResumeTarget(sessionId: string, namespace: string): LocalResumeTargetResult {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        const session = access.session
        const metadata = session.metadata
        if (!metadata || typeof metadata.path !== 'string' || metadata.path.length === 0) {
            return { type: 'error', message: 'Session metadata missing path', code: 'resume_unavailable' }
        }

        const agentSessionId = this.resolveAgentResumeId(session, namespace)
        if (!agentSessionId) {
            return { type: 'error', message: 'Resume session ID unavailable', code: 'resume_unavailable' }
        }

        return {
            type: 'success',
            target: {
                sessionId: access.sessionId,
                flavor: this.resolveFlavor(session),
                directory: metadata.path,
                machineId: metadata.machineId,
                host: metadata.host,
                active: session.active,
                thinking: session.thinking,
                controlledByUser: session.agentState?.controlledByUser === true,
                agentSessionId,
                model: session.model ?? null,
                effort: session.effort ?? null,
                modelReasoningEffort: session.modelReasoningEffort ?? null,
                permissionMode: session.permissionMode,
                collaborationMode: session.collaborationMode
            }
        }
    }

    listLocalResumableSessions(namespace: string, opts?: { machineId?: string }): ResumableSession[] {
        return this.getSessionsByNamespace(namespace)
            .map((session) => this.resolveLocalResumeTarget(session.id, namespace))
            .filter((result): result is { type: 'success'; target: LocalResumeTarget } => result.type === 'success')
            .map(({ target }) => {
                const session = this.getSessionByNamespace(target.sessionId, namespace)
                return {
                    sessionId: target.sessionId,
                    flavor: target.flavor,
                    directory: target.directory,
                    machineId: target.machineId,
                    host: target.host,
                    active: target.active,
                    thinking: target.thinking,
                    controlledByUser: target.controlledByUser,
                    agentSessionId: target.agentSessionId,
                    model: target.model,
                    effort: target.effort,
                    modelReasoningEffort: target.modelReasoningEffort,
                    permissionMode: target.permissionMode,
                    collaborationMode: target.collaborationMode,
                    updatedAt: session?.updatedAt ?? 0,
                    name: session?.metadata?.name,
                    summary: session?.metadata?.summary?.text,
                    firstUserMessage: this.resolveFirstUserMessage(target.sessionId)
                }
            })
            .filter((session) => !opts?.machineId || session.machineId === opts.machineId)
            .sort((a, b) => b.updatedAt - a.updatedAt)
    }

    private resolveFirstUserMessage(sessionId: string): string | undefined {
        for (const message of this.store.messages.getFirstMessages(sessionId, 50)) {
            const roleWrapped = unwrapRoleWrappedRecordEnvelope(message.content)
            const text = roleWrapped?.role === 'user'
                ? extractUserMessageText(roleWrapped.content)
                : roleWrapped?.role === 'agent'
                    ? extractClaudeUserMessageTextFromAgentOutput(roleWrapped.content)
                    : undefined
            if (text) return text
        }

        return undefined
    }

    async resumeSession(sessionId: string, namespace: string, opts?: { permissionMode?: PermissionMode; resumeWithSessionId?: string }): Promise<ResumeSessionResult> {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        const session = access.session
        if (session.active) {
            // Archive the active session first so we can resume with a fresh spawn
            try {
                await this.archiveSession(access.sessionId)
            } catch {
                // Best-effort: if archive fails, continue anyway
            }
        }

        const targetResult = this.resolveLocalResumeTarget(access.sessionId, namespace)
        if (targetResult.type === 'error') {
            return targetResult
        }

        const target = targetResult.target
        const metadata = session.metadata!
        const flavor = target.flavor
        // Fork: allow caller to override the agent-session token (e.g. resume from a
        // specific past session id picked via /resume-options).
        let resumeToken: string | null | undefined = opts?.resumeWithSessionId ?? target.agentSessionId

        const onlineMachines = this.machineCache.getOnlineMachinesByNamespace(namespace)
        if (onlineMachines.length === 0) {
            return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
        }

        const targetMachine = this.findTargetMachine(onlineMachines, metadata)
        if (!targetMachine) {
            return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
        }

        // Fork: for Claude/Cursor/Gemini without explicit resume token, use --continue
        const useContinue = !resumeToken && flavor !== 'codex' && flavor !== 'opencode'

        // Fork: auto-discovery fallback for agents that don't support --continue
        if (!resumeToken && !useContinue) {
            try {
                const scanResult = await this.rpcGateway.listAgentSessions(
                    targetMachine.id,
                    metadata.path,
                    flavor
                )

                if (scanResult.success && scanResult.sessions?.length) {
                    const validSessions = scanResult.sessions.filter(s => s.valid)
                    if (validSessions.length > 0) {
                        resumeToken = validSessions[0].sessionId
                    }
                }
            } catch {
                // Scan failed, continue without resume token
            }
        }

        const preferredPermissionMode = opts?.permissionMode
            ?? session.permissionMode
            ?? session.metadata?.preferredPermissionMode
        let spawnResult = await this.rpcGateway.spawnSession(
            targetMachine.id,
            target.directory,
            flavor,
            session.model ?? undefined,
            session.modelReasoningEffort ?? undefined,
            undefined,
            undefined,
            undefined,
            resumeToken ?? undefined,
            session.effort ?? undefined,
            undefined,
            useContinue || undefined,
            preferredPermissionMode
        )

        // Fallback: if resume spawn fails, retry without resume token (start fresh session)
        if (spawnResult.type !== 'success') {
            spawnResult = await this.rpcGateway.spawnSession(
                targetMachine.id,
                metadata.path,
                flavor
            )
        }

        if (spawnResult.type !== 'success') {
            return { type: 'error', message: spawnResult.message, code: 'resume_failed' }
        }

        const becameActive = await this.waitForSessionActive(spawnResult.sessionId)
        if (!becameActive) {
            return { type: 'error', message: 'Session failed to become active', code: 'resume_failed' }
        }

        if (preferredPermissionMode !== undefined) {
            try {
                await this.applySessionConfig(spawnResult.sessionId, { permissionMode: preferredPermissionMode })
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to restore permission mode'
                return { type: 'error', message, code: 'resume_failed' }
            }
        }

        if (spawnResult.sessionId !== access.sessionId) {
            // The old session may have already been merged by the automatic dedup path
            // (triggered when the spawned CLI sets its agent session ID in metadata).
            // Only attempt the explicit merge if the old session still exists.
            const oldSession = this.sessionCache.getSessionByNamespace(access.sessionId, namespace)
            if (oldSession) {
                try {
                    await this.sessionCache.mergeSessions(access.sessionId, spawnResult.sessionId, namespace)
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Failed to merge resumed session'
                    return { type: 'error', message, code: 'resume_failed' }
                }
            }
        }

        return { type: 'success', sessionId: spawnResult.sessionId }
    }

    async handoffSessionToLocal(sessionId: string, namespace: string): Promise<LocalHandoffResult> {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        if (!access.session.active) {
            return { type: 'success' }
        }

        if (access.session.agentState?.controlledByUser === true) {
            return {
                type: 'error',
                message: 'Session is already controlled by a local terminal',
                code: 'already_local'
            }
        }

        try {
            await this.rpcGateway.handoffSessionToLocal(access.sessionId)
        } catch (error) {
            return {
                type: 'error',
                message: error instanceof Error ? error.message : String(error),
                code: 'handoff_failed'
            }
        }

        const inactive = await this.waitForSessionInactive(access.sessionId)
        if (!inactive) {
            return {
                type: 'error',
                message: 'Timed out waiting for remote session to hand off',
                code: 'handoff_failed'
            }
        }

        return { type: 'success' }
    }

    async listResumeOptions(sessionId: string, namespace: string): Promise<
        | { type: 'success'; sessions: Array<{ sessionId: string; modifiedAt: number; sizeBytes: number; valid: boolean }>; currentSessionId: string | null }
        | { type: 'error'; message: string; code: string }
    > {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        const session = access.session
        const metadata = session.metadata
        if (!metadata || typeof metadata.path !== 'string') {
            return { type: 'error', message: 'Session metadata missing path', code: 'resume_unavailable' }
        }

        const flavor = metadata.flavor === 'codex' || metadata.flavor === 'gemini' || metadata.flavor === 'opencode' || metadata.flavor === 'cursor'
            ? metadata.flavor
            : 'claude'

        const onlineMachines = this.machineCache.getOnlineMachinesByNamespace(namespace)
        if (onlineMachines.length === 0) {
            return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
        }

        const targetMachine = this.findTargetMachine(onlineMachines, metadata)
        if (!targetMachine) {
            return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
        }

        const scanResult = await this.rpcGateway.listAgentSessions(
            targetMachine.id,
            metadata.path,
            flavor
        )

        if (!scanResult.success || !scanResult.sessions) {
            return { type: 'error', message: scanResult.error || 'Failed to scan sessions', code: 'resume_failed' }
        }

        const currentSessionId = flavor === 'codex'
            ? metadata.codexSessionId
            : flavor === 'gemini'
                ? metadata.geminiSessionId
                : flavor === 'opencode'
                    ? metadata.opencodeSessionId
                    : flavor === 'cursor'
                        ? metadata.cursorSessionId
                        : metadata.claudeSessionId

        return {
            type: 'success',
            sessions: scanResult.sessions,
            currentSessionId: currentSessionId || null
        }
    }

    private recoverClaudeSessionIdFromMessages(sessionId: string, namespace: string): string | null {
        const messages = this.messageService.getMessages(sessionId, 200)
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const found = this.extractClaudeSessionId(messages[i].content)
            if (!found) continue

            this.persistRecoveredClaudeSessionId(sessionId, namespace, found)
            return found
        }
        return null
    }

    private extractClaudeSessionId(value: unknown): string | null {
        if (!value || typeof value !== 'object') {
            return null
        }

        const obj = value as Record<string, unknown>
        const direct = this.normalizeClaudeSessionId(obj.session_id) ?? this.normalizeClaudeSessionId(obj.sessionId)
        if (direct) {
            return direct
        }

        const content = obj.content
        if (content && typeof content === 'object') {
            const found = this.extractClaudeSessionId(content)
            if (found) return found
        }

        const data = obj.data
        if (data && typeof data === 'object') {
            const found = this.extractClaudeSessionId(data)
            if (found) return found
        }

        return null
    }

    private normalizeClaudeSessionId(value: unknown): string | null {
        if (typeof value !== 'string') {
            return null
        }
        const trimmed = value.trim()
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
            ? trimmed
            : null
    }

    private persistRecoveredClaudeSessionId(sessionId: string, namespace: string, claudeSessionId: string): void {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const latest = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                ?? this.sessionCache.refreshSession(sessionId)
            if (!latest?.metadata) return
            if (latest.metadata.claudeSessionId === claudeSessionId) return

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                { ...latest.metadata, claudeSessionId },
                latest.metadataVersion,
                namespace,
                { touchUpdatedAt: false }
            )
            if (result.result === 'success') {
                this.sessionCache.refreshSession(sessionId)
                return
            }
            if (result.result !== 'version-mismatch') {
                return
            }
        }
    }

    private hasSameAgentSessionIds(
        prev: Session['metadata'] | null,
        next: NonNullable<Session['metadata']>
    ): boolean {
        return (prev?.codexSessionId ?? null) === (next.codexSessionId ?? null)
            && (prev?.claudeSessionId ?? null) === (next.claudeSessionId ?? null)
            && (prev?.geminiSessionId ?? null) === (next.geminiSessionId ?? null)
            && (prev?.opencodeSessionId ?? null) === (next.opencodeSessionId ?? null)
            && (prev?.cursorSessionId ?? null) === (next.cursorSessionId ?? null)
    }

    private triggerDedupIfNeeded(sessionId: string): void {
        const session = this.sessionCache.getSession(sessionId)
        if (session?.metadata) {
            void this.sessionCache.deduplicateByAgentSessionId(sessionId).catch(() => {
                // best-effort: web-side safety net hides remaining duplicates
            })
        }
    }

    async waitForSessionActive(sessionId: string, timeoutMs: number = 15_000): Promise<boolean> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            const session = this.getSession(sessionId)
            if (session?.active) {
                return true
            }
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return false
    }

    async waitForSessionInactive(sessionId: string, timeoutMs: number = 15_000): Promise<boolean> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            const session = this.getSession(sessionId)
            if (!session?.active) {
                return true
            }
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return false
    }

    async checkPathsExist(machineId: string, paths: string[]): Promise<Record<string, boolean>> {
        return await this.rpcGateway.checkPathsExist(machineId, paths)
    }

    async listMachineDirectory(machineId: string, path: string): Promise<RpcListDirectoryResponse> {
        return await this.rpcGateway.listMachineDirectory(machineId, path)
    }

    async getGitStatus(sessionId: string, cwd?: string): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitStatus(sessionId, cwd)
    }

    async getGitDiffNumstat(sessionId: string, options: { cwd?: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitDiffNumstat(sessionId, options)
    }

    async getGitDiffFile(sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitDiffFile(sessionId, options)
    }

    async readSessionFile(sessionId: string, path: string): Promise<RpcReadFileResponse> {
        return await this.rpcGateway.readSessionFile(sessionId, path)
    }

    async readGeneratedImage(sessionId: string, imageId: string): Promise<RpcGeneratedImageResponse> {
        return await this.rpcGateway.readGeneratedImage(sessionId, imageId)
    }

    async listDirectory(sessionId: string, path: string): Promise<RpcListDirectoryResponse> {
        return await this.rpcGateway.listDirectory(sessionId, path)
    }

    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<RpcUploadFileResponse> {
        return await this.rpcGateway.uploadFile(sessionId, filename, content, mimeType)
    }

    async uploadFileFromHub(sessionId: string, filename: string, downloadUrl: string, mimeType: string): Promise<RpcUploadFileResponse> {
        return await this.rpcGateway.uploadFileFromHub(sessionId, filename, downloadUrl, mimeType)
    }

    hasSessionMethod(sessionId: string, method: string): boolean {
        return this.rpcGateway.hasSessionMethod(sessionId, method)
    }

    async deleteUploadFile(sessionId: string, path: string): Promise<RpcDeleteUploadResponse> {
        return await this.rpcGateway.deleteUploadFile(sessionId, path)
    }

    async runRipgrep(sessionId: string, args: string[], cwd?: string): Promise<RpcCommandResponse> {
        return await this.rpcGateway.runRipgrep(sessionId, args, cwd)
    }

    async listSlashCommands(sessionId: string, agent: string): Promise<SlashCommandsResponse> {
        return await this.rpcGateway.listSlashCommands(sessionId, agent)
    }

    async listSkills(sessionId: string, flavor?: string): Promise<{
        success: boolean
        skills?: Array<{ name: string; description?: string }>
        error?: string
    }> {
        return await this.rpcGateway.listSkills(sessionId, flavor)
    }

    async listCodexModelsForSession(sessionId: string): Promise<RpcListCodexModelsResponse> {
        return await this.rpcGateway.listCodexModelsForSession(sessionId)
    }

    async listCodexModelsForMachine(machineId: string): Promise<RpcListCodexModelsResponse> {
        return await this.rpcGateway.listCodexModelsForMachine(machineId)
    }

    async listCursorModelsForSession(sessionId: string): Promise<RpcListCursorModelsResponse> {
        return await this.rpcGateway.listCursorModelsForSession(sessionId)
    }

    async listCursorModelsForMachine(machineId: string): Promise<RpcListCursorModelsResponse> {
        return await this.rpcGateway.listCursorModelsForMachine(machineId)
    }

    async listOpencodeModelsForSession(sessionId: string): Promise<RpcListOpencodeModelsResponse> {
        return await this.rpcGateway.listOpencodeModelsForSession(sessionId)
    }

    async listOpencodeModelsForCwd(machineId: string, cwd: string): Promise<RpcListOpencodeModelsResponse> {
        return await this.rpcGateway.listOpencodeModelsForCwd(machineId, cwd)
    }
}
