import { AgentStateSchema, MetadataSchema, SessionPatchSchema, TeamStateSchema } from '@hapi/protocol/schemas'
import type { AgentAccountStatus, CodexCollaborationMode, CopilotAgentMode, PermissionMode, Session, SessionPatch } from '@hapi/protocol/types'
import type { Store } from '../store'
import { clampAliveTime } from './aliveTime'
import { EventPublisher } from './eventPublisher'
import { extractTodoWriteTodosFromMessageContent, TodosSchema } from './todos'
import { extractBackgroundTaskDelta } from './backgroundTasks'

const QUEUED_MESSAGE_THINKING_GRACE_MS = 15_000
// Lifecycle timestamps are authored by the CLI's wall clock.  A socket
// handshake supplies the Hub-minus-CLI offset so a small host skew does not
// reject a legitimate replacement runtime.  Keep the correction deliberately
// bounded: clientTime is untrusted input and must never become an arbitrary
// takeover tolerance.
const MAX_RUNTIME_CLOCK_OFFSET_MS = 10_000
// tiann/hapi#919: metadata writers (renameSession, clearSessionArchiveMetadata,
// restoreSessionArchiveMetadata) retry on version-mismatch with a fresh cache
// snapshot. Cap retries so genuine concurrent contention still surfaces to the
// HTTP caller as 409 instead of spinning forever.
const METADATA_RETRY_ATTEMPTS = 5
type RuntimeConfigKey = 'permissionMode' | 'model' | 'modelReasoningEffort' | 'effort' | 'serviceTier' | 'collaborationMode' | 'copilotAgentMode'

export class SessionCache {
    private readonly sessions: Map<string, Session> = new Map()
    private readonly lastBroadcastAtBySessionId: Map<string, number> = new Map()
    private readonly todoBackfillAttemptedSessionIds: Set<string> = new Set()
    private readonly deduplicateInProgress: Set<string> = new Set()
    private readonly deduplicatePending: Set<string> = new Set()
    private readonly pendingThinkingUntilBySessionId: Map<string, number> = new Map()
    private readonly runtimeConfigUpdatedAtBySessionId: Map<string, Partial<Record<RuntimeConfigKey, number>>> = new Map()
    /** Last ordered liveness timestamp (Hub clock for identified runtimes). */
    private readonly lastAlivePayloadTimeBySessionId: Map<string, number> = new Map()
    /** Hub-local owner prevents an older CLI connection from ending a newer run. */
    private readonly runtimeOwnerBySessionId: Map<string, {
        runtimeId: string
        runtimeGeneration: number
        ended: boolean
    }> = new Map()

    constructor(
        private readonly store: Store,
        private readonly publisher: EventPublisher
    ) {
    }

    getSessions(): Session[] {
        return Array.from(this.sessions.values())
    }

    getSessionsByNamespace(namespace: string): Session[] {
        return this.getSessions().filter((session) => session.namespace === namespace)
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId)
    }

    getSessionByNamespace(sessionId: string, namespace: string): Session | undefined {
        const session = this.sessions.get(sessionId)
        if (!session || session.namespace !== namespace) {
            return undefined
        }
        return session
    }

    resolveSessionAccess(
        sessionId: string,
        namespace: string
    ): { ok: true; sessionId: string; session: Session } | { ok: false; reason: 'not-found' | 'access-denied' } {
        const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
        if (session) {
            if (session.namespace !== namespace) {
                return { ok: false, reason: 'access-denied' }
            }
            return { ok: true, sessionId, session }
        }

        return { ok: false, reason: 'not-found' }
    }

    getActiveSessions(): Session[] {
        return this.getSessions().filter((session) => session.active)
    }

    getOrCreateSession(
        tag: string,
        metadata: unknown,
        agentState: unknown,
        namespace: string,
        model?: string,
        effort?: string,
        modelReasoningEffort?: string,
        requestedId?: string
    ): Session {
        const stored = this.store.sessions.getOrCreateSession(
            tag,
            metadata,
            agentState,
            namespace,
            model,
            effort,
            modelReasoningEffort,
            requestedId
        )
        return this.refreshSession(stored.id) ?? (() => { throw new Error('Failed to load session') })()
    }

    /**
     * After fork hydrate / rewind truncate, re-scan the transcript for the
     * latest TodoWrite (or clear todos). Bypasses the one-shot backfill flag
     * and the normal `setSessionTodos` monotonic guard. Watermark still
     * ratchets inside `replaceSessionTodos` — do not pass the remaining
     * message's older `createdAt` as the SSE version.
     */
    rebuildTodosFromTranscript(sessionId: string): void {
        const stored = this.store.sessions.getSession(sessionId)
        if (!stored) return

        this.todoBackfillAttemptedSessionIds.delete(sessionId)
        const messages = this.store.messages.getAllMessages(sessionId)
        let foundTodos: unknown | null = null
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const message = messages[i]
            if (!message) continue
            const todos = extractTodoWriteTodosFromMessageContent(message.content)
            if (todos) {
                foundTodos = todos
                break
            }
        }
        this.store.sessions.replaceSessionTodos(
            sessionId,
            foundTodos,
            stored.namespace
        )
        this.todoBackfillAttemptedSessionIds.add(sessionId)
        this.refreshSession(sessionId)
    }

    refreshSession(sessionId: string): Session | null {
        let stored = this.store.sessions.getSession(sessionId)
        if (!stored) {
            const existed = this.sessions.delete(sessionId)
            this.pendingThinkingUntilBySessionId.delete(sessionId)
            this.runtimeConfigUpdatedAtBySessionId.delete(sessionId)
            this.lastAlivePayloadTimeBySessionId.delete(sessionId)
            this.runtimeOwnerBySessionId.delete(sessionId)
            if (existed) {
                this.publisher.emit({ type: 'session-removed', sessionId })
            }
            return null
        }

        const existing = this.sessions.get(sessionId)

        if (stored.todos === null && !this.todoBackfillAttemptedSessionIds.has(sessionId)) {
            this.todoBackfillAttemptedSessionIds.add(sessionId)
            const messages = this.store.messages.getMessages(sessionId, 200)
            for (let i = messages.length - 1; i >= 0; i -= 1) {
                const message = messages[i]
                const todos = extractTodoWriteTodosFromMessageContent(message.content)
                if (todos) {
                    const updated = this.store.sessions.setSessionTodos(sessionId, todos, message.createdAt, stored.namespace)
                    if (updated) {
                        stored = this.store.sessions.getSession(sessionId) ?? stored
                    }
                    break
                }
            }
        }

        const metadata = (() => {
            const parsed = MetadataSchema.safeParse(stored.metadata)
            return parsed.success ? parsed.data : null
        })()

        const agentState = (() => {
            const parsed = AgentStateSchema.safeParse(stored.agentState)
            return parsed.success ? parsed.data : null
        })()

        const todos = (() => {
            if (stored.todos === null) return undefined
            const parsed = TodosSchema.safeParse(stored.todos)
            return parsed.success ? parsed.data : undefined
        })()

        const teamState = (() => {
            if (stored.teamState === null || stored.teamState === undefined) return undefined
            const parsed = TeamStateSchema.safeParse(stored.teamState)
            return parsed.success ? parsed.data : undefined
        })()

        const session: Session = {
            id: stored.id,
            namespace: stored.namespace,
            seq: stored.seq,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            pinned: stored.pinned,
            globalPinned: stored.globalPinned,
            active: existing?.active ?? stored.active,
            // Legacy / idle rows may still have active_at NULL in SQLite.
            // Public Session.activeAt is always a number for CLI Zod parse.
            activeAt: existing?.activeAt
                ?? stored.activeAt
                ?? stored.updatedAt
                ?? stored.createdAt
                ?? 0,
            metadata,
            metadataVersion: stored.metadataVersion,
            agentState,
            agentStateVersion: stored.agentStateVersion,
            thinking: existing?.thinking ?? false,
            thinkingAt: existing?.thinkingAt ?? 0,
            activeTurnStartedAt: existing?.activeTurnStartedAt ?? null,
            backgroundTaskCount: existing?.backgroundTaskCount ?? 0,
            todos,
            teamState,
            todosUpdatedAt: stored.todosUpdatedAt ?? 0,
            teamStateUpdatedAt: stored.teamStateUpdatedAt ?? 0,
            model: stored.model,
            modelReasoningEffort: stored.modelReasoningEffort,
            effort: stored.effort,
            serviceTier: stored.serviceTier,
            permissionMode: existing?.permissionMode ?? metadata?.preferredPermissionMode,
            collaborationMode: existing?.collaborationMode,
            usage: existing?.usage ?? null,
            accountStatus: existing?.accountStatus ?? null,
            copilotAgentMode: existing?.copilotAgentMode ?? metadata?.preferredCopilotAgentMode
        }

        this.sessions.set(sessionId, session)
        this.publisher.emit({ type: existing ? 'session-updated' : 'session-added', sessionId, data: session })
        return session
    }

    reloadAll(): void {
        const sessions = this.store.sessions.getSessions()
        for (const session of sessions) {
            this.refreshSession(session.id)
        }
    }

    setSessionPinned(sessionId: string, pinned: boolean): void {
        this.setSessionPinMode(sessionId, pinned ? 'project' : 'none')
    }

    setSessionPinMode(sessionId: string, mode: 'none' | 'project' | 'global'): void {
        const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
        if (!session) throw new Error('Session not found')
        this.store.sessions.setSessionPinMode(sessionId, mode, session.namespace)
        this.refreshSession(sessionId)
    }

    markSessionActive(sessionId: string, time: number = Date.now()): void {
        const t = clampAliveTime(time) ?? Date.now()
        const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
        if (!session) return

        const wasActive = session.active
        session.active = true
        session.activeAt = Math.max(session.activeAt, t)

        this.lastBroadcastAtBySessionId.set(session.id, Date.now())
        this.publisher.emit({
            type: 'session-updated',
            sessionId: session.id,
            namespace: session.namespace,
            data: {
                active: true,
                activeAt: session.activeAt,
                thinking: session.thinking
            } satisfies SessionPatch
        })

        if (!wasActive) {
            this.refreshSession(sessionId)
        }
    }

    /**
     * Persist the authoritative CLI process id without touching the session's
     * user-visible activity timestamp. This is intentionally version-retried:
     * metadata writes (title/model/native thread id) can race the first alive
     * packet, but a claim is not safe across Hub restart until it is durable.
     */
    private persistRuntimeOwnerId(sessionId: string, runtimeId: string): Session | null {
        for (let attempt = 0; attempt < METADATA_RETRY_ATTEMPTS; attempt += 1) {
            const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
            if (!session?.metadata) {
                return null
            }
            if (session.metadata.runtimeId === runtimeId) {
                return session
            }

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                { ...session.metadata, runtimeId },
                session.metadataVersion,
                session.namespace,
                { touchUpdatedAt: false }
            )
            if (result.result === 'error') {
                return null
            }
            if (result.result === 'success') {
                return this.refreshSession(sessionId)
            }
            this.refreshSession(sessionId)
        }
        return null
    }

    /**
     * Apply a structured patch to the cached Session in place.
     *
     * Returns `true` if the patch parsed, carried at least one field, and a
     * Session was present to update. Returns `false` when:
     *   - the patch data fails SessionPatchSchema (caller falls back to
     *     refreshSession),
     *   - the patch is the empty object `{}` — the web client's
     *     `getSessionPatch` rejects empty payloads and would fall through to
     *     REST invalidation, so we route empty events through the legacy
     *     refresh path instead (caller falls back to refreshSession),
     *   - the session is not in the cache (caller falls back to refreshSession
     *     so the DB read can hydrate it),
     *   - the patch's namespace hint disagrees with the cached session
     *     namespace (cross-namespace event, caller skips).
     *
     * Companion to syncEngine.handleRealtimeEvent. Closes the second half of
     * #884 by giving the four no-data emit-sites in cli/sessionHandlers.ts a
     * way to propagate their delta straight through to SSE without a DB
     * re-read or full-Session broadcast.
     */
    applySessionPatch(sessionId: string, data: unknown, namespace?: string): boolean {
        const parsed = SessionPatchSchema.safeParse(data)
        if (!parsed.success) {
            return false
        }

        // Empty patch ({}): forward would hit the web-side fallback that
        // triggers a REST refetch. Let the caller fall back to refreshSession
        // so the existing full-Session broadcast path keeps the cache
        // coherent.
        if (Object.keys(parsed.data).length === 0) {
            return false
        }

        const session = this.sessions.get(sessionId)
        if (!session) {
            return false
        }

        if (namespace && session.namespace !== namespace) {
            return false
        }

        const patch = parsed.data

        if (patch.active !== undefined) session.active = patch.active
        if (patch.thinking !== undefined) session.thinking = patch.thinking
        if (patch.activeTurnStartedAt !== undefined) session.activeTurnStartedAt = patch.activeTurnStartedAt
        if (patch.activeAt !== undefined) session.activeAt = patch.activeAt
        if (patch.updatedAt !== undefined) session.updatedAt = Math.max(session.updatedAt, patch.updatedAt)
        if (patch.model !== undefined) session.model = patch.model
        if (patch.modelReasoningEffort !== undefined) session.modelReasoningEffort = patch.modelReasoningEffort
        if (patch.effort !== undefined) session.effort = patch.effort
        if (Object.prototype.hasOwnProperty.call(patch, 'serviceTier')) {
            session.serviceTier = patch.serviceTier ?? null
        }
        if (patch.permissionMode !== undefined) session.permissionMode = patch.permissionMode
        if (patch.collaborationMode !== undefined) session.collaborationMode = patch.collaborationMode
        if (patch.copilotAgentMode !== undefined) session.copilotAgentMode = patch.copilotAgentMode
        if (patch.backgroundTaskCount !== undefined) session.backgroundTaskCount = patch.backgroundTaskCount
        if (patch.todos !== undefined) {
            session.todos = patch.todos.value
            session.todosUpdatedAt = patch.todos.version
        }
        // Versioned teamState: key present + value null = TeamDelete clear.
        if (patch.teamState !== undefined) {
            session.teamState = patch.teamState.value ?? undefined
            session.teamStateUpdatedAt = patch.teamState.version
        }
        if (patch.metadata !== undefined) {
            session.metadata = patch.metadata.value
            session.metadataVersion = patch.metadata.version
        }
        if (patch.agentState !== undefined) {
            session.agentState = patch.agentState.value
            session.agentStateVersion = patch.agentState.version
        }

        return true
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
        serviceTier?: string | null
        collaborationMode?: CodexCollaborationMode
        copilotAgentMode?: CopilotAgentMode
        runtimeId?: string
        runtimeGeneration?: number
    }): boolean {
        const hasRuntimeSource = typeof payload.runtimeId === 'string'
            && Number.isSafeInteger(payload.runtimeGeneration)
        // Runtime identity establishes ordering across runners; use Hub receive
        // time for liveness/config comparisons so host clock skew cannot make a
        // valid owner look ten minutes stale.
        const t = hasRuntimeSource ? Date.now() : clampAliveTime(payload.time)
        if (!t) return false

        let session = this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid)
        if (!session) return false

        // An explicit end persists lifecycleState=archived before (new CLIs) or
        // during (Hub fallback) teardown. A delayed heartbeat must never turn
        // that durable terminal state back into active=true. A genuinely new
        // runtime first writes lifecycleState=running through the ownership-
        // gated metadata path, then its alive event can activate the row.
        if (session.metadata?.lifecycleState === 'archived') {
            return false
        }

        // Once a modern runtime has durably claimed the row, legacy packets
        // without a complete runtime identity are no longer authoritative.
        // Otherwise an orphaned older CLI can keep overwriting the current
        // owner's active/thinking state indefinitely.
        if (!hasRuntimeSource && session.metadata?.runtimeId) {
            return false
        }

        if (hasRuntimeSource) {
            const runtimeGeneration = payload.runtimeGeneration as number
            const owner = this.runtimeOwnerBySessionId.get(session.id)
            const durableRuntimeId = session.metadata?.runtimeId
            if (durableRuntimeId && durableRuntimeId !== payload.runtimeId) {
                // A different process must first persist a newer `running`
                // transition through the metadata ownership gate. Requiring
                // that transition closes both cold-start ambiguity and the
                // warm-cache case where a stale, later-first-seen runtime sends
                // alive after the current owner's heartbeat expires.
                return false
            }
            if (owner) {
                const sameRuntime = payload.runtimeId === owner.runtimeId
                if (sameRuntime) {
                    if (owner.ended || runtimeGeneration !== owner.runtimeGeneration) {
                        return false
                    }
                } else {
                    // Within one Hub lifetime, generation is the first-seen
                    // ordering authority. Once a newer runtime has owned this
                    // session, an older runtime must not reclaim it merely
                    // because the newer owner ended or its heartbeat expired.
                    if (runtimeGeneration <= owner.runtimeGeneration) {
                        return false
                    }
                    if (session.active && !owner.ended) {
                        // A later first-seen runtime still cannot steal a live
                        // owner: an older runner may have been offline when the
                        // current runner connected, then reconnect with a higher
                        // Hub-local generation.
                        return false
                    }
                }
            }
            if (!owner || payload.runtimeId !== owner.runtimeId) {
                this.lastAlivePayloadTimeBySessionId.delete(session.id)
            }
            this.runtimeOwnerBySessionId.set(session.id, {
                runtimeId: payload.runtimeId as string,
                runtimeGeneration,
                ended: false
            })
            const persistedSession = this.persistRuntimeOwnerId(session.id, payload.runtimeId as string)
            if (!persistedSession) {
                // Keep the in-memory owner as a retry watermark, but do not
                // advertise the row active until the claim is durable.
                return false
            }
            session = persistedSession
        }

        const wasActive = session.active
        const wasThinking = session.thinking
        const previousActiveTurnStartedAt = session.activeTurnStartedAt
        const previousPermissionMode = session.permissionMode
        const previousModel = session.model
        const previousModelReasoningEffort = session.modelReasoningEffort
        const previousEffort = session.effort
        const previousServiceTier = session.serviceTier
        const previousCollaborationMode = session.collaborationMode
        const previousCopilotAgentMode = session.copilotAgentMode
        const pendingThinkingUntil = this.pendingThinkingUntilBySessionId.get(session.id) ?? 0
        const requestedThinking = Boolean(payload.thinking)
        const hubNow = Date.now()
        const preserveQueuedThinking = !requestedThinking && pendingThinkingUntil > hubNow
        const hasUnconsumedPrompt = preserveQueuedThinking
            && this.store.messages.getImmediateQueuedLocalMessages(session.id).length > 0
        // Codex update_plan is scoped to one turn and is not guaranteed to
        // receive a final all-completed update. A quiet heartbeat is the safe
        // lifecycle boundary: unlike the volatile false -> true heartbeat it
        // cannot race a reliable update_plan from the newly-started turn.
        const hasPendingRequest = Object.keys(session.agentState?.requests ?? {}).length > 0
        const hasBackgroundWork = (session.backgroundTaskCount ?? 0) > 0
        const clearedTodos = !requestedThinking
            && !preserveQueuedThinking
            && !hasPendingRequest
            && !hasBackgroundWork
            ? this.clearCodexTurnTodos(session)
            : null

        session.active = true
        session.activeAt = Math.max(session.activeAt, t)
        this.lastAlivePayloadTimeBySessionId.set(
            session.id,
            Math.max(this.lastAlivePayloadTimeBySessionId.get(session.id) ?? Number.NEGATIVE_INFINITY, t)
        )
        session.thinking = requestedThinking || preserveQueuedThinking
        session.thinkingAt = t
        if (!requestedThinking && preserveQueuedThinking && hasUnconsumedPrompt) {
            session.activeTurnStartedAt = hubNow
        } else if (wasThinking && !session.thinking) {
            session.activeTurnStartedAt = null
        }
        if (requestedThinking || pendingThinkingUntil <= hubNow) {
            this.pendingThinkingUntilBySessionId.delete(session.id)
        }
        if (payload.permissionMode !== undefined && !this.isStaleRuntimeKeepAlive(session.id, 'permissionMode', t)) {
            session.permissionMode = payload.permissionMode
            this.persistPreferredPermissionMode(session, payload.permissionMode)
        }
        if (payload.model !== undefined && !this.isStaleRuntimeKeepAlive(session.id, 'model', t)) {
            if (payload.model !== session.model) {
                this.store.sessions.setSessionModel(payload.sid, payload.model, session.namespace, {
                    touchUpdatedAt: false
                })
            }
            session.model = payload.model
        }
        if (payload.modelReasoningEffort !== undefined && !this.isStaleRuntimeKeepAlive(session.id, 'modelReasoningEffort', t)) {
            if (payload.modelReasoningEffort !== session.modelReasoningEffort) {
                this.store.sessions.setSessionModelReasoningEffort(payload.sid, payload.modelReasoningEffort, session.namespace, {
                    touchUpdatedAt: false
                })
            }
            session.modelReasoningEffort = payload.modelReasoningEffort
        }
        if (payload.effort !== undefined && !this.isStaleRuntimeKeepAlive(session.id, 'effort', t)) {
            if (payload.effort !== session.effort) {
                this.store.sessions.setSessionEffort(payload.sid, payload.effort, session.namespace, {
                    touchUpdatedAt: false
                })
            }
            session.effort = payload.effort
        }
        if (payload.serviceTier !== undefined && !this.isStaleRuntimeKeepAlive(session.id, 'serviceTier', t)) {
            if (payload.serviceTier !== session.serviceTier) {
                this.store.sessions.setSessionServiceTier(payload.sid, payload.serviceTier, session.namespace, {
                    touchUpdatedAt: false
                })
            }
            session.serviceTier = payload.serviceTier
        }
        if (payload.collaborationMode !== undefined && !this.isStaleRuntimeKeepAlive(session.id, 'collaborationMode', t)) {
            session.collaborationMode = payload.collaborationMode
        }
        if (payload.copilotAgentMode !== undefined && !this.isStaleRuntimeKeepAlive(session.id, 'copilotAgentMode', t)) {
            session.copilotAgentMode = payload.copilotAgentMode
            this.persistPreferredCopilotAgentMode(session, payload.copilotAgentMode)
        }

        const now = Date.now()
        const lastBroadcastAt = this.lastBroadcastAtBySessionId.get(session.id) ?? 0
        const modeChanged = previousPermissionMode !== session.permissionMode
            || previousModel !== session.model
            || previousModelReasoningEffort !== session.modelReasoningEffort
            || previousEffort !== session.effort
            || previousServiceTier !== session.serviceTier
            || previousCollaborationMode !== session.collaborationMode
            || previousCopilotAgentMode !== session.copilotAgentMode
        const turnBoundaryChanged = previousActiveTurnStartedAt !== session.activeTurnStartedAt
        const shouldBroadcast = (!wasActive && session.active)
            || (wasThinking !== session.thinking)
            || turnBoundaryChanged
            || modeChanged
            || clearedTodos !== null
            || (now - lastBroadcastAt > 10_000)

        if (shouldBroadcast) {
            this.lastBroadcastAtBySessionId.set(session.id, now)
            this.publisher.emit({
                type: 'session-updated',
                sessionId: session.id,
                data: {
                    active: true,
                    activeAt: session.activeAt,
                    thinking: session.thinking,
                    activeTurnStartedAt: session.activeTurnStartedAt,
                    permissionMode: session.permissionMode,
                    model: session.model,
                    modelReasoningEffort: session.modelReasoningEffort,
                    effort: session.effort,
                    serviceTier: session.serviceTier,
                    collaborationMode: session.collaborationMode,
                    copilotAgentMode: session.copilotAgentMode,
                    ...(clearedTodos ? {
                        todos: clearedTodos,
                        updatedAt: session.updatedAt
                    } : {})
                } satisfies SessionPatch
            })
        }
        return true
    }

    /**
     * Drop the queued-message thinking grace timer for a session.
     *
     * `markMessageQueued` sets a 15s grace during which we keep `thinking=true`
     * even if the CLI sends `keepAlive(thinking=false)` — that grace exists to
     * cover the gap between the user POSTing a prompt and the CLI starting to
     * stream. Sessions that handle the message synchronously (e.g. slash
     * commands intercepted in `onUserMessage`) never call onThinkingChange and
     * would otherwise leave the spinner stuck for the full grace window. The
     * messages-consumed socket event signals the CLI has finished its
     * synchronous handling, so it's safe to drop the grace.
     */
    clearQueuedThinkingGrace(sessionId: string): void {
        this.pendingThinkingUntilBySessionId.delete(sessionId)
    }

    /** Clear a completed/idle Codex turn's plan without outranking future
     * client timestamps. The one-step ratchet preserves stale-write rejection
     * while avoiding a Hub Date.now watermark from a different clock. */
    private clearCodexTurnTodos(session: Session): { version: number; value: [] } | null {
        if (session.metadata?.flavor !== 'codex' || !session.todos?.length) {
            return null
        }

        const version = (session.todosUpdatedAt ?? 0) + 1
        const updated = this.store.sessions.setSessionTodos(
            session.id,
            [],
            version,
            session.namespace
        )
        if (!updated) {
            return null
        }

        session.todos = []
        session.todosUpdatedAt = version
        session.updatedAt = Math.max(session.updatedAt, version)
        return { version, value: [] }
    }

    markMessageQueued(
        sessionId: string,
        time: number = Date.now(),
        activeTurnStartedAt: number = time
    ): void {
        const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
        if (!session) return
        if (!session.active) return

        const nextTime = clampAliveTime(time) ?? Date.now()
        const wasThinking = session.thinking
        const previousUpdatedAt = session.updatedAt
        const clearedTodos = !wasThinking
            ? this.clearCodexTurnTodos(session)
            : null

        session.thinking = true
        session.thinkingAt = nextTime
        if (!wasThinking) session.activeTurnStartedAt = activeTurnStartedAt
        session.updatedAt = Math.max(session.updatedAt, nextTime)
        this.pendingThinkingUntilBySessionId.set(session.id, nextTime + QUEUED_MESSAGE_THINKING_GRACE_MS)

        if (!wasThinking || session.updatedAt !== previousUpdatedAt) {
            this.lastBroadcastAtBySessionId.set(session.id, Date.now())
            this.publisher.emit({
                type: 'session-updated',
                sessionId: session.id,
                data: {
                    thinking: true,
                    activeTurnStartedAt: session.activeTurnStartedAt,
                    updatedAt: session.updatedAt,
                    ...(clearedTodos ? { todos: clearedTodos } : {})
                } satisfies SessionPatch
            })
        }
    }

    applyBackgroundTaskDelta(sessionId: string, delta: { started: number; completed: number }): void {
        const session = this.sessions.get(sessionId)
        if (!session) return

        const prev = session.backgroundTaskCount ?? 0
        const next = Math.max(0, prev + delta.started - delta.completed)
        if (next === prev) return

        session.backgroundTaskCount = next
        this.publisher.emit({
            type: 'session-updated',
            sessionId,
            data: { backgroundTaskCount: next } satisfies SessionPatch
        })
    }

    recordSessionActivity(sessionId: string, updatedAt: number): void {
        if (!Number.isFinite(updatedAt)) {
            return
        }

        const stored = this.store.sessions.getSession(sessionId)
        if (!stored) {
            return
        }

        const nextUpdatedAt = Math.max(stored.updatedAt, updatedAt)
        const touched = this.store.sessions.touchSessionUpdatedAt(sessionId, nextUpdatedAt, stored.namespace)
        const session = this.sessions.get(sessionId)

        if (!session) {
            if (touched) {
                this.refreshSession(sessionId)
            }
            return
        }

        if (nextUpdatedAt <= session.updatedAt && !touched) {
            return
        }

        session.updatedAt = Math.max(session.updatedAt, nextUpdatedAt)
        this.publisher.emit({
            type: 'session-updated',
            sessionId,
            namespace: session.namespace,
            data: { updatedAt: session.updatedAt } satisfies SessionPatch
        })
    }

    /**
     * tiann/hapi#893 (scratchlist v2): emit a `session-updated` SSE patch
     * carrying `scratchlistUpdatedAt` so other clients viewing the same
     * session refetch the entries query. Called by `SyncEngine` after
     * any successful scratchlist mutation. The timestamp is the trigger,
     * not the payload - clients use it as a change-detection token and
     * pull entries via the dedicated REST query.
     *
     * Per operator decision (see brief): piggyback on `session-updated`
     * rather than introduce a new event type, because scratchlist
     * mutations are exceedingly rare relative to keep-alive patches.
     *
     * Resolves the namespace from the in-memory session map (or the DB
     * row as a fallback) so the SSE manager can scope the broadcast
     * correctly even if the cache is cold.
     */
    emitScratchlistChanged(sessionId: string, updatedAt: number = Date.now()): void {
        const cached = this.sessions.get(sessionId)
        const namespace = cached?.namespace
            ?? this.store.sessions.getSession(sessionId)?.namespace
        if (!namespace) return
        this.publisher.emit({
            type: 'session-updated',
            sessionId,
            namespace,
            data: { scratchlistUpdatedAt: updatedAt } satisfies SessionPatch
        })
    }

    handleSessionEnd(payload: {
        sid: string
        time: number
        runtimeId?: string
        runtimeGeneration?: number
    }): number | null {
        return this.handleSessionEndInternal(payload, false)
    }

    /** Explicit Hub archive/kill is an authority boundary of its own. */
    handleHubSessionEnd(payload: { sid: string; time: number }): number | null {
        return this.handleSessionEndInternal(payload, true)
    }

    private handleSessionEndInternal(payload: {
        sid: string
        time: number
        runtimeId?: string
        runtimeGeneration?: number
    }, hubAuthoritative: boolean): number | null {
        if (!Number.isFinite(payload.time)) {
            return null
        }
        // Preserve old timestamps for generation ordering. clampAliveTime()
        // returns null for values older than ten minutes, and substituting now
        // here would let a replayed old session-end kill a newly reopened run.
        const legacyEventTime = Math.min(payload.time, Date.now())

        let session = this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid)
        if (!session) return null

        if (
            session.metadata?.lifecycleState === 'archived'
            && !session.active
            && !session.thinking
            && (session.backgroundTaskCount ?? 0) === 0
            && session.metadata.piResumeAttempt === undefined
            && session.metadata.ptyResumeAttempt === undefined
        ) {
            // Durable terminal state already reconciled. Treat a cold/replayed
            // duplicate as rejected so handlers do not emit another ended
            // event or sweep immediate messages queued after the original end.
            return null
        }

        const hasRuntimeSource = typeof payload.runtimeId === 'string'
            && Number.isSafeInteger(payload.runtimeGeneration)
        // Mirror the alive fence: an unsourced legacy end must not stop (and
        // subsequently archive) a session already owned by a modern runtime.
        if (!hubAuthoritative && !hasRuntimeSource && session.metadata?.runtimeId) {
            return null
        }
        if (hasRuntimeSource) {
            const owner = this.runtimeOwnerBySessionId.get(session.id)
            const durableRuntimeId = session.metadata?.runtimeId
            if (durableRuntimeId && durableRuntimeId !== payload.runtimeId) {
                return null
            }
            if (owner) {
                if (
                    owner.ended
                    || payload.runtimeGeneration !== owner.runtimeGeneration
                    || payload.runtimeId !== owner.runtimeId
                ) {
                    return null
                }
            } else {
                // A reconnect can flush buffered events before the client's
                // connect handler sends its first keepalive. Claim the cold
                // cache now so the following same-runtime alive cannot revive
                // a runner that already ended.
                this.runtimeOwnerBySessionId.set(session.id, {
                    runtimeId: payload.runtimeId as string,
                    runtimeGeneration: payload.runtimeGeneration as number,
                    ended: false
                })
            }
            const persistedSession = this.persistRuntimeOwnerId(session.id, payload.runtimeId as string)
            if (!persistedSession) {
                return null
            }
            session = persistedSession
        }
        const t = (hasRuntimeSource || hubAuthoritative) ? Date.now() : legacyEventTime

        // Timestamp ordering is only meaningful inside one runtime. New clients
        // additionally carry a Hub-owned runtime generation, which is the
        // cross-run authority and is checked above.
        const lastAlivePayloadTime = this.lastAlivePayloadTimeBySessionId.get(session.id)
        if (!hubAuthoritative && !hasRuntimeSource && lastAlivePayloadTime !== undefined && t < lastAlivePayloadTime) {
            return null
        }
        const lifecycleStateSince = typeof session.metadata?.lifecycleStateSince === 'number'
            ? session.metadata.lifecycleStateSince
            : 0
        if (
            !hubAuthoritative
            && !hasRuntimeSource
            &&
            session.metadata?.lifecycleState === 'running'
            && lifecycleStateSince > t
        ) {
            return null
        }

        if (hasRuntimeSource || hubAuthoritative) {
            const owner = this.runtimeOwnerBySessionId.get(session.id)
            if (owner) {
                owner.ended = true
            }
        }

        if (
            !session.active
            && !session.thinking
            && (session.backgroundTaskCount ?? 0) === 0
        ) {
            // A valid explicit end can arrive after the 30s liveness expiry.
            // Report it as accepted so SyncEngine can still reconcile stale
            // lifecycleState=running metadata without changing live state.
            return t
        }

        session.active = false
        this.store.sessions.setSessionActive(session.id, false, t, session.namespace)
        session.thinking = false
        session.thinkingAt = t
        session.activeTurnStartedAt = null
        session.backgroundTaskCount = 0
        const clearedTodos = this.clearCodexTurnTodos(session)
        this.pendingThinkingUntilBySessionId.delete(session.id)
        this.lastAlivePayloadTimeBySessionId.delete(session.id)

        this.publisher.emit({
            type: 'session-updated',
            sessionId: session.id,
            data: {
                active: false,
                thinking: false,
                activeTurnStartedAt: null,
                backgroundTaskCount: 0,
                ...(clearedTodos ? { todos: clearedTodos, updatedAt: session.updatedAt } : {})
            } satisfies SessionPatch
        })
        return t
    }

    isRuntimeMetadataUpdateAllowed(payload: {
        sid: string
        metadata: unknown
        runtimeId: string
        runtimeGeneration: number
        clockOffset?: number
    }): boolean {
        const owner = this.runtimeOwnerBySessionId.get(payload.sid)
        if (!payload.metadata || typeof payload.metadata !== 'object' || Array.isArray(payload.metadata)) {
            return false
        }
        const lifecycleState = (payload.metadata as Record<string, unknown>).lifecycleState
        if (!owner) {
            const session = this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid)
            const durableRuntimeId = session?.metadata?.runtimeId
            if (
                durableRuntimeId === payload.runtimeId
                && session?.metadata?.lifecycleState === 'archived'
                && lifecycleState === 'running'
            ) {
                // runtimeId survives transport reconnects, not process restarts.
                // Once that runtime archived, it cannot reopen itself after a
                // Hub restart; a legitimate new run has a new runtimeId.
                return false
            }
            if (durableRuntimeId && durableRuntimeId !== payload.runtimeId) {
                if (lifecycleState !== 'running') {
                    return false
                }
                // Cold Hub cache cannot order random runtime ids. Accept a
                // replacement only when its process-start lifecycle timestamp
                // is strictly newer than the durable owner's last running OR
                // archived transition. This also prevents an old buffered
                // `running` write from reviving an explicitly archived row.
                // Both values are authored by CLI lifecycle code; comparison
                // is limited to different-runtime takeover. Same-runtime
                // liveness/config ordering remains entirely in Hub time.
                if (!session || !this.isStrictlyNewerRuntimeLifecycle(session, payload.metadata, payload.clockOffset)) {
                    return false
                }
            }
            return true
        }

        const sameRuntime = payload.runtimeId === owner.runtimeId
            && payload.runtimeGeneration === owner.runtimeGeneration
        if (sameRuntime) {
            return owner.ended ? lifecycleState === 'archived' : true
        }

        // An ended or expired newer owner remains the ordering watermark for
        // this Hub lifetime. Without this check, a delayed `running` write from
        // an older runtime can reclaim the session after B(gen=2) ended merely
        // because the row is now inactive.
        if (payload.runtimeGeneration <= owner.runtimeGeneration) {
            return false
        }

        const session = this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid)
        if (lifecycleState === 'running' && (!session?.active || owner.ended)) {
            const durableRuntimeId = session?.metadata?.runtimeId
            if (
                durableRuntimeId
                && durableRuntimeId !== payload.runtimeId
                && !this.isStrictlyNewerRuntimeLifecycle(session, payload.metadata, payload.clockOffset)
            ) {
                return false
            }
            // bootstrapExistingSession queues running metadata before Socket.IO
            // invokes the client's connect handler/keepalive. The successful
            // write callback (recordRuntimeMetadataUpdate) establishes owner;
            // a version-mismatch must not let a stale writer steal it.
            return true
        }
        return false
    }

    private isStrictlyNewerRuntimeLifecycle(
        session: Session,
        metadata: unknown,
        clockOffset?: number
    ): boolean {
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
            return false
        }
        const incomingSince = (metadata as Record<string, unknown>).lifecycleStateSince
        const durableSince = session.metadata?.lifecycleStateSince
        const boundedClockOffset = typeof clockOffset === 'number'
            && Number.isFinite(clockOffset)
            && Math.abs(clockOffset) <= MAX_RUNTIME_CLOCK_OFFSET_MS
            ? clockOffset
            : 0
        return typeof incomingSince === 'number'
            && Number.isFinite(incomingSince)
            && typeof durableSince === 'number'
            && Number.isFinite(durableSince)
            && incomingSince + boundedClockOffset > durableSince
    }

    /** Commit ownership only after update-metadata actually persisted. */
    recordRuntimeMetadataUpdate(payload: {
        sid: string
        metadata: unknown
        runtimeId: string
        runtimeGeneration: number
    }): void {
        if (!payload.metadata || typeof payload.metadata !== 'object' || Array.isArray(payload.metadata)) {
            return
        }
        const metadataRecord = payload.metadata as Record<string, unknown>
        const lifecycleState = metadataRecord.lifecycleState
        if (lifecycleState !== 'running' || metadataRecord.runtimeId !== payload.runtimeId) {
            return
        }

        const owner = this.runtimeOwnerBySessionId.get(payload.sid)
        const sameRuntime = owner
            && owner.runtimeId === payload.runtimeId
            && owner.runtimeGeneration === payload.runtimeGeneration
        if (sameRuntime && !owner.ended) {
            return
        }
        if (owner && payload.runtimeGeneration <= owner.runtimeGeneration) {
            return
        }

        this.lastAlivePayloadTimeBySessionId.delete(payload.sid)
        this.runtimeOwnerBySessionId.set(payload.sid, {
            runtimeId: payload.runtimeId,
            runtimeGeneration: payload.runtimeGeneration,
            ended: false
        })
    }

    handleSessionUsage(payload: {
        sid: string
        totalCostUsd: number
        totalInputTokens: number
        totalOutputTokens: number
    }): void {
        const session = this.sessions.get(payload.sid)
        if (!session) return

        session.usage = {
            totalCostUsd: payload.totalCostUsd,
            totalInputTokens: payload.totalInputTokens,
            totalOutputTokens: payload.totalOutputTokens
        }

        // Upstream's SessionPatchSchema is strict and excludes usage/accountStatus,
        // so emit the full Session (also a valid SessionUpdatedData variant).
        this.publisher.emit({
            type: 'session-updated',
            sessionId: session.id,
            data: session
        })
    }

    handleSessionAccountStatus(payload: { sid: string; accountStatus: AgentAccountStatus }): void {
        const session = this.sessions.get(payload.sid)
        if (!session) return

        session.accountStatus = payload.accountStatus

        // See handleSessionUsage — emit full Session rather than a strict SessionPatch.
        this.publisher.emit({
            type: 'session-updated',
            sessionId: session.id,
            data: session
        })
    }

    expireInactive(now: number = Date.now()): string[] {
        const sessionTimeoutMs = 30_000
        const expired: string[] = []

        for (const session of this.sessions.values()) {
            if (!session.active) continue
            if (now - session.activeAt <= sessionTimeoutMs) continue
            session.active = false
            this.store.sessions.setSessionActive(session.id, false, now, session.namespace)
            session.thinking = false
            session.thinkingAt = now
            session.activeTurnStartedAt = null
            session.backgroundTaskCount = 0
            const clearedTodos = this.clearCodexTurnTodos(session)
            this.pendingThinkingUntilBySessionId.delete(session.id)
            this.lastAlivePayloadTimeBySessionId.delete(session.id)
            expired.push(session.id)
            this.publisher.emit({
                type: 'session-updated',
                sessionId: session.id,
                data: {
                    active: false,
                    thinking: false,
                    activeTurnStartedAt: null,
                    backgroundTaskCount: 0,
                    ...(clearedTodos ? { todos: clearedTodos, updatedAt: session.updatedAt } : {})
                } satisfies SessionPatch
            })
        }

        return expired
    }

    applySessionConfig(
        sessionId: string,
        config: {
            permissionMode?: PermissionMode
            model?: { provider: string; modelId: string } | string | null
            modelReasoningEffort?: string | null
            effort?: string | null
            serviceTier?: string | null
            collaborationMode?: CodexCollaborationMode
            copilotAgentMode?: CopilotAgentMode
        }
    ): void {
        const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
        if (!session) {
            return
        }

        const appliedAt = Date.now()
        if (config.permissionMode !== undefined) {
            session.permissionMode = config.permissionMode
            this.persistPreferredPermissionMode(session, config.permissionMode)
            this.markRuntimeConfigUpdated(sessionId, 'permissionMode', appliedAt)
        }
        if (config.model !== undefined) {
            const modelValue = config.model
            // Normalize object form { provider, modelId } to plain string for DB storage
            const piModelObject = modelValue !== null && typeof modelValue === 'object'
                ? modelValue
                : null
            const normalizedModel: string | null = piModelObject ? piModelObject.modelId : modelValue as string | null
            if (normalizedModel !== session.model) {
                const updated = this.store.sessions.setSessionModel(sessionId, normalizedModel, session.namespace, {
                    touchUpdatedAt: false
                })
                if (!updated) {
                    throw new Error('Failed to update session model')
                }
            }
            session.model = normalizedModel
            // Pi requires provider + modelId to uniquely identify a model.
            // Persist the provider-qualified form in metadata so web can
            // resolve the exact model even when two providers share a modelId.
            if (session.metadata?.flavor === 'pi') {
                this.persistPiSelectedModel(session, piModelObject)
            }
            this.markRuntimeConfigUpdated(sessionId, 'model', appliedAt)
        }
        if (config.modelReasoningEffort !== undefined) {
            if (config.modelReasoningEffort !== session.modelReasoningEffort) {
                const updated = this.store.sessions.setSessionModelReasoningEffort(sessionId, config.modelReasoningEffort, session.namespace, {
                    touchUpdatedAt: false
                })
                if (!updated) {
                    throw new Error('Failed to update session model reasoning effort')
                }
            }
            session.modelReasoningEffort = config.modelReasoningEffort
            this.markRuntimeConfigUpdated(sessionId, 'modelReasoningEffort', appliedAt)
        }
        if (config.effort !== undefined) {
            if (config.effort !== session.effort) {
                const updated = this.store.sessions.setSessionEffort(sessionId, config.effort, session.namespace, {
                    touchUpdatedAt: false
                })
                if (!updated) {
                    throw new Error('Failed to update session effort')
                }
            }
            session.effort = config.effort
            this.markRuntimeConfigUpdated(sessionId, 'effort', appliedAt)
        }
        if (config.serviceTier !== undefined) {
            if (config.serviceTier !== session.serviceTier) {
                const updated = this.store.sessions.setSessionServiceTier(sessionId, config.serviceTier, session.namespace, {
                    touchUpdatedAt: false
                })
                if (!updated) {
                    throw new Error('Failed to update session service tier')
                }
            }
            session.serviceTier = config.serviceTier
            this.markRuntimeConfigUpdated(sessionId, 'serviceTier', appliedAt)
        }
        if (config.collaborationMode !== undefined) {
            session.collaborationMode = config.collaborationMode
            this.markRuntimeConfigUpdated(sessionId, 'collaborationMode', appliedAt)
        }
        if (config.copilotAgentMode !== undefined) {
            session.copilotAgentMode = config.copilotAgentMode
            this.persistPreferredCopilotAgentMode(session, config.copilotAgentMode)
            this.markRuntimeConfigUpdated(sessionId, 'copilotAgentMode', appliedAt)
        }

        this.publisher.emit({ type: 'session-updated', sessionId, data: session })
    }

    private markRuntimeConfigUpdated(
        sessionId: string,
        key: RuntimeConfigKey,
        at: number
    ): void {
        const existing = this.runtimeConfigUpdatedAtBySessionId.get(sessionId) ?? {}
        existing[key] = at
        this.runtimeConfigUpdatedAtBySessionId.set(sessionId, existing)
    }

    private isStaleRuntimeKeepAlive(
        sessionId: string,
        key: RuntimeConfigKey,
        payloadTime: number
    ): boolean {
        const updatedAt = this.runtimeConfigUpdatedAtBySessionId.get(sessionId)?.[key]
        return updatedAt !== undefined && payloadTime < updatedAt
    }

    /**
     * tiann/hapi#916: hub-side write of the archive-metadata fields normally
     * authored by the CLI's `archiveAndClose`. Called by `syncEngine.archiveSession`
     * when the kill-RPC fails because the CLI is unreachable (e.g. the
     * hub-restart cascade already killed it). Without this, the route would
     * either 500 (pre-fix) or silently return ok=true while leaving
     * `lifecycleState=running` on disk — both confuse the operator.
     *
     * Idempotent: if `lifecycleState` is already `archived` we return without
     * touching the row to avoid resetting `lifecycleStateSince`. Best-effort:
     * if every retry hits `version-mismatch` (genuine contention) the original
     * `archiveSession` flow still marks the session inactive in cache via
     * `handleSessionEnd`, just without flipping the persisted lifecycle.
     */
    markSessionArchivedFromHub(
        sessionId: string,
        reason: string,
        options?: { onlyRunningSinceAtOrBefore?: number }
    ): void {
        for (let attempt = 0; attempt < METADATA_RETRY_ATTEMPTS; attempt += 1) {
            const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
            if (!session) return
            const current = session.metadata
            if (!current) return
            if (current.lifecycleState === 'archived') {
                return
            }
            if (options?.onlyRunningSinceAtOrBefore !== undefined) {
                if (current.lifecycleState !== 'running') {
                    return
                }
                const lifecycleStateSince = typeof current.lifecycleStateSince === 'number'
                    ? current.lifecycleStateSince
                    : 0
                if (lifecycleStateSince > options.onlyRunningSinceAtOrBefore) {
                    return
                }
            }

            const next: Record<string, unknown> = {
                ...current,
                lifecycleState: 'archived',
                lifecycleStateSince: Date.now(),
                archivedBy: 'hub',
                archiveReason: reason
            }

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                next,
                session.metadataVersion,
                session.namespace,
                { touchUpdatedAt: false }
            )

            if (result.result === 'error') {
                // tiann/hapi#916 review feedback: persistence failure must
                // surface so the route returns 5xx. Silently returning here
                // would let `/archive` claim success while the row stays
                // unarchived in the DB.
                throw new Error('Failed to archive session metadata from hub')
            }

            if (result.result === 'success') {
                this.refreshSession(sessionId)
                return
            }

            this.refreshSession(sessionId)
        }

        // tiann/hapi#916 review feedback: exhausted retries means we never
        // got a successful write. Match the renameSession / mergeSessions
        // contract and surface this as an error so non-RPC failures stay
        // 5xx per the issue's acceptance criteria.
        throw new Error('Session was modified concurrently while archiving from hub')
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        // tiann/hapi#919: retry-with-refresh on version-mismatch instead of
        // throwing on the first contention. Mirrors the good pattern in
        // mergeSessions (~L780) and in syncEngine's metadata helpers. Without
        // this, a stale cache snapshot produces forever-409 on PATCH /sessions/:id
        // until some unrelated event triggers a refresh.
        for (let attempt = 0; attempt < METADATA_RETRY_ATTEMPTS; attempt += 1) {
            const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
            if (!session) {
                throw new Error('Session not found')
            }

            const currentMetadata = session.metadata ?? { path: '', host: '' }
            const newMetadata = { ...currentMetadata, name }

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                newMetadata,
                session.metadataVersion,
                session.namespace,
                { touchUpdatedAt: false }
            )

            if (result.result === 'error') {
                throw new Error('Failed to update session metadata')
            }

            if (result.result === 'success') {
                this.refreshSession(sessionId)
                return
            }

            this.refreshSession(sessionId)
        }

        throw new Error('Session was modified concurrently. Please try again.')
    }

    async updateSessionSummary(sessionId: string, text: string): Promise<void> {
        // Keep the generated/native title separate from metadata.name. A
        // manually chosen name must continue to win in the Web title helper,
        // while the summary remains available as the agent-authored fallback.
        for (let attempt = 0; attempt < METADATA_RETRY_ATTEMPTS; attempt += 1) {
            const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
            if (!session) {
                throw new Error('Session not found')
            }

            const currentMetadata = session.metadata ?? { path: '', host: '' }
            const newMetadata = {
                ...currentMetadata,
                summary: {
                    text,
                    updatedAt: Date.now()
                }
            }

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                newMetadata,
                session.metadataVersion,
                session.namespace,
                { touchUpdatedAt: false }
            )

            if (result.result === 'error') {
                throw new Error('Failed to update session metadata')
            }

            if (result.result === 'success') {
                this.refreshSession(sessionId)
                return
            }

            this.refreshSession(sessionId)
        }

        throw new Error('Session was modified concurrently. Please try again.')
    }

    /**
     * Clear archive-related metadata on an archived session so it can be resumed.
     * - Removes `lifecycleState`, `archivedBy`, `archiveReason`, and stamps
     *   `lifecycleStateSince` so subsequent CLI lifecycle writes still win on time.
     * - For Cursor sessions that pre-date #799 (no `cursorSessionProtocol` set, but a
     *   `cursorSessionId` exists) defaults the protocol to `stream-json` so routing
     *   reaches the legacy launcher instead of the new ACP path.
     *
     * Returns the protocol that was applied (or already present) for cursor sessions,
     * or `undefined` for other flavors. Throws on version mismatch / store error.
     * No-op when metadata is null (callers should pre-check).
     */
    async clearSessionArchiveMetadata(sessionId: string): Promise<{ cursorSessionProtocol?: 'acp' | 'stream-json' }> {
        // tiann/hapi#919: retry-with-refresh on version-mismatch. The reopen
        // flow runs this on every archived-session resume — a stale snapshot
        // here used to forever-409 the only reopen affordance.
        for (let attempt = 0; attempt < METADATA_RETRY_ATTEMPTS; attempt += 1) {
            const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
            if (!session) {
                throw new Error('Session not found')
            }

            const currentMetadata = session.metadata
            if (!currentMetadata) {
                throw new Error('Session metadata missing')
            }

            const next: Record<string, unknown> = { ...currentMetadata }
            delete next.lifecycleState
            delete next.archivedBy
            delete next.archiveReason
            next.lifecycleStateSince = Date.now()

            let cursorSessionProtocol: 'acp' | 'stream-json' | undefined
            if (currentMetadata.flavor === 'cursor') {
                const existing = currentMetadata.cursorSessionProtocol
                if (existing === 'acp' || existing === 'stream-json') {
                    cursorSessionProtocol = existing
                } else if (currentMetadata.cursorSessionId) {
                    // Pre-#799 default: presence of cursorSessionId without protocol means stream-json.
                    cursorSessionProtocol = 'stream-json'
                    next.cursorSessionProtocol = 'stream-json'
                }
            }

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                next,
                session.metadataVersion,
                session.namespace,
                { touchUpdatedAt: false }
            )

            if (result.result === 'error') {
                throw new Error('Failed to update session metadata')
            }

            if (result.result === 'success') {
                this.refreshSession(sessionId)
                return cursorSessionProtocol ? { cursorSessionProtocol } : {}
            }

            this.refreshSession(sessionId)
        }

        throw new Error('Session was modified concurrently. Please try again.')
    }

    /**
     * Restore archive-related metadata fields that were captured before a reopen attempt.
     * Used when `resumeSession` fails after `clearSessionArchiveMetadata` already ran so the
     * session does not drift into a "not archived, not active" zombie state.
     *
     * Restores the four archive fields **exactly**: if a field was present in the snapshot
     * it is written, if it was absent it is deleted (covering the case where
     * `clearSessionArchiveMetadata` stamped a fresh `lifecycleStateSince` on a row that did
     * not have one originally). Other concurrent edits (e.g. a rename in flight) are
     * preserved. Returns silently if the session is gone or its metadata is unset; throws
     * on version mismatch so the caller can decide whether to retry.
     */
    async restoreSessionArchiveMetadata(
        sessionId: string,
        snapshot: {
            lifecycleState?: string
            archivedBy?: string
            archiveReason?: string
            lifecycleStateSince?: number
        }
    ): Promise<void> {
        // tiann/hapi#919: retry-with-refresh on version-mismatch. This is the
        // /reopen rollback path — if it fails the session is left in a
        // half-cleared archive state, so making it robust to a stale snapshot
        // matters more here than for the other two.
        for (let attempt = 0; attempt < METADATA_RETRY_ATTEMPTS; attempt += 1) {
            const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
            if (!session) return
            const current = session.metadata
            if (!current) return

            const next: Record<string, unknown> = { ...current }
            if (snapshot.lifecycleState !== undefined) {
                next.lifecycleState = snapshot.lifecycleState
            } else {
                delete next.lifecycleState
            }
            if (snapshot.archivedBy !== undefined) {
                next.archivedBy = snapshot.archivedBy
            } else {
                delete next.archivedBy
            }
            if (snapshot.archiveReason !== undefined) {
                next.archiveReason = snapshot.archiveReason
            } else {
                delete next.archiveReason
            }
            if (snapshot.lifecycleStateSince !== undefined) {
                next.lifecycleStateSince = snapshot.lifecycleStateSince
            } else {
                delete next.lifecycleStateSince
            }

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                next,
                session.metadataVersion,
                session.namespace,
                { touchUpdatedAt: false }
            )

            if (result.result === 'error') {
                throw new Error('Failed to restore archive metadata')
            }

            if (result.result === 'success') {
                this.refreshSession(sessionId)
                return
            }

            this.refreshSession(sessionId)
        }

        throw new Error('Session was modified concurrently during reopen rollback')
    }

    async deleteSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session) {
            throw new Error('Session not found')
        }

        if (session.active) {
            throw new Error('Cannot delete active session')
        }

        const scratchlistAttachments = this.store.scratchlist
            .list(sessionId)
            .flatMap((entry) => entry.attachments)

        const deleted = this.store.sessions.deleteSession(sessionId, session.namespace)
        if (!deleted) {
            throw new Error('Failed to delete session')
        }

        this.sessions.delete(sessionId)
        this.lastBroadcastAtBySessionId.delete(sessionId)
        this.todoBackfillAttemptedSessionIds.delete(sessionId)
        this.pendingThinkingUntilBySessionId.delete(sessionId)

        void import('../scratchlistAttachments/storage').then(async ({
            deleteScratchlistAttachmentFiles,
            deleteScratchlistSessionAttachmentDir,
            getHapiHomeDir,
        }) => {
            const hapiHome = getHapiHomeDir()
            await deleteScratchlistAttachmentFiles(hapiHome, scratchlistAttachments)
            await deleteScratchlistSessionAttachmentDir(hapiHome, session.namespace, sessionId)
        })

        this.publisher.emit({ type: 'session-removed', sessionId, namespace: session.namespace })
    }

    async mergeSessions(oldSessionId: string, newSessionId: string, namespace: string): Promise<void> {
        await this.mergeSessionData(oldSessionId, newSessionId, namespace, { deleteOldSession: true })
    }

    async mergeSessionHistory(
        oldSessionId: string,
        newSessionId: string,
        namespace: string,
        options: { mergeAgentState?: boolean } = {}
    ): Promise<void> {
        await this.mergeSessionData(oldSessionId, newSessionId, namespace, {
            deleteOldSession: false,
            mergeAgentState: options.mergeAgentState ?? true
        })
    }

    private async mergeSessionData(
        oldSessionId: string,
        newSessionId: string,
        namespace: string,
        options: { deleteOldSession: boolean; mergeAgentState?: boolean }
    ): Promise<void> {
        if (oldSessionId === newSessionId) {
            return
        }

        const oldStored = this.store.sessions.getSessionByNamespace(oldSessionId, namespace)
        const newStored = this.store.sessions.getSessionByNamespace(newSessionId, namespace)
        if (!oldStored || !newStored) {
            throw new Error('Session not found for merge')
        }

        const movedMessages = this.store.messages.mergeSessionMessages(oldSessionId, newSessionId)
        // mergeSessions deletes the source. mergeSessionHistory keeps it alive
        // with the original socket, so its notify chain must stay on that id.
        if (options.deleteOldSession) {
            this.store.workGraph.reassignNotifySession(namespace, oldSessionId, newSessionId)
        }
        if (movedMessages.moved > 0) {
            this.store.usage.transferSession(oldSessionId, newSessionId)
            if (!options.deleteOldSession) {
                this.publisher.emit({ type: 'messages-invalidated', sessionId: oldSessionId, namespace })
            }
            this.publisher.emit({ type: 'messages-invalidated', sessionId: newSessionId, namespace })
        }

        // Keep any share link alive across the id change (resume spawns a new
        // session id and merges the old one in). Without this the shared link
        // would 404 the moment the owner resumes the shared session.
        if (options.deleteOldSession) {
            this.store.shares.migrateShares(oldSessionId, newSessionId, namespace)
        }

        // tiann/hapi#920: transfer scratchlist rows BEFORE the
        // deleteSession() call below fires `ON DELETE CASCADE` on
        // `session_scratchlist.session_id`. Without this step every
        // dedup (#448 agent-id collision) and every resume-of-inactive
        // path (`syncEngine.resumeSession` -> here) silently destroys
        // the operator's per-session notes, contradicting the v2.0
        // promise that scratchlist survives reloads.
        const movedScratchlist = this.store.scratchlist.transfer(oldSessionId, newSessionId)
        if (movedScratchlist.moved > 0) {
            // Attachment hub paths embed the old session id. Re-key files +
            // metadata so quota/resolve stay correct on the consolidated id.
            const {
                getHapiHomeDir,
                moveScratchlistAttachmentFilesForSession,
                deleteScratchlistSessionAttachmentDir,
            } = await import('../scratchlistAttachments/storage')
            const hapiHome = getHapiHomeDir()
            for (const entry of this.store.scratchlist.list(newSessionId)) {
                if (entry.attachments.length === 0) continue
                const attachments = await moveScratchlistAttachmentFilesForSession(
                    hapiHome,
                    namespace,
                    oldSessionId,
                    newSessionId,
                    entry.attachments,
                )
                if (attachments.some((att, i) => att.path !== entry.attachments[i]?.path)) {
                    this.store.scratchlist.update(newSessionId, entry.entryId, { attachments })
                }
            }
            // Collided SQL losers + orphan uploads still under the old dir.
            await deleteScratchlistSessionAttachmentDir(hapiHome, namespace, oldSessionId)
            // Rows landed on the consolidated session - invalidate so
            // any client on the new id refetches.
            this.emitScratchlistChanged(newSessionId)
        } else if (movedScratchlist.collided > 0) {
            // Every old entry lost the PK race — drop leftover hub blobs.
            const { getHapiHomeDir, deleteScratchlistSessionAttachmentDir } = await import(
                '../scratchlistAttachments/storage'
            )
            await deleteScratchlistSessionAttachmentDir(getHapiHomeDir(), namespace, oldSessionId)
        }
        if (!options.deleteOldSession && (movedScratchlist.moved > 0 || movedScratchlist.collided > 0)) {
            // HAPI Bot PR #896: when every old entry collides (moved=0,
            // collided>0) the transfer still deletes rows from the
            // still-alive old session. Emit even when moved=0 so web
            // clients viewing the old id drop stale cache entries that
            // would 404 on edit/delete.
            this.emitScratchlistChanged(oldSessionId)
        }

        const mergedMetadata = this.mergeSessionMetadata(oldStored.metadata, newStored.metadata)
        if (mergedMetadata !== null && mergedMetadata !== newStored.metadata) {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const latest = this.store.sessions.getSessionByNamespace(newSessionId, namespace)
                if (!latest) break
                const result = this.store.sessions.updateSessionMetadata(
                    newSessionId,
                    mergedMetadata,
                    latest.metadataVersion,
                    namespace,
                    { touchUpdatedAt: false }
                )
                if (result.result === 'success') {
                    break
                }
                if (result.result === 'error') {
                    break
                }
            }
        }

        if (newStored.model === null && oldStored.model !== null) {
            const updated = this.store.sessions.setSessionModel(newSessionId, oldStored.model, namespace, {
                touchUpdatedAt: false
            })
            if (!updated) {
                throw new Error('Failed to preserve session model during merge')
            }
        }

        if (newStored.modelReasoningEffort === null && oldStored.modelReasoningEffort !== null) {
            const updated = this.store.sessions.setSessionModelReasoningEffort(newSessionId, oldStored.modelReasoningEffort, namespace, {
                touchUpdatedAt: false
            })
            if (!updated) {
                throw new Error('Failed to preserve session model reasoning effort during merge')
            }
        }

        if (newStored.effort === null && oldStored.effort !== null) {
            const updated = this.store.sessions.setSessionEffort(newSessionId, oldStored.effort, namespace, {
                touchUpdatedAt: false
            })
            if (!updated) {
                throw new Error('Failed to preserve session effort during merge')
            }
        }

        if (newStored.serviceTier === null && oldStored.serviceTier !== null) {
            const updated = this.store.sessions.setSessionServiceTier(newSessionId, oldStored.serviceTier, namespace, {
                touchUpdatedAt: false
            })
            if (!updated) {
                throw new Error('Failed to preserve session service tier during merge')
            }
        }

        const latestSource = this.store.sessions.getSessionByNamespace(oldSessionId, namespace)
        const latestSourceMode = latestSource?.globalPinned
            ? 'global' as const
            : latestSource?.pinned
                ? 'project' as const
                : 'none' as const
        if (latestSourceMode !== 'none') {
            const latest = this.store.sessions.getSessionByNamespace(newSessionId, namespace)
            if (!latest) {
                throw new Error('Session not found for merge')
            }
            const latestMode = latest.globalPinned ? 'global' : latest.pinned ? 'project' : 'none'
            // Prefer the stronger pin: global > project > none. Never downgrade a
            // concurrently (or already) global-pinned target to project-only.
            const desiredMode =
                latestSourceMode === 'global' || latestMode === 'global'
                    ? 'global' as const
                    : latestSourceMode === 'project' || latestMode === 'project'
                        ? 'project' as const
                        : 'none' as const
            if (desiredMode !== latestMode) {
                const updated = this.store.sessions.setSessionPinMode(newSessionId, desiredMode, namespace)
                const now = this.store.sessions.getSessionByNamespace(newSessionId, namespace)
                const nowMode = now?.globalPinned ? 'global' : now?.pinned ? 'project' : 'none'
                if (!updated && nowMode !== desiredMode) {
                    throw new Error('Failed to preserve session pin during merge')
                }
            }
        }

        if (oldStored.todos !== null && oldStored.todosUpdatedAt !== null) {
            this.store.sessions.setSessionTodos(
                newSessionId,
                oldStored.todos,
                oldStored.todosUpdatedAt,
                namespace
            )
        }

        // Merge agentState: union requests/completedRequests from both sessions so pending
        // approvals on inactive duplicates are not lost. Active duplicates keep their
        // own agentState because permission approve/deny RPCs are routed by session id.
        // Read the latest target state right before writing to avoid overwriting live updates.
        if ((options.mergeAgentState ?? true) && oldStored.agentState !== null) {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const latest = this.store.sessions.getSessionByNamespace(newSessionId, namespace)
                if (!latest) break
                const mergedAgentState = this.mergeAgentState(oldStored.agentState, latest.agentState)
                if (mergedAgentState === null || mergedAgentState === latest.agentState) break
                const result = this.store.sessions.updateSessionAgentState(
                    newSessionId,
                    mergedAgentState,
                    latest.agentStateVersion,
                    namespace
                )
                if (result.result !== 'version-mismatch') break
                // version-mismatch: retry with fresh snapshot
            }
        }

        if (oldStored.teamState !== null && oldStored.teamStateUpdatedAt !== null) {
            this.store.sessions.setSessionTeamState(
                newSessionId,
                oldStored.teamState,
                oldStored.teamStateUpdatedAt,
                namespace
            )
        }

        if (options.deleteOldSession) {
            const deleted = this.store.sessions.deleteSession(oldSessionId, namespace)
            if (!deleted) {
                throw new Error('Failed to delete old session during merge')
            }

            const existed = this.sessions.delete(oldSessionId)
            if (existed) {
                this.publisher.emit({ type: 'session-removed', sessionId: oldSessionId, namespace })
            }
            this.lastBroadcastAtBySessionId.delete(oldSessionId)
            this.todoBackfillAttemptedSessionIds.delete(oldSessionId)
        } else {
            this.refreshSession(oldSessionId)
        }

        const refreshed = this.refreshSession(newSessionId)
        if (refreshed) {
            this.publisher.emit({ type: 'session-updated', sessionId: newSessionId, data: refreshed })
        }
    }

    private mergeSessionMetadata(oldMetadata: unknown | null, newMetadata: unknown | null): unknown | null {
        if (!oldMetadata || typeof oldMetadata !== 'object') {
            return newMetadata
        }
        if (!newMetadata || typeof newMetadata !== 'object') {
            return oldMetadata
        }

        const oldObj = oldMetadata as Record<string, unknown>
        const newObj = newMetadata as Record<string, unknown>
        const merged: Record<string, unknown> = { ...newObj }
        let changed = false

        if (typeof oldObj.name === 'string' && typeof newObj.name !== 'string') {
            merged.name = oldObj.name
            changed = true
        }

        const oldSummary = oldObj.summary as { text?: unknown; updatedAt?: unknown } | undefined
        const newSummary = newObj.summary as { text?: unknown; updatedAt?: unknown } | undefined
        const oldUpdatedAt = typeof oldSummary?.updatedAt === 'number' ? oldSummary.updatedAt : null
        const newUpdatedAt = typeof newSummary?.updatedAt === 'number' ? newSummary.updatedAt : null
        if (oldUpdatedAt !== null && (newUpdatedAt === null || oldUpdatedAt > newUpdatedAt)) {
            merged.summary = oldSummary
            changed = true
        }

        if (oldObj.worktree && !newObj.worktree) {
            merged.worktree = oldObj.worktree
            changed = true
        }

        if (typeof oldObj.path === 'string' && typeof newObj.path !== 'string') {
            merged.path = oldObj.path
            changed = true
        }
        if (typeof oldObj.host === 'string' && typeof newObj.host !== 'string') {
            merged.host = oldObj.host
            changed = true
        }
        if (typeof oldObj.preferredPermissionMode === 'string' && typeof newObj.preferredPermissionMode !== 'string') {
            merged.preferredPermissionMode = oldObj.preferredPermissionMode
            changed = true
        }
        if (typeof oldObj.preferredCopilotAgentMode === 'string' && typeof newObj.preferredCopilotAgentMode !== 'string') {
            merged.preferredCopilotAgentMode = oldObj.preferredCopilotAgentMode
            changed = true
        }

        return changed ? merged : newMetadata
    }

    private persistPreferredPermissionMode(session: Session, permissionMode: PermissionMode): void {
        const currentMetadata = session.metadata
        if (!currentMetadata || currentMetadata.preferredPermissionMode === permissionMode) {
            return
        }

        const nextMetadata = { ...currentMetadata, preferredPermissionMode: permissionMode }
        const result = this.store.sessions.updateSessionMetadata(
            session.id,
            nextMetadata,
            session.metadataVersion,
            session.namespace,
            { touchUpdatedAt: false }
        )

        if (result.result === 'error') {
            return
        }

        const parsed = MetadataSchema.safeParse(result.value)
        if (!parsed.success) {
            return
        }

        session.metadata = parsed.data
        session.metadataVersion = result.version
    }

    private persistPreferredCopilotAgentMode(session: Session, copilotAgentMode: CopilotAgentMode): void {
        const currentMetadata = session.metadata
        if (!currentMetadata || currentMetadata.preferredCopilotAgentMode === copilotAgentMode) {
            return
        }

        const nextMetadata = { ...currentMetadata, preferredCopilotAgentMode: copilotAgentMode }
        const result = this.store.sessions.updateSessionMetadata(
            session.id,
            nextMetadata,
            session.metadataVersion,
            session.namespace,
            { touchUpdatedAt: false }
        )

        if (result.result === 'error') {
            return
        }

        const parsed = MetadataSchema.safeParse(result.value)
        if (!parsed.success) {
            return
        }

        session.metadata = parsed.data
        session.metadataVersion = result.version
    }

    private persistPiSelectedModel(session: Session, piSelected: { provider: string; modelId: string } | null): void {
        const currentMetadata = session.metadata
        if (!currentMetadata || currentMetadata.piSelectedModel === piSelected) {
            return
        }

        const nextMetadata = { ...currentMetadata, piSelectedModel: piSelected }
        const result = this.store.sessions.updateSessionMetadata(
            session.id,
            nextMetadata,
            session.metadataVersion,
            session.namespace,
            { touchUpdatedAt: false }
        )

        if (result.result === 'error') {
            return
        }

        const parsed = MetadataSchema.safeParse(result.value)
        if (!parsed.success) {
            return
        }

        session.metadata = parsed.data
        session.metadataVersion = result.version
    }

    private mergeAgentState(oldState: unknown | null, newState: unknown | null): unknown | null {
        if (oldState === null) return newState
        if (newState === null) return oldState

        const oldObj = oldState as Record<string, unknown>
        const newObj = newState as Record<string, unknown>

        const completedRequests = {
            ...((oldObj.completedRequests as Record<string, unknown> | undefined) ?? {}),
            ...((newObj.completedRequests as Record<string, unknown> | undefined) ?? {})
        }
        // Filter out requests that are already completed to avoid resurrecting them as pending
        const completedIds = new Set(Object.keys(completedRequests))
        const requests = Object.fromEntries(
            Object.entries({
                ...((oldObj.requests as Record<string, unknown> | undefined) ?? {}),
                ...((newObj.requests as Record<string, unknown> | undefined) ?? {})
            }).filter(([id]) => !completedIds.has(id))
        )

        return { ...oldObj, ...newObj, requests, completedRequests }
    }

    private extractAgentSessionId(
        metadata: NonNullable<Session['metadata']>
    ): { field: 'codexSessionId' | 'claudeSessionId' | 'geminiSessionId' | 'opencodeSessionId' | 'grokSessionId' | 'cursorSessionId' | 'piSessionId' | 'agySessionId' | 'copilotSessionId'; value: string; dedupeKey: string; machineId?: string } | null {
        const scoped = (field: 'codexSessionId' | 'claudeSessionId' | 'geminiSessionId' | 'opencodeSessionId' | 'grokSessionId' | 'cursorSessionId' | 'piSessionId' | 'agySessionId' | 'copilotSessionId', value: string) => ({
            field,
            value,
            dedupeKey: field === 'piSessionId' ? `${field}:${metadata.machineId ?? 'unscoped'}:${value}` : `${field}:${value}`,
            ...(field === 'piSessionId' && metadata.machineId ? { machineId: metadata.machineId } : {})
        })
        if (metadata.codexSessionId) return scoped('codexSessionId', metadata.codexSessionId)
        if (metadata.claudeSessionId) return scoped('claudeSessionId', metadata.claudeSessionId)
        if (metadata.geminiSessionId) return scoped('geminiSessionId', metadata.geminiSessionId)
        if (metadata.opencodeSessionId) return scoped('opencodeSessionId', metadata.opencodeSessionId)
        if (metadata.grokSessionId) return scoped('grokSessionId', metadata.grokSessionId)
        if (metadata.cursorSessionId) return scoped('cursorSessionId', metadata.cursorSessionId)
        if (metadata.piSessionId) return scoped('piSessionId', metadata.piSessionId)
        if (metadata.agySessionId) return scoped('agySessionId', metadata.agySessionId)
        if (metadata.copilotSessionId) return scoped('copilotSessionId', metadata.copilotSessionId)
        return null
    }

    async deduplicateByAgentSessionId(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session?.metadata) return

        const agentId = this.extractAgentSessionId(session.metadata)
        if (!agentId) return

        // Guard: if another dedup for this agent ID is already in progress,
        // coalesce this trigger and run one more pass afterwards. This matters
        // for active duplicates: a session can become inactive while the first
        // pass is only allowed to move history, and the follow-up pass should
        // then be allowed to delete the inactive duplicate record.
        if (this.deduplicateInProgress.has(agentId.dedupeKey)) {
            this.deduplicatePending.add(agentId.dedupeKey)
            return
        }
        this.deduplicateInProgress.add(agentId.dedupeKey)

        try {
            do {
                this.deduplicatePending.delete(agentId.dedupeKey)

                const currentSession = this.sessions.get(sessionId)
                const candidates: { id: string; session: Session }[] = []
                if (currentSession?.metadata && currentSession.metadata[agentId.field] === agentId.value) {
                    if (agentId.field !== 'piSessionId' || currentSession.metadata.machineId === agentId.machineId) {
                        candidates.push({ id: sessionId, session: currentSession })
                    }
                }
                for (const [existingId, existing] of this.sessions) {
                    if (existingId === sessionId) continue
                    if (existing.namespace !== session.namespace) continue
                    if (!existing.metadata) continue
                    if (existing.metadata[agentId.field] !== agentId.value) continue
                    if (agentId.field === 'piSessionId' && existing.metadata.machineId !== agentId.machineId) continue
                    candidates.push({ id: existingId, session: existing })
                }

                if (candidates.length <= 1) continue

                const activeCandidates = candidates.filter(({ session }) => session.active)
                if (activeCandidates.length > 1) {
                    // Do not move history between two live session ids. The web may
                    // intentionally keep the currently selected duplicate visible,
                    // and the hub does not know which active duplicate that is.
                    continue
                }

                // Keep the same canonical session the sidebar is likely to show:
                // active sessions win, then the most recently updated session wins.
                // If timestamps tie, prefer the session that triggered this dedup run
                // so callers can intentionally preserve the visible/resumed session.
                candidates.sort((a, b) => {
                    if (a.session.active !== b.session.active) return a.session.active ? -1 : 1
                    const updatedDelta = b.session.updatedAt - a.session.updatedAt
                    if (updatedDelta !== 0) return updatedDelta
                    if (a.id === sessionId) return -1
                    if (b.id === sessionId) return 1
                    return b.session.activeAt - a.session.activeAt
                })
                const targetId = candidates[0].id
                const targetNamespace = candidates[0].session.namespace

                for (const { id } of candidates.slice(1)) {
                    if (id === targetId) continue
                    try {
                        const candidate = this.sessions.get(id)
                        if (candidate?.active) {
                            // Keep the live session record/socket intact, but move its already
                            // persisted history into the visible dedup target.  This preserves
                            // left-sidebar dedup while making resumed/restarted sessions show
                            // the full conversation history.
                            await this.mergeSessionHistory(id, targetId, targetNamespace, {
                                mergeAgentState: false
                            })
                        } else {
                            await this.mergeSessions(id, targetId, targetNamespace)
                        }
                    } catch {
                        // best-effort: duplicate remains if merge fails
                    }
                }
            } while (this.deduplicatePending.has(agentId.dedupeKey))
        } finally {
            this.deduplicateInProgress.delete(agentId.dedupeKey)
            this.deduplicatePending.delete(agentId.dedupeKey)
        }
    }
}
