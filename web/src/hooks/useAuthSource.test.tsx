import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    getShareTokenFromPath,
    getShareTokenFromSearch,
    useAuthSource,
} from './useAuthSource'

const BASE_URL = 'https://hub.test'

describe('useAuthSource share links', () => {
    beforeEach(() => {
        localStorage.clear()
        sessionStorage.clear()
        window.history.replaceState({}, '', '/')
    })

    afterEach(() => {
        localStorage.clear()
        sessionStorage.clear()
        window.history.replaceState({}, '', '/')
    })

    it('uses a share path ahead of an existing owner token', async () => {
        localStorage.setItem(`hapi_access_token::${BASE_URL}`, 'owner-token')
        window.history.replaceState({}, '', '/s/share-token')

        const { result } = renderHook(() => useAuthSource(BASE_URL))

        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.authSource).toEqual({ type: 'shareToken', token: 'share-token' })
    })

    it('restores share auth from a copyable session subroute', async () => {
        localStorage.setItem(`hapi_access_token::${BASE_URL}`, 'owner-token')
        window.history.replaceState({}, '', '/sessions/session-id/files?tab=changes&share=share-token')

        const { result } = renderHook(() => useAuthSource(BASE_URL))

        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.authSource).toEqual({ type: 'shareToken', token: 'share-token' })
    })

    it('does not make a bare session UUID a public capability', async () => {
        window.history.replaceState({}, '', '/sessions/session-id')

        const { result } = renderHook(() => useAuthSource(BASE_URL))

        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.authSource).toBeNull()
    })

    it('keeps owner authentication working on a bare session URL', async () => {
        localStorage.setItem(`hapi_access_token::${BASE_URL}`, 'owner-token')
        sessionStorage.setItem('hapi_share_token', 'stale-share-token')
        window.history.replaceState({}, '', '/sessions/session-id')

        const { result } = renderHook(() => useAuthSource(BASE_URL))

        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.authSource).toEqual({ type: 'accessToken', token: 'owner-token' })
    })

    it('handles malformed path encoding without crashing', () => {
        window.history.replaceState({}, '', '/s/%E0%A4%A')

        expect(getShareTokenFromPath()).toBeNull()
        expect(getShareTokenFromSearch()).toBeNull()
    })
})
