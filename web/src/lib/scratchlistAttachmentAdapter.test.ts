import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_BYTES_PER_FILE } from '@hapi/protocol'
import {
    createScratchlistAttachmentAdapter,
    hubAttachmentFromRestoredDraft,
} from './scratchlistAttachmentAdapter'

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('hubAttachmentFromRestoredDraft', () => {
    it('reconstructs hub metadata from hapi-hub:scratchlist storage key', () => {
        const file = new File([new Uint8Array([1, 2, 3])], 'proof.png', { type: 'image/png' })
        const path = 'hapi-hub:scratchlist/default/session-1/a1b2c3d4-e5f6-4789-a012-3456789abcde-proof.png'
        expect(hubAttachmentFromRestoredDraft(path, file, 'image/png')).toEqual({
            id: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
            filename: 'proof.png',
            mimeType: 'image/png',
            size: 3,
            path,
        })
    })

    it('returns null for non-hub paths', () => {
        const file = new File(['x'], 'x.txt', { type: 'text/plain' })
        expect(hubAttachmentFromRestoredDraft('/uploads/x.txt', file, 'text/plain')).toBeNull()
    })
})

describe('createScratchlistAttachmentAdapter', () => {
    it('uses assistant-ui universal matching so pasted images are accepted', () => {
        const adapter = createScratchlistAttachmentAdapter({} as never, 'session-1')

        expect(adapter.accept).toBe('*')
    })

    it('rejects oversized files before FileReader or upload allocation', async () => {
        const readAsDataUrl = vi.spyOn(FileReader.prototype, 'readAsDataURL')
        const uploadScratchlistAttachment = vi.fn()
        const adapter = createScratchlistAttachmentAdapter(
            { uploadScratchlistAttachment } as never,
            'session-1'
        )
        const file = new File(['small fixture'], 'oversized.bin', { type: 'application/octet-stream' })
        Object.defineProperty(file, 'size', {
            configurable: true,
            value: SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_BYTES_PER_FILE + 1,
        })

        const states: import('@assistant-ui/react').PendingAttachment[] = []
        for await (const pending of adapter.add({ file }) as AsyncGenerator<
            import('@assistant-ui/react').PendingAttachment
        >) {
            states.push(pending)
        }

        expect(states).toHaveLength(1)
        expect(states[0]?.status).toEqual({ type: 'incomplete', reason: 'error' })
        expect(readAsDataUrl).not.toHaveBeenCalled()
        expect(uploadScratchlistAttachment).not.toHaveBeenCalled()
        readAsDataUrl.mockRestore()
    })

    it('reuses restored hub path without re-uploading', async () => {
        const drafts = await import('./composer-attachment-drafts')
        const hubId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'
        const path = `hapi-hub:scratchlist/default/session-1/${hubId}-proof.png`
        const file = new File([new Uint8Array([137, 80, 78, 71])], 'proof.png', { type: 'image/png' })
        drafts.saveDraftAttachments('session-1', [{
            id: 'composer-att-1',
            file,
            path,
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
        }])
        const [restored] = await drafts.getDraftAttachments('session-1')
        expect(restored).toBeTruthy()

        const uploadScratchlistAttachment = vi.fn()
        const api = { uploadScratchlistAttachment } as never
        const adapter = createScratchlistAttachmentAdapter(api, 'session-1')

        const iter = adapter.add({ file: restored! }) as AsyncGenerator<
            import('@assistant-ui/react').PendingAttachment
        >
        const states: import('@assistant-ui/react').PendingAttachment[] = []
        for await (const pending of iter) {
            states.push(pending)
        }

        expect(uploadScratchlistAttachment).not.toHaveBeenCalled()
        expect(states).toHaveLength(1)
        const ready = states[0] as {
            id: string
            status: unknown
            path?: string
            hubAttachment?: { id: string; path: string }
            previewUrl?: string
        }
        expect(ready.id).toBe('composer-att-1')
        expect(ready.status).toEqual({ type: 'requires-action', reason: 'composer-send' })
        expect(ready.path).toBe(path)
        expect(ready.hubAttachment).toEqual({
            id: hubId,
            filename: 'proof.png',
            mimeType: 'image/png',
            size: restored!.size,
            path,
        })
        expect(ready.previewUrl).toBe('data:image/png;base64,aW1hZ2U=')
    })

    it('re-uploads a restored hub path when the destination session changed', async () => {
        const drafts = await import('./composer-attachment-drafts')
        const hubId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'
        const oldPath = `hapi-hub:scratchlist/default/session-old/${hubId}-proof.txt`
        const file = new File(['proof'], 'proof.txt', { type: 'text/plain' })
        drafts.saveDraftAttachments('session-old', [{
            id: 'composer-att-old',
            file,
            path: oldPath,
        }])
        const [restored] = await drafts.getDraftAttachments('session-old')
        const uploadScratchlistAttachment = vi.fn().mockResolvedValue({
            success: true,
            attachment: {
                id: 'hub-new',
                filename: 'proof.txt',
                mimeType: 'text/plain',
                size: file.size,
                path: 'hapi-hub:scratchlist/default/session-new/hub-new-proof.txt',
            },
        })
        const adapter = createScratchlistAttachmentAdapter(
            { uploadScratchlistAttachment } as never,
            'session-new',
        )
        const states: import('@assistant-ui/react').PendingAttachment[] = []

        for await (const pending of adapter.add({ file: restored! }) as AsyncGenerator<
            import('@assistant-ui/react').PendingAttachment
        >) {
            states.push(pending)
        }

        expect(uploadScratchlistAttachment).toHaveBeenCalledWith(
            'session-new',
            'proof.txt',
            expect.any(String),
            'text/plain',
        )
        expect(states.at(-1)).toEqual(expect.objectContaining({
            path: 'hapi-hub:scratchlist/default/session-new/hub-new-proof.txt',
        }))
    })

    it('sets path on requires-action yield so composer canSend unlocks after hub upload', async () => {
        const uploadScratchlistAttachment = vi.fn().mockResolvedValue({
            success: true,
            attachment: {
                id: 'hub-1',
                filename: 'proof.png',
                mimeType: 'image/png',
                size: 12,
                path: '/scratchlist/sessions/s1/proof.png',
            },
        })
        const api = { uploadScratchlistAttachment } as never
        const adapter = createScratchlistAttachmentAdapter(api, 'session-1')
        const file = new File([new Uint8Array([137, 80, 78, 71])], 'proof.png', { type: 'image/png' })

        const iter = adapter.add({ file }) as AsyncGenerator<import('@assistant-ui/react').PendingAttachment>
        const states: import('@assistant-ui/react').PendingAttachment[] = []
        for await (const pending of iter) {
            states.push(pending)
        }

        const ready = states.at(-1)
        expect(ready?.status).toEqual({ type: 'requires-action', reason: 'composer-send' })
        expect((ready as { path?: string }).path).toBe('/scratchlist/sessions/s1/proof.png')
    })

    it('keeps a successful hub upload usable when preview FileReader fails', async () => {
        let readCount = 0
        class PreviewFailingFileReader {
            result: string | null = null
            onload: (() => void) | null = null
            onerror: ((error: Error) => void) | null = null

            readAsDataURL(): void {
                readCount += 1
                queueMicrotask(() => {
                    if (readCount === 1) {
                        this.result = 'data:image/png;base64,aW1hZ2U='
                        this.onload?.()
                    } else {
                        this.onerror?.(new Error('preview read failed'))
                    }
                })
            }
        }
        vi.stubGlobal('FileReader', PreviewFailingFileReader)

        const uploadScratchlistAttachment = vi.fn().mockResolvedValue({
            success: true,
            attachment: {
                id: 'hub-preview-failed',
                filename: 'proof.png',
                mimeType: 'image/png',
                size: 5,
                path: 'hapi-hub:scratchlist/default/session-1/hub-preview-failed-proof.png',
            },
        })
        const adapter = createScratchlistAttachmentAdapter(
            { uploadScratchlistAttachment } as never,
            'session-1'
        )
        const file = new File(['image'], 'proof.png', { type: 'image/png' })
        const states: import('@assistant-ui/react').PendingAttachment[] = []

        for await (const pending of adapter.add({ file }) as AsyncGenerator<
            import('@assistant-ui/react').PendingAttachment
        >) {
            states.push(pending)
        }

        expect(readCount).toBe(2)
        expect(states.at(-1)).toEqual(expect.objectContaining({
            path: 'hapi-hub:scratchlist/default/session-1/hub-preview-failed-proof.png',
            previewUrl: undefined,
            status: { type: 'requires-action', reason: 'composer-send' },
        }))
    })

    it('deletes the hub upload when remove races the preview await', async () => {
        let readCount = 0
        let finishPreview: (() => void) | undefined
        class DelayedPreviewFileReader {
            result: string | null = null
            onload: (() => void) | null = null
            onerror: ((error: Error) => void) | null = null

            readAsDataURL(): void {
                readCount += 1
                if (readCount === 1) {
                    queueMicrotask(() => {
                        this.result = 'data:image/png;base64,aW1hZ2U='
                        this.onload?.()
                    })
                    return
                }
                finishPreview = () => {
                    this.result = 'data:image/png;base64,cHJldmlldw=='
                    this.onload?.()
                }
            }
        }
        vi.stubGlobal('FileReader', DelayedPreviewFileReader)

        const uploadScratchlistAttachment = vi.fn().mockResolvedValue({
            success: true,
            attachment: {
                id: 'hub-raced',
                filename: 'proof.png',
                mimeType: 'image/png',
                size: 5,
                path: 'hapi-hub:scratchlist/default/session-1/hub-raced-proof.png',
            },
        })
        const deleteScratchlistAttachment = vi.fn().mockResolvedValue(undefined)
        const adapter = createScratchlistAttachmentAdapter({
            uploadScratchlistAttachment,
            deleteScratchlistAttachment,
        } as never, 'session-1')
        const file = new File(['image'], 'proof.png', { type: 'image/png' })
        const iter = adapter.add({ file }) as AsyncGenerator<import('@assistant-ui/react').PendingAttachment>
        const initial = await iter.next()
        await iter.next()
        const finishing = iter.next()

        await vi.waitFor(() => expect(finishPreview).toBeTypeOf('function'))
        await adapter.remove({
            id: (initial.value as { id: string }).id,
            type: 'file',
            name: file.name,
            contentType: file.type,
            status: { type: 'running', reason: 'uploading', progress: 50 },
        } as never)
        finishPreview?.()

        await expect(finishing).resolves.toEqual(expect.objectContaining({ done: true }))
        expect(deleteScratchlistAttachment).toHaveBeenCalledWith('session-1', 'hub-raced')
    })

    it('deletes hub blob when cancel races the in-flight upload completion', async () => {
        let pendingId = ''
        let adapter: ReturnType<typeof createScratchlistAttachmentAdapter>
        const deleteScratchlistAttachment = vi.fn().mockResolvedValue(undefined)
        const uploadScratchlistAttachment = vi.fn().mockImplementation(async () => {
            await adapter.remove({
                id: pendingId,
                type: 'file',
                name: 'proof.png',
                contentType: 'image/png',
                status: { type: 'running', reason: 'uploading', progress: 50 },
            } as never)
            return {
                success: true,
                attachment: {
                    id: 'hub-race',
                    filename: 'proof.png',
                    mimeType: 'image/png',
                    size: 4,
                    path: 'hapi-hub:scratchlist/default/session-1/hub-race-proof.png',
                },
            }
        })
        const api = { uploadScratchlistAttachment, deleteScratchlistAttachment } as never
        adapter = createScratchlistAttachmentAdapter(api, 'session-1')
        const file = new File([new Uint8Array([137, 80, 78, 71])], 'proof.png', { type: 'image/png' })

        const iter = adapter.add({ file }) as AsyncGenerator<import('@assistant-ui/react').PendingAttachment>
        const first = await iter.next()
        pendingId = (first.value as { id: string }).id

        for await (const _pending of iter) {
            // drain
        }

        expect(deleteScratchlistAttachment).toHaveBeenCalledWith('session-1', 'hub-race')
    })
})
