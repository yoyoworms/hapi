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

export function registerCodexModelHandlers(rpcHandlerManager: RpcHandlerManager, machineScoped = false): void {
    rpcHandlerManager.registerHandler<ListCodexModelsRequest, ListCodexModelsResponse>(RPC_METHODS.ListCodexModels, async (data) => {
        logger.debug('List Codex models request');

        try {
            let environment: Record<string, string> | undefined;
            if (machineScoped || data?.accountId) {
                const account = await codexAccountManager.resolveAccount(data?.accountId);
                environment = {
                    CODEX_HOME: account.homeDir,
                    HAPI_CODEX_ACCOUNT_ID: account.id,
                    HAPI_CODEX_ACCOUNT_LABEL: account.label,
                    HAPI_CODEX_ACCOUNT_KIND: account.kind,
                    HAPI_CODEX_SOURCE_ACCOUNT_ID: '',
                    HAPI_CODEX_RESUME_PATH: '',
                    HAPI_CODEX_API_KEY: account.env?.HAPI_CODEX_API_KEY ?? ''
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
