import { describe, expect, it } from 'bun:test'
import { Store } from '../../../store'
import { RpcRegistry } from '../../rpcRegistry'
import { TerminalRegistry } from '../../terminalRegistry'
import type { CliSocketWithData, SocketServer } from '../../socketTypes'
import { registerCliHandlers } from './index'

type Handler = (...args: unknown[]) => void

class FakeNamespace {
    readonly sockets = new Map<string, FakeSocket>()
    readonly adapter = { rooms: new Map<string, Set<string>>() }
}

class FakeSocket {
    readonly data: Record<string, unknown>
    readonly handshake: { auth: Record<string, unknown> }
    readonly joinedRooms = new Set<string>()
    disconnected = false
    private readonly handlers = new Map<string, Handler>()

    constructor(
        readonly id: string,
        private readonly namespace: FakeNamespace,
        options: {
            sessionId: string
            runtimeId?: string
            runtimeGeneration?: number
            clockOffset?: number
        }
    ) {
        this.data = {
            namespace: 'default',
            ...(options.runtimeId ? { runtimeId: options.runtimeId } : {}),
            ...(options.runtimeGeneration !== undefined
                ? { runtimeGeneration: options.runtimeGeneration }
                : {}),
            ...(options.clockOffset !== undefined
                ? { clockOffset: options.clockOffset }
                : {})
        }
        this.handshake = { auth: { sessionId: options.sessionId } }
        namespace.sockets.set(id, this)
    }

    on(event: string, handler: Handler): this {
        this.handlers.set(event, handler)
        return this
    }

    emit(): boolean {
        return true
    }

    to(): { emit: () => void } {
        return { emit: () => {} }
    }

    join(room: string): void {
        this.joinedRooms.add(room)
        const ids = this.namespace.adapter.rooms.get(room) ?? new Set<string>()
        ids.add(this.id)
        this.namespace.adapter.rooms.set(room, ids)
    }

    leave(room: string): void {
        this.joinedRooms.delete(room)
        const ids = this.namespace.adapter.rooms.get(room)
        ids?.delete(this.id)
        if (ids?.size === 0) {
            this.namespace.adapter.rooms.delete(room)
        }
    }

    disconnect(): this {
        if (this.disconnected) {
            return this
        }
        this.disconnected = true
        for (const room of [...this.joinedRooms]) {
            this.leave(room)
        }
        this.namespace.sockets.delete(this.id)
        this.handlers.get('disconnect')?.('server namespace disconnect')
        return this
    }

    trigger(event: string, ...args: unknown[]): void {
        this.handlers.get(event)?.(...args)
    }
}

class FakeIo {
    readonly cli = new FakeNamespace()
    readonly terminal = new FakeNamespace()

    of(name: string): FakeNamespace {
        return name === '/cli' ? this.cli : this.terminal
    }
}

function register(
    socket: FakeSocket,
    io: FakeIo,
    store: Store,
    rpcRegistry: RpcRegistry,
    onSessionAlive?: (payload: {
        sid: string
        time: number
        thinking?: boolean
        runtimeId?: string
        runtimeGeneration?: number
        clockOffset?: number
    }) => boolean,
    onSessionEnd?: (payload: {
        sid: string
        time: number
        runtimeId?: string
        runtimeGeneration?: number
        clockOffset?: number
    }) => boolean,
    onSessionMetadataUpdateAllowed?: (payload: {
        sid: string
        metadata: unknown
        runtimeId: string
        runtimeGeneration: number
        clockOffset?: number
    }) => boolean
): void {
    registerCliHandlers(socket as unknown as CliSocketWithData, {
        io: io as unknown as SocketServer,
        store,
        rpcRegistry,
        terminalRegistry: new TerminalRegistry({ idleTimeoutMs: 0 }),
        onSessionAlive,
        onSessionEnd,
        onSessionMetadataUpdateAllowed
    })
}

describe('cli session runtime rooms', () => {
    it('keeps a legacy socket out of the room and RPC registry for a running modern owner', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'runtime-room-existing-owner',
            {
                lifecycleState: 'running',
                lifecycleStateSince: Date.now(),
                runtimeId: 'runtime-current'
            },
            null,
            'default'
        )
        const io = new FakeIo()
        const rpcRegistry = new RpcRegistry()
        expect(store.sessions.setSessionActive(session.id, true, Date.now(), session.namespace)).toBe(true)
        const legacy = new FakeSocket('legacy', io.cli, { sessionId: session.id })

        register(legacy, io, store, rpcRegistry)
        legacy.trigger('rpc-register', { method: `${session.id}:sendMessage` })

        expect(legacy.disconnected).toBe(false)
        expect(io.cli.adapter.rooms.get(`session:${session.id}`)).toBeUndefined()
        expect(rpcRegistry.getSocketIdForMethod(`${session.id}:sendMessage`)).toBeNull()
    })

    it('replaces an overlapping socket from the same durable runtime immediately', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'runtime-room-reconnect-overlap',
            { runtimeId: 'runtime-owner', lifecycleState: 'running' },
            null,
            'default'
        )
        expect(store.sessions.setSessionActive(session.id, true, Date.now(), session.namespace)).toBe(true)
        const io = new FakeIo()
        const room = `session:${session.id}`
        const previous = new FakeSocket('previous', io.cli, {
            sessionId: session.id,
            runtimeId: 'runtime-owner',
            runtimeGeneration: 1
        })
        const rpcRegistry = new RpcRegistry()
        register(previous, io, store, rpcRegistry)
        const reconnect = new FakeSocket('reconnect', io.cli, {
            sessionId: session.id,
            runtimeId: 'runtime-owner',
            runtimeGeneration: 1
        })

        register(reconnect, io, store, rpcRegistry)

        expect(previous.disconnected).toBe(true)
        expect(reconnect.disconnected).toBe(false)
        expect(io.cli.adapter.rooms.get(room)).toEqual(new Set(['reconnect']))

        let lateMessageAcked = false
        previous.trigger('message', {
            sid: session.id,
            message: {
                role: 'agent',
                content: { type: 'text', data: 'late duplicate' }
            }
        }, () => {
            lateMessageAcked = true
        })
        previous.trigger('session-alive', {
            sid: session.id,
            time: Date.now(),
            thinking: true
        })

        expect(lateMessageAcked).toBe(true)
        expect(store.messages.getMessages(session.id)).toEqual([])
        expect(previous.disconnected).toBe(true)
        expect(io.cli.adapter.rooms.get(room)).toEqual(new Set(['reconnect']))
    })

    it('accepts buffered output from the exact running owner before reconnect alive', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'runtime-room-inactive-reconnect-buffer',
            { runtimeId: 'runtime-owner', lifecycleState: 'running' },
            null,
            'default'
        )
        const io = new FakeIo()
        const owner = new FakeSocket('owner', io.cli, {
            sessionId: session.id,
            runtimeId: 'runtime-owner',
            runtimeGeneration: 1
        })

        // Simulates liveness expiry while the CLI transport was offline. On
        // reconnect, Socket.IO flushes buffered messages before `connect` emits
        // the next session-alive packet.
        expect(store.sessions.getSession(session.id)?.active).toBe(false)
        register(owner, io, store, new RpcRegistry(), () => true)
        owner.trigger('message', {
            sid: session.id,
            message: {
                role: 'agent',
                content: { type: 'text', data: 'buffered completion' }
            }
        }, () => {})

        expect(io.cli.adapter.rooms.get(`session:${session.id}`)).toEqual(new Set(['owner']))
        expect(store.messages.getMessages(session.id)).toHaveLength(1)
    })

    it('activates only the modern socket after its runtime claim is accepted', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'runtime-room-claim',
            { lifecycleState: 'running', lifecycleStateSince: Date.now() },
            null,
            'default'
        )
        const io = new FakeIo()
        const rpcRegistry = new RpcRegistry()
        const room = `session:${session.id}`
        const legacy = new FakeSocket('legacy', io.cli, { sessionId: session.id })
        const owner = new FakeSocket('owner', io.cli, {
            sessionId: session.id,
            runtimeId: 'runtime-owner',
            runtimeGeneration: 2
        })

        register(legacy, io, store, rpcRegistry)
        legacy.trigger('rpc-register', { method: `${session.id}:sendMessage` })
        register(owner, io, store, rpcRegistry, () => true)
        owner.trigger('rpc-register', { method: `${session.id}:sendMessage` })

        expect(io.cli.adapter.rooms.get(room)).toBeUndefined()
        legacy.trigger('session-alive', {
            sid: session.id,
            time: Date.now() - 1,
            thinking: false
        })
        expect(io.cli.adapter.rooms.get(room)).toEqual(new Set(['legacy']))
        owner.trigger('session-alive', {
            sid: session.id,
            time: Date.now(),
            thinking: true
        })

        expect(legacy.disconnected).toBe(true)
        expect(owner.disconnected).toBe(false)
        expect(io.cli.adapter.rooms.get(room)).toEqual(new Set(['owner']))
        expect(rpcRegistry.getSocketIdForMethod(`${session.id}:sendMessage`)).toBe('owner')
    })

    it('keeps exactly one pure-legacy socket active after alive claims', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'runtime-room-pure-legacy',
            {},
            null,
            'default'
        )
        const io = new FakeIo()
        const rpcRegistry = new RpcRegistry()
        const method = `${session.id}:sendMessage`
        const first = new FakeSocket('legacy-first', io.cli, { sessionId: session.id })
        const second = new FakeSocket('legacy-second', io.cli, { sessionId: session.id })

        register(first, io, store, rpcRegistry, () => true)
        register(second, io, store, rpcRegistry, () => true)
        first.trigger('rpc-register', { method })
        second.trigger('rpc-register', { method })
        expect(io.cli.adapter.rooms.get(`session:${session.id}`)).toBeUndefined()
        expect(rpcRegistry.getSocketIdForMethod(method)).toBeNull()

        first.trigger('session-alive', { sid: session.id, time: Date.now() })
        expect(io.cli.adapter.rooms.get(`session:${session.id}`)).toEqual(new Set(['legacy-first']))
        expect(rpcRegistry.getSocketIdForMethod(method)).toBe('legacy-first')

        second.trigger('session-alive', { sid: session.id, time: Date.now() + 1 })
        expect(first.disconnected).toBe(true)
        expect(second.disconnected).toBe(false)
        expect(io.cli.adapter.rooms.get(`session:${session.id}`)).toEqual(new Set(['legacy-second']))
        expect(rpcRegistry.getSocketIdForMethod(method)).toBe('legacy-second')
    })

    it('lets a new runtime claim an inactive row instead of fencing legitimate resume', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'runtime-room-inactive-resume',
            {
                lifecycleState: 'running',
                lifecycleStateSince: 100,
                runtimeId: 'runtime-ended'
            },
            null,
            'default'
        )
        const io = new FakeIo()
        const next = new FakeSocket('next', io.cli, {
            sessionId: session.id,
            runtimeId: 'runtime-next',
            runtimeGeneration: 2
        })

        register(next, io, store, new RpcRegistry())
        expect(next.disconnected).toBe(false)
        expect(io.cli.adapter.rooms.get(`session:${session.id}`)).toBeUndefined()

        let ack: unknown = null
        next.trigger('update-metadata', {
            sid: session.id,
            expectedVersion: session.metadataVersion,
            metadata: {
                lifecycleState: 'running',
                lifecycleStateSince: 200
            }
        }, (response: unknown) => {
            ack = response
        })

        expect(ack).toEqual(expect.objectContaining({ result: 'success' }))
        expect(store.sessions.getSession(session.id)?.metadata).toEqual(expect.objectContaining({
            runtimeId: 'runtime-next',
            lifecycleStateSince: 200
        }))
        expect(io.cli.adapter.rooms.get(`session:${session.id}`)).toEqual(new Set(['next']))
    })

    it('forwards the bounded clock offset with a replacement metadata claim', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'runtime-room-clock-offset',
            {
                lifecycleState: 'archived',
                lifecycleStateSince: 10_000,
                runtimeId: 'runtime-ended'
            },
            null,
            'default'
        )
        const io = new FakeIo()
        const next = new FakeSocket('next-clock-offset', io.cli, {
            sessionId: session.id,
            runtimeId: 'runtime-next',
            runtimeGeneration: 2,
            // The CLI's local lifecycle timestamp is 2.6s behind Hub time.
            clockOffset: 2_600
        })
        let receivedOffset: number | undefined

        register(next, io, store, new RpcRegistry(), undefined, undefined, (payload) => {
            receivedOffset = payload.clockOffset
            return payload.clockOffset === 2_600
        })

        let ack: unknown = null
        next.trigger('update-metadata', {
            sid: session.id,
            expectedVersion: session.metadataVersion,
            metadata: {
                lifecycleState: 'running',
                // 7.5s + 2.6s = 10.1s, strictly newer than the durable 10s.
                lifecycleStateSince: 7_500
            }
        }, (response: unknown) => {
            ack = response
        })

        expect(receivedOffset).toBe(2_600)
        expect(ack).toEqual(expect.objectContaining({ result: 'success' }))
        expect(store.sessions.getSession(session.id)?.metadata).toEqual(expect.objectContaining({
            runtimeId: 'runtime-next',
            lifecycleState: 'running',
            lifecycleStateSince: 7_500
        }))
    })

    it('removes a socket from the prompt room when its alive claim is rejected', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'runtime-room-rejected',
            {},
            null,
            'default'
        )
        const io = new FakeIo()
        const socket = new FakeSocket('rejected', io.cli, {
            sessionId: session.id,
            runtimeId: 'runtime-rejected',
            runtimeGeneration: 1
        })
        const rpcRegistry = new RpcRegistry()

        register(socket, io, store, rpcRegistry, () => false)
        socket.trigger('rpc-register', { method: `${session.id}:sendMessage` })
        expect(io.cli.adapter.rooms.get(`session:${session.id}`)).toBeUndefined()
        expect(rpcRegistry.getSocketIdForMethod(`${session.id}:sendMessage`)).toBeNull()

        socket.trigger('session-alive', {
            sid: session.id,
            time: Date.now(),
            thinking: false
        })

        expect(io.cli.adapter.rooms.get(`session:${session.id}`)).toBeUndefined()
        expect(rpcRegistry.getSocketIdForMethod(`${session.id}:sendMessage`)).toBeNull()
    })

    it('rejects session-end from a pending socket that never owned the session', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'runtime-room-pending-end',
            { lifecycleState: 'running' },
            null,
            'default'
        )
        expect(store.sessions.setSessionActive(session.id, true, Date.now(), session.namespace)).toBe(true)
        const io = new FakeIo()
        const owner = new FakeSocket('legacy-owner', io.cli, { sessionId: session.id })
        const pending = new FakeSocket('pending', io.cli, {
            sessionId: session.id,
            runtimeId: 'runtime-pending',
            runtimeGeneration: 1
        })
        let pendingEndCalls = 0

        register(owner, io, store, new RpcRegistry(), () => true)
        owner.trigger('session-alive', { sid: session.id, time: Date.now() })
        register(pending, io, store, new RpcRegistry(), () => false, () => {
            pendingEndCalls += 1
            return true
        })

        pending.trigger('session-end', { sid: session.id, time: Date.now() + 1 })

        expect(pendingEndCalls).toBe(0)
        expect(owner.disconnected).toBe(false)
        expect(io.cli.adapter.rooms.get(`session:${session.id}`)).toEqual(new Set(['legacy-owner']))
    })

    it('rejects terminal metadata writes from pending sockets while another legacy owner is active', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'runtime-room-pending-legacy-metadata',
            { lifecycleState: 'running', lifecycleStateSince: 100 },
            null,
            'default'
        )
        expect(store.sessions.setSessionActive(session.id, true, Date.now(), session.namespace)).toBe(true)
        const io = new FakeIo()
        const owner = new FakeSocket('legacy-owner', io.cli, { sessionId: session.id })
        const pendingLegacy = new FakeSocket('legacy-pending', io.cli, { sessionId: session.id })
        const pendingModern = new FakeSocket('modern-pending', io.cli, {
            sessionId: session.id,
            runtimeId: 'runtime-pending',
            runtimeGeneration: 1
        })

        register(owner, io, store, new RpcRegistry(), () => true)
        owner.trigger('session-alive', { sid: session.id, time: Date.now() })
        register(pendingLegacy, io, store, new RpcRegistry(), () => false)
        register(pendingModern, io, store, new RpcRegistry(), () => false)

        const acks: unknown[] = []
        for (const pending of [pendingLegacy, pendingModern]) {
            pending.trigger('update-metadata', {
                sid: session.id,
                expectedVersion: session.metadataVersion,
                metadata: {
                    lifecycleState: 'archived',
                    lifecycleStateSince: 200
                }
            }, (response: unknown) => {
                acks.push(response)
            })
        }

        expect(acks).toHaveLength(2)
        for (const ack of acks) {
            expect(ack).toEqual(expect.objectContaining({
                result: 'success',
                metadata: expect.objectContaining({ lifecycleState: 'running' })
            }))
        }
        expect(store.sessions.getSession(session.id)?.metadata).toEqual(expect.objectContaining({
            lifecycleState: 'running',
            lifecycleStateSince: 100
        }))
        expect(owner.disconnected).toBe(false)
    })

    it('deactivates room and RPC ownership after an accepted session end', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'runtime-room-ended',
            { runtimeId: 'runtime-owner', lifecycleState: 'running' },
            null,
            'default'
        )
        expect(store.sessions.setSessionActive(session.id, true, Date.now(), session.namespace)).toBe(true)
        const io = new FakeIo()
        const rpcRegistry = new RpcRegistry()
        const owner = new FakeSocket('owner', io.cli, {
            sessionId: session.id,
            runtimeId: 'runtime-owner',
            runtimeGeneration: 1
        })

        let endCalls = 0
        register(owner, io, store, rpcRegistry, undefined, () => {
            endCalls += 1
            return true
        })
        owner.trigger('rpc-register', { method: `${session.id}:sendMessage` })
        expect(io.cli.adapter.rooms.get(`session:${session.id}`)).toEqual(new Set(['owner']))
        expect(rpcRegistry.getSocketIdForMethod(`${session.id}:sendMessage`)).toBe('owner')

        owner.trigger('update-metadata', {
            sid: session.id,
            expectedVersion: session.metadataVersion,
            metadata: {
                lifecycleState: 'archived',
                lifecycleStateSince: Date.now()
            }
        }, () => {})

        expect(io.cli.adapter.rooms.get(`session:${session.id}`)).toBeUndefined()
        expect(rpcRegistry.getSocketIdForMethod(`${session.id}:sendMessage`)).toBeNull()

        owner.trigger('session-end', { sid: session.id, time: Date.now() })

        expect(endCalls).toBe(1)
        expect(io.cli.adapter.rooms.get(`session:${session.id}`)).toBeUndefined()
        expect(rpcRegistry.getSocketIdForMethod(`${session.id}:sendMessage`)).toBeNull()
    })
})
