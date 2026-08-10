import { Hono } from 'hono'
import type { UsageSummaryResponse } from '@hapi/protocol/apiTypes'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'
import { getUsageSummary } from '../../sync/usageService'
import type { SyncEngine } from '../../sync/syncEngine'

export interface UsageData {
    five_hour: { utilization: number; resets_at: string } | null
    seven_day: { utilization: number; resets_at: string } | null
    seven_day_opus: { utilization: number; resets_at: string } | null
    seven_day_sonnet: { utilization: number; resets_at: string } | null
    extra_usage: {
        is_enabled: boolean
        monthly_limit: number | null
        used_credits: number | null
        utilization: number | null
    } | null
    subscriptionType?: string
    rateLimitTier?: string
    accountLabel?: string | null
}

type CachedUsageEntry = { data: UsageData; timestamp: number }
const cachedUsageByNamespace = new Map<string, CachedUsageEntry>()
const USAGE_CACHE_TTL_MS = 120_000

async function fetchOAuthUsage(
    getSyncEngine: (() => SyncEngine | null) | undefined,
    namespace: string
): Promise<UsageData | null> {
    const now = Date.now()
    const cached = cachedUsageByNamespace.get(namespace)
    if (cached && now - cached.timestamp < USAGE_CACHE_TTL_MS) return cached.data
    const engine = getSyncEngine?.()
    if (!engine) return cached?.data ?? null
    try {
        const data = await engine.getUsage(namespace) as UsageData | null
        if (data) cachedUsageByNamespace.set(namespace, { data, timestamp: now })
        return data ?? cached?.data ?? null
    } catch {
        return cached?.data ?? null
    }
}

export function createUsageRoutes(
    store: Store,
    getSyncEngine?: () => SyncEngine | null
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Live account/reset-window quota used by the composer status bar.
    app.get('/usage', async (c) => {
        const usage = await fetchOAuthUsage(getSyncEngine, c.get('namespace'))
        if (!usage) return c.json({ error: 'Unable to fetch usage data' }, 503)
        c.header('Cache-Control', 'no-store')
        return c.json(usage)
    })

    app.get('/usage/summary', (c) => {
        if (c.get('namespace') !== 'default') {
            return c.json({ error: 'Usage summary is only available to the hub owner' }, 403)
        }
        const range = c.req.query('range')
        const timeZone = c.req.query('timeZone') ?? 'UTC'
        if (timeZone.length > 100) {
            return c.json({ error: 'Invalid timeZone' }, 400)
        }
        try {
            new Intl.DateTimeFormat('en-US', { timeZone })
        } catch {
            return c.json({ error: 'Invalid timeZone' }, 400)
        }
        const response: UsageSummaryResponse = getUsageSummary(store, c.get('namespace'), range, timeZone)
        c.header('Cache-Control', 'no-store')
        return c.json(response)
    })

    return app
}
