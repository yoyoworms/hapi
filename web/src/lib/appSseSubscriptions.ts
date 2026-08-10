export type AppGlobalSseSubscription = {
    all: true
}

export type AppSessionSseSubscription = {
    sessionId: string
}

export function getAppGlobalSseSubscription(
    sharedMode = false,
): AppGlobalSseSubscription | null {
    // Share JWTs are intentionally scoped to one session. Requesting all=true
    // is both unauthorized and a needless reconnect loop (Hub returns 403).
    if (sharedMode) return null
    return { all: true }
}

/** Share viewers retain only the read-only, session-scoped SSE connection. */
export function shouldEnableOwnerRealtimeFeatures(sharedMode: boolean): boolean {
    return !sharedMode
}

export function getAppSessionSseSubscription(
    selectedSessionId: string | null | undefined,
    allowedSessionId?: string | null,
): AppSessionSseSubscription | null {
    if (!selectedSessionId) {
        return null
    }
    if (allowedSessionId === null) return null
    if (allowedSessionId !== undefined && selectedSessionId !== allowedSessionId) {
        return null
    }
    return { sessionId: selectedSessionId }
}
