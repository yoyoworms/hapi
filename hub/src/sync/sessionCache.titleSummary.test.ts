import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => events.push(event)
    } as unknown as EventPublisher
}

describe('SessionCache.updateSessionSummary', () => {
    it('keeps a manual title across agent writes and a hub cache restart, and allows another manual rename', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const created = cache.getOrCreateSession('manual-title', { path: '/tmp', host: 'localhost' }, null, 'default')
        const activityAt = created.updatedAt
        await cache.renameSession(created.id, 'My title')
        const manuallyNamed = store.sessions.getSession(created.id)!
        store.sessions.updateSessionMetadata(created.id, {
            ...manuallyNamed.metadata!, name: 'Planned title', nameSource: 'agent'
        }, manuallyNamed.metadataVersion, 'default', { touchUpdatedAt: false })

        const restarted = new SessionCache(store, createPublisher([]))
        restarted.refreshSession(created.id)
        expect(restarted.getSession(created.id)?.metadata).toMatchObject({ name: 'My title', nameSource: 'user' })
        await restarted.updateSessionSummary(created.id, 'New generated summary')
        expect(restarted.getSession(created.id)?.metadata?.name).toBe('My title')
        await restarted.renameSession(created.id, 'My revised title')
        expect(restarted.getSession(created.id)?.metadata).toMatchObject({ name: 'My revised title', nameSource: 'user' })
        expect(store.sessions.getSession(created.id)?.updatedAt).toBe(activityAt)
        store.close()
    })

    it.each([false, true])('preserves title ownership when merging into a resumed session (destination manually named=%s)', async (destinationUserTitle) => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const source = cache.getOrCreateSession('source-title', {
            path: '/tmp', host: 'localhost', name: 'My title', nameSource: 'user'
        }, null, 'default')
        const target = cache.getOrCreateSession('target-title', {
            path: '/tmp', host: 'localhost', name: 'Destination title', nameSource: destinationUserTitle ? 'user' : 'agent'
        }, null, 'default')
        await cache.mergeSessions(source.id, target.id, 'default')
        expect(cache.getSession(target.id)?.metadata).toMatchObject({
            name: destinationUserTitle ? 'Destination title' : 'My title', nameSource: 'user'
        })
        store.close()
    })

    it('keeps the latest manual rename when a CLI echoes stale user-owned metadata', async () => {
        const store = new Store(':memory:')
        try {
            const cache = new SessionCache(store, createPublisher([]))
            const created = cache.getOrCreateSession('stale-user-title', {
                path: '/tmp', host: 'localhost'
            }, null, 'default')
            await cache.renameSession(created.id, 'First manual title')
            const staleMetadata = store.sessions.getSession(created.id)!.metadata
            await cache.renameSession(created.id, 'Latest manual title')
            const current = store.sessions.getSession(created.id)!

            const rejected = store.sessions.updateSessionMetadata(created.id, staleMetadata,
                current.metadataVersion - 1, 'default')
            expect(rejected.result).toBe('version-mismatch')
            // A CLI retries with the current version but may still echo its old name.
            const retried = store.sessions.updateSessionMetadata(created.id, staleMetadata,
                current.metadataVersion, 'default')
            expect(retried).toMatchObject({
                result: 'success', value: { name: 'Latest manual title', nameSource: 'user' }
            })
            cache.refreshSession(created.id)
            expect(cache.getSession(created.id)?.metadata).toMatchObject({
                name: 'Latest manual title', nameSource: 'user'
            })
        } finally {
            store.close()
        }
    })

    it('preserves metadata.name while stamping the generated summary timestamp', async () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const created = cache.getOrCreateSession(
            'summary-session',
            { path: '/tmp', host: 'localhost', name: 'Manual name' },
            null,
            'default'
        )

        await cache.updateSessionSummary(created.id, 'Generated title')

        const updated = cache.getSession(created.id)
        expect(updated?.metadata?.name).toBe('Manual name')
        expect(updated?.metadata?.summary?.text).toBe('Generated title')
        expect(updated?.metadata?.summary?.updatedAt).toBeGreaterThan(0)

        const stored = store.sessions.getSession(created.id)
        expect(stored?.metadata).toMatchObject({
            name: 'Manual name',
            summary: { text: 'Generated title' }
        })
    })
})
