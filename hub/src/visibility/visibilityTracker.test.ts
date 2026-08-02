import { describe, expect, it } from 'bun:test'
import { VisibilityTracker } from './visibilityTracker'

describe('VisibilityTracker session scoping', () => {
    it('lets a share-scoped caller update only its own session subscription', () => {
        const tracker = new VisibilityTracker()
        tracker.registerConnection('shared', 'default', 'hidden', 'session-a')
        tracker.registerConnection('other', 'default', 'hidden', 'session-b')
        tracker.registerConnection('global', 'default', 'hidden')

        expect(tracker.setVisibility('shared', 'default', 'visible', 'session-a')).toBe(true)
        expect(tracker.setVisibility('other', 'default', 'visible', 'session-a')).toBe(false)
        expect(tracker.setVisibility('global', 'default', 'visible', 'session-a')).toBe(false)
        expect(tracker.isVisibleConnection('shared')).toBe(true)
        expect(tracker.isVisibleConnection('other')).toBe(false)
        expect(tracker.isVisibleConnection('global')).toBe(false)
    })

    it('keeps owner visibility updates backward compatible', () => {
        const tracker = new VisibilityTracker()
        tracker.registerConnection('global', 'default', 'hidden')

        expect(tracker.setVisibility('global', 'default', 'visible')).toBe(true)
        expect(tracker.isVisibleConnection('global')).toBe(true)
    })
})
