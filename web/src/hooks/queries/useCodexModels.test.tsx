import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RPC_TARGET_MISSING_ERROR_CODE } from '@hapi/protocol/rpcMethods'
import { ApiError, type ApiClient } from '@/api/client'
import { useCodexModels } from './useCodexModels'

function wrapper(queryClient: QueryClient) {
    return ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

function createQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: { retry: false }
        }
    })
}

describe('useCodexModels query scoping', () => {
    it('returns an empty result without API access even if the owner catalog is cached', async () => {
        const getMachineCodexModels = vi.fn(async () => ({
            success: true,
            models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }]
        }))
        const getSessionCodexModels = vi.fn()
        const api = {
            getMachineCodexModels,
            getSessionCodexModels
        } as unknown as ApiClient
        const queryClient = createQueryClient()
        const sharedWrapper = wrapper(queryClient)

        const owner = renderHook(() => useCodexModels({
            api,
            sessionId: 'session-1',
            machineId: 'machine-1',
            enabled: true
        }), { wrapper: sharedWrapper })

        await waitFor(() => {
            expect(owner.result.current.models[0]?.id).toBe('gpt-5.5')
        })

        const viewer = renderHook(() => useCodexModels({
            api: null,
            sessionId: 'session-1',
            machineId: 'machine-1',
            enabled: false
        }), { wrapper: sharedWrapper })

        expect(viewer.result.current).toEqual({
            models: [],
            isLoading: false,
            error: null
        })
        expect(getMachineCodexModels).toHaveBeenCalledTimes(1)
        expect(getSessionCodexModels).not.toHaveBeenCalled()
    })

    it('shares machine-backed discovery across sessions on the same machine', async () => {
        const getMachineCodexModels = vi.fn(async () => ({
            success: true,
            models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }]
        }))
        const getSessionCodexModels = vi.fn()
        const api = {
            getMachineCodexModels,
            getSessionCodexModels
        } as unknown as ApiClient
        const queryClient = createQueryClient()
        const sharedWrapper = wrapper(queryClient)

        const first = renderHook(() => useCodexModels({
            api,
            sessionId: 'session-1',
            machineId: 'machine-1',
            enabled: true
        }), { wrapper: sharedWrapper })
        const second = renderHook(() => useCodexModels({
            api,
            sessionId: 'session-2',
            machineId: 'machine-1',
            enabled: true
        }), { wrapper: sharedWrapper })

        await waitFor(() => {
            expect(first.result.current.models[0]?.id).toBe('gpt-5.5')
            expect(second.result.current.models[0]?.id).toBe('gpt-5.5')
        })
        expect(getMachineCodexModels).toHaveBeenCalledTimes(1)
        expect(getSessionCodexModels).not.toHaveBeenCalled()
    })


    it('isolates machine discovery by selected Codex account', async () => {
        const getMachineCodexModels = vi.fn(async (_machineId: string, accountId?: string | null) => ({
            success: true,
            models: [{ id: accountId ?? 'default', displayName: accountId ?? 'default', isDefault: true }]
        }))
        const api = {
            getMachineCodexModels,
            getSessionCodexModels: vi.fn()
        } as unknown as ApiClient
        const queryClient = createQueryClient()
        const sharedWrapper = wrapper(queryClient)

        const managed = renderHook(() => useCodexModels({
            api,
            machineId: 'machine-1',
            accountId: 'managed-1',
            enabled: true
        }), { wrapper: sharedWrapper })
        const customApi = renderHook(() => useCodexModels({
            api,
            machineId: 'machine-1',
            accountId: 'api-1',
            enabled: true
        }), { wrapper: sharedWrapper })

        await waitFor(() => {
            expect(managed.result.current.models[0]?.id).toBe('managed-1')
            expect(customApi.result.current.models[0]?.id).toBe('api-1')
        })
        expect(getMachineCodexModels.mock.calls.map(([, accountId]) => accountId).sort()).toEqual([
            'api-1',
            'managed-1'
        ])
    })

    it('isolates session fallback catalogs after the machine target is missing', async () => {
        const getMachineCodexModels = vi.fn(async () => {
            throw new ApiError(
                'machine RPC unavailable',
                503,
                RPC_TARGET_MISSING_ERROR_CODE
            )
        })
        const getSessionCodexModels = vi.fn(async (sessionId: string) => ({
            success: true,
            models: [{ id: sessionId, displayName: sessionId, isDefault: true }]
        }))
        const api = {
            getMachineCodexModels,
            getSessionCodexModels
        } as unknown as ApiClient
        const queryClient = createQueryClient()
        const sharedWrapper = wrapper(queryClient)

        const first = renderHook(() => useCodexModels({
            api,
            sessionId: 'session-1',
            machineId: 'machine-1',
            enabled: true
        }), { wrapper: sharedWrapper })
        const second = renderHook(() => useCodexModels({
            api,
            sessionId: 'session-2',
            machineId: 'machine-1',
            enabled: true
        }), { wrapper: sharedWrapper })

        await waitFor(() => {
            expect(first.result.current.models[0]?.id).toBe('session-1')
            expect(second.result.current.models[0]?.id).toBe('session-2')
        })
        expect(getSessionCodexModels.mock.calls.map(([sessionId]) => sessionId).sort()).toEqual([
            'session-1',
            'session-2'
        ])
    })
})
