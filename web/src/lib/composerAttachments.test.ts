import { describe, expect, it } from 'vitest'
import type { Attachment } from '@assistant-ui/react'
import { collectComposerAttachmentMetadata, getComposerAttachmentMetadata } from './composerAttachments'

describe('composerAttachments', () => {
    it('extracts metadata from complete attachments', () => {
        const metadata = {
            id: 'att-1',
            filename: 'plan.txt',
            mimeType: 'text/plain',
            size: 42,
            path: '/uploads/plan.txt'
        }
        const attachment: Attachment = {
            id: 'att-1',
            type: 'file',
            name: 'plan.txt',
            contentType: 'text/plain',
            status: { type: 'complete' },
            content: [{ type: 'text', text: JSON.stringify({ __attachmentMetadata: metadata }) }]
        }

        expect(getComposerAttachmentMetadata(attachment)).toEqual(metadata)
    })

    it('builds metadata for requires-action composer attachments', () => {
        const attachment = {
            id: 'att-2',
            type: 'file',
            name: 'image.png',
            contentType: 'image/png',
            status: { type: 'requires-action', reason: 'composer-send' as const },
            file: { size: 128 } as File,
            path: '/uploads/image.png',
            previewUrl: 'blob:preview'
        } satisfies Attachment & { path: string; previewUrl: string }

        expect(getComposerAttachmentMetadata(attachment)).toEqual({
            id: 'att-2',
            filename: 'image.png',
            mimeType: 'image/png',
            size: 128,
            path: '/uploads/image.png',
            previewUrl: 'blob:preview'
        })
    })

    it('skips attachments without usable metadata', () => {
        const attachments: Attachment[] = [
            {
                id: 'att-3',
                type: 'file',
                name: 'broken.txt',
                contentType: 'text/plain',
                status: { type: 'complete' },
                content: [{ type: 'text', text: 'not-json' }]
            },
            {
                id: 'att-4',
                type: 'file',
                name: 'uploading.txt',
                contentType: 'text/plain',
                status: { type: 'running', reason: 'uploading', progress: 50 },
                file: { size: 64 } as File
            }
        ]

        expect(collectComposerAttachmentMetadata(attachments)).toEqual([])
    })
})
