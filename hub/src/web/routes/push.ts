import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import type { PushPayload, PushService } from '../../push/pushService'
import type { SSEManager } from '../../sse/sseManager'

const subscriptionSchema = z.object({
    endpoint: z.string().min(1),
    keys: z.object({
        p256dh: z.string().min(1),
        auth: z.string().min(1)
    })
})

const unsubscribeSchema = z.object({
    endpoint: z.string().min(1)
})

const testNotificationSchema = z.object({
    title: z.string().min(1).max(120).optional(),
    body: z.string().min(1).max(500).optional(),
    sessionId: z.string().min(1).optional(),
    url: z.string().min(1).optional()
}).optional()

export function createPushRoutes(options: {
    store: Store
    vapidPublicKey: string
    pushService: PushService
    getSseManager: () => SSEManager | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/push/vapid-public-key', (c) => {
        return c.json({ publicKey: options.vapidPublicKey })
    })

    app.post('/push/subscribe', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = subscriptionSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const { endpoint, keys } = parsed.data
        options.store.push.addPushSubscription(namespace, {
            endpoint,
            p256dh: keys.p256dh,
            auth: keys.auth
        })

        return c.json({ ok: true })
    })

    app.delete('/push/subscribe', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = unsubscribeSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        options.store.push.removePushSubscription(namespace, parsed.data.endpoint)
        return c.json({ ok: true })
    })

    app.post('/push/test', async (c) => {
        const json = await c.req.json().catch(() => undefined)
        const parsed = testNotificationSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const body = parsed.data ?? {}
        const sessionId = body.sessionId ?? 'push-test'
        const url = body.url ?? '/sessions'
        const payload: PushPayload = {
            title: body.title ?? 'LXAPI Test Push',
            body: body.body ?? `Test notification ${new Date().toLocaleString()}`,
            tag: `push-test-${Date.now()}`,
            data: {
                type: 'ready',
                sessionId,
                url
            }
        }

        const sseDeliveries = await (options.getSseManager()?.sendToast(namespace, {
            type: 'toast',
            data: {
                title: payload.title,
                body: payload.body,
                sessionId,
                url
            }
        }) ?? Promise.resolve(0))

        void options.pushService.sendToNamespace(namespace, payload).catch((error) => {
            console.error('[push:test] Failed to send web push:', error)
        })

        return c.json({ ok: true, sseDeliveries })
    })

    return app
}
