import { z } from 'zod'
import type { RpcRegistry } from '../../rpcRegistry'
import type { CliSocketWithData } from '../../socketTypes'

const rpcRegisterSchema = z.object({
    method: z.string().min(1)
})

const rpcUnregisterSchema = z.object({
    method: z.string().min(1)
})

export function registerRpcHandlers(socket: CliSocketWithData, rpcRegistry: RpcRegistry): void {
    registerGatedRpcHandlers(socket, rpcRegistry, true)
}

export type RpcRegistrationController = {
    activate: () => void
    deactivate: () => void
}

/**
 * Register RPC method announcements without exposing them globally until the
 * session socket has proved runtime ownership. Socket.IO can deliver
 * `rpc-register` before the first alive packet, so announcements are retained
 * locally and replayed atomically when ownership is accepted.
 */
export function registerGatedRpcHandlers(
    socket: CliSocketWithData,
    rpcRegistry: RpcRegistry,
    initiallyActive: boolean
): RpcRegistrationController {
    const announcedMethods = new Set<string>()
    let active = initiallyActive

    socket.on('rpc-register', (data: unknown) => {
        const parsed = rpcRegisterSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        announcedMethods.add(parsed.data.method)
        if (active) {
            rpcRegistry.register(socket, parsed.data.method)
        }
    })

    socket.on('rpc-unregister', (data: unknown) => {
        const parsed = rpcUnregisterSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        announcedMethods.delete(parsed.data.method)
        if (active) {
            rpcRegistry.unregister(socket, parsed.data.method)
        }
    })

    return {
        activate: () => {
            if (active) {
                return
            }
            active = true
            for (const method of announcedMethods) {
                rpcRegistry.register(socket, method)
            }
        },
        deactivate: () => {
            if (!active) {
                return
            }
            active = false
            rpcRegistry.unregisterAll(socket)
        }
    }
}
