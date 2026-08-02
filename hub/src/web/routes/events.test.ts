import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SSEManager } from '../../sse/sseManager'
import type { SyncEngine } from '../../sync/syncEngine'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import type { WebAppEnv } from '../middleware/auth'
import { createEventsRoutes } from './events'

const SID = 'shared-session'

function fakeEngine(): SyncEngine {
    return {
        resolveSessionAccess: (sessionId: string, namespace: string) => ({
            ok: true,
            sessionId,
            session: { id: sessionId, namespace }
        })
    } as unknown as SyncEngine
}

function scopedApp(options: {
    manager?: SSEManager
    tracker?: VisibilityTracker
} = {}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const tracker = options.tracker ?? new VisibilityTracker()
    const manager = options.manager ?? ({ subscribe: () => {}, unsubscribe: () => {} } as unknown as SSEManager)
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        c.set('sessionScope', SID)
        await next()
    })
    app.route('/', createEventsRoutes(() => manager, () => fakeEngine(), () => tracker))
    return app
}

describe('share-scoped SSE routes', () => {
    it.each([
        ['/events?all=true', 'namespace-wide subscriptions'],
        ['/events?machineId=machine-a', 'machine subscriptions'],
        ['/events?sessionId=other-session', 'another session'],
    ] as const)('rejects %s (%s)', async (path) => {
        const response = await scopedApp().request(path)
        expect(response.status).toBe(403)
    })

    it('forces a missing sessionId to the JWT session scope', async () => {
        const subscriptions: Array<{
            all?: boolean
            sessionId?: string | null
            machineId?: string | null
        }> = []
        const manager = {
            subscribe: (options: typeof subscriptions[number]) => {
                subscriptions.push(options)
            },
            unsubscribe: () => {}
        } as unknown as SSEManager
        const controller = new AbortController()
        const response = await scopedApp({ manager }).request('/events', {
            signal: controller.signal
        })
        const reader = response.body?.getReader()
        await reader?.read()

        const subscribed = subscriptions[0]
        expect(subscribed).not.toBeNull()
        expect(subscribed?.all).toBe(false)
        expect(subscribed?.sessionId).toBe(SID)
        expect(subscribed?.machineId).toBeNull()

        controller.abort()
        await reader?.cancel().catch(() => {})
    })

    it('cannot change visibility for a global or different-session subscription', async () => {
        const tracker = new VisibilityTracker()
        tracker.registerConnection('global', 'default', 'hidden')
        tracker.registerConnection('other', 'default', 'hidden', 'other-session')
        tracker.registerConnection('own', 'default', 'hidden', SID)
        const app = scopedApp({ tracker })

        const update = (subscriptionId: string) => app.request('/visibility', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ subscriptionId, visibility: 'visible' })
        })

        expect((await update('global')).status).toBe(404)
        expect((await update('other')).status).toBe(404)
        expect((await update('own')).status).toBe(200)
        expect(tracker.isVisibleConnection('global')).toBe(false)
        expect(tracker.isVisibleConnection('other')).toBe(false)
        expect(tracker.isVisibleConnection('own')).toBe(true)
    })
})
