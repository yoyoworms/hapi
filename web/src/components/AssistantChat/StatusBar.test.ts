import { describe, expect, it } from 'vitest'
import { getVisibleCodexPlanProgress, shouldShowComposerStatusBar } from './StatusBar'

describe('shouldShowComposerStatusBar', () => {
    it('hides the composer status bar for Cursor sessions', () => {
        expect(shouldShowComposerStatusBar('cursor')).toBe(false)
    })

    it('shows the composer status bar for other agents', () => {
        expect(shouldShowComposerStatusBar('claude')).toBe(true)
        expect(shouldShowComposerStatusBar('codex')).toBe(true)
        expect(shouldShowComposerStatusBar(null)).toBe(true)
    })
})

describe('getVisibleCodexPlanProgress', () => {
    const progress = {
        explanation: null,
        steps: [{ step: 'Verify', status: 'in_progress' as const }],
        completed: 1,
        total: 2,
        currentStep: 'Verify',
        isComplete: false
    }

    it('shows Codex progress while the current turn is active', () => {
        expect(getVisibleCodexPlanProgress('codex', progress, true)).toBe(progress)
    })

    it('hides stale progress after the turn settles', () => {
        expect(getVisibleCodexPlanProgress('codex', progress, false)).toBeNull()
    })

    it('does not show Codex plan progress for other agent flavors', () => {
        expect(getVisibleCodexPlanProgress('claude', progress, true)).toBeNull()
    })
})
