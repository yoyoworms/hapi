type SessionWorkState = {
    active: boolean
    thinking: boolean
    backgroundTaskCount?: number | null
    pendingRequestsCount?: number | null
}

/** True while a session has user-visible work or is waiting on the user. */
export function hasLiveSessionWork(state: SessionWorkState): boolean {
    return state.active && (
        state.thinking
        || (state.backgroundTaskCount ?? 0) > 0
        || (state.pendingRequestsCount ?? 0) > 0
    )
}

/**
 * Codex `update_plan` snapshots belong to the current turn. Codex does not
 * always emit a final snapshot, so an incomplete persisted plan must not look
 * live after the turn becomes idle. Other agents keep their existing durable
 * TodoWrite semantics.
 */
export function shouldShowSessionTasks(
    agentFlavor: string | null | undefined,
    state: SessionWorkState
): boolean {
    if (agentFlavor !== 'codex') return true
    return hasLiveSessionWork(state)
}
