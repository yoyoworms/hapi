function parseExplicitBoolean(value: string | null | undefined): boolean | null {
    if (value == null) return null
    const normalized = value.trim().toLowerCase()
    if (normalized === '1' || normalized === 'true') return true
    if (normalized === '0' || normalized === 'false') return false
    return null
}

/**
 * The native textarea is the compatibility default. The segmented
 * contenteditable composer remains opt-in because system/third-party IMEs do
 * not consistently expose it as a focused text input client.
 *
 * An explicit disable from any source wins over an enable from another source.
 */
export function isRichComposerMentionsEnabled(): boolean {
    const configuredValues: Array<boolean | null> = [
        parseExplicitBoolean(import.meta.env.VITE_RICH_COMPOSER_MENTIONS),
    ]

    try {
        if (typeof window !== 'undefined') {
            configuredValues.push(
                parseExplicitBoolean(window.localStorage.getItem('hapi.composer.richMentions')),
                parseExplicitBoolean(new URLSearchParams(window.location.search).get('richMentions')),
            )
        }
    } catch {
        // Storage and URL access can be unavailable in restricted webviews.
    }

    return configuredValues.includes(true) && !configuredValues.includes(false)
}
