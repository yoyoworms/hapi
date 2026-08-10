import { describe, expect, it } from 'vitest'
import {
    getAppGlobalSseSubscription,
    getAppSessionSseSubscription,
    shouldEnableOwnerRealtimeFeatures,
} from './appSseSubscriptions'

describe('app SSE subscriptions', () => {
    it('always uses a global all:true subscription for the session list', () => {
        expect(getAppGlobalSseSubscription()).toEqual({ all: true })
        expect(getAppGlobalSseSubscription(false)).toEqual({ all: true })
    })

    it('keeps share-token viewers on session SSE without owner side channels', () => {
        expect(getAppGlobalSseSubscription(true)).toBeNull()
        expect(shouldEnableOwnerRealtimeFeatures(true)).toBe(false)
        expect(shouldEnableOwnerRealtimeFeatures(false)).toBe(true)
    })

    it('uses a session-scoped subscription only when a session is selected', () => {
        expect(getAppSessionSseSubscription(null)).toBeNull()
        expect(getAppSessionSseSubscription(undefined)).toBeNull()
        expect(getAppSessionSseSubscription('')).toBeNull()
        expect(getAppSessionSseSubscription('session-a')).toEqual({ sessionId: 'session-a' })
    })

    it('never opens a share SSE stream for a route outside the JWT session', () => {
        expect(getAppSessionSseSubscription('session-a', 'session-a')).toEqual({ sessionId: 'session-a' })
        expect(getAppSessionSseSubscription('session-b', 'session-a')).toBeNull()
        expect(getAppSessionSseSubscription('session-a', null)).toBeNull()
    })
})
