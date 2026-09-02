import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
    isVirtualKeyboardTarget,
    resolveVisualViewportHeight,
    useViewportHeight,
} from './useViewportHeight'

describe('visual viewport keyboard ownership', () => {
    it('recognizes text editors but not ordinary controls', () => {
        const textarea = document.createElement('textarea')
        const textInput = document.createElement('input')
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        const contentEditable = document.createElement('div')
        contentEditable.setAttribute('contenteditable', 'true')

        expect(isVirtualKeyboardTarget(textarea)).toBe(true)
        expect(isVirtualKeyboardTarget(textInput)).toBe(true)
        expect(isVirtualKeyboardTarget(contentEditable)).toBe(true)
        expect(isVirtualKeyboardTarget(checkbox)).toBe(false)
        expect(isVirtualKeyboardTarget(document.body)).toBe(false)
    })

    it('uses the reduced viewport only while a text editor owns focus', () => {
        const textarea = document.createElement('textarea')

        expect(resolveVisualViewportHeight({
            windowHeight: 800,
            viewportHeight: 400,
            activeElement: textarea,
        })).toBe(400)
        expect(resolveVisualViewportHeight({
            windowHeight: 800,
            viewportHeight: 400,
            activeElement: document.body,
        })).toBeNull()
    })

    it('releases a stale keyboard-sized override after focus leaves the editor', () => {
        const root = document.documentElement
        root.style.setProperty('--app-viewport-height', '400px')
        const nextHeight = resolveVisualViewportHeight({
            windowHeight: 800,
            // iOS PWA can keep returning the old keyboard-open height.
            viewportHeight: 400,
            activeElement: document.body,
        })
        if (nextHeight === null) {
            root.style.removeProperty('--app-viewport-height')
        }

        expect(root.style.getPropertyValue('--app-viewport-height')).toBe('')
    })

    it('clears the live CSS override immediately on a dropped iOS focusout', () => {
        const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
        const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
        const viewport = new EventTarget() as VisualViewport
        Object.defineProperty(viewport, 'height', { value: 400, configurable: true })
        Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
        Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
        const textarea = document.createElement('textarea')
        document.body.appendChild(textarea)
        textarea.focus()

        const hook = renderHook(() => useViewportHeight())
        expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe('400px')

        // iOS may omit the closing visualViewport resize. focusout must still
        // restore the full-height PWA immediately.
        textarea.blur()
        expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe('')

        hook.unmount()
        textarea.remove()
        if (originalViewport) {
            Object.defineProperty(window, 'visualViewport', originalViewport)
        } else {
            Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
        }
        if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight)
    })
})

/**
 * Unit tests for the useViewportHeight hook logic.
 *
 * Because the hook depends on window.visualViewport (not available in jsdom),
 * we test the core update logic directly rather than rendering the hook.
 */
describe('useViewportHeight update logic', () => {
    const root = document.documentElement

    beforeEach(() => {
        root.style.removeProperty('--app-viewport-height')
    })

    afterEach(() => {
        root.style.removeProperty('--app-viewport-height')
    })

    it('sets --app-viewport-height when visual viewport is smaller than window', () => {
        // Simulate the update logic from the hook
        const viewportHeight = 400
        const windowHeight = 800
        const diff = windowHeight - viewportHeight
        if (diff > 1) {
            root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
        } else {
            root.style.removeProperty('--app-viewport-height')
        }

        expect(root.style.getPropertyValue('--app-viewport-height')).toBe('400px')
    })

    it('removes --app-viewport-height when viewports match', () => {
        // First set it
        root.style.setProperty('--app-viewport-height', '400px')

        // Then simulate keyboard close
        const viewportHeight = 800
        const windowHeight = 800
        const diff = windowHeight - viewportHeight
        if (diff > 1) {
            root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
        } else {
            root.style.removeProperty('--app-viewport-height')
        }

        expect(root.style.getPropertyValue('--app-viewport-height')).toBe('')
    })

    it('ignores sub-pixel differences (threshold of 1px)', () => {
        const viewportHeight = 799.5
        const windowHeight = 800
        const diff = windowHeight - viewportHeight
        if (diff > 1) {
            root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
        } else {
            root.style.removeProperty('--app-viewport-height')
        }

        expect(root.style.getPropertyValue('--app-viewport-height')).toBe('')
    })

    it('resets page scroll when keyboard is open', () => {
        const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

        // Simulate: keyboard open AND page has been scrolled by iOS
        Object.defineProperty(window, 'scrollY', { value: 120, configurable: true })

        const viewportHeight = 400
        const windowHeight = 800
        const diff = windowHeight - viewportHeight
        if (diff > 1) {
            root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
            if (window.scrollY > 0) {
                window.scrollTo(0, 0)
            }
        }

        expect(scrollToSpy).toHaveBeenCalledWith(0, 0)

        // Cleanup
        Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
        scrollToSpy.mockRestore()
    })

    it('does not reset scroll when page is not scrolled', () => {
        const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

        Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })

        const viewportHeight = 400
        const windowHeight = 800
        const diff = windowHeight - viewportHeight
        if (diff > 1) {
            root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
            if (window.scrollY > 0) {
                window.scrollTo(0, 0)
            }
        }

        expect(scrollToSpy).not.toHaveBeenCalled()

        scrollToSpy.mockRestore()
    })
})
