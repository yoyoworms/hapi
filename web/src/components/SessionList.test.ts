import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { deduplicateSessionsByAgentId, expandSelectedSessionCollapseOverrides, getRecentSessions, getVisibleSessionPreview, normalizeSearch, RECENT_SESSIONS_WINDOW_MS, sessionMatchesQuery } from './SessionList'

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

describe('deduplicateSessionsByAgentId', () => {
    it('deduplicates sessions with the same agentSessionId', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 })
        ]
        const result = deduplicateSessionsByAgentId(sessions)
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('b') // more recent wins
    })

    it('keeps active session over inactive duplicate', () => {
        const sessions = [
            makeSession({ id: 'a', active: true, metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 })
        ]
        const result = deduplicateSessionsByAgentId(sessions)
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('a') // active wins despite older updatedAt
    })

    it('prefers selected session among inactive duplicates', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 })
        ]
        const result = deduplicateSessionsByAgentId(sessions, 'a')
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('a') // selected wins despite older updatedAt
    })

    it('active always wins over selected inactive', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 }),
            makeSession({ id: 'b', active: true, metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 })
        ]
        const result = deduplicateSessionsByAgentId(sessions, 'a')
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('b') // active wins over selected
    })

    it('passes through sessions without agentSessionId', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p' } }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' } }),
            makeSession({ id: 'c', metadata: null })
        ]
        const result = deduplicateSessionsByAgentId(sessions)
        expect(result).toHaveLength(3)
    })

    it('deduplicates independently across different agentSessionIds', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 }),
            makeSession({ id: 'c', metadata: { path: '/p', agentSessionId: 'thread-2' }, updatedAt: 100 }),
            makeSession({ id: 'd', metadata: { path: '/p', agentSessionId: 'thread-2' }, updatedAt: 200 })
        ]
        const result = deduplicateSessionsByAgentId(sessions)
        expect(result).toHaveLength(2)
        expect(result.map(s => s.id).sort()).toEqual(['b', 'd'])
    })
})

describe('getRecentSessions', () => {
    const now = 1_000_000_000_000
    const oneHour = 60 * 60 * 1000

    it('keeps sessions updated within the 12h window', () => {
        const sessions = [
            makeSession({ id: 'within', updatedAt: now - 6 * oneHour }),
            makeSession({ id: 'outside', updatedAt: now - 13 * oneHour })
        ]
        const result = getRecentSessions(sessions, now)
        expect(result.map(s => s.id)).toEqual(['within'])
    })

    it('orders active sessions ahead of inactive within window, by recency', () => {
        const sessions = [
            makeSession({ id: 'idle-fresh', updatedAt: now - 1 * oneHour }),
            makeSession({ id: 'active-old', active: true, updatedAt: now - 5 * oneHour }),
            makeSession({ id: 'pending', active: true, pendingRequestsCount: 1, updatedAt: now - 8 * oneHour })
        ]
        const result = getRecentSessions(sessions, now)
        expect(result.map(s => s.id)).toEqual(['pending', 'active-old', 'idle-fresh'])
    })

    it('exposes RECENT_SESSIONS_WINDOW_MS as 12 hours', () => {
        expect(RECENT_SESSIONS_WINDOW_MS).toBe(12 * 60 * 60 * 1000)
    })

    it('dedupes by agentSessionId before sorting', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: now - 1 * oneHour }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: now - 2 * oneHour })
        ]
        const result = getRecentSessions(sessions, now)
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('a')
    })

    it('keeps pinned sessions even outside the 12h window', () => {
        const sessions = [
            makeSession({ id: 'pinned-old', updatedAt: now - 48 * oneHour }),
            makeSession({ id: 'fresh', updatedAt: now - 1 * oneHour }),
            makeSession({ id: 'stale', updatedAt: now - 36 * oneHour })
        ]
        const result = getRecentSessions(sessions, now, new Set(['pinned-old']))
        expect(result.map(s => s.id)).toEqual(['pinned-old', 'fresh'])
    })

    it('orders pinned sessions ahead of unpinned regardless of activity', () => {
        const sessions = [
            makeSession({ id: 'unpinned-active', active: true, pendingRequestsCount: 1, updatedAt: now - 1 * oneHour }),
            makeSession({ id: 'pinned-idle', updatedAt: now - 3 * oneHour })
        ]
        const result = getRecentSessions(sessions, now, new Set(['pinned-idle']))
        expect(result.map(s => s.id)).toEqual(['pinned-idle', 'unpinned-active'])
    })
})


describe('session list search helpers', () => {
    it('normalizes whitespace and case before filtering', () => {
        const session = makeSession({
            id: 'session-1',
            metadata: {
                path: '/work/hapi',
                name: 'Fix Bot Review',
                flavor: 'codex',
                machineId: 'machine-1'
            }
        })

        expect(normalizeSearch('  BOT  ')).toBe('bot')
        expect(sessionMatchesQuery(session, normalizeSearch('bot review'), 'desktop')).toBe(true)
        expect(sessionMatchesQuery(session, normalizeSearch('desktop'), 'desktop')).toBe(true)
        expect(sessionMatchesQuery(session, normalizeSearch('missing'), 'desktop')).toBe(false)
    })
})

describe('getVisibleSessionPreview', () => {
    it('keeps selected and pending sessions inside the collapsed preview without promoting them', () => {
        const sessions = Array.from({ length: 6 }, (_, index) => makeSession({
            id: `s-${index + 1}`,
            pendingRequestsCount: index === 4 ? 1 : 0,
            metadata: { path: '/work/hapi' },
            updatedAt: 100 - index
        }))

        const preview = getVisibleSessionPreview(sessions, {
            selectedSessionId: 's-6',
            limit: 3
        })

        expect(preview.map(session => session.id)).toEqual(['s-1', 's-5', 's-6'])
    })

    it('does not exceed the limit just because many sessions are active', () => {
        const sessions = Array.from({ length: 6 }, (_, index) => makeSession({
            id: `s-${index + 1}`,
            active: true,
            metadata: { path: '/work/hapi' },
            updatedAt: 100 - index
        }))

        const preview = getVisibleSessionPreview(sessions, { limit: 4 })

        expect(preview.map(session => session.id)).toEqual(['s-1', 's-2', 's-3', 's-4'])
    })

    it('does not move an already-visible selected session to the top', () => {
        const sessions = Array.from({ length: 6 }, (_, index) => makeSession({
            id: `s-${index + 1}`,
            metadata: { path: '/work/hapi' },
            updatedAt: 100 - index
        }))

        const preview = getVisibleSessionPreview(sessions, {
            selectedSessionId: 's-3',
            limit: 4
        })

        expect(preview.map(session => session.id)).toEqual(['s-1', 's-2', 's-3', 's-4'])
    })

    it('returns all sessions when expanded', () => {
        const sessions = Array.from({ length: 4 }, (_, index) => makeSession({
            id: `s-${index + 1}`,
            metadata: { path: '/work/hapi' }
        }))

        expect(getVisibleSessionPreview(sessions, { expanded: true, limit: 2 })).toHaveLength(4)
    })
})


describe('expandSelectedSessionCollapseOverrides', () => {
    it('expands collapsed project and machine, but preserves session preview folding', () => {
        const overrides = new Map<string, boolean>([
            ['machine-1::/work/hapi', true],
            ['sessions::machine-1::/work/hapi', true],
            ['machine::machine-1', true]
        ])

        const result = expandSelectedSessionCollapseOverrides(overrides, {
            key: 'machine-1::/work/hapi',
            machineId: 'machine-1'
        })

        expect(result.has('machine-1::/work/hapi')).toBe(false)
        expect(result.get('sessions::machine-1::/work/hapi')).toBe(true)
        expect(result.has('machine::machine-1')).toBe(false)
    })

    it('leaves missing session preview override unset', () => {
        const overrides = new Map<string, boolean>()

        const result = expandSelectedSessionCollapseOverrides(overrides, {
            key: 'machine-1::/work/hapi',
            machineId: 'machine-1'
        })

        expect(result.has('sessions::machine-1::/work/hapi')).toBe(false)
    })
})
