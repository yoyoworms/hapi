import { useEffect } from 'react'
import { isTelegramApp } from '@/hooks/useTelegram'

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
            // Only apply when the visual viewport is meaningfully smaller than
            // the window (keyboard is open). A small threshold (1px) avoids
            // false positives from sub-pixel rounding.
            const diff = window.innerHeight - viewport.height
            if (diff > 1) {
                root.style.setProperty('--app-viewport-height', `${viewport.height}px`)
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
            scheduleUpdate()
            focusTimers.push(window.setTimeout(scheduleUpdate, 50))
            focusTimers.push(window.setTimeout(scheduleUpdate, 250))
        }

        update()
        viewport.addEventListener('resize', scheduleUpdate)
        viewport.addEventListener('scroll', scheduleUpdate)
        window.addEventListener('resize', scheduleUpdate)
        window.addEventListener('orientationchange', scheduleFocusUpdates)
        document.addEventListener('focusin', scheduleFocusUpdates)
        document.addEventListener('focusout', scheduleFocusUpdates)

        return () => {
            viewport.removeEventListener('resize', scheduleUpdate)
            viewport.removeEventListener('scroll', scheduleUpdate)
            window.removeEventListener('resize', scheduleUpdate)
            window.removeEventListener('orientationchange', scheduleFocusUpdates)
            document.removeEventListener('focusin', scheduleFocusUpdates)
            document.removeEventListener('focusout', scheduleFocusUpdates)
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
