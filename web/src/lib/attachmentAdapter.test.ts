import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const NativeURL = globalThis.URL

function stubObjectUrl(
    createObjectURL: (blob: Blob) => string,
    revokeObjectURL: (url: string) => void,
): void {
    class URLMock extends NativeURL {}
    Object.defineProperties(URLMock, {
        createObjectURL: { configurable: true, value: createObjectURL },
        revokeObjectURL: { configurable: true, value: revokeObjectURL },
    })
    vi.stubGlobal('URL', URLMock)
}

async function collectAdditions(
    file: File,
    uploadFile = vi.fn(async () => ({ success: true, path: '/uploads/file' }))
) {
    const { createAttachmentAdapter } = await import('./attachmentAdapter')
    const adapter = createAttachmentAdapter({ uploadFile } as never, 'session-1')
    const additions = adapter.add({ file }) as AsyncIterable<Record<string, unknown>>
    const emitted: Record<string, unknown>[] = []

    for await (const attachment of additions) {
        emitted.push(attachment)
    }

    return { adapter, emitted, uploadFile }
}

function setReportedFileSize(file: File, size: number): File {
    Object.defineProperty(file, 'size', { configurable: true, value: size })
    return file
}

function installThumbnailMocks(previewUrls: string[]) {
    const createObjectURL = vi.fn(() => 'blob:thumbnail-source')
    const revokeObjectURL = vi.fn()
    stubObjectUrl(createObjectURL, revokeObjectURL)
    vi.stubGlobal('Image', class {
        naturalWidth = 2400
        naturalHeight = 1600
        width = 2400
        height = 1600
        onload: (() => void) | null = null
        onerror: (() => void) | null = null

        set src(_value: string) {
            this.onload?.()
        }
    })

    const context = {
        fillStyle: '',
        fillRect: vi.fn(),
        drawImage: vi.fn(),
    }
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue(context as never)
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    for (const previewUrl of previewUrls) {
        toDataURL.mockReturnValueOnce(previewUrl)
    }

    return { context, createObjectURL, getContext, revokeObjectURL, toDataURL }
}

async function getSentAttachmentMetadata(
    adapter: Awaited<ReturnType<typeof collectAdditions>>['adapter'],
    attachment: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const sent = await adapter.send(attachment as never) as unknown as {
        content?: Array<{ type: string; text?: string }>
    }
    const serialized = sent.content?.find((part) => part.type === 'text')?.text
    expect(serialized).toBeTruthy()
    const parsed = JSON.parse(serialized ?? '{}') as { __attachmentMetadata?: Record<string, unknown> }
    expect(parsed.__attachmentMetadata).toBeDefined()
    return parsed.__attachmentMetadata ?? {}
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', undefined)
    // jsdom has no image decoder. Make ordinary tests deterministically
    // exercise the small-file fallback; thumbnail-specific tests replace it.
    stubObjectUrl(
        vi.fn(() => { throw new Error('Image decoder unavailable') }),
        vi.fn(),
    )
    vi.resetModules()
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('attachmentAdapter', () => {
    it('uses the assistant-ui wildcard sentinel so all files reach the adapter', async () => {
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const adapter = createAttachmentAdapter({} as never, 'session-1')

        expect(adapter.accept).toBe('*')
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

    it('does not re-persist an oversized preview restored from a legacy draft', async () => {
        const drafts = await import('./composer-attachment-drafts')
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const oversizedPreview = `data:image/png;base64,${'A'.repeat(349_528 + 4)}`
        const file = new File(['image'], 'legacy.png', { type: 'image/png' })
        drafts.saveDraftAttachments('session-1', [{
            id: 'attachment-legacy',
            file,
            path: '/uploads/legacy.png',
            previewUrl: oversizedPreview,
        }])
        const [restored] = await drafts.getDraftAttachments('session-1')
        expect(restored).toBeDefined()

        const adapter = createAttachmentAdapter({ uploadFile: vi.fn() } as never, 'session-1')
        const emitted: Record<string, unknown>[] = []
        for await (const attachment of adapter.add({ file: restored! }) as AsyncIterable<Record<string, unknown>>) {
            emitted.push(attachment)
        }
        expect(emitted.at(-1)).toMatchObject({ previewUrl: oversizedPreview })

        const metadata = await getSentAttachmentMetadata(adapter, emitted.at(-1) ?? {})
        expect(metadata).not.toHaveProperty('previewUrl')
        expect(metadata).toMatchObject({ filename: 'legacy.png', path: '/uploads/legacy.png' })
    })

    it('uploads an image when the initial preview read fails', async () => {
        let readCount = 0
        class FileReaderMock {
            result: string | ArrayBuffer | null = null
            onload: FileReader['onload'] = null
            onerror: FileReader['onerror'] = null

            readAsDataURL(): void {
                readCount += 1
                if (readCount === 1) {
                    this.onerror?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>)
                    return
                }
                this.result = 'data:image/png;base64,dXBsb2Fk'
                this.onload?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>)
            }
        }
        vi.stubGlobal('FileReader', FileReaderMock)

        const file = new File(['proof'], 'proof.png', { type: 'image/png' })
        const { emitted, uploadFile } = await collectAdditions(file)

        expect(readCount).toBe(2)
        expect(uploadFile).toHaveBeenCalledWith('session-1', 'proof.png', 'dXBsb2Fk', 'image/png')
        expect(emitted.at(-1)).toMatchObject({
            status: { type: 'requires-action', reason: 'composer-send' },
            path: '/uploads/file'
        })
        expect(emitted.every((attachment) => attachment.previewUrl === undefined)).toBe(true)
    })
})

describe('attachmentAdapter image previews', () => {
    it('includes the preview URL in every image upload state', async () => {
        const file = new File(['image'], 'photo.png', { type: 'image/png' })
        const readSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL')
        const { emitted } = await collectAdditions(file)

        expect(emitted).toHaveLength(3)
        expect(emitted[0]).toMatchObject({
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
            status: { type: 'running', progress: 0 }
        })
        expect(emitted[1]).toMatchObject({
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
            status: { type: 'running', progress: 50 }
        })
        expect(emitted[2]).toMatchObject({
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
            status: { type: 'requires-action' }
        })
        // One read for the tiny persisted preview, one for the original upload.
        expect(readSpy).toHaveBeenCalledTimes(2)
    })

    it('uploads original image bytes while persisting a bounded multi-pass thumbnail', async () => {
        // First profile exceeds the 256 KiB decoded limit; the second profile
        // succeeds and must be the only image bytes persisted in metadata.
        const oversizedBase64 = 'A'.repeat(349_528 + 4)
        const oversizedPreview = `data:image/jpeg;base64,${oversizedBase64}`
        const thumbnailPreview = `data:image/jpeg;base64,${btoa('small-thumbnail')}`
        const mocks = installThumbnailMocks([oversizedPreview, thumbnailPreview])
        const originalText = 'full-resolution-original-image'
        const file = setReportedFileSize(
            new File([originalText], 'photo.png', { type: 'image/png' }),
            300 * 1024,
        )

        const { adapter, emitted, uploadFile } = await collectAdditions(file)
        const ready = emitted.at(-1)
        expect(ready).toMatchObject({
            previewUrl: thumbnailPreview,
            status: { type: 'requires-action' },
        })
        expect(mocks.toDataURL).toHaveBeenCalledTimes(2)
        expect(mocks.toDataURL).toHaveBeenNthCalledWith(1, 'image/jpeg', 0.76)
        expect(mocks.toDataURL).toHaveBeenNthCalledWith(2, 'image/jpeg', 0.70)
        expect(mocks.revokeObjectURL).toHaveBeenCalledWith('blob:thumbnail-source')

        const originalBase64 = btoa(originalText)
        expect(uploadFile).toHaveBeenCalledWith('session-1', 'photo.png', originalBase64, 'image/png')
        expect(uploadFile).not.toHaveBeenCalledWith(
            'session-1',
            'photo.png',
            thumbnailPreview.split(',')[1],
            'image/png',
        )

        const metadata = await getSentAttachmentMetadata(adapter, ready ?? {})
        expect(metadata).toMatchObject({
            filename: 'photo.png',
            previewUrl: thumbnailPreview,
        })
        const persistedPayload = (metadata.previewUrl as string).split(',')[1] ?? ''
        expect(atob(persistedPayload).length).toBeLessThanOrEqual(256 * 1024)
    })

    it('does not fall back to a large original when thumbnail decoding fails', async () => {
        stubObjectUrl(
            vi.fn(() => 'blob:broken-thumbnail-source'),
            vi.fn(),
        )
        vi.stubGlobal('Image', class {
            naturalWidth = 2400
            naturalHeight = 1600
            width = 2400
            height = 1600
            onload: (() => void) | null = null
            onerror: (() => void) | null = null

            set src(_value: string) {
                this.onerror?.()
            }
        })
        const originalText = 'large-original-still-uploaded'
        const file = setReportedFileSize(
            new File([originalText], 'broken.png', { type: 'image/png' }),
            300 * 1024,
        )

        const { adapter, emitted, uploadFile } = await collectAdditions(file)
        expect(emitted).toHaveLength(3)
        expect(emitted.every((attachment) => attachment.previewUrl === undefined)).toBe(true)
        expect(uploadFile).toHaveBeenCalledWith(
            'session-1',
            'broken.png',
            btoa(originalText),
            'image/png',
        )

        const metadata = await getSentAttachmentMetadata(adapter, emitted.at(-1) ?? {})
        expect(metadata).not.toHaveProperty('previewUrl')
        expect(metadata).toMatchObject({ filename: 'broken.png', path: '/uploads/file' })
    })

    it('does not generate previews for non-image attachments', async () => {
        const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
        const { emitted } = await collectAdditions(file)

        expect(emitted).toHaveLength(3)
        expect(emitted.every((attachment) => attachment.previewUrl === undefined)).toBe(true)
    })

    it('hands an inactive attachment to the resumed session before uploading', async () => {
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const file = new File(['image'], 'ready.png', { type: 'image/png' })
        const uploadFile = vi.fn().mockResolvedValue({ success: true, path: '/uploads/ready.png' })
        const resolveSessionId = vi.fn().mockResolvedValue('session-resumed')
        const onSessionResolved = vi.fn().mockResolvedValue(undefined)
        const adapter = createAttachmentAdapter(
            { uploadFile } as never,
            'session-inactive',
            resolveSessionId,
            onSessionResolved,
        )

        const additions = adapter.add({ file }) as AsyncIterable<unknown>
        for await (const _attachment of additions) {
            // Consume the upload lifecycle.
        }

        expect(resolveSessionId).toHaveBeenCalledOnce()
        expect(onSessionResolved).toHaveBeenCalledWith('session-resumed', expect.objectContaining({
            id: expect.any(String),
            file,
            isCancelled: expect.any(Function),
        }))
        expect(uploadFile).not.toHaveBeenCalled()

    })

    it('still hands off after resume when the attachment is cancelled mid-flight', async () => {
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const file = new File(['image'], 'ready.png', { type: 'image/png' })
        const uploadFile = vi.fn().mockResolvedValue({ success: true, path: '/uploads/ready.png' })
        let releaseResolve!: (sessionId: string) => void
        let markResolveStarted!: () => void
        const resolveSessionReady = new Promise<void>((resolve) => {
            markResolveStarted = resolve
        })
        const resolveSessionId = vi.fn().mockImplementation(() => {
            markResolveStarted()
            return new Promise<string>((resolve) => {
                releaseResolve = resolve
            })
        })
        const onSessionResolved = vi.fn().mockResolvedValue(undefined)
        const adapter = createAttachmentAdapter(
            { uploadFile } as never,
            'session-inactive',
            resolveSessionId,
            onSessionResolved,
        )

        const additions = adapter.add({ file }) as AsyncIterable<Record<string, unknown>>
        const iterator = additions[Symbol.asyncIterator]()
        const first = await iterator.next()
        const pendingId = first.value?.id as string
        expect(pendingId).toBeTruthy()

        const remainder = iterator.next()
        await resolveSessionReady
        await adapter.remove({ id: pendingId } as never)
        releaseResolve('session-resumed')
        await remainder

        expect(resolveSessionId).toHaveBeenCalledOnce()
        // Resume already merged the source session away — hand off with a live
        // cancellation predicate (never drop the id), and never upload.
        expect(onSessionResolved).toHaveBeenCalledWith('session-resumed', expect.objectContaining({
            id: pendingId,
            file,
            isCancelled: expect.any(Function),
        }))
        const handoff = onSessionResolved.mock.calls[0]?.[1] as { isCancelled: () => boolean }
        expect(handoff.isCancelled()).toBe(true)
        expect(uploadFile).not.toHaveBeenCalled()
    })

    it('shares one resume promise across staggered inactive attachment generators', async () => {
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const file1 = new File(['one'], 'one.txt', { type: 'text/plain' })
        const file2 = new File(['two'], 'two.txt', { type: 'text/plain' })
        const uploadFile = vi.fn()
        let resolveResume!: (sessionId: string) => void
        let resumeCalls = 0
        let uploadResolution: Promise<string> | undefined
        const resolveSessionId = vi.fn(() => {
            resumeCalls += 1
            return new Promise<string>((resolve) => {
                resolveResume = resolve
            })
        })
        const resolveUploadSession = () => {
            uploadResolution ??= resolveSessionId().catch((error) => {
                uploadResolution = undefined
                throw error
            })
            return uploadResolution
        }
        const onSessionResolved = vi.fn().mockResolvedValue(undefined)
        const adapter = createAttachmentAdapter(
            { uploadFile } as never,
            'session-inactive',
            resolveUploadSession,
            onSessionResolved,
        )

        const first = (async () => {
            for await (const _ of adapter.add({ file: file1 }) as AsyncIterable<unknown>) {
                // consume
            }
        })()
        const second = (async () => {
            for await (const _ of adapter.add({ file: file2 }) as AsyncIterable<unknown>) {
                // consume
            }
        })()

        await vi.waitFor(() => {
            expect(resumeCalls).toBe(1)
        })
        resolveResume('session-resumed')
        await Promise.all([first, second])
        expect(resumeCalls).toBe(1)
        expect(onSessionResolved).toHaveBeenCalled()
        expect(uploadFile).not.toHaveBeenCalled()
    })
})
