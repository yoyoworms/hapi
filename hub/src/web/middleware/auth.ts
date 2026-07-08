import type { MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { jwtVerify } from 'jose'
import type { Store } from '../../store'

export type WebAppEnv = {
    Variables: {
        userId: number
        namespace: string
        /** Set when the request is authenticated by a session share link.
         *  A scoped request may only touch this one session. */
        sessionScope?: string
    }
}

const jwtPayloadSchema = z.object({
    uid: z.number(),
    ns: z.string(),
    // Session-share scope. When present, the token grants no-login access to
    // exactly one session (`sid`) and nothing else. `share` is the share token
    // used to enforce revocation on every request.
    scope: z.literal('session').optional(),
    sid: z.string().optional(),
    share: z.string().optional()
})

/**
 * Paths a session-scoped (share-link) request is allowed to reach. Deny by
 * default: anything not explicitly whitelisted here is 403 for a shared
 * viewer, so a leaked link can only interact with the one shared session —
 * never list/spawn/delete other sessions, touch machines, or change settings.
 */
function isSharePathAllowed(method: string, path: string, sid: string): boolean {
    // SSE stream + its visibility heartbeat (SSE is separately scoped to sid).
    if (method === 'GET' && path === '/api/events') return true
    if (method === 'POST' && path === '/api/visibility') return true

    const base = `/api/sessions/${encodeURIComponent(sid)}`
    const rawBase = `/api/sessions/${sid}`
    const matchesBase = path === base || path === rawBase
    const suffix = path.startsWith(`${base}/`)
        ? path.slice(base.length)
        : path.startsWith(`${rawBase}/`)
            ? path.slice(rawBase.length)
            : null

    // GET the session itself.
    if (method === 'GET' && matchesBase) return true
    if (suffix === null) return false

    // Read/render + interact with THIS session only.
    if (method === 'GET') {
        if (suffix === '/messages') return true
        if (suffix === '/file' || suffix === '/file/raw') return true
        if (suffix === '/files' || suffix === '/directory') return true
        if (suffix === '/git-status' || suffix === '/git-diff-numstat' || suffix === '/git-diff-file') return true
        if (suffix.startsWith('/generated-images/')) return true
    }
    if (method === 'POST') {
        if (suffix === '/messages') return true          // send a message
        if (suffix === '/abort') return true             // stop the current turn
        if (suffix === '/upload' || suffix === '/upload/delete') return true
    }
    if (method === 'DELETE') {
        if (suffix.startsWith('/messages/')) return true  // cancel/retry a queued message
    }
    return false
}

export function createAuthMiddleware(jwtSecret: Uint8Array, store: Store): MiddlewareHandler<WebAppEnv> {
    return async (c, next) => {
        const path = c.req.path
        // Public: initial auth, telegram bind, and share-link redeem.
        if (path === '/api/auth' || path === '/api/bind' || path.startsWith('/api/share/')) {
            await next()
            return
        }

        const authorization = c.req.header('authorization')
        const tokenFromHeader = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
        const tokenFromQuery = path === '/api/events' ? c.req.query().token : undefined
        const token = tokenFromHeader ?? tokenFromQuery

        if (!token) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }

        try {
            const verified = await jwtVerify(token, jwtSecret, { algorithms: ['HS256'] })
            const parsed = jwtPayloadSchema.safeParse(verified.payload)
            if (!parsed.success) {
                return c.json({ error: 'Invalid token payload' }, 401)
            }

            // Session-share scoped token: enforce single-session access + live revocation.
            if (parsed.data.scope === 'session') {
                const sid = parsed.data.sid
                const shareToken = parsed.data.share
                if (!sid || !shareToken) {
                    return c.json({ error: 'Invalid share token payload' }, 401)
                }
                const share = store.shares.getShareByToken(shareToken)
                if (!share || share.revoked || share.sessionId !== sid || share.namespace !== parsed.data.ns) {
                    return c.json({ error: 'Share link revoked or invalid' }, 401)
                }
                if (!isSharePathAllowed(c.req.method, path, sid)) {
                    return c.json({ error: 'Not permitted for a shared session' }, 403)
                }
                c.set('sessionScope', sid)
            }

            c.set('userId', parsed.data.uid)
            c.set('namespace', parsed.data.ns)
            await next()
            return
        } catch {
            return c.json({ error: 'Invalid token' }, 401)
        }
    }
}
