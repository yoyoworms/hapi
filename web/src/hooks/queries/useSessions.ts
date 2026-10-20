import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export type UseSessionsOptions = {
    enabled?: boolean
}

// Session summaries are kept current by the global SSE stream, which patches
// the React Query cache as lifecycle events arrive.  The REST query is mainly
// a cold-start and recovery path.  A longer freshness window prevents every
// route remount (there are several observers on a session page) from issuing
// another full /api/sessions request while still allowing explicit refetches
// and SSE invalidations to recover missed events.
export const SESSION_LIST_STALE_TIME_MS = 15_000

export function useSessions(api: ApiClient | null, options: UseSessionsOptions = {}): {
    sessions: SessionSummary[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.sessions,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getSessions()
        },
        enabled: Boolean(api) && (options.enabled ?? true),
        staleTime: SESSION_LIST_STALE_TIME_MS,
        refetchOnReconnect: false,
    })

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
        refetch: query.refetch,
    }
}
