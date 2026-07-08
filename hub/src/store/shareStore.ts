import type { Database } from 'bun:sqlite'
import { randomBytes } from 'crypto'

export type StoredShare = {
    token: string
    sessionId: string
    namespace: string
    revoked: boolean
    createdAt: number
}

type DbShareRow = {
    token: string
    session_id: string
    namespace: string
    revoked: number
    created_at: number
}

function toStoredShare(row: DbShareRow): StoredShare {
    return {
        token: row.token,
        sessionId: row.session_id,
        namespace: row.namespace,
        revoked: row.revoked === 1,
        createdAt: row.created_at
    }
}

/**
 * Session share links: opaque, server-stored tokens that grant no-login,
 * single-session access. Interactive by design (the recipient can drive the
 * session), so the token is unguessable (32 random bytes) and revocable —
 * revocation is enforced on every scoped request, not just at redeem time.
 */
export class ShareStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    /** Return the active (non-revoked) share for a session, or null. */
    getActiveShareForSession(sessionId: string, namespace: string): StoredShare | null {
        const row = this.db.prepare(
            'SELECT * FROM session_shares WHERE session_id = ? AND namespace = ? AND revoked = 0 ORDER BY created_at DESC LIMIT 1'
        ).get(sessionId, namespace) as DbShareRow | undefined
        return row ? toStoredShare(row) : null
    }

    /** Look up a share by its token (any state). */
    getShareByToken(token: string): StoredShare | null {
        const row = this.db.prepare(
            'SELECT * FROM session_shares WHERE token = ? LIMIT 1'
        ).get(token) as DbShareRow | undefined
        return row ? toStoredShare(row) : null
    }

    /**
     * Create a share for a session (idempotent-ish: reuse an existing active
     * share so re-clicking "share" doesn't spawn a new link each time).
     */
    createShare(sessionId: string, namespace: string): StoredShare {
        const existing = this.getActiveShareForSession(sessionId, namespace)
        if (existing) return existing

        const token = randomBytes(32).toString('base64url')
        const now = Date.now()
        this.db.prepare(`
            INSERT INTO session_shares (token, session_id, namespace, revoked, created_at)
            VALUES (?, ?, ?, 0, ?)
        `).run(token, sessionId, namespace, now)
        return { token, sessionId, namespace, revoked: false, createdAt: now }
    }

    /** Revoke all active shares for a session. Returns true if any were revoked. */
    revokeSharesForSession(sessionId: string, namespace: string): boolean {
        const result = this.db.prepare(
            'UPDATE session_shares SET revoked = 1 WHERE session_id = ? AND namespace = ? AND revoked = 0'
        ).run(sessionId, namespace)
        return result.changes > 0
    }
}
