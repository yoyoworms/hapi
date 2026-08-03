import type { AgentAccountStatus, CodexCollaborationMode, PermissionMode } from '@hapi/protocol/types'
import type { SessionEndReason } from '@hapi/protocol'
import type { Store, StoredMachine, StoredSession } from '../../../store'
import type { RpcRegistry } from '../../rpcRegistry'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { TerminalRegistry } from '../../terminalRegistry'
import type { CliSocketWithData, SocketServer } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'
import { registerMachineHandlers } from './machineHandlers'
import { registerGatedRpcHandlers, registerRpcHandlers } from './rpcHandlers'
import { registerSessionHandlers } from './sessionHandlers'
import { cleanupTerminalHandlers, registerTerminalHandlers } from './terminalHandlers'

type SessionAlivePayload = {
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
    runtimeId?: string
    runtimeGeneration?: number
}

function getSessionRuntimeId(session: Pick<StoredSession, 'metadata'>): string | null {
    if (!session.metadata || typeof session.metadata !== 'object' || Array.isArray(session.metadata)) {
        return null
    }
    const runtimeId = (session.metadata as Record<string, unknown>).runtimeId
    return typeof runtimeId === 'string' && runtimeId.length > 0 ? runtimeId : null
}

function isRunningRuntimeOwner(session: StoredSession, runtimeId: string | null): boolean {
    if (!runtimeId || getSessionRuntimeId(session) !== runtimeId) {
        return false
    }
    if (!session.metadata || typeof session.metadata !== 'object' || Array.isArray(session.metadata)) {
        return false
    }
    return (session.metadata as Record<string, unknown>).lifecycleState === 'running'
}

function isDurableRuntimeOwner(session: StoredSession, runtimeId: string | null): boolean {
    return Boolean(runtimeId && getSessionRuntimeId(session) === runtimeId)
}

function isRuntimeLifecycle(
    metadata: unknown,
    runtimeId: string,
    lifecycleState: 'running' | 'archived'
): boolean {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return false
    }
    const record = metadata as Record<string, unknown>
    return record.lifecycleState === lifecycleState && record.runtimeId === runtimeId
}

type SessionEndPayload = {
    sid: string
    time: number
    reason?: SessionEndReason
    runtimeId?: string
    runtimeGeneration?: number
}

type SessionReadyPayload = {
    sid: string
    time: number
}

type MachineAlivePayload = {
    machineId: string
    time: number
}

export type CliHandlersDeps = {
    io: SocketServer
    store: Store
    rpcRegistry: RpcRegistry
    terminalRegistry: TerminalRegistry
    onSessionAlive?: (payload: SessionAlivePayload) => boolean | void
    onSessionReady?: (payload: SessionReadyPayload) => void
    onSessionEnd?: (payload: SessionEndPayload) => boolean
    onSessionUsage?: (payload: { sid: string; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number }) => void
    onSessionAccountStatus?: (payload: { sid: string; accountStatus: AgentAccountStatus }) => void
    onSessionMetadataUpdated?: (payload: {
        sid: string
        namespace: string
        metadata: unknown
        runtimeId?: string
        runtimeGeneration?: number
    }) => void
    onSessionMetadataUpdateAllowed?: (payload: { sid: string; metadata: unknown; runtimeId: string; runtimeGeneration: number }) => boolean
    onMachineAlive?: (payload: MachineAlivePayload) => void
    onWebappEvent?: (event: SyncEvent) => void
    onBackgroundTaskDelta?: (sessionId: string, delta: { started: number; completed: number }) => void
    onSessionActivity?: (sessionId: string, updatedAt: number) => void
    onSweepImmediateQueued?: (sessionId: string, now: number) => void
    onMessagesConsumed?: (sessionId: string) => void
}

export function registerCliHandlers(socket: CliSocketWithData, deps: CliHandlersDeps): void {
    const { io, store, rpcRegistry, terminalRegistry, onSessionAlive, onSessionReady, onSessionEnd, onSessionUsage, onSessionAccountStatus, onSessionMetadataUpdated, onSessionMetadataUpdateAllowed, onMachineAlive, onWebappEvent, onBackgroundTaskDelta, onSessionActivity, onSweepImmediateQueued, onMessagesConsumed } = deps
    const cliNamespace = io.of('/cli')
    const terminalNamespace = io.of('/terminal')
    const namespace = typeof socket.data.namespace === 'string' ? socket.data.namespace : null
    const auth = socket.handshake.auth as Record<string, unknown> | undefined
    const sessionId = typeof auth?.sessionId === 'string' ? auth.sessionId : null

    const resolveSessionAccess = (requestedSessionId: string): AccessResult<StoredSession> => {
        if (!namespace) {
            return { ok: false, reason: 'namespace-missing' }
        }
        if (sessionId && requestedSessionId !== sessionId) {
            return { ok: false, reason: 'access-denied' }
        }
        const session = store.sessions.getSessionByNamespace(requestedSessionId, namespace)
        if (session) {
            return { ok: true, value: session }
        }
        if (store.sessions.getSession(requestedSessionId)) {
            return { ok: false, reason: 'access-denied' }
        }
        return { ok: false, reason: 'not-found' }
    }

    const resolveMachineAccess = (machineId: string): AccessResult<StoredMachine> => {
        if (!namespace) {
            return { ok: false, reason: 'namespace-missing' }
        }
        const machine = store.machines.getMachineByNamespace(machineId, namespace)
        if (machine) {
            return { ok: true, value: machine }
        }
        if (store.machines.getMachine(machineId)) {
            return { ok: false, reason: 'access-denied' }
        }
        return { ok: false, reason: 'not-found' }
    }

    let sessionInitiallyOwned = false
    let sessionInitiallyAuthoritative = false
    if (sessionId) {
        const sessionAccess = resolveSessionAccess(sessionId)
        if (sessionAccess.ok) {
            const socketRuntimeId = typeof socket.data.runtimeId === 'string' ? socket.data.runtimeId : null
            sessionInitiallyOwned = isDurableRuntimeOwner(sessionAccess.value, socketRuntimeId)
            // Socket.IO flushes its sendBuffer before the client-side connect
            // callback can emit a fresh alive packet. The exact durable owner
            // of a still-running lifecycle must therefore publish immediately,
            // even if Hub liveness expired while the transport was offline.
            sessionInitiallyAuthoritative = isRunningRuntimeOwner(sessionAccess.value, socketRuntimeId)
            if (sessionInitiallyAuthoritative) {
                socket.join(`session:${sessionId}`)
            }
        }
    }

    const reconcileSessionRoomOwner = (sid: string, runtimeId: string): boolean => {
        if (sid !== sessionId || socket.data.runtimeId !== runtimeId) {
            return false
        }
        const room = `session:${sid}`
        socket.join(room)
        const peerIds = Array.from(cliNamespace.adapter.rooms.get(room) ?? [])
        for (const peerId of peerIds) {
            if (peerId === socket.id) {
                continue
            }
            const peer = cliNamespace.sockets.get(peerId)
            if (!peer) {
                continue
            }
            peer.leave(room)
            // Server-side disconnect does not auto-reconnect in Socket.IO. It
            // permanently fences an orphaned runner instead of letting it
            // rejoin and execute every future prompt a second time.
            peer.disconnect(true)
        }
        return true
    }

    const reconcileLegacySessionRoomOwner = (sid: string): boolean => {
        if (sid !== sessionId || typeof socket.data.runtimeId === 'string') {
            return false
        }
        const room = `session:${sid}`
        socket.join(room)
        const peerIds = Array.from(cliNamespace.adapter.rooms.get(room) ?? [])
        for (const peerId of peerIds) {
            if (peerId === socket.id) {
                continue
            }
            const peer = cliNamespace.sockets.get(peerId)
            if (!peer || typeof peer.data.runtimeId === 'string') {
                continue
            }
            peer.leave(room)
            peer.disconnect(true)
        }
        return true
    }

    if (
        sessionInitiallyAuthoritative
        && sessionId
        && typeof socket.data.runtimeId === 'string'
    ) {
        // A reconnect carrying the durable owner's exact runtime id can replace
        // an overlapping old Socket.IO transport immediately; it need not wait
        // for the first heartbeat and briefly receive prompts twice.
        reconcileSessionRoomOwner(sessionId, socket.data.runtimeId)
    }

    const machineId = typeof auth?.machineId === 'string' ? auth.machineId : null
    if (machineId && resolveMachineAccess(machineId).ok) {
        socket.join(`machine:${machineId}`)
    }

    const emitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => {
        const message = reason === 'access-denied'
            ? `${scope} access denied`
            : reason === 'not-found'
                ? `${scope} not found`
                : 'Namespace missing'
        socket.emit('error', { message, code: reason, scope, id })
    }

    const sessionRpcController = sessionId
        ? registerGatedRpcHandlers(socket, rpcRegistry, sessionInitiallyAuthoritative)
        : null
    let sessionTransportConnected = true
    let sessionRuntimeOwned = sessionInitiallyOwned
    let sessionRuntimeActive = sessionInitiallyAuthoritative
    if (!sessionId) {
        registerRpcHandlers(socket, rpcRegistry)
    }
    registerSessionHandlers(socket, {
        store,
        resolveSessionAccess,
        emitAccessError,
        isSessionTransportActive: () => sessionTransportConnected,
        isSessionRuntimeOwned: (sid) => sessionTransportConnected
            && sessionRuntimeOwned
            && sid === sessionId,
        isSessionRuntimeActive: (sid) => sessionTransportConnected
            && sessionRuntimeActive
            && sid === sessionId,
        onSessionAlive: (payload) => {
            if (!sessionTransportConnected || payload.sid !== sessionId) {
                return false
            }
            const accepted = onSessionAlive?.(payload) !== false
            if (!accepted) {
                sessionRuntimeActive = false
                socket.leave(`session:${payload.sid}`)
                sessionRpcController?.deactivate()
                return false
            }
            let ownsRoom = false
            if (payload.runtimeId) {
                ownsRoom = reconcileSessionRoomOwner(payload.sid, payload.runtimeId)
            } else {
                const current = resolveSessionAccess(payload.sid)
                if (current.ok && !getSessionRuntimeId(current.value)) {
                    ownsRoom = reconcileLegacySessionRoomOwner(payload.sid)
                }
            }
            if (!ownsRoom) {
                sessionRuntimeActive = false
                sessionRpcController?.deactivate()
                return false
            }
            sessionRuntimeActive = true
            sessionRuntimeOwned = true
            sessionRpcController?.activate()
            return true
        },
        onSessionReady,
        onSessionEnd: (payload) => {
            if (
                !sessionTransportConnected
                || !sessionRuntimeOwned
                || payload.sid !== sessionId
            ) {
                return false
            }
            const accepted = onSessionEnd?.(payload) ?? true
            if (accepted && payload.sid === sessionId) {
                sessionRuntimeActive = false
                sessionRuntimeOwned = false
                socket.leave(`session:${payload.sid}`)
                sessionRpcController?.deactivate()
            }
            return accepted
        },
        onSessionUsage,
        onSessionAccountStatus,
        onSessionMetadataUpdated: (payload) => {
            if (!sessionTransportConnected) {
                return
            }
            onSessionMetadataUpdated?.(payload)
            if (payload.runtimeId && isRuntimeLifecycle(payload.metadata, payload.runtimeId, 'running')) {
                if (reconcileSessionRoomOwner(payload.sid, payload.runtimeId)) {
                    sessionRuntimeActive = true
                    sessionRuntimeOwned = true
                    sessionRpcController?.activate()
                }
            } else if (
                payload.runtimeId
                && payload.sid === sessionId
                && isRuntimeLifecycle(payload.metadata, payload.runtimeId, 'archived')
            ) {
                sessionRuntimeActive = false
                socket.leave(`session:${payload.sid}`)
                sessionRpcController?.deactivate()
            }
        },
        onSessionMetadataUpdateAllowed: (payload) => sessionTransportConnected
            && (onSessionMetadataUpdateAllowed?.(payload) ?? true),
        onWebappEvent,
        onBackgroundTaskDelta,
        onSessionActivity,
        onSweepImmediateQueued,
        onMessagesConsumed
    })
    registerMachineHandlers(socket, {
        store,
        resolveMachineAccess,
        emitAccessError,
        onMachineAlive,
        onWebappEvent
    })
    registerTerminalHandlers(socket, {
        terminalRegistry,
        terminalNamespace,
        resolveSessionAccess,
        emitAccessError
    })

    socket.on('ping', (callback: () => void) => {
        callback()
    })

    socket.on('disconnect', () => {
        sessionTransportConnected = false
        sessionRuntimeOwned = false
        sessionRuntimeActive = false
        sessionRpcController?.deactivate()
        rpcRegistry.unregisterAll(socket)
        cleanupTerminalHandlers(socket, { terminalRegistry, terminalNamespace })
    })
}
