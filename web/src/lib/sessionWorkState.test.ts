import { describe, expect, it } from 'vitest'
import { hasLiveSessionWork, shouldShowSessionTasks } from './sessionWorkState'

describe('session work state', () => {
    it('treats thinking, background work, and user requests as live work', () => {
        expect(hasLiveSessionWork({ active: true, thinking: true })).toBe(true)
        expect(hasLiveSessionWork({ active: true, thinking: false, backgroundTaskCount: 1 })).toBe(true)
        expect(hasLiveSessionWork({ active: true, thinking: false, pendingRequestsCount: 1 })).toBe(true)
    })

    it('does not treat quiet or inactive sessions as live work', () => {
        expect(hasLiveSessionWork({ active: true, thinking: false })).toBe(false)
        expect(hasLiveSessionWork({ active: false, thinking: true })).toBe(false)
    })

    it('hides idle Codex plan snapshots without changing other agents todo semantics', () => {
        const idle = { active: true, thinking: false }
        expect(shouldShowSessionTasks('codex', idle)).toBe(false)
        expect(shouldShowSessionTasks('claude', idle)).toBe(true)
        expect(shouldShowSessionTasks('codex', { ...idle, pendingRequestsCount: 1 })).toBe(true)
    })

})
