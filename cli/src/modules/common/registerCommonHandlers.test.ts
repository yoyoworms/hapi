import { describe, expect, it } from 'vitest'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { registerCommonHandlers } from './registerCommonHandlers'

describe('registerCommonHandlers', () => {
    it('registers the agent session listing RPC', () => {
        const rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: 'session-1'
        })

        registerCommonHandlers(rpcHandlerManager, process.cwd())

        expect(rpcHandlerManager.hasHandler('list-agent-sessions')).toBe(true)
    })
})
