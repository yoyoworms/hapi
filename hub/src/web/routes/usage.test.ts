import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { createUsageRoutes } from './usage'
import type { SyncEngine } from '../../sync/syncEngine'

function createApp(store: Store, namespace: string, engine?: SyncEngine): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createUsageRoutes(store, engine ? () => engine : undefined))
    return app
}

describe('GET /api/usage/summary', () => {
    it('returns a no-store summary for the hub owner', async () => {
        const store = new Store(':memory:')
        try {
            const response = await createApp(store, 'default').request('/api/usage/summary?range=30d')

            expect(response.status).toBe(200)
            expect(response.headers.get('cache-control')).toBe('no-store')
            const body = await response.json() as { range: { from: number | null; to: number | null }; totals: { requests: number } }
            expect(typeof body.range.from).toBe('number')
            expect(typeof body.range.to).toBe('number')
            expect(body.totals.requests).toBe(0)
        } finally {
            store.close()
        }
    })

    it('rejects non-default namespaces', async () => {
        const store = new Store(':memory:')
        try {
            const response = await createApp(store, 'tenant').request('/api/usage/summary')

            expect(response.status).toBe(403)
            expect(await response.json()).toEqual({ error: 'Usage summary is only available to the hub owner' })
        } finally {
            store.close()
        }
    })

    it('validates IANA time zones', async () => {
        const store = new Store(':memory:')
        try {
            for (const timeZone of ['America/New_York', 'Asia/Shanghai']) {
                const response = await createApp(store, 'default').request(`/api/usage/summary?timeZone=${encodeURIComponent(timeZone)}`)
                expect(response.status).toBe(200)
            }
            for (const timeZone of ['Mars/Olympus', 'x'.repeat(101)]) {
                const response = await createApp(store, 'default').request(`/api/usage/summary?timeZone=${encodeURIComponent(timeZone)}`)
                expect(response.status).toBe(400)
            }
        } finally {
            store.close()
        }
    })
})

describe('GET /api/usage', () => {
    it('keeps live account quota caches isolated by namespace', async () => {
        const store = new Store(':memory:')
        const namespaces: string[] = []
        const engine = {
            getUsage: async (namespace: string) => {
                namespaces.push(namespace)
                return {
                    five_hour: null,
                    seven_day: null,
                    seven_day_opus: null,
                    seven_day_sonnet: null,
                    extra_usage: null,
                    subscriptionType: namespace
                }
            }
        } as Partial<SyncEngine> as SyncEngine
        try {
            const teamA = await createApp(store, 'usage-team-a', engine).request('/api/usage')
            const teamB = await createApp(store, 'usage-team-b', engine).request('/api/usage')
            expect(await teamA.json()).toMatchObject({ subscriptionType: 'usage-team-a' })
            expect(await teamB.json()).toMatchObject({ subscriptionType: 'usage-team-b' })
            expect(namespaces).toEqual(['usage-team-a', 'usage-team-b'])
        } finally {
            store.close()
        }
    })
})
