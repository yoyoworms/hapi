import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { getPinnedSessionIds } from './usePinnedSessions'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        model: null,
        effort: null,
        ...overrides
    }
}

describe('getPinnedSessionIds', () => {
    it('returns ids of sessions whose metadata.pinnedAt is a number', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', host: 'h', pinnedAt: 12345 } }),
            makeSession({ id: 'b', metadata: { path: '/p', host: 'h' } }),
            makeSession({ id: 'c', metadata: { path: '/p', host: 'h', pinnedAt: 99 } })
        ]
        const pinned = getPinnedSessionIds(sessions)
        expect([...pinned].sort()).toEqual(['a', 'c'])
    })

    it('ignores sessions with null metadata or non-numeric pinnedAt', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: null }),
            makeSession({ id: 'b', metadata: { path: '/p', host: 'h', pinnedAt: null } }),
            makeSession({ id: 'c', metadata: { path: '/p', host: 'h' } })
        ]
        const pinned = getPinnedSessionIds(sessions)
        expect(pinned.size).toBe(0)
    })

    it('returns empty set for empty input', () => {
        expect(getPinnedSessionIds([]).size).toBe(0)
    })
})
