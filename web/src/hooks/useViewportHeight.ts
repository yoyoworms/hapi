import { useEffect } from 'react'
import { isTelegramApp } from '@/hooks/useTelegram'

const NON_KEYBOARD_INPUT_TYPES = new Set([
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
])

export function isVirtualKeyboardTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    const contentEditable = target.getAttribute('contenteditable')
    if (target.isContentEditable || contentEditable === 'true' || contentEditable === 'plaintext-only') return true
    if (target instanceof HTMLTextAreaElement) return true
    if (target instanceof HTMLInputElement) {
        return !NON_KEYBOARD_INPUT_TYPES.has(target.type.toLowerCase())
    }
    return false
}

export function resolveVisualViewportHeight(args: {
    windowHeight: number
    viewportHeight: number
    activeElement: EventTarget | null
}): number | null {
    if (!isVirtualKeyboardTarget(args.activeElement)) return null
    return args.windowHeight - args.viewportHeight > 1
        ? args.viewportHeight
        : null
}

/**
 * Sets a CSS custom property `--app-viewport-height` on <html> that tracks the
 * visual viewport height. This is a fallback for browsers that do not support
 * the `interactive-widget=resizes-content` viewport meta attribute — on those
 * browsers `100dvh` does NOT shrink when the virtual keyboard opens, so the
 * composer input is hidden behind the keyboard.
 *
 * The hook listens to `window.visualViewport.resize` and writes the viewport
 * height into the CSS variable. The CSS height chain is:
 *   var(--tg-viewport-stable-height, var(--app-viewport-height, 100dvh))
 *
 * Skipped in Telegram Mini Apps (Telegram SDK provides its own height variable).
 */
export function useViewportHeight(): void {
    useEffect(() => {
        // Telegram Mini App has its own viewport management via --tg-viewport-stable-height
        if (isTelegramApp()) return

        const viewport = window.visualViewport
        if (!viewport) return

        const root = document.documentElement
        const isMobileStandalone = root.dataset.mobileStandaloneApp === 'true'
        let rafId: number | null = null
        const focusTimers: number[] = []

        function resetWindowScroll() {
            if (!isMobileStandalone) {
                return
            }
            if (window.scrollX !== 0 || window.scrollY !== 0) {
                window.scrollTo(0, 0)
            }
        }

        function update() {
            if (!viewport) return
            // Only constrain the app while a real text editor owns focus. iOS
            // PWA can leave visualViewport.height at its keyboard-open value
            // after the keyboard/editor is dismissed. Treating that stale
            // metric as authoritative leaves the whole app permanently short.
            const viewportHeight = resolveVisualViewportHeight({
                windowHeight: window.innerHeight,
                viewportHeight: viewport.height,
                activeElement: document.activeElement,
            })
            if (viewportHeight !== null) {
                root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
                // On iOS PWA (black-translucent status bar + viewport-fit=cover),
                // the browser scrolls the page upward when the keyboard opens to
                // keep the focused input visible. This pushes the header behind
                // the iOS status bar. Reset the page scroll so the app stays
                // pinned to the top — the inner flex layout already handles
                // keeping the composer visible.
                if (window.scrollY > 0) {
                    window.scrollTo(0, 0)
                }
            } else {
                root.style.removeProperty('--app-viewport-height')
            }
            resetWindowScroll()
        }

        function scheduleUpdate() {
            if (rafId !== null) {
                return
            }
            rafId = window.requestAnimationFrame(() => {
                rafId = null
                update()
            })
        }

        function scheduleFocusUpdates() {
            for (const timer of focusTimers.splice(0)) {
                window.clearTimeout(timer)
            }
            scheduleUpdate()
            focusTimers.push(window.setTimeout(scheduleUpdate, 50))
            focusTimers.push(window.setTimeout(scheduleUpdate, 250))
            focusTimers.push(window.setTimeout(scheduleUpdate, 500))
            focusTimers.push(window.setTimeout(scheduleUpdate, 1000))
        }

        function handleFocusOut(event: FocusEvent) {
            // Mobile WebKit often reports no final visualViewport resize when
            // leaving a PWA text field. Release the keyboard-sized override at
            // the focus boundary instead of waiting for a metric that may never
            // arrive. A following focusin restores it when focus moved between
            // two editors.
            if (!isVirtualKeyboardTarget(event.relatedTarget)) {
                root.style.removeProperty('--app-viewport-height')
                resetWindowScroll()
            }
            scheduleFocusUpdates()
        }

        update()
        viewport.addEventListener('resize', scheduleUpdate)
        viewport.addEventListener('scroll', scheduleUpdate)
        window.addEventListener('resize', scheduleUpdate)
        window.addEventListener('orientationchange', scheduleFocusUpdates)
        document.addEventListener('focusin', scheduleFocusUpdates)
        document.addEventListener('focusout', handleFocusOut)

        return () => {
            viewport.removeEventListener('resize', scheduleUpdate)
            viewport.removeEventListener('scroll', scheduleUpdate)
            window.removeEventListener('resize', scheduleUpdate)
            window.removeEventListener('orientationchange', scheduleFocusUpdates)
            document.removeEventListener('focusin', scheduleFocusUpdates)
            document.removeEventListener('focusout', handleFocusOut)
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId)
            }
            for (const timer of focusTimers) {
                window.clearTimeout(timer)
            }
            root.style.removeProperty('--app-viewport-height')
        }
    }, [])
}
