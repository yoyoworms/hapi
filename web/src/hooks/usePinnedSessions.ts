import { useCallback, useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function getPinnedSessionIds(sessions: readonly SessionSummary[]): Set<string> {
    const pinned = new Set<string>()
    for (const session of sessions) {
        if (session.metadata && typeof (session.metadata as { pinnedAt?: number | null }).pinnedAt === 'number') {
            pinned.add(session.id)
        }
    }
    return pinned
}

export function usePinnedSessions(sessions: readonly SessionSummary[], api: ApiClient | null) {
    const queryClient = useQueryClient()

    const pinned = useMemo(() => getPinnedSessionIds(sessions), [sessions])

    const isPinned = useCallback(
        (sessionId: string) => pinned.has(sessionId),
        [pinned]
    )

    const pinMutation = useMutation({
        mutationFn: async ({ sessionId, pinned }: { sessionId: string; pinned: boolean }) => {
            if (!api) throw new Error('API unavailable')
            await api.pinSession(sessionId, pinned)
        },
        onSuccess: async (_, variables) => {
            await queryClient.invalidateQueries({ queryKey: queryKeys.session(variables.sessionId) })
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        }
    })

    const togglePin = useCallback(
        (sessionId: string) => {
            const next = !pinned.has(sessionId)
            pinMutation.mutate({ sessionId, pinned: next })
        },
        [pinned, pinMutation]
    )

    return { pinned, isPinned, togglePin }
}
