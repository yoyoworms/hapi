import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { ClaudeModelSummary } from '@/types/api'

type ClaudeModelsState = {
    availableModels: ClaudeModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
}

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { expiresAt: number; state: ClaudeModelsState }>()
const EMPTY_STATE: ClaudeModelsState = {
    availableModels: [],
    currentModelId: null,
    isLoading: false,
    error: null,
}

export function useClaudeModelsForMachine(args: {
    api: ApiClient | null
    machineId?: string | null
    enabled?: boolean
}): ClaudeModelsState & { refetch: () => void } {
    const { api, machineId } = args
    const enabled = Boolean(args.enabled && api && machineId)
    const cacheKey = machineId ?? 'unknown'
    const [state, setState] = useState<ClaudeModelsState>(() => {
        if (!enabled) return EMPTY_STATE
        const cached = cache.get(cacheKey)
        return cached && cached.expiresAt > Date.now() ? cached.state : { ...EMPTY_STATE, isLoading: true }
    })
    const [reloadToken, setReloadToken] = useState(0)

    const load = useCallback(async () => {
        if (!enabled || !api || !machineId) {
            setState(EMPTY_STATE)
            return
        }
        const cached = cache.get(cacheKey)
        if (cached && cached.expiresAt > Date.now()) {
            setState(cached.state)
            return
        }
        setState((current) => ({ ...current, isLoading: true, error: null }))
        try {
            const response = await api.getMachineClaudeModels(machineId)
            const next: ClaudeModelsState = {
                availableModels: response.availableModels ?? [],
                currentModelId: response.currentModelId ?? null,
                isLoading: false,
                error: response.success === false ? (response.error ?? 'Failed to load Claude models') : null,
            }
            cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, state: next })
            setState(next)
        } catch (error) {
            setState({
                availableModels: [],
                currentModelId: null,
                isLoading: false,
                error: error instanceof Error ? error.message : 'Failed to load Claude models',
            })
        }
    }, [api, cacheKey, enabled, machineId])

    useEffect(() => {
        void load()
    }, [load, reloadToken])

    return { ...state, refetch: () => setReloadToken((value) => value + 1) }
}
