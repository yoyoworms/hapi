import type { AgentAccountLimit, AgentAccountStatus } from '@hapi/protocol/types'
import type { SDKMessage } from '@/claude/sdk'

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null
        ? value as Record<string, unknown>
        : null
}

function asFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeResetAt(value: unknown): number | null {
    const resetAt = asFiniteNumber(value)
    if (resetAt === null || resetAt <= 0) return null
    return resetAt < 1_000_000_000_000 ? Math.round(resetAt * 1000) : Math.round(resetAt)
}

function remainingPercent(status: unknown, utilization: unknown): number | null {
    if (status === 'rejected') return 0

    const used = asFiniteNumber(utilization)
    if (used === null) return null
    const usedPercent = used <= 1 ? used * 100 : used
    return Math.max(0, Math.min(100, 100 - usedPercent))
}

function classifyLimit(value: unknown): 'window' | 'weekly' | null {
    if (typeof value !== 'string') return null
    const normalized = value.toLowerCase().replace(/[\s-]/g, '_')
    if (normalized.includes('five_hour') || normalized.includes('5_hour') || normalized.includes('5h')) {
        return 'window'
    }
    if (normalized.includes('seven_day') || normalized.includes('7_day') || normalized.includes('7d') || normalized.includes('week')) {
        return 'weekly'
    }
    return null
}

export class ClaudeAccountStatusTracker {
    private window: AgentAccountLimit | null = null
    private weekly: AgentAccountLimit | null = null

    update(message: SDKMessage, now = Date.now()): AgentAccountStatus | null {
        if (message.type !== 'rate_limit_event') return null

        const info = asRecord(message.rate_limit_info ?? message.rateLimitInfo)
        if (!info) return null

        const status = info.status
        if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') {
            return null
        }

        const kind = classifyLimit(info.rateLimitType ?? info.rate_limit_type)
        if (!kind) return null

        const resetAt = normalizeResetAt(info.resetsAt ?? info.resets_at)
        const percent = remainingPercent(status, info.utilization)
        if (resetAt === null && percent === null) return null

        const previous = kind === 'window' ? this.window : this.weekly
        const limit: AgentAccountLimit = {
            ...previous,
            ...(resetAt !== null ? {
                resetAt,
                remainingMs: Math.max(0, resetAt - now)
            } : {}),
            ...(percent !== null ? { remainingPercent: percent } : {})
        }

        if (kind === 'window') {
            this.window = limit
        } else {
            this.weekly = limit
        }

        return {
            provider: 'claude',
            accountLabel: 'Claude',
            window: this.window,
            weekly: this.weekly,
            updatedAt: now
        }
    }
}
