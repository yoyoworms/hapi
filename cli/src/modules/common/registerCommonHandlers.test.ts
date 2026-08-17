import { describe, expect, it } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { registerCommonHandlers } from './registerCommonHandlers'

const CODEX_ACCOUNT_METHODS = [
    RPC_METHODS.ListCodexAccounts,
    RPC_METHODS.StartCodexAccountLogin,
    RPC_METHODS.GetCodexAccountLoginStatus,
    RPC_METHODS.AddCodexApiEndpoint,
    RPC_METHODS.SetDefaultCodexAccount,
    RPC_METHODS.RemoveCodexAccount
] as const

describe('registerCommonHandlers', () => {
    it('registers the agent session listing RPC', () => {
        const rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: 'session-1'
        })

        registerCommonHandlers(rpcHandlerManager, process.cwd())

        expect(rpcHandlerManager.hasHandler('list-agent-sessions')).toBe(true)
        for (const method of CODEX_ACCOUNT_METHODS) {
            expect(rpcHandlerManager.hasHandler(method), method).toBe(false)
        }
    })

    it('registers Codex account RPCs only for an explicitly machine-scoped client', () => {
        const rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: 'machine-1'
        })

        registerCommonHandlers(rpcHandlerManager, process.cwd(), {
            codexAccountsMachineScoped: true
        })

        for (const method of CODEX_ACCOUNT_METHODS) {
            expect(rpcHandlerManager.hasHandler(method), method).toBe(true)
        }
    })
})
