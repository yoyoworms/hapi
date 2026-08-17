import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { codexAccountManager } from '@/codex/codexAccountManager';
import {
    AddCodexApiEndpointRequestSchema,
    CodexAccountLoginStartResponseSchema,
    CodexAccountLoginStatusResponseSchema,
    CodexAccountsResponseSchema,
    type AddCodexApiEndpointRequest,
    type CodexAccountLoginStartResponse,
    type CodexAccountLoginStatusResponse,
    type CodexAccountsResponse
} from '@hapi/protocol/apiTypes';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

export interface CodexAccountRpcManager {
    listAccounts(): Promise<CodexAccountsResponse>;
    startLogin(): Promise<CodexAccountLoginStartResponse>;
    getLoginStatus(attemptId: string): CodexAccountLoginStatusResponse;
    addApiEndpoint(input: AddCodexApiEndpointRequest): Promise<CodexAccountsResponse>;
    setDefaultAccount(accountId: string): Promise<CodexAccountsResponse>;
    removeAccount(accountId: string): Promise<CodexAccountsResponse>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function requiredStringParam(value: unknown, key: string, errorMessage: string): string {
    const candidate = asRecord(value)?.[key];
    if (typeof candidate !== 'string' || !candidate.trim()) {
        throw new Error(errorMessage);
    }
    return candidate.trim();
}

export function registerCodexAccountHandlers(
    rpcHandlerManager: RpcHandlerManager,
    accountManager: CodexAccountRpcManager = codexAccountManager
): void {
    rpcHandlerManager.registerHandler<unknown, CodexAccountsResponse>(
        RPC_METHODS.ListCodexAccounts,
        async () => CodexAccountsResponseSchema.parse(await accountManager.listAccounts())
    );

    rpcHandlerManager.registerHandler<unknown, CodexAccountLoginStartResponse>(
        RPC_METHODS.StartCodexAccountLogin,
        async () => CodexAccountLoginStartResponseSchema.parse(await accountManager.startLogin())
    );

    rpcHandlerManager.registerHandler<unknown, CodexAccountLoginStatusResponse>(
        RPC_METHODS.GetCodexAccountLoginStatus,
        async (params) => {
            let attemptId: string;
            try {
                attemptId = requiredStringParam(
                    params,
                    'attemptId',
                    'Codex login attempt id is required'
                );
            } catch (error) {
                return {
                    success: false,
                    status: 'not_found',
                    error: error instanceof Error
                        ? error.message
                        : 'Codex login attempt id is required'
                };
            }
            return CodexAccountLoginStatusResponseSchema.parse(
                accountManager.getLoginStatus(attemptId)
            );
        }
    );

    rpcHandlerManager.registerHandler<unknown, CodexAccountsResponse>(
        RPC_METHODS.AddCodexApiEndpoint,
        async (params) => {
            const parsed = AddCodexApiEndpointRequestSchema.safeParse(params);
            if (!parsed.success) {
                throw new Error(parsed.error.issues[0]?.message ?? 'Invalid Codex API endpoint');
            }
            return CodexAccountsResponseSchema.parse(
                await accountManager.addApiEndpoint(parsed.data)
            );
        }
    );

    rpcHandlerManager.registerHandler<unknown, CodexAccountsResponse>(
        RPC_METHODS.SetDefaultCodexAccount,
        async (params) => {
            const accountId = requiredStringParam(
                params,
                'accountId',
                'Codex account id is required'
            );
            return CodexAccountsResponseSchema.parse(
                await accountManager.setDefaultAccount(accountId)
            );
        }
    );

    rpcHandlerManager.registerHandler<unknown, CodexAccountsResponse>(
        RPC_METHODS.RemoveCodexAccount,
        async (params) => {
            const accountId = requiredStringParam(
                params,
                'accountId',
                'Codex account id is required'
            );
            return CodexAccountsResponseSchema.parse(
                await accountManager.removeAccount(accountId)
            );
        }
    );
}
