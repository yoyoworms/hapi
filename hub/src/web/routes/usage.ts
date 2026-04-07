import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
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
}

// Cache usage data to avoid rate limiting (endpoint allows ~5 requests per token)
let cachedUsage: UsageData | null = null
let cacheTimestamp = 0
const CACHE_TTL = 120_000 // 2 minutes

async function fetchUsageViaRpc(getSyncEngine: () => SyncEngine | null): Promise<UsageData | null> {
    const now = Date.now()
    if (cachedUsage && (now - cacheTimestamp) < CACHE_TTL) {
        return cachedUsage
    }

    const syncEngine = getSyncEngine()
    if (!syncEngine) return cachedUsage

    try {
        const data = await syncEngine.getUsage() as UsageData | null
        if (data) {
            cachedUsage = data
            cacheTimestamp = now
        }
        return data ?? cachedUsage
    } catch {
        return cachedUsage
    }
}

export function createUsageRoutes(getSyncEngine: () => SyncEngine | null) {
    const app = new Hono<WebAppEnv>()

    app.get('/usage', async (c) => {
        const usage = await fetchUsageViaRpc(getSyncEngine)
        if (!usage) {
            return c.json({ error: 'Unable to fetch usage data' }, 503)
        }
        return c.json(usage)
    })

    return app
}
