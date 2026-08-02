import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('attachmentAdapter restored uploads', () => {
    beforeEach(() => {
        vi.stubGlobal('indexedDB', undefined)
        vi.resetModules()
    })

    afterEach(() => {
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    it('uses assistant-ui universal matching so pasted images are accepted', async () => {
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const adapter = createAttachmentAdapter({} as never, 'session-1')

        expect(adapter.accept).toBe('*')
    })

    it('rejects oversized files before publishing a resumable running upload', async () => {
        const readAsDataUrl = vi.spyOn(FileReader.prototype, 'readAsDataURL')
        const uploadFile = vi.fn()
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const adapter = createAttachmentAdapter({ uploadFile } as never, 'session-1')
        const file = new File(['small fixture'], 'oversized.bin', { type: 'application/octet-stream' })
        Object.defineProperty(file, 'size', { configurable: true, value: 50 * 1024 * 1024 + 1 })
        const emitted = []

        for await (const attachment of adapter.add({ file }) as AsyncIterable<unknown>) {
            emitted.push(attachment)
        }

        expect(emitted).toHaveLength(1)
        expect(emitted[0]).toEqual(expect.objectContaining({
            status: { type: 'incomplete', reason: 'error' },
        }))
        expect(readAsDataUrl).not.toHaveBeenCalled()
        expect(uploadFile).not.toHaveBeenCalled()
    })

    it('restores an uploaded draft without uploading it again', async () => {
        const drafts = await import('./composer-attachment-drafts')
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const file = new File(['image'], 'ready.png', { type: 'image/png' })
        drafts.saveDraftAttachments('session-1', [{
            id: 'attachment-ready',
            file,
            path: '/uploads/ready.png',
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
        }])
        const [restored] = await drafts.getDraftAttachments('session-1')
        expect(restored).toBeDefined()

        const uploadFile = vi.fn()
        const adapter = createAttachmentAdapter({ uploadFile } as never, 'session-1')
        const emitted = []
        const additions = adapter.add({ file: restored! }) as AsyncIterable<unknown>
        for await (const attachment of additions) {
            emitted.push(attachment)
        }

        expect(uploadFile).not.toHaveBeenCalled()
        expect(emitted).toEqual([expect.objectContaining({
            id: 'attachment-ready',
            path: '/uploads/ready.png',
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
            status: { type: 'requires-action', reason: 'composer-send' },
        })])
    })

    it('re-uploads a restored CLI path when the resumed session id changed', async () => {
        const drafts = await import('./composer-attachment-drafts')
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const file = new File(['old session bytes'], 'resume.txt', { type: 'text/plain' })
        drafts.saveDraftAttachments('session-old', [{
            id: 'attachment-old',
            file,
            path: '/uploads/session-old/resume.txt',
        }])
        const [restored] = await drafts.getDraftAttachments('session-old')
        const uploadFile = vi.fn().mockResolvedValue({
            success: true,
            path: '/uploads/session-new/resume.txt',
        })
        const adapter = createAttachmentAdapter({ uploadFile } as never, 'session-new')
        const emitted = []

        for await (const attachment of adapter.add({ file: restored! }) as AsyncIterable<unknown>) {
            emitted.push(attachment)
        }

        expect(uploadFile).toHaveBeenCalledWith(
            'session-new',
            'resume.txt',
            expect.any(String),
            'text/plain',
        )
        expect(emitted.at(-1)).toEqual(expect.objectContaining({
            path: '/uploads/session-new/resume.txt',
            status: { type: 'requires-action', reason: 'composer-send' },
        }))
    })

    it('re-uploads a restored scratchlist draft without deleting the copied source blob', async () => {
        const drafts = await import('./composer-attachment-drafts')
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const file = new File(['scratchlist bytes'], 'ready.txt', { type: 'text/plain' })
        const hubAttachmentId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'
        const scratchlistPath = `hapi-hub:scratchlist/default/session-1/${hubAttachmentId}-ready.txt`
        drafts.saveDraftAttachments('session-1', [{
            id: 'attachment-ready',
            file,
            path: scratchlistPath,
        }])
        const [restored] = await drafts.getDraftAttachments('session-1')
        expect(restored).toBeDefined()

        const uploadFile = vi.fn().mockResolvedValue({
            success: true,
            path: '/uploads/reuploaded-ready.txt',
        })
        const deleteScratchlistAttachment = vi.fn()
        const adapter = createAttachmentAdapter({
            uploadFile,
            deleteScratchlistAttachment,
        } as never, 'session-1')
        const emitted = []
        const additions = adapter.add({ file: restored! }) as AsyncIterable<unknown>
        for await (const attachment of additions) {
            emitted.push(attachment)
        }

        expect(uploadFile).toHaveBeenCalledWith(
            'session-1',
            'ready.txt',
            expect.any(String),
            'text/plain',
        )
        expect(deleteScratchlistAttachment).not.toHaveBeenCalled()
        expect(emitted.at(-1)).toEqual(expect.objectContaining({
            path: '/uploads/reuploaded-ready.txt',
            status: { type: 'requires-action', reason: 'composer-send' },
        }))
        expect(emitted.at(-1)).not.toEqual(expect.objectContaining({
            id: 'attachment-ready',
            path: scratchlistPath,
        }))
    })

    it('keeps a successful upload usable when both preview attempts fail', async () => {
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
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
            throw new Error('thumbnail decode failed')
        })

        const uploadFile = vi.fn().mockResolvedValue({
            success: true,
            path: '/uploads/preview-failed.png',
        })
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const adapter = createAttachmentAdapter({ uploadFile } as never, 'session-1')
        const file = new File(['image'], 'preview-failed.png', { type: 'image/png' })
        const emitted = []

        for await (const attachment of adapter.add({ file }) as AsyncIterable<unknown>) {
            emitted.push(attachment)
        }

        expect(readCount).toBe(2)
        expect(emitted.at(-1)).toEqual(expect.objectContaining({
            path: '/uploads/preview-failed.png',
            previewUrl: undefined,
            status: { type: 'requires-action', reason: 'composer-send' },
        }))
    })

    it('deletes an uploaded file when remove races the preview await', async () => {
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
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
            throw new Error('thumbnail decode failed')
        })

        const uploadFile = vi.fn().mockResolvedValue({
            success: true,
            path: '/uploads/raced.png',
        })
        const deleteUploadFile = vi.fn().mockResolvedValue(undefined)
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const adapter = createAttachmentAdapter({ uploadFile, deleteUploadFile } as never, 'session-1')
        const file = new File(['image'], 'raced.png', { type: 'image/png' })
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
        expect(deleteUploadFile).toHaveBeenCalledWith('session-1', '/uploads/raced.png')
    })
})
