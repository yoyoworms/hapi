import { describe, expect, it } from 'vitest'
import {
    formatAccountLimit,
    formatCompactContextUsageLabel,
    formatContextUsageLabel,
    formatUsageText,
    getContextWarning,
    getVisibleCodexPlanProgress,
    getContextUsageDetails,
    shouldShowCodexFastBadge
} from './StatusBar'

describe('account and session usage labels', () => {
    it('formats the remaining account quota and clamps invalid percentages', () => {
        expect(formatAccountLimit({ remainingPercent: 64 })).toBe('64%')
        expect(formatAccountLimit({ remainingMs: 3_600_000, remainingPercent: 120 })).toBe('100% (1h)')
        expect(formatAccountLimit({ remainingMs: 3_600_000 })).toBe('1h')
    })

    it('uses the absolute reset time instead of a stale reported duration', () => {
        const now = 1_800_000_000_000
        expect(formatAccountLimit({
            remainingMs: 6 * 3_600_000,
            remainingPercent: 64,
            resetAt: now + 2 * 3_600_000
        }, now)).toBe('64% (2h)')
    })

    it('prefers durable session totals and falls back to the latest transcript usage', () => {
        expect(formatUsageText({
            totalCostUsd: 0.25,
            totalInputTokens: 1_000,
            totalOutputTokens: 200
        }, null)?.text).toBe('$0.25 · 1k tok')

        expect(formatUsageText(null, {
            inputTokens: 100,
            outputTokens: 20,
            cacheCreation: 0,
            cacheRead: 2_000,
            contextSize: 2_100,
            contextWindow: 372_000,
            model: 'gpt-5.4',
            timestamp: 1
        })?.text).toBe('ctx 2k · 2k tok')
    })
})

describe('context warning colors', () => {
    it('keeps usage below 70% muted', () => {
        expect(getContextWarning(69, 100).color).toBe('text-[var(--app-hint)]')
    })

    it('shows a warning from 70% through below 90%', () => {
        expect(getContextWarning(70, 100).color).toBe('text-amber-500')
        expect(getContextWarning(89, 100).color).toBe('text-amber-500')
    })

    it('shows danger at 90% and above', () => {
        expect(getContextWarning(90, 100).color).toBe('text-red-500')
        expect(getContextWarning(95, 100).color).toBe('text-red-500')
    })
})

describe('context usage labels', () => {
    it('keeps the desktop label compact and expresses used capacity', () => {
        expect(formatContextUsageLabel(90_000, 258_000)).toBe('35% · 90k / 258k')
    })

    it('uses the compact parenthesized mobile label with a fixed English suffix', () => {
        expect(formatCompactContextUsageLabel(186_000, 262_000)).toBe('ctx 262k (29% left)')
    })

    it('orders cache, used, and remaining metrics for the desktop details', () => {
        expect(getContextUsageDetails(90_000, 258_000, 86_000)).toEqual({
            cacheRead: '86k',
            used: '90k',
            usedPercentage: 35,
            remaining: '168k',
            remainingPercentage: 65
        })
    })

    it('keeps external and detailed percentages complementary at rounding midpoints', () => {
        expect(formatContextUsageLabel(69, 200)).toBe('35% · 69 / 200')
        expect(formatCompactContextUsageLabel(69, 200)).toBe('ctx 200 (65% left)')
        expect(getContextUsageDetails(69, 200, 0)).toMatchObject({
            usedPercentage: 35,
            remainingPercentage: 65
        })
    })
})

describe('getVisibleCodexPlanProgress', () => {
    const progress = {
        explanation: null,
        steps: [{ step: 'Verify', status: 'in_progress' as const }],
        completed: 1,
        total: 2,
        currentStep: 'Verify',
        isComplete: false
    }

    it('shows current Codex progress only while the turn is active', () => {
        expect(getVisibleCodexPlanProgress('codex', progress, true)).toBe(progress)
        expect(getVisibleCodexPlanProgress('codex', progress, false)).toBeNull()
        expect(getVisibleCodexPlanProgress('claude', progress, true)).toBeNull()
    })
})

describe('shouldShowCodexFastBadge', () => {
    it('uses only the effective service tier', () => {
        expect(shouldShowCodexFastBadge('codex', undefined)).toBe(false)
        expect(shouldShowCodexFastBadge('codex', 'standard')).toBe(false)
        expect(shouldShowCodexFastBadge('codex', 'fast')).toBe(true)
        expect(shouldShowCodexFastBadge('codex', 'priority')).toBe(true)
        expect(shouldShowCodexFastBadge('claude', 'fast')).toBe(false)
    })
})
