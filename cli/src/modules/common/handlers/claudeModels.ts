import { logger } from '@/ui/logger'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { listClaudeModelsForMachine } from '../claudeModels'
import { getErrorMessage, rpcError } from '../rpcResponses'

export function registerClaudeModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler(RPC_METHODS.ListClaudeModelsForMachine, async () => {
        try {
            return await listClaudeModelsForMachine()
        } catch (error) {
            logger.debug('Failed to list Claude models:', error)
            return rpcError(getErrorMessage(error, 'Failed to list Claude models'))
        }
    })
}
