import { createMemoryHistory } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { buildSharedSessionNavigation, createAppRouter } from './router'

describe('shared-session route masking', () => {
    it('keeps the share capability in the copyable URL', async () => {
        const history = createMemoryHistory({ initialEntries: ['/s/share-token'] })
        const router = createAppRouter(history)

        await router.navigate(buildSharedSessionNavigation('session-id', 'share-token'))

        // The application renders its existing session detail route.
        expect(router.state.location.pathname).toBe('/sessions/session-id')
        expect(router.state.location.search).toMatchObject({ share: 'share-token' })
        // The address bar remains a self-contained share link, so a copied URL
        // can be redeemed in a different tab/device without the owner's token.
        expect(history.location.pathname).toBe('/s/share-token')

        await router.navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId: 'session-id' },
            search: { tab: 'changes' },
        })

        // Route masks are one navigation only. Retaining the capability as a
        // session search param keeps deeper URLs portable as well.
        expect(history.location.pathname).toBe('/sessions/session-id/files')
        const publicSearch = new URLSearchParams(history.location.search)
        expect(publicSearch.get('share')).toBe('share-token')
        expect(publicSearch.get('tab')).toBe('changes')

        const copiedUrl = `${history.location.pathname}${history.location.search}`
        const freshHistory = createMemoryHistory({ initialEntries: [copiedUrl] })
        const freshRouter = createAppRouter(freshHistory)
        await freshRouter.load()

        expect(freshRouter.state.location.pathname).toBe('/sessions/session-id/files')
        expect(freshRouter.state.location.search).toMatchObject({
            share: 'share-token',
            tab: 'changes',
        })
    })
})
