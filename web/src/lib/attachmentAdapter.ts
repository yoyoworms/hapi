import type { AttachmentAdapter, PendingAttachment, CompleteAttachment, Attachment } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata } from '@/types/api'
import { isImageMimeType } from '@/lib/fileAttachments'
import { randomId } from '@/lib/randomId'
import { getRestoredUploadMetadata } from '@/lib/composer-attachment-drafts'

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024
// Previews are persisted inline (base64) in the message content, so they must
// stay small. We downscale images to a thumbnail before embedding; a full-res
// data URL of a multi-MB photo previously bloated message rows to several MB
// each. If the thumbnail step fails we only inline the original when it is
// already under this cap, otherwise we skip the preview (renders as a file).
const PREVIEW_MAX_DIM = 1280
const PREVIEW_QUALITY = 0.72
const MAX_INLINE_PREVIEW_BYTES = 256 * 1024

type PendingUploadAttachment = PendingAttachment & {
    path?: string
    previewUrl?: string
}

// Shared map of uploaded attachment paths, keyed by attachment ID.
// Used by directSend (thinking mode) to retrieve paths that may not
// survive assistant-ui's internal state serialization.
export const uploadedAttachmentPaths = new Map<string, { path: string; previewUrl?: string }>()

export function createAttachmentAdapter(api: ApiClient, sessionId: string): AttachmentAdapter {
    const cancelledAttachmentIds = new Set<string>()

    const deleteUpload = async (path?: string) => {
        if (!path) return
        try {
            await api.deleteUploadFile(sessionId, path)
        } catch {
            // Best effort cleanup
        }
    }

    return {
        accept: '*/*',

        async *add({ file }): AsyncGenerator<PendingAttachment> {
            const restored = getRestoredUploadMetadata(file)
            if (restored) {
                yield {
                    id: restored.id,
                    type: 'file',
                    name: file.name,
                    contentType: file.type || 'application/octet-stream',
                    file,
                    status: { type: 'requires-action', reason: 'composer-send' },
                    path: restored.path,
                    previewUrl: restored.previewUrl,
                } as PendingUploadAttachment
                return
            }

            const id = randomId()
            const contentType = file.type || 'application/octet-stream'

            yield {
                id,
                type: 'file',
                name: file.name,
                contentType,
                file,
                status: { type: 'running', reason: 'uploading', progress: 0 }
            }

            try {
                if (cancelledAttachmentIds.has(id)) {
                    return
                }

                if (file.size > MAX_UPLOAD_BYTES) {
                    yield {
                        id,
                        type: 'file',
                        name: `${file.name} (file too large: ${(file.size / 1024 / 1024).toFixed(1)}MB)`,
                        contentType,
                        file,
                        status: { type: 'incomplete', reason: 'error' }
                    }
                    return
                }

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
                    status: { type: 'running', reason: 'uploading', progress: 50 }
                }

                const result = await api.uploadFile(sessionId, file.name, content, contentType)
                if (cancelledAttachmentIds.has(id)) {
                    if (result.success && result.path) {
                        await deleteUpload(result.path)
                    }
                    return
                }

                if (!result.success || !result.path) {
                    const serverErr = (result as { error?: string }).error ?? 'upload failed'
                    yield {
                        id,
                        type: 'file',
                        name: `${file.name} (${serverErr})`,
                        contentType,
                        file,
                        status: { type: 'incomplete', reason: 'error' }
                    }
                    return
                }

                // Generate a downscaled thumbnail preview for images under 5MB.
                // Kept small because it is persisted inline in the message content.
                let previewUrl: string | undefined
                if (isImageMimeType(contentType) && file.size <= MAX_PREVIEW_BYTES) {
                    try {
                        previewUrl = await fileToThumbnailDataUrl(file)
                    } catch {
                        previewUrl = file.size <= MAX_INLINE_PREVIEW_BYTES
                            ? await fileToDataUrl(file)
                            : undefined
                    }
                }

                // Save path for directSend access
                uploadedAttachmentPaths.set(id, { path: result.path!, previewUrl })

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'requires-action', reason: 'composer-send' },
                    path: result.path,
                    previewUrl
                } as PendingUploadAttachment
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err)
                console.error('[upload] attachment failed:', errMsg)
                yield {
                    id,
                    type: 'file',
                    name: `${file.name} (${errMsg})`,
                    contentType,
                    file,
                    status: { type: 'incomplete', reason: 'error' }
                }
            }
        },

        async remove(attachment: Attachment): Promise<void> {
            cancelledAttachmentIds.add(attachment.id)
            const path = (attachment as PendingUploadAttachment).path
            await deleteUpload(path)
        },

        async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
            const pending = attachment as PendingUploadAttachment
            const path = pending.path

            // Build AttachmentMetadata to be sent with the message
            const metadata: AttachmentMetadata | undefined = path ? {
                id: attachment.id,
                filename: attachment.name,
                mimeType: attachment.contentType ?? 'application/octet-stream',
                size: attachment.file?.size ?? 0,
                path,
                previewUrl: pending.previewUrl
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
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
            const result = reader.result as string
            const base64 = result.split(',')[1]
            if (!base64) {
                reject(new Error('Failed to read file'))
                return
            }
            resolve(base64)
        }
        reader.onerror = reject
        reader.readAsDataURL(file)
    })
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

function loadImageElement(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('image decode failed'))
        img.src = src
    })
}

/**
 * Downscale an image to a thumbnail data URL (JPEG) bounded by PREVIEW_MAX_DIM.
 * Keeps the inline preview to tens of KB instead of the multi-MB full-res image.
 */
async function fileToThumbnailDataUrl(file: File): Promise<string> {
    const objectUrl = URL.createObjectURL(file)
    try {
        const img = await loadImageElement(objectUrl)
        const largestSide = Math.max(img.width, img.height)
        const scale = largestSide > PREVIEW_MAX_DIM ? PREVIEW_MAX_DIM / largestSide : 1
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('no 2d canvas context')
        ctx.drawImage(img, 0, 0, w, h)
        return canvas.toDataURL('image/jpeg', PREVIEW_QUALITY)
    } finally {
        URL.revokeObjectURL(objectUrl)
    }
}
