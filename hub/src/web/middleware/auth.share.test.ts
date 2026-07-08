import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { WebAppEnv } from './auth'
import { createAuthMiddleware } from './auth'
import type { Store } from '../../store'
import type { StoredShare } from '../../store/shareStore'

const JWT_SECRET = new TextEncoder().encode('test-secret')
const SID = 'session-abc'

function fakeStore(share: StoredShare | null): Store {
    return { shares: { getShareByToken: () => share } } as unknown as Store
}

function activeShare(overrides: Partial<StoredShare> = {}): StoredShare {
    return { token: 'tok', sessionId: SID, namespace: 'default', revoked: false, createdAt: 0, ...overrides }
}

async function scopedToken(overrides: Record<string, unknown> = {}): Promise<string> {
    return await new SignJWT({ uid: 1, ns: 'default', scope: 'session', sid: SID, share: 'tok', ...overrides })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(JWT_SECRET)
}

function appWith(share: StoredShare | null) {
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(JWT_SECRET, fakeStore(share)))
    // Echo route: 200 means the middleware let the request through.
    app.all('/api/*', (c) => c.json({ scope: c.get('sessionScope') ?? null }))
    return app
}

async function req(app: Hono<WebAppEnv>, method: string, path: string, token: string) {
    return await app.request(path, { method, headers: { authorization: `Bearer ${token}` } })
}

describe('share-scoped auth middleware', () => {
    it('allows reading and messaging the shared session', async () => {
        const app = appWith(activeShare())
        const token = await scopedToken()
        expect((await req(app, 'GET', `/api/sessions/${SID}`, token)).status).toBe(200)
        expect((await req(app, 'GET', `/api/sessions/${SID}/messages`, token)).status).toBe(200)
        expect((await req(app, 'POST', `/api/sessions/${SID}/messages`, token)).status).toBe(200)
        expect((await req(app, 'POST', `/api/sessions/${SID}/abort`, token)).status).toBe(200)
        expect((await req(app, 'GET', '/api/events', token)).status).toBe(200)
    })

    it('blocks other sessions and dangerous actions', async () => {
        const app = appWith(activeShare())
        const token = await scopedToken()
        // Another session entirely.
        expect((await req(app, 'GET', '/api/sessions/other', token)).status).toBe(403)
        // Dangerous actions on the shared session itself.
        expect((await req(app, 'POST', `/api/sessions/${SID}/archive`, token)).status).toBe(403)
        expect((await req(app, 'DELETE', `/api/sessions/${SID}`, token)).status).toBe(403)
        expect((await req(app, 'POST', `/api/sessions/${SID}/share`, token)).status).toBe(403)
        // Namespace-wide surfaces.
        expect((await req(app, 'GET', '/api/sessions', token)).status).toBe(403)
        expect((await req(app, 'GET', '/api/machines', token)).status).toBe(403)
    })

    it('rejects a revoked share on every request', async () => {
        const app = appWith(activeShare({ revoked: true }))
        const token = await scopedToken()
        expect((await req(app, 'GET', `/api/sessions/${SID}`, token)).status).toBe(401)
    })

    it('rejects a token whose sid does not match the stored share', async () => {
        const app = appWith(activeShare({ sessionId: 'different' }))
        const token = await scopedToken()
        expect((await req(app, 'GET', `/api/sessions/${SID}`, token)).status).toBe(401)
    })

    it('sets sessionScope for a valid scoped request', async () => {
        const app = appWith(activeShare())
        const token = await scopedToken()
        const res = await req(app, 'GET', `/api/sessions/${SID}`, token)
        expect(await res.json()).toEqual({ scope: SID })
    })
})
