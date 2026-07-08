import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { SyncEngine } from '../../sync/syncEngine'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { requireSyncEngine, requireSessionFromParam } from './guards'
import { getOrCreateOwnerId } from '../../config/ownerId'
import { toSessionSummary } from '@hapi/protocol'

/**
 * Session share links.
 *
 * Owner endpoints (authenticated, under /api/sessions/:id/share) let the
 * session owner mint / inspect / revoke a share token. The public redeem
 * endpoint (/api/share/:token/auth — whitelisted in the auth middleware)
 * exchanges a valid token for a short-lived, session-scoped JWT that grants
 * no-login access to that one session only.
 */
export function createSharesRoutes(
    getSyncEngine: () => SyncEngine | null,
    store: Store,
    jwtSecret: Uint8Array
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Owner: current share status for a session.
    app.get('/sessions/:id/share', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const namespace = c.get('namespace')
        const share = store.shares.getActiveShareForSession(sessionResult.sessionId, namespace)
        return c.json({ shared: Boolean(share), token: share?.token ?? null })
    })

    // Owner: create (or reuse) a share for a session.
    app.post('/sessions/:id/share', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const namespace = c.get('namespace')
        const share = store.shares.createShare(sessionResult.sessionId, namespace)
        return c.json({ shared: true, token: share.token })
    })

    // Owner: revoke all shares for a session.
    app.delete('/sessions/:id/share', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const namespace = c.get('namespace')
        store.shares.revokeSharesForSession(sessionResult.sessionId, namespace)
        return c.json({ shared: false })
    })

    // Public: redeem a share token for a session-scoped JWT + the session summary.
    app.post('/share/:token/auth', async (c) => {
        const token = c.req.param('token')
        const share = store.shares.getShareByToken(token)
        if (!share || share.revoked) {
            return c.json({ error: 'Share link revoked or invalid' }, 404)
        }

        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }
        const access = engine.resolveSessionAccess(share.sessionId, share.namespace)
        if (!access.ok) {
            return c.json({ error: 'Shared session no longer exists' }, 404)
        }

        const userId = await getOrCreateOwnerId()
        const jwt = await new SignJWT({
            uid: userId,
            ns: share.namespace,
            scope: 'session',
            sid: share.sessionId,
            share: share.token
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('4h')
            .sign(jwtSecret)

        return c.json({
            token: jwt,
            sessionId: share.sessionId,
            session: toSessionSummary(access.session)
        })
    })

    return app
}
