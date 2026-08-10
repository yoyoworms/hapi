import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    listCodexModels,
    type ListCodexModelsRequest,
    type ListCodexModelsResponse
} from '../codexModels';
import { getErrorMessage, rpcError } from '../rpcResponses';
import { codexAccountManager } from '@/codex/codexAccountManager';

export function registerCodexModelHandlers(
    rpcHandlerManager: RpcHandlerManager,
    machineScoped: boolean = false
): void {
    rpcHandlerManager.registerHandler<ListCodexModelsRequest, ListCodexModelsResponse>(RPC_METHODS.ListCodexModels, async (data) => {
        logger.debug('List Codex models request');

        try {
            let environment: Record<string, string> | undefined;
            if (machineScoped || data?.accountId) {
                const account = await codexAccountManager.resolveAccount(data?.accountId);
                environment = {
                    CODEX_HOME: account.homeDir,
                    ...account.env
                };
            }
            const models = await listCodexModels(data?.includeHidden === true, environment);
            return { success: true, models };
        } catch (error) {
            logger.debug('Failed to list Codex models:', error);
            return rpcError(getErrorMessage(error, 'Failed to list Codex models'));
        }
    });
}
