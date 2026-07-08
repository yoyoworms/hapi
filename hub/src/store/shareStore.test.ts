import { describe, expect, it } from 'bun:test'
import { Store } from './index'

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag: string, namespace = 'default') {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, namespace)
}

describe('ShareStore', () => {
    it('creates a share and looks it up by token', () => {
        const store = makeStore()
        const session = makeSession(store, 's1')
        const share = store.shares.createShare(session.id, 'default')

        expect(share.token.length).toBeGreaterThan(20)
        expect(share.sessionId).toBe(session.id)
        expect(share.revoked).toBe(false)

        const byToken = store.shares.getShareByToken(share.token)
        expect(byToken?.sessionId).toBe(session.id)
    })

    it('reuses an existing active share instead of minting a new one', () => {
        const store = makeStore()
        const session = makeSession(store, 's2')
        const a = store.shares.createShare(session.id, 'default')
        const b = store.shares.createShare(session.id, 'default')
        expect(a.token).toBe(b.token)
    })

    it('revokes shares and reflects it on lookup', () => {
        const store = makeStore()
        const session = makeSession(store, 's3')
        const share = store.shares.createShare(session.id, 'default')

        const revoked = store.shares.revokeSharesForSession(session.id, 'default')
        expect(revoked).toBe(true)

        expect(store.shares.getShareByToken(share.token)?.revoked).toBe(true)
        expect(store.shares.getActiveShareForSession(session.id, 'default')).toBeNull()
    })

    it('scopes shares by namespace', () => {
        const store = makeStore()
        const session = makeSession(store, 's4', 'nsA')
        const share = store.shares.createShare(session.id, 'nsA')
        // A share is only "active" within its own namespace.
        expect(store.shares.getActiveShareForSession(session.id, 'nsA')?.token).toBe(share.token)
        expect(store.shares.getActiveShareForSession(session.id, 'nsB')).toBeNull()
    })
})
