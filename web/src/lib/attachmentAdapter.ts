import type { AttachmentAdapter, PendingAttachment, CompleteAttachment, Attachment } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata } from '@/types/api'
import { isImageMimeType } from '@/lib/fileAttachments'
import { randomId } from '@/lib/randomId'
import { getRestoredUploadMetadata } from '@/lib/composer-attachment-drafts'
import type { AttachmentDraftHandoff } from '@/lib/composer-draft-transfer'

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024
// Message previews are persisted inline, so a full-resolution data URL makes
// every history fetch pay for the original image again. Keep the decoded
// thumbnail payload below 256 KiB; the base64 text is roughly 4/3 larger.
const MAX_INLINE_PREVIEW_BYTES = 256 * 1024
const PREVIEW_PROFILES = [
    { maxDimension: 1280, quality: 0.76 },
    { maxDimension: 1024, quality: 0.70 },
    { maxDimension: 896, quality: 0.64 },
    { maxDimension: 768, quality: 0.58 },
    { maxDimension: 640, quality: 0.52 },
    { maxDimension: 512, quality: 0.46 },
] as const

type PendingUploadAttachment = PendingAttachment & {
    path?: string
    previewUrl?: string
    uploadSessionId?: string
}

export function createAttachmentAdapter(
    api: ApiClient,
    sessionId: string,
    resolveSessionId?: () => Promise<string>,
    // Always hand off after resume merges into a new session id — even when
    // the pick is cancelled — so the caller can navigate off a deleted source.
    // Cancellation is re-checked at transfer save time via isCancelled().
    onSessionResolved?: (sessionId: string, pending: AttachmentDraftHandoff) => Promise<void>,
): AttachmentAdapter {
    const cancelledAttachmentIds = new Set<string>()

    const deleteUpload = async (path?: string, uploadSessionId = sessionId) => {
        if (!path) return
        try {
            await api.deleteUploadFile(uploadSessionId, path)
        } catch {
            // Best effort cleanup
        }
    }

    return {
        // assistant-ui uses the exact "*" sentinel for an allow-all adapter.
        // "*/*" is forwarded to MIME matching and rejects every file before
        // this adapter's add() method can run.
        accept: '*',

        async *add({ file }): AsyncGenerator<PendingAttachment> {
            // Upload paths are scoped to the session that created them. An
            // inactive composer may resume into a different session id, so its
            // persisted file must follow the normal resolve/transfer flow and
            // be uploaded again by the resumed composer. Pathless restored
            // metadata still supplies a stable id so draft merge cannot
            // duplicate the same File across persistence passes.
            const restored = getRestoredUploadMetadata(file)
            if (!resolveSessionId && restored?.path) {
                yield {
                    id: restored.id,
                    type: 'file',
                    name: file.name,
                    contentType: file.type || 'application/octet-stream',
                    file,
                    status: { type: 'requires-action', reason: 'composer-send' },
                    path: restored.path,
                    previewUrl: restored.previewUrl,
                    uploadSessionId: restored.uploadSessionId,
                } as PendingUploadAttachment
                return
            }

            const id = restored?.id ?? randomId()
            const contentType = file.type || 'application/octet-stream'

            try {
                let previewUrl: string | undefined
                if (isImageMimeType(contentType) && file.size <= MAX_PREVIEW_BYTES) {
                    previewUrl = await createPersistableImagePreview(file)
                }

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'running', reason: 'uploading', progress: 0 },
                    previewUrl
                } as PendingUploadAttachment

                if (cancelledAttachmentIds.has(id)) {
                    return
                }

                if (file.size > MAX_UPLOAD_BYTES) {
                    yield {
                        id,
                        type: 'file',
                        name: file.name,
                        contentType,
                        file,
                        status: { type: 'incomplete', reason: 'error' }
                    }
                    return
                }

                const uploadSessionId = resolveSessionId ? await resolveSessionId() : sessionId
                // Resume may already have merged the source session away. Always
                // hand off with a live cancellation predicate so transfer can
                // drop this id (even if already persisted on the source draft).
                if (uploadSessionId !== sessionId && onSessionResolved) {
                    await onSessionResolved(uploadSessionId, {
                        id,
                        file,
                        previewUrl,
                        isCancelled: () => cancelledAttachmentIds.has(id),
                    })
                    return
                }
                if (cancelledAttachmentIds.has(id)) {
                    return
                }

                // The preview is deliberately downscaled. Always upload the
                // original File so the agent retains full image detail.
                const content = await fileToBase64(file)

                if (cancelledAttachmentIds.has(id)) {
                    return
                }

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'running', reason: 'uploading', progress: 50 },
                    previewUrl
                } as PendingUploadAttachment

                const result = await api.uploadFile(uploadSessionId, file.name, content, contentType)
                if (cancelledAttachmentIds.has(id)) {
                    if (result.success && result.path) {
                        await deleteUpload(result.path, uploadSessionId)
                    }
                    return
                }

                if (!result.success || !result.path) {
                    yield {
                        id,
                        type: 'file',
                        name: file.name,
                        contentType,
                        file,
                        status: { type: 'incomplete', reason: 'error' }
                    }
                    return
                }

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'requires-action', reason: 'composer-send' },
                    path: result.path,
                    previewUrl,
                    uploadSessionId,
                } as PendingUploadAttachment

            } catch {
                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'incomplete', reason: 'error' }
                }
            }
        },

        async remove(attachment: Attachment): Promise<void> {
            cancelledAttachmentIds.add(attachment.id)
            const path = (attachment as PendingUploadAttachment).path
            const uploadSessionId = (attachment as PendingUploadAttachment).uploadSessionId
            await deleteUpload(path, uploadSessionId)
        },

        async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
            const pending = attachment as PendingUploadAttachment
            const path = pending.path
            const previewUrl = pending.previewUrl
                && dataUrlBinarySize(pending.previewUrl) <= MAX_INLINE_PREVIEW_BYTES
                ? pending.previewUrl
                : undefined

            // Build AttachmentMetadata to be sent with the message
            const metadata: AttachmentMetadata | undefined = path ? {
                id: attachment.id,
                filename: attachment.name,
                mimeType: attachment.contentType ?? 'application/octet-stream',
                size: attachment.file?.size ?? 0,
                path,
                previewUrl
            } : undefined

            return {
                id: attachment.id,
                type: attachment.type,
                name: attachment.name,
                contentType: attachment.contentType,
                status: { type: 'complete' },
                // Store metadata as JSON in the text content for extraction by assistant-runtime
                content: metadata ? [{ type: 'text', text: JSON.stringify({ __attachmentMetadata: metadata }) }] : []
            }
        }
    }
}

async function fileToBase64(file: File): Promise<string> {
    return base64FromDataUrl(await fileToDataUrl(file))
}

function base64FromDataUrl(dataUrl: string): string {
    const separatorIndex = dataUrl.indexOf(',')
    const base64 = separatorIndex >= 0 ? dataUrl.slice(separatorIndex + 1) : ''
    if (!base64) {
        throw new Error('Failed to read file')
    }
    return base64
}

async function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
            resolve(reader.result as string)
        }
        reader.onerror = reject
        reader.readAsDataURL(file)
    })
}

function dataUrlBinarySize(dataUrl: string): number {
    const separatorIndex = dataUrl.indexOf(',')
    if (separatorIndex < 0 || !dataUrl.slice(0, separatorIndex).includes(';base64')) {
        return Number.POSITIVE_INFINITY
    }
    const payload = dataUrl.slice(separatorIndex + 1)
    if (!payload) return Number.POSITIVE_INFINITY
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
    return Math.max(0, Math.floor(payload.length * 3 / 4) - padding)
}

async function createPersistableImagePreview(file: File): Promise<string | undefined> {
    try {
        return await fileToThumbnailDataUrl(file)
    } catch {
        // Tiny images are already safe to persist unchanged. Never fall back
        // to a multi-megabyte original when browser image decoding/canvas fails.
        if (file.size > MAX_INLINE_PREVIEW_BYTES) return undefined
        try {
            const dataUrl = await fileToDataUrl(file)
            return dataUrlBinarySize(dataUrl) <= MAX_INLINE_PREVIEW_BYTES
                ? dataUrl
                : undefined
        } catch {
            return undefined
        }
    }
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('Image preview decode failed'))
        image.src = src
    })
}

async function fileToThumbnailDataUrl(file: File): Promise<string> {
    const objectUrl = URL.createObjectURL(file)
    try {
        const image = await loadImageElement(objectUrl)
        const largestSide = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height)
        if (!Number.isFinite(largestSide) || largestSide <= 0) {
            throw new Error('Image preview has invalid dimensions')
        }

        const sourceWidth = image.naturalWidth || image.width
        const sourceHeight = image.naturalHeight || image.height
        const canvas = document.createElement('canvas')

        for (const profile of PREVIEW_PROFILES) {
            const scale = Math.min(1, profile.maxDimension / largestSide)
            canvas.width = Math.max(1, Math.round(sourceWidth * scale))
            canvas.height = Math.max(1, Math.round(sourceHeight * scale))
            const context = canvas.getContext('2d')
            if (!context) throw new Error('Image preview canvas unavailable')
            // JPEG has no alpha channel. A white background avoids transparent
            // screenshots becoming black in browsers with differing defaults.
            context.fillStyle = '#fff'
            context.fillRect(0, 0, canvas.width, canvas.height)
            context.drawImage(image, 0, 0, canvas.width, canvas.height)
            const previewUrl = canvas.toDataURL('image/jpeg', profile.quality)
            if (dataUrlBinarySize(previewUrl) <= MAX_INLINE_PREVIEW_BYTES) {
                return previewUrl
            }
        }

        throw new Error('Image preview exceeds inline size limit')
    } finally {
        URL.revokeObjectURL(objectUrl)
    }
}
