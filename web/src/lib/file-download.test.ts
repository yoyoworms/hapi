import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadBlobFile } from './file-download'

const NativeURL = globalThis.URL

describe('downloadBlobFile', () => {
    const createObjectURL = vi.fn(() => 'blob:hapi-download')
    const revokeObjectURL = vi.fn()

    beforeEach(() => {
        vi.useFakeTimers()
        createObjectURL.mockClear()
        revokeObjectURL.mockClear()

        class URLMock extends NativeURL {}
        Object.defineProperties(URLMock, {
            createObjectURL: { configurable: true, value: createObjectURL },
            revokeObjectURL: { configurable: true, value: revokeObjectURL },
        })
        vi.stubGlobal('URL', URLMock)
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('clicks a named blob download and delays URL revocation for Safari/PWA', () => {
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
        const blob = new Blob(['video'], { type: 'video/mp4' })

        downloadBlobFile('clip.mp4', blob)

        expect(createObjectURL).toHaveBeenCalledWith(blob)
        expect(click).toHaveBeenCalledOnce()
        expect(document.querySelector('a[download="clip.mp4"]')).not.toBeInTheDocument()
        expect(revokeObjectURL).not.toHaveBeenCalled()

        vi.advanceTimersByTime(999)
        expect(revokeObjectURL).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:hapi-download')
    })
})
