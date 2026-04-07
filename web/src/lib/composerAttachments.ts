import type { Attachment } from '@assistant-ui/react'
import type { AttachmentMetadata } from '@/types/api'

type AttachmentMetadataEnvelope = {
    __attachmentMetadata: AttachmentMetadata
}

type TextPart = {
    type: 'text'
    text: string
}

type UploadingComposerAttachment = Attachment & {
    path?: string
    previewUrl?: string
}

function parseAttachmentMetadata(text: string): AttachmentMetadata | null {
    try {
        const parsed = JSON.parse(text) as unknown
        if (!parsed || typeof parsed !== 'object' || !('__attachmentMetadata' in parsed)) {
            return null
        }
        return (parsed as AttachmentMetadataEnvelope).__attachmentMetadata
    } catch {
        return null
    }
}

export function getComposerAttachmentMetadata(attachment: Attachment): AttachmentMetadata | null {
    if (attachment.status.type === 'complete') {
        const content = attachment.content ?? []
        for (const part of content) {
            if (part.type !== 'text') continue
            const metadata = parseAttachmentMetadata((part as TextPart).text)
            if (metadata) {
                return metadata
            }
        }
        return null
    }

    if (attachment.status.type !== 'requires-action') {
        return null
    }

    const uploadAttachment = attachment as UploadingComposerAttachment
    if (!uploadAttachment.path) {
        return null
    }

    return {
        id: attachment.id,
        filename: attachment.name,
        mimeType: attachment.contentType ?? 'application/octet-stream',
        size: attachment.file?.size ?? 0,
        path: uploadAttachment.path,
        previewUrl: uploadAttachment.previewUrl
    }
}

export function collectComposerAttachmentMetadata(attachments: readonly Attachment[]): AttachmentMetadata[] {
    const metadata: AttachmentMetadata[] = []
    for (const attachment of attachments) {
        const entry = getComposerAttachmentMetadata(attachment)
        if (entry) {
            metadata.push(entry)
        }
    }
    return metadata
}
