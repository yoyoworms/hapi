import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    CodexAccountLoginStartResponse,
    CodexAccountLoginStatusResponse,
    CodexAccountsResponse
} from '@hapi/protocol/apiTypes';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    registerCodexAccountHandlers,
    type CodexAccountRpcManager
} from './codexAccounts';

const accountsResponse: CodexAccountsResponse = {
    success: true,
    defaultAccountId: 'system',
    accounts: [{
        id: 'system',
        label: 'user@example.com',
        kind: 'system',
        isDefault: true,
        authenticated: true,
        planType: 'pro'
    }]
};

const loginStartResponse: CodexAccountLoginStartResponse = {
    success: true,
    attemptId: 'attempt-1',
    accountId: 'account-1',
    verificationUrl: 'https://example.com/device',
    userCode: 'ABCD-EFGH'
};

const loginStatusResponse: CodexAccountLoginStatusResponse = {
    success: true,
    status: 'pending'
};

function createAccountManager() {
    return {
        listAccounts: vi.fn(async () => accountsResponse),
        startLogin: vi.fn(async () => loginStartResponse),
        getLoginStatus: vi.fn(() => loginStatusResponse),
        addApiEndpoint: vi.fn(async () => accountsResponse),
        setDefaultAccount: vi.fn(async () => accountsResponse),
        removeAccount: vi.fn(async () => accountsResponse)
    } satisfies CodexAccountRpcManager;
}

async function callRpc(
    rpc: RpcHandlerManager,
    method: string,
    params: unknown = {}
): Promise<unknown> {
    const raw = await rpc.handleRequest({
        method: `machine-test:${method}`,
        params: JSON.stringify(params)
    });
    return JSON.parse(raw) as unknown;
}

describe('Codex account machine RPC handlers', () => {
    let rpc: RpcHandlerManager;
    let accountManager: ReturnType<typeof createAccountManager>;

    beforeEach(() => {
        rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' });
        accountManager = createAccountManager();
        registerCodexAccountHandlers(rpc, accountManager);
    });

    it('registers all account-management methods', () => {
        const methods = [
            RPC_METHODS.ListCodexAccounts,
            RPC_METHODS.StartCodexAccountLogin,
            RPC_METHODS.GetCodexAccountLoginStatus,
            RPC_METHODS.AddCodexApiEndpoint,
            RPC_METHODS.SetDefaultCodexAccount,
            RPC_METHODS.RemoveCodexAccount
        ];

        for (const method of methods) {
            expect(rpc.hasHandler(method), method).toBe(true);
        }
    });

    it('lists accounts through the injected manager', async () => {
        await expect(callRpc(rpc, RPC_METHODS.ListCodexAccounts)).resolves.toEqual(accountsResponse);
        expect(accountManager.listAccounts).toHaveBeenCalledOnce();
    });

    it('starts device login through the injected manager', async () => {
        await expect(callRpc(rpc, RPC_METHODS.StartCodexAccountLogin)).resolves.toEqual(loginStartResponse);
        expect(accountManager.startLogin).toHaveBeenCalledOnce();
    });

    it('validates and trims the login attempt id', async () => {
        await expect(callRpc(rpc, RPC_METHODS.GetCodexAccountLoginStatus, {
            attemptId: '  attempt-1  '
        })).resolves.toEqual(loginStatusResponse);
        expect(accountManager.getLoginStatus).toHaveBeenCalledWith('attempt-1');

        await expect(callRpc(rpc, RPC_METHODS.GetCodexAccountLoginStatus, {
            attemptId: '   '
        })).resolves.toEqual({
            success: false,
            status: 'not_found',
            error: 'Codex login attempt id is required'
        });
        expect(accountManager.getLoginStatus).toHaveBeenCalledOnce();
    });

    it('validates and forwards API endpoint fields', async () => {
        await expect(callRpc(rpc, RPC_METHODS.AddCodexApiEndpoint, {
            label: '  Company proxy  ',
            baseUrl: 'https://api.example.com/v1',
            apiKey: '  secret-key  ',
            model: '  company-model  '
        })).resolves.toEqual(accountsResponse);
        expect(accountManager.addApiEndpoint).toHaveBeenCalledWith({
            label: 'Company proxy',
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'secret-key',
            model: 'company-model'
        });

        const invalid = await callRpc(rpc, RPC_METHODS.AddCodexApiEndpoint, {
            label: 'Company proxy',
            baseUrl: 'ftp://api.example.com',
            apiKey: 'secret-key',
            model: 'company-model'
        });
        expect(invalid).toEqual({ error: 'Base URL must use http or https' });
        expect(accountManager.addApiEndpoint).toHaveBeenCalledOnce();
    });

    it('validates and forwards the default account id', async () => {
        await expect(callRpc(rpc, RPC_METHODS.SetDefaultCodexAccount, {
            accountId: '  account-1  '
        })).resolves.toEqual(accountsResponse);
        expect(accountManager.setDefaultAccount).toHaveBeenCalledWith('account-1');

        await expect(callRpc(rpc, RPC_METHODS.SetDefaultCodexAccount, {
            accountId: ''
        })).resolves.toEqual({ error: 'Codex account id is required' });
        expect(accountManager.setDefaultAccount).toHaveBeenCalledOnce();
    });

    it('validates and forwards the removed account id', async () => {
        await expect(callRpc(rpc, RPC_METHODS.RemoveCodexAccount, {
            accountId: '  account-1  '
        })).resolves.toEqual(accountsResponse);
        expect(accountManager.removeAccount).toHaveBeenCalledWith('account-1');

        await expect(callRpc(rpc, RPC_METHODS.RemoveCodexAccount, null)).resolves.toEqual({
            error: 'Codex account id is required'
        });
        expect(accountManager.removeAccount).toHaveBeenCalledOnce();
    });
});
