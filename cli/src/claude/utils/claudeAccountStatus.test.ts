import { describe, expect, it } from 'vitest'
import { ClaudeAccountStatusTracker } from './claudeAccountStatus'

describe('ClaudeAccountStatusTracker', () => {
    it('publishes an allowed five-hour window even when utilization is absent', () => {
        const now = 1_787_840_000_000
        const tracker = new ClaudeAccountStatusTracker()

        expect(tracker.update({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'allowed',
                resetsAt: 1_787_842_800,
                rateLimitType: 'five_hour'
            }
        }, now)).toEqual({
            provider: 'claude',
            accountLabel: 'Claude',
            window: {
                resetAt: 1_787_842_800_000,
                remainingMs: 2_800_000
            },
            weekly: null,
            updatedAt: now
        })
    })

    it('merges five-hour and weekly limits and converts utilization to remaining percent', () => {
        const now = 1_787_840_000_000
        const tracker = new ClaudeAccountStatusTracker()

        tracker.update({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'allowed_warning',
                resetsAt: 1_787_842_800,
                utilization: 0.82,
                rateLimitType: 'five_hour'
            }
        }, now)

        expect(tracker.update({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'allowed',
                resetsAt: 1_788_444_800,
                utilization: 25,
                rateLimitType: 'seven_day'
            }
        }, now)).toEqual({
            provider: 'claude',
            accountLabel: 'Claude',
            window: expect.objectContaining({ remainingPercent: 18 }),
            weekly: {
                resetAt: 1_788_444_800_000,
                remainingMs: 604_800_000,
                remainingPercent: 75
            },
            updatedAt: now
        })
    })

    it('does not discard a known percentage when a later SDK event only has reset time', () => {
        const now = 1_787_840_000_000
        const tracker = new ClaudeAccountStatusTracker()

        tracker.update({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'allowed_warning',
                resetsAt: 1_787_842_800,
                utilization: 0.42,
                rateLimitType: 'five_hour'
            }
        }, now)

        const status = tracker.update({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'allowed',
                resetsAt: 1_787_843_000,
                rateLimitType: 'five_hour'
            }
        }, now)

        expect(status?.window).toEqual({
            remainingPercent: 58,
            resetAt: 1_787_843_000_000,
            remainingMs: 3_000_000
        })
    })

    it('reports a rejected limit as zero percent remaining', () => {
        const tracker = new ClaudeAccountStatusTracker()
        const status = tracker.update({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'rejected',
                resets_at: 1_787_842_800,
                rate_limit_type: '5h'
            }
        }, 1_787_840_000_000)

        expect(status?.window?.remainingPercent).toBe(0)
    })

    it('ignores unrelated and malformed events', () => {
        const tracker = new ClaudeAccountStatusTracker()
        expect(tracker.update({ type: 'assistant' })).toBeNull()
        expect(tracker.update({
            type: 'rate_limit_event',
            rate_limit_info: { status: 'allowed', rateLimitType: 'unknown' }
        })).toBeNull()
    })
})
