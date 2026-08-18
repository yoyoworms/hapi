import { useCallback, useEffect, useState } from 'react'
import { isRichComposerMentionsEnabled } from '@/lib/composerInputMode'

export type ComposerInputMode = 'native' | 'rich'

const STORAGE_KEY = 'hapi.composer.richMentions'

function readMode(): ComposerInputMode {
    return isRichComposerMentionsEnabled() ? 'rich' : 'native'
}

export function getComposerInputModeOptions(): ReadonlyArray<{
    value: ComposerInputMode
    labelKey: string
}> {
    return [
        { value: 'native', labelKey: 'settings.chat.inputMode.native' },
        { value: 'rich', labelKey: 'settings.chat.inputMode.rich' },
    ]
}

export function useComposerInputMode(): {
    composerInputMode: ComposerInputMode
    setComposerInputMode: (mode: ComposerInputMode) => void
} {
    const [composerInputMode, setComposerInputModeState] = useState<ComposerInputMode>(readMode)

    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (event.key === STORAGE_KEY) {
                setComposerInputModeState(readMode())
            }
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setComposerInputMode = useCallback((mode: ComposerInputMode) => {
        let persisted = false
        try {
            window.localStorage.setItem(STORAGE_KEY, mode === 'rich' ? '1' : '0')
            persisted = true
        } catch {
            // Keep the in-memory preference usable when storage is unavailable.
        }
        setComposerInputModeState(persisted ? readMode() : mode)
    }, [])

    return { composerInputMode, setComposerInputMode }
}
