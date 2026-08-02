import { describe, expect, it, vi } from 'vitest'
import {
    bridgeComposerWheel,
    installComposerWheelBridge,
    normalizeComposerWheelDelta,
} from './composerWheel'

function setMetric(element: HTMLElement, key: 'scrollHeight' | 'clientHeight', value: number) {
    Object.defineProperty(element, key, { configurable: true, value })
}

describe('bridgeComposerWheel', () => {
    it('routes toolbar wheel gestures to the sibling chat viewport', () => {
        const boundary = document.createElement('div')
        const button = document.createElement('button')
        boundary.append(button)
        const viewport = document.createElement('div')
        setMetric(viewport, 'scrollHeight', 1000)
        setMetric(viewport, 'clientHeight', 300)
        viewport.scrollTop = 500

        expect(bridgeComposerWheel({
            target: button,
            boundary,
            viewport,
            deltaX: 0,
            deltaY: -120,
        })).toBe(true)
        expect(viewport.scrollTop).toBe(380)
    })

    it('leaves the gesture on an editor that can scroll in that direction', () => {
        const boundary = document.createElement('div')
        const editor = document.createElement('textarea')
        boundary.append(editor)
        const viewport = document.createElement('div')
        setMetric(editor, 'scrollHeight', 600)
        setMetric(editor, 'clientHeight', 120)
        editor.scrollTop = 100
        editor.style.overflowY = 'auto'
        setMetric(viewport, 'scrollHeight', 1000)
        setMetric(viewport, 'clientHeight', 300)
        viewport.scrollTop = 500
        expect(bridgeComposerWheel({
            target: editor,
            boundary,
            viewport,
            deltaX: 0,
            deltaY: -120,
        })).toBe(false)
        expect(viewport.scrollTop).toBe(500)
    })

    it('routes away from an editor once it reaches its scroll boundary', () => {
        const boundary = document.createElement('div')
        const editor = document.createElement('textarea')
        boundary.append(editor)
        const viewport = document.createElement('div')
        setMetric(editor, 'scrollHeight', 600)
        setMetric(editor, 'clientHeight', 120)
        editor.scrollTop = 0
        editor.style.overflowY = 'auto'
        setMetric(viewport, 'scrollHeight', 1000)
        setMetric(viewport, 'clientHeight', 300)
        viewport.scrollTop = 500
        expect(bridgeComposerWheel({
            target: editor,
            boundary,
            viewport,
            deltaX: 0,
            deltaY: -120,
        })).toBe(true)
        expect(viewport.scrollTop).toBe(380)
    })

    it('normalizes line and page wheel delta modes to CSS pixels', () => {
        expect(normalizeComposerWheelDelta(3, WheelEvent.DOM_DELTA_LINE, 300)).toBe(48)
        expect(normalizeComposerWheelDelta(-1, WheelEvent.DOM_DELTA_PAGE, 300)).toBe(-300)
        expect(normalizeComposerWheelDelta(12, WheelEvent.DOM_DELTA_PIXEL, 300)).toBe(12)
    })

    it('installs a non-passive native listener that cancels document scrolling', () => {
        const boundary = document.createElement('div')
        const button = document.createElement('button')
        boundary.append(button)
        document.body.append(boundary)
        const viewport = document.createElement('div')
        setMetric(viewport, 'scrollHeight', 1000)
        setMetric(viewport, 'clientHeight', 300)
        viewport.scrollTop = 500
        const addEventListenerSpy = vi.spyOn(boundary, 'addEventListener')

        const cleanup = installComposerWheelBridge(boundary, () => viewport)
        expect(addEventListenerSpy).toHaveBeenCalledWith(
            'wheel',
            expect.any(Function),
            { passive: false },
        )

        const event = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY: -3,
            deltaMode: WheelEvent.DOM_DELTA_LINE,
        })
        button.dispatchEvent(event)

        expect(event.defaultPrevented).toBe(true)
        expect(viewport.scrollTop).toBe(452)

        cleanup()
        const afterCleanup = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY: -50,
        })
        button.dispatchEvent(afterCleanup)
        expect(afterCleanup.defaultPrevented).toBe(false)
        expect(viewport.scrollTop).toBe(452)
        boundary.remove()
    })
})
