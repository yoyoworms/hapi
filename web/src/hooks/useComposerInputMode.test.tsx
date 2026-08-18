import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useComposerInputMode } from './useComposerInputMode'

describe('useComposerInputMode', () => {
    beforeEach(() => {
        window.localStorage.removeItem('hapi.composer.richMentions')
        window.history.replaceState({}, '', window.location.pathname)
    })

    afterEach(() => {
        window.localStorage.removeItem('hapi.composer.richMentions')
        window.history.replaceState({}, '', window.location.pathname)
    })

    it('uses the native textarea by default', () => {
        const { result } = renderHook(() => useComposerInputMode())
        expect(result.current.composerInputMode).toBe('native')
    })

    it('persists an explicit rich-composer opt in', () => {
        const { result } = renderHook(() => useComposerInputMode())

        act(() => result.current.setComposerInputMode('rich'))

        expect(result.current.composerInputMode).toBe('rich')
        expect(window.localStorage.getItem('hapi.composer.richMentions')).toBe('1')
    })
})
