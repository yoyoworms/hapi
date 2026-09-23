import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { ClaudeModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useClaudeModelsForMachine(args: {
    api: ApiClient | null
    machineId?: string | null
    enabled?: boolean
}): {
    availableModels: ClaudeModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
    refetch: () => void
} {
    const { api, machineId } = args
    const enabled = Boolean(args.enabled && api && machineId)
    const query = useQuery({
        queryKey: machineId ? queryKeys.machineClaudeModels(machineId) : ['machine-claude-models', 'unknown'] as const,
        queryFn: async () => {
            if (!api || !machineId) throw new Error('Claude models target unavailable')
            return await api.getMachineClaudeModels(machineId)
        },
        enabled,
        staleTime: 60_000,
        retry: false,
    })
    return {
        availableModels: query.data?.availableModels ?? [],
        currentModelId: query.data?.currentModelId ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Claude models')
            : query.error instanceof Error ? query.error.message : query.error ? 'Failed to load Claude models' : null,
        refetch: () => { void query.refetch() },
    }
}
