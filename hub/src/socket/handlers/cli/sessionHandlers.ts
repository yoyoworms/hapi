import type { ClientToServerEvents } from '@hapi/protocol'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { AgentAccountStatus, CodexCollaborationMode, PermissionMode } from '@hapi/protocol/types'
import type { Store, StoredSession } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import { extractTodoWriteTodosFromMessageContent } from '../../../sync/todos'
import { extractTeamStateFromMessageContent, applyTeamStateDelta } from '../../../sync/teams'
import type { CliSocketWithData } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'

type SessionAlivePayload = {
    sid: string
    time: number
    thinking?: boolean
    mode?: 'local' | 'remote'
    permissionMode?: PermissionMode
    model?: string | null
    effort?: string | null
    collaborationMode?: CodexCollaborationMode
}

type SessionEndPayload = {
    sid: string
    time: number
}

type ResolveSessionAccess = (sessionId: string) => AccessResult<StoredSession>

type EmitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => void

type UpdateMetadataHandler = ClientToServerEvents['update-metadata']
type UpdateStateHandler = ClientToServerEvents['update-state']

const messageSchema = z.object({
    sid: z.string(),
    message: z.union([z.string(), z.unknown()]),
    localId: z.string().optional()
})

const updateMetadataSchema = z.object({
    sid: z.string(),
    expectedVersion: z.number().int(),
    metadata: z.unknown()
})

const updateStateSchema = z.object({
    sid: z.string(),
    expectedVersion: z.number().int(),
    agentState: z.unknown().nullable()
})

function getAgentEventType(content: unknown): string | null {
    if (!content || typeof content !== 'object') {
        return null
    }

    const record = content as {
        type?: unknown
        role?: unknown
        content?: {
            type?: unknown
            data?: {
                type?: unknown
            }
        }
        data?: {
            type?: unknown
        }
    }

    if (record.type === 'event' && record.data && typeof record.data.type === 'string') {
        return record.data.type
    }

    if (
        record.role === 'agent'
        && record.content?.type === 'event'
        && record.content.data
        && typeof record.content.data.type === 'string'
    ) {
        return record.content.data.type
    }

    return null
}

export type SessionHandlersDeps = {
    store: Store
    resolveSessionAccess: ResolveSessionAccess
    emitAccessError: EmitAccessError
    onSessionAlive?: (payload: SessionAlivePayload) => void
    onSessionEnd?: (payload: SessionEndPayload) => void
    onSessionUsage?: (payload: { sid: string; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number }) => void
    onSessionAccountStatus?: (payload: { sid: string; accountStatus: AgentAccountStatus }) => void
    onSessionMetadataUpdated?: (payload: { sid: string; namespace: string; metadata: unknown }) => void
    onWebappEvent?: (event: SyncEvent) => void
}

export function registerSessionHandlers(socket: CliSocketWithData, deps: SessionHandlersDeps): void {
    const { store, resolveSessionAccess, emitAccessError, onSessionAlive, onSessionEnd, onSessionUsage, onSessionAccountStatus, onSessionMetadataUpdated, onWebappEvent } = deps

    // Track recently seen content uuids to deduplicate messages from Socket.IO reconnect buffer
    const recentContentUuids = new Set<string>()

    socket.on('message', (data: unknown, ack?: () => void) => {
        const parsed = messageSchema.safeParse(data)
        if (!parsed.success) {
            ack?.()
            return
        }

        const { sid, localId } = parsed.data
        const raw = parsed.data.message

        const content = typeof raw === 'string'
            ? (() => {
                try {
                    return JSON.parse(raw) as unknown
                } catch {
                    return raw
                }
            })()
            : raw

        const sessionAccess = resolveSessionAccess(sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', sid, sessionAccess.reason)
            return
        }
        const session = sessionAccess.value

        // Extract usage data from event messages before dropping them
        const _c = content as any
        if (_c?.role === 'agent' && _c?.content?.type === 'event' && _c?.content?.data?.type === 'usage') {
            const usage = _c.content.data
            onSessionUsage?.({
                sid,
                totalCostUsd: usage.totalCostUsd,
                totalInputTokens: usage.totalInputTokens,
                totalOutputTokens: usage.totalOutputTokens
            })
            ack?.()
            return
        }
        if (_c?.role === 'agent' && _c?.content?.type === 'event' && _c?.content?.data?.type === 'account-status') {
            const accountStatus = _c.content.data.accountStatus
            if (accountStatus && typeof accountStatus === 'object') {
                onSessionAccountStatus?.({ sid, accountStatus })
            }
            ack?.()
            return
        }
        // Skip other internal event messages (ready, rate_limit_event, etc.)
        // These are not user-visible and should not be stored or forwarded
        const agentEventType = getAgentEventType(_c)
        if (agentEventType === 'ready') {
            onWebappEvent?.({
                type: 'message-received',
                sessionId: sid,
                message: {
                    id: randomUUID(),
                    seq: null,
                    localId: null,
                    content,
                    createdAt: Date.now()
                }
            })
            ack?.()
            return
        }
        if (_c?.type === 'event' || (_c?.role === 'agent' && _c?.content?.type === 'event')) {
            ack?.()
            return
        }
        const INTERNAL_TYPES = ['usage', 'ready', 'rate_limit_event', 'rate_limit_info']
        if (typeof _c?.type === 'string' && INTERNAL_TYPES.includes(_c.type)) {
            ack?.()
            return
        }
        if (_c?.role === 'agent' && typeof _c?.content?.type === 'string' && INTERNAL_TYPES.includes(_c.content.type)) {
            ack?.()
            return
        }

        // Deduplicate by content uuid (prevents duplicates from Socket.IO reconnect buffer)
        const _uuid = _c?.content?.data?.uuid
        if (typeof _uuid === 'string') {
            const dedupKey = `${sid}:${_uuid}`
            if (recentContentUuids.has(dedupKey)) {
                ack?.()
                return
            }
            recentContentUuids.add(dedupKey)
            // Cap set size to prevent memory leak
            if (recentContentUuids.size > 5000) {
                const first = recentContentUuids.values().next().value
                if (first) recentContentUuids.delete(first)
            }
        }
        const msg = store.messages.addMessage(sid, content, localId, socket.data.clockOffset)

        const todos = extractTodoWriteTodosFromMessageContent(content)
        if (todos) {
            const updated = store.sessions.setSessionTodos(sid, todos, msg.createdAt, session.namespace)
            if (updated) {
                onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
            }
        }

        const teamDelta = extractTeamStateFromMessageContent(content)
        if (teamDelta) {
            const existingSession = store.sessions.getSession(sid)
            const existingTeamState = existingSession?.teamState as import('@hapi/protocol/types').TeamState | null | undefined
            const newTeamState = applyTeamStateDelta(existingTeamState ?? null, teamDelta)
            const updated = store.sessions.setSessionTeamState(sid, newTeamState, msg.createdAt, session.namespace)
            if (updated) {
                onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
            }
        }

        const update = {
            id: randomUUID(),
            seq: msg.seq,
            createdAt: Date.now(),
            body: {
                t: 'new-message' as const,
                sid,
                message: {
                    id: msg.id,
                    seq: msg.seq,
                    createdAt: msg.createdAt,
                    localId: msg.localId,
                    content: msg.content
                }
            }
        }
        socket.to(`session:${sid}`).emit('update', update)

        onWebappEvent?.({
            type: 'message-received',
            sessionId: sid,
            message: {
                id: msg.id,
                seq: msg.seq,
                localId: msg.localId,
                content: msg.content,
                createdAt: msg.createdAt
            }
        })

        ack?.()
    })

    const handleUpdateMetadata: UpdateMetadataHandler = (data, cb) => {
        const parsed = updateMetadataSchema.safeParse(data)
        if (!parsed.success) {
            cb({ result: 'error' })
            return
        }

        const { sid, metadata, expectedVersion } = parsed.data
        const sessionAccess = resolveSessionAccess(sid)
        if (!sessionAccess.ok) {
            cb({ result: 'error', reason: sessionAccess.reason })
            return
        }

        const result = store.sessions.updateSessionMetadata(
            sid,
            metadata,
            expectedVersion,
            sessionAccess.value.namespace
        )
        if (result.result === 'success') {
            cb({ result: 'success', version: result.version, metadata: result.value })
        } else if (result.result === 'version-mismatch') {
            cb({ result: 'version-mismatch', version: result.version, metadata: result.value })
        } else {
            cb({ result: 'error' })
        }

        if (result.result === 'success') {
            onSessionMetadataUpdated?.({ sid, namespace: sessionAccess.value.namespace, metadata: result.value })
            const update = {
                id: randomUUID(),
                seq: Date.now(),
                createdAt: Date.now(),
                body: {
                    t: 'update-session' as const,
                    sid,
                    metadata: { version: result.version, value: metadata },
                    agentState: null
                }
            }
            socket.to(`session:${sid}`).emit('update', update)
            onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
        }
    }

    socket.on('update-metadata', handleUpdateMetadata)

    const handleUpdateState: UpdateStateHandler = (data, cb) => {
        const parsed = updateStateSchema.safeParse(data)
        if (!parsed.success) {
            cb({ result: 'error' })
            return
        }

        const { sid, agentState, expectedVersion } = parsed.data
        const sessionAccess = resolveSessionAccess(sid)
        if (!sessionAccess.ok) {
            cb({ result: 'error', reason: sessionAccess.reason })
            return
        }

        const result = store.sessions.updateSessionAgentState(
            sid,
            agentState,
            expectedVersion,
            sessionAccess.value.namespace
        )
        if (result.result === 'success') {
            cb({ result: 'success', version: result.version, agentState: result.value })
        } else if (result.result === 'version-mismatch') {
            cb({ result: 'version-mismatch', version: result.version, agentState: result.value })
        } else {
            cb({ result: 'error' })
        }

        if (result.result === 'success') {
            const update = {
                id: randomUUID(),
                seq: Date.now(),
                createdAt: Date.now(),
                body: {
                    t: 'update-session' as const,
                    sid,
                    metadata: null,
                    agentState: { version: result.version, value: agentState }
                }
            }
            socket.to(`session:${sid}`).emit('update', update)
            onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
        }
    }

    socket.on('update-state', handleUpdateState)

    socket.on('session-alive', (data: SessionAlivePayload) => {
        if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        onSessionAlive?.(data)
    })

    socket.on('session-end', (data: SessionEndPayload) => {
        if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        onSessionEnd?.(data)
    })
}
