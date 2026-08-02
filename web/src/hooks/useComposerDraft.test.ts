import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock composer-drafts module
vi.mock('@/lib/composer-drafts', () => ({
    getDraft: vi.fn(() => ''),
    saveDraft: vi.fn(),
    clearDraft: vi.fn(),
}))
vi.mock('@/lib/composer-attachment-drafts', () => ({
    getDraftAttachments: vi.fn(async () => []),
    saveDraftAttachments: vi.fn(),
    clearDraftAttachments: vi.fn(),
}))

import { clearDraft, getDraft, saveDraft } from '@/lib/composer-drafts'
import {
    clearDraftAttachments,
    getDraftAttachments,
    saveDraftAttachments,
} from '@/lib/composer-attachment-drafts'
import { useComposerDraft } from './useComposerDraft'

const mockGetDraft = vi.mocked(getDraft)
const mockSaveDraft = vi.mocked(saveDraft)
const mockClearDraft = vi.mocked(clearDraft)
const mockGetDraftAttachments = vi.mocked(getDraftAttachments)
const mockSaveDraftAttachments = vi.mocked(saveDraftAttachments)
const mockClearDraftAttachments = vi.mocked(clearDraftAttachments)

describe('useComposerDraft', () => {
    let rAFCallbacks: Array<() => void>

    beforeEach(() => {
        vi.clearAllMocks()
        mockGetDraft.mockReturnValue('')
        mockGetDraftAttachments.mockResolvedValue([])
        rAFCallbacks = []
        vi.stubGlobal('requestAnimationFrame', vi.fn((cb: () => void) => {
            rAFCallbacks.push(cb)
            return rAFCallbacks.length
        }))
        vi.stubGlobal('cancelAnimationFrame', vi.fn())
    })

    afterEach(() => {
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    async function flushRAF() {
        const cbs = [...rAFCallbacks]
        rAFCallbacks = []
        cbs.forEach(cb => cb())
        await Promise.resolve()
        await Promise.resolve()
    }

    it('restores saved draft on mount via requestAnimationFrame', async () => {
        mockGetDraft.mockReturnValue('saved text')
        const setText = vi.fn()

        renderHook(() => useComposerDraft('session-1', '', [], true, setText, vi.fn()))

        // Before rAF fires, setText should not have been called
        expect(setText).not.toHaveBeenCalled()

        // Flush rAF
        await act(async () => flushRAF())
        expect(mockGetDraft).toHaveBeenCalledWith('session-1')
        expect(setText).toHaveBeenCalledWith('saved text')
    })

    it('does not restore draft if composer already has text', async () => {
        mockGetDraft.mockReturnValue('saved text')
        const setText = vi.fn()

        renderHook(() => useComposerDraft('session-1', 'user is typing', [], true, setText, vi.fn()))

        await act(async () => flushRAF())
        expect(setText).not.toHaveBeenCalled()
    })

    it('does not restore if draft is empty', async () => {
        mockGetDraft.mockReturnValue('')
        const setText = vi.fn()

        renderHook(() => useComposerDraft('session-1', '', [], true, setText, vi.fn()))

        await act(async () => flushRAF())
        expect(setText).not.toHaveBeenCalled()
    })

    it('saves draft on unmount after rAF has fired', async () => {
        mockGetDraft.mockReturnValue('')
        const setText = vi.fn()

        const { unmount, rerender } = renderHook(
            ({ text }) => useComposerDraft('session-1', text, [], true, setText, vi.fn()),
            { initialProps: { text: '' } },
        )

        // Fire rAF to set draftReady = true
        await act(async () => flushRAF())

        // Simulate user typing
        rerender({ text: 'my draft' })

        unmount()

        expect(mockSaveDraft).toHaveBeenCalledWith('session-1', 'my draft')
        expect(mockSaveDraftAttachments).toHaveBeenCalledWith('session-1', [])
    })

    it('debounces draft persistence while the user is typing', async () => {
        vi.useFakeTimers()
        try {
            const { rerender } = renderHook(
                ({ text }) => useComposerDraft('session-1', text, [], true, vi.fn(), vi.fn()),
                { initialProps: { text: '' } },
            )
            await act(async () => flushRAF())

            rerender({ text: 'survives a tab crash' })
            expect(mockSaveDraft).not.toHaveBeenCalled()
            await act(async () => vi.advanceTimersByTimeAsync(250))

            expect(mockSaveDraft).toHaveBeenCalledWith('session-1', 'survives a tab crash')
        } finally {
            vi.useRealTimers()
        }
    })

    it('persists attachment File objects whenever the composer attachment set changes', async () => {
        const file = new File(['image'], 'image.png', { type: 'image/png' })
        const { rerender } = renderHook(
            ({ attachments }) => useComposerDraft(
                'session-1',
                '',
                attachments,
                true,
                vi.fn(),
                vi.fn(),
            ),
            { initialProps: { attachments: [] as Array<{ id: string; file: File }> } },
        )
        await act(async () => flushRAF())
        mockSaveDraftAttachments.mockClear()

        rerender({ attachments: [{ id: 'attachment-1', file }] })

        expect(mockSaveDraftAttachments).toHaveBeenCalledWith('session-1', [{
            id: 'attachment-1',
            file,
        }])

        mockSaveDraftAttachments.mockClear()
        mockClearDraftAttachments.mockClear()
        rerender({ attachments: [] })
        expect(mockClearDraftAttachments).toHaveBeenCalledWith('session-1')
    })

    it('keeps an explicit last-chip removal while attachment uploads are unavailable', async () => {
        const file = new File(['image'], 'image.png', { type: 'image/png' })
        const { rerender } = renderHook(
            ({ attachments, canRestore }) => useComposerDraft(
                'session-1',
                '',
                attachments,
                canRestore,
                vi.fn(),
                vi.fn(),
            ),
            {
                initialProps: {
                    attachments: [{ id: 'attachment-1', file }] as Array<{ id: string; file: File }>,
                    canRestore: true,
                },
            },
        )
        await act(async () => flushRAF())

        rerender({
            attachments: [{ id: 'attachment-1', file }],
            canRestore: false,
        })
        mockClearDraftAttachments.mockClear()
        rerender({ attachments: [], canRestore: false })

        expect(mockClearDraftAttachments).toHaveBeenCalledWith('session-1')
    })

    it('keeps the pre-submit text and files while assistant-ui is temporarily empty', async () => {
        const file = new File(['image'], 'image.png', { type: 'image/png' })
        const initialAttachments = [{ id: 'attachment-1', file }]
        const { result, rerender, unmount } = renderHook(
            ({ text, attachments }) => useComposerDraft(
                'session-1',
                text,
                attachments,
                true,
                vi.fn(),
                vi.fn(),
            ),
            { initialProps: { text: 'send me', attachments: initialAttachments } },
        )
        await act(async () => flushRAF())
        mockSaveDraft.mockClear()
        mockSaveDraftAttachments.mockClear()

        act(() => result.current.prepareForSubmit())
        rerender({ text: '', attachments: [] })
        window.dispatchEvent(new Event('pagehide'))
        unmount()

        expect(mockSaveDraft).toHaveBeenCalledWith('session-1', 'send me')
        expect(mockSaveDraft).not.toHaveBeenCalledWith('session-1', '')
        expect(mockSaveDraftAttachments).toHaveBeenCalledWith('session-1', initialAttachments)
        expect(mockSaveDraftAttachments).not.toHaveBeenCalledWith('session-1', [])
    })

    it('clears only the retained snapshot after an accepted local destination', async () => {
        const file = new File(['image'], 'image.png', { type: 'image/png' })
        const { result, rerender } = renderHook(
            ({ text, attachments }) => useComposerDraft(
                'session-1',
                text,
                attachments,
                true,
                vi.fn(),
                vi.fn(),
            ),
            {
                initialProps: {
                    text: 'scratch note',
                    attachments: [{ id: 'attachment-1', file }],
                },
            },
        )
        await act(async () => flushRAF())
        act(() => result.current.prepareForSubmit())
        rerender({ text: '', attachments: [] })

        act(() => result.current.completeSubmission())

        expect(mockClearDraft).toHaveBeenCalledWith('session-1')
        expect(mockClearDraftAttachments).toHaveBeenCalledWith('session-1')
    })

    it('persists immediately when the page is hidden', async () => {
        const { rerender } = renderHook(
            ({ text }) => useComposerDraft('session-1', text, [], true, vi.fn(), vi.fn()),
            { initialProps: { text: '' } },
        )
        await act(async () => flushRAF())
        rerender({ text: 'mobile background draft' })

        window.dispatchEvent(new Event('pagehide'))

        expect(mockSaveDraft).toHaveBeenCalledWith('session-1', 'mobile background draft')
        expect(mockSaveDraftAttachments).toHaveBeenCalledWith('session-1', [])
    })

    it('does not rewrite the same File for upload progress-only object updates', async () => {
        const file = new File(['image'], 'image.png', { type: 'image/png' })
        const { rerender } = renderHook(
            ({ attachments }) => useComposerDraft(
                'session-1',
                '',
                attachments,
                true,
                vi.fn(),
                vi.fn(),
            ),
            { initialProps: { attachments: [] as Array<{ id: string; file: File; path?: string }> } },
        )
        await act(async () => flushRAF())
        mockSaveDraftAttachments.mockClear()

        rerender({ attachments: [{ id: 'attachment-1', file }] })
        rerender({ attachments: [{ id: 'attachment-1', file }] })
        rerender({ attachments: [{ id: 'attachment-1', file }] })

        expect(mockSaveDraftAttachments).toHaveBeenCalledTimes(1)

        rerender({ attachments: [{ id: 'attachment-1', file, path: '/uploads/image.png' }] })
        expect(mockSaveDraftAttachments).toHaveBeenCalledTimes(2)
    })

    it('deduplicates visibility-hidden plus pagehide but persists again after returning visible', async () => {
        const file = new File(['large draft'], 'draft.bin', { type: 'application/octet-stream' })
        const visibility = vi.spyOn(document, 'visibilityState', 'get')
        visibility.mockReturnValue('hidden')
        const { rerender } = renderHook(
            ({ text }) => useComposerDraft(
                'session-1',
                text,
                [{ id: 'attachment-1', file }],
                true,
                vi.fn(),
                vi.fn(),
            ),
            { initialProps: { text: '' } },
        )
        await act(async () => flushRAF())
        rerender({ text: 'first background' })
        mockSaveDraft.mockClear()
        mockSaveDraftAttachments.mockClear()

        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('pagehide'))

        expect(mockSaveDraft).toHaveBeenCalledTimes(1)
        expect(mockSaveDraftAttachments).toHaveBeenCalledTimes(1)
        expect(mockSaveDraftAttachments).toHaveBeenCalledWith('session-1', [{
            id: 'attachment-1',
            file,
        }])

        visibility.mockReturnValue('visible')
        document.dispatchEvent(new Event('visibilitychange'))
        rerender({ text: 'second background' })
        mockSaveDraft.mockClear()
        mockSaveDraftAttachments.mockClear()
        visibility.mockReturnValue('hidden')
        document.dispatchEvent(new Event('visibilitychange'))

        expect(mockSaveDraft).toHaveBeenCalledTimes(1)
        expect(mockSaveDraft).toHaveBeenCalledWith('session-1', 'second background')
        expect(mockSaveDraftAttachments).toHaveBeenCalledTimes(1)
        visibility.mockRestore()
    })

    it('does not save draft on unmount before rAF has fired', () => {
        mockGetDraft.mockReturnValue('')
        const setText = vi.fn()

        const { unmount } = renderHook(
            () => useComposerDraft('session-1', 'some text', [], true, setText, vi.fn()),
        )

        // Unmount before rAF fires (draftReady is still false)
        unmount()

        expect(mockSaveDraft).not.toHaveBeenCalled()
        expect(vi.mocked(cancelAnimationFrame)).toHaveBeenCalled()
    })

    it('does nothing when sessionId is undefined', async () => {
        const setText = vi.fn()

        const { unmount } = renderHook(
            () => useComposerDraft(undefined, 'text', [], true, setText, vi.fn()),
        )

        await act(async () => flushRAF())
        unmount()

        expect(mockGetDraft).not.toHaveBeenCalled()
        expect(mockSaveDraft).not.toHaveBeenCalled()
        expect(setText).not.toHaveBeenCalled()
    })

    it('restores saved attachments when the composer is empty', async () => {
        const file = new File(['image'], 'image.png', { type: 'image/png' })
        mockGetDraftAttachments.mockResolvedValue([file])
        const addAttachment = vi.fn(async () => {})

        const { result } = renderHook(() => useComposerDraft('session-1', '', [], true, vi.fn(), addAttachment))
        await act(async () => flushRAF())

        expect(addAttachment).toHaveBeenCalledWith(file)

        // A route error and the local async outcome can race the mount restore.
        // The controller serializes them so the chip is never duplicated.
        await act(async () => result.current.restoreAttachments('session-1'))
        expect(addAttachment).toHaveBeenCalledTimes(1)
    })

    it('does not duplicate saved attachments when the composer already has files', async () => {
        const current = new File(['current'], 'current.png', { type: 'image/png' })
        const saved = new File(['saved'], 'saved.png', { type: 'image/png' })
        mockGetDraftAttachments.mockResolvedValue([saved])
        const addAttachment = vi.fn(async () => {})

        renderHook(() => useComposerDraft('session-1', '', [{ id: 'current', file: current }], true, vi.fn(), addAttachment))
        await act(async () => flushRAF())

        expect(addAttachment).not.toHaveBeenCalled()
    })

    it('continues restoring attachments after one draft fails', async () => {
        const broken = new File(['broken'], 'broken.png', { type: 'image/png' })
        const healthy = new File(['healthy'], 'healthy.png', { type: 'image/png' })
        mockGetDraftAttachments.mockResolvedValue([broken, healthy])
        const addAttachment = vi.fn(async (file: File) => {
            if (file === broken) throw new Error('expired draft')
        })

        renderHook(() => useComposerDraft('session-1', '', [], true, vi.fn(), addAttachment))
        await act(async () => flushRAF())

        expect(addAttachment).toHaveBeenNthCalledWith(1, broken)
        expect(addAttachment).toHaveBeenNthCalledWith(2, healthy)
    })

    it('defers a requested attachment restore until the session can upload again', async () => {
        const file = new File(['saved'], 'saved.png', { type: 'image/png' })
        mockGetDraftAttachments.mockResolvedValue([file])
        const addAttachment = vi.fn(async () => {})
        const { result, rerender } = renderHook(
            ({ canRestore }) => useComposerDraft(
                'session-1',
                '',
                [],
                canRestore,
                vi.fn(),
                addAttachment,
            ),
            { initialProps: { canRestore: false } },
        )
        await act(async () => flushRAF())

        await act(async () => result.current.restoreAttachments('session-1'))
        expect(addAttachment).not.toHaveBeenCalled()

        rerender({ canRestore: true })
        await act(async () => flushRAF())
        expect(addAttachment).toHaveBeenCalledWith(file)
    })

    it('preserves saved attachments while the attachment adapter is unavailable', async () => {
        const saved = new File(['saved'], 'saved.png', { type: 'image/png' })
        mockGetDraftAttachments.mockResolvedValue([saved])
        const addAttachment = vi.fn(async () => {})

        const { unmount } = renderHook(() => (
            useComposerDraft('session-1', '', [], false, vi.fn(), addAttachment)
        ))
        await act(async () => flushRAF())
        unmount()

        expect(mockGetDraftAttachments).not.toHaveBeenCalled()
        expect(addAttachment).not.toHaveBeenCalled()
        expect(mockSaveDraftAttachments).not.toHaveBeenCalled()
    })
})
