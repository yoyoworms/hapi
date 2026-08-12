import { describe, expect, it } from 'bun:test'
import { SignJWT } from 'jose'
import type { Store } from '../store'
import type { SyncEngine } from '../sync/syncEngine'
import type { PushService } from '../push/pushService'
import { createWebApp } from './server'

const JWT_SECRET = new TextEncoder().encode('share-route-wiring-test-secret')
const SESSION_ID = 'session-share-wiring'

async function ownerToken(): Promise<string> {
    return await new SignJWT({ uid: 1, ns: 'default' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(JWT_SECRET)
}

function createTestApp() {
    const activeShare = {
        token: 'share-token',
        sessionId: SESSION_ID,
        namespace: 'default',
        revoked: false,
        createdAt: 1,
    }
    let shareCreated = false
    const store = {
        shares: {
            getActiveShareForSession: () => shareCreated ? activeShare : null,
            createShare: () => {
                shareCreated = true
                return activeShare
            },
            revokeSharesForSession: () => {
                shareCreated = false
            },
        },
    } as unknown as Store
    const engine = {
        resolveSessionAccess: (sessionId: string, namespace: string) => ({
            ok: sessionId === SESSION_ID && namespace === 'default',
            sessionId,
            session: { id: sessionId },
        }),
    } as unknown as SyncEngine

    return createWebApp({
        getSyncEngine: () => engine,
        getSseManager: () => null,
        getVisibilityTracker: () => null,
        jwtSecret: JWT_SECRET,
        store,
        vapidPublicKey: '',
        pushService: {} as PushService,
        embeddedAssetMap: null,
        configurationOverride: {
            corsOrigins: ['*'],
            dataDir: '/tmp/hapi-share-route-wiring',
            dbPath: ':memory:',
        },
    })
}

async function request(app: ReturnType<typeof createTestApp>, method: string) {
    const token = await ownerToken()
    return await app.request(`/api/sessions/${SESSION_ID}/share`, {
        method,
        headers: { authorization: `Bearer ${token}` },
    })
}

describe('production web server share route wiring', () => {
    it('mounts owner share status, create, and revoke endpoints', async () => {
        const app = createTestApp()

        const initial = await request(app, 'GET')
        expect(initial.status).toBe(200)
        expect(await initial.json()).toEqual({ shared: false, token: null })

        const created = await request(app, 'POST')
        expect(created.status).toBe(200)
        expect(await created.json()).toEqual({ shared: true, token: 'share-token' })

        const revoked = await request(app, 'DELETE')
        expect(revoked.status).toBe(200)
        expect(await revoked.json()).toEqual({ shared: false })
    })
})
