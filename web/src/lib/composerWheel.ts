type ComposerWheelBridgeInput = {
    target: EventTarget | null
    boundary: HTMLElement
    viewport: HTMLElement
    deltaX: number
    deltaY: number
    deltaMode?: number
    ctrlKey?: boolean
}

const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2
const DEFAULT_WHEEL_LINE_HEIGHT_PX = 16

/** Convert WheelEvent line/page deltas to CSS pixels before scrolling. */
export function normalizeComposerWheelDelta(
    delta: number,
    deltaMode: number,
    viewportSize: number,
): number {
    if (deltaMode === WHEEL_DELTA_LINE) return delta * DEFAULT_WHEEL_LINE_HEIGHT_PX
    if (deltaMode === WHEEL_DELTA_PAGE) return delta * Math.max(1, viewportSize)
    return delta
}

function canConsumeVerticalWheel(element: Element, deltaY: number): boolean {
    const style = window.getComputedStyle(element)
    if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') return false
    if (element.scrollHeight <= element.clientHeight + 1) return false
    if (deltaY < 0) return element.scrollTop > 0
    return element.scrollTop + element.clientHeight < element.scrollHeight - 1
}

/**
 * Composer and toolbar are siblings of the chat viewport, so a wheel gesture
 * that starts over them cannot naturally bubble into message history. Route a
 * vertical gesture to the chat viewport unless a nested editor/picker can
 * actually scroll in that direction. Returning true means the caller should
 * prevent the document-level default to avoid scroll chaining.
 */
export function bridgeComposerWheel(input: ComposerWheelBridgeInput): boolean {
    if (input.ctrlKey || input.deltaY === 0) return false
    if (Math.abs(input.deltaX) >= Math.abs(input.deltaY)) return false

    let element = input.target instanceof Element ? input.target : null
    while (element && element !== input.boundary) {
        if (canConsumeVerticalWheel(element, input.deltaY)) return false
        element = element.parentElement
    }

    const deltaY = normalizeComposerWheelDelta(
        input.deltaY,
        input.deltaMode ?? 0,
        input.viewport.clientHeight,
    )
    const maxScrollTop = Math.max(0, input.viewport.scrollHeight - input.viewport.clientHeight)
    input.viewport.scrollTop = Math.max(
        0,
        Math.min(maxScrollTop, input.viewport.scrollTop + deltaY),
    )
    return true
}

/**
 * React registers delegated wheel handlers as passive, so preventDefault from
 * an `onWheel` prop cannot stop the document's native scroll. Install the
 * composer bridge directly with passive:false and return its cleanup.
 */
export function installComposerWheelBridge(
    boundary: HTMLElement,
    getViewport: () => HTMLElement | null,
): () => void {
    const handleWheel = (event: WheelEvent) => {
        const viewport = getViewport()
        if (!viewport) return
        if (bridgeComposerWheel({
            target: event.target,
            boundary,
            viewport,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            ctrlKey: event.ctrlKey,
        })) {
            event.preventDefault()
        }
    }

    boundary.addEventListener('wheel', handleWheel, { passive: false })
    return () => boundary.removeEventListener('wheel', handleWheel)
}
