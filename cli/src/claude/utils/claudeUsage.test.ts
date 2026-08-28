import { describe, expect, it } from 'vitest'
import { parseClaudeUsageResponse } from './claudeUsage'

describe('parseClaudeUsageResponse', () => {
    it('maps five-hour and weekly utilization to remaining percentages and reset times', () => {
        const now = Date.parse('2026-08-28T00:00:00.000Z')
        const status = parseClaudeUsageResponse({
            five_hour: {
                utilization: 32,
                resets_at: '2026-08-28T03:59:59.87318+08:00'
            },
            seven_day: {
                utilization: 6,
                resets_at: '2026-09-03T02:59:59.8732+08:00'
            }
        }, now)

        expect(status).toEqual({
            provider: 'claude',
            accountLabel: 'Claude',
            window: {
                remainingPercent: 68,
                resetAt: Date.parse('2026-08-28T03:59:59.87318+08:00'),
                remainingMs: 0
            },
            weekly: {
                remainingPercent: 94,
                resetAt: Date.parse('2026-09-03T02:59:59.8732+08:00'),
                remainingMs: Date.parse('2026-09-03T02:59:59.8732+08:00') - now
            },
            updatedAt: now
        })
    })

    it('accepts decimal percentage utilization and numeric Unix reset timestamps', () => {
        const now = 1_787_840_000_000
        const status = parseClaudeUsageResponse({
            five_hour: { utilization: 0.25, resets_at: 1_787_842_800 },
            seven_day: { utilization: 1, resets_at: null }
        }, now)

        expect(status?.window).toEqual({
            remainingPercent: 99.75,
            resetAt: 1_787_842_800_000,
            remainingMs: 2_800_000
        })
        expect(status?.weekly).toEqual({ remainingPercent: 99 })
    })

    it('ignores malformed or empty responses', () => {
        expect(parseClaudeUsageResponse(null)).toBeNull()
        expect(parseClaudeUsageResponse({ five_hour: { utilization: '32' } })).toBeNull()
        expect(parseClaudeUsageResponse({ limits: [] })).toBeNull()
    })
})
