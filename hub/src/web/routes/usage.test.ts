import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createUsageRoutes } from './usage'

describe('usage routes', () => {
    it('scopes usage cache by namespace', async () => {
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
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', c.req.header('x-namespace') ?? 'default')
            await next()
        })
        app.route('/api', createUsageRoutes(() => engine as SyncEngine))

        const responseA = await app.request('/api/usage', {
            headers: { 'x-namespace': 'team-a' }
        })
        const responseB = await app.request('/api/usage', {
            headers: { 'x-namespace': 'team-b' }
        })

        expect(responseA.status).toBe(200)
        expect(await responseA.json()).toMatchObject({ subscriptionType: 'team-a' })
        expect(responseB.status).toBe(200)
        expect(await responseB.json()).toMatchObject({ subscriptionType: 'team-b' })
        expect(namespaces).toEqual(['team-a', 'team-b'])
    })
})
