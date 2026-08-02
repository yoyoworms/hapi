import { describe, expect, it } from 'vitest'
import { getClipboardImageFiles } from './clipboardAttachments'

describe('getClipboardImageFiles', () => {
    it('uses clipboard files when the browser populates them', () => {
        const image = new File(['image'], 'pasted.png', { type: 'image/png' })
        const text = new File(['text'], 'notes.txt', { type: 'text/plain' })

        expect(getClipboardImageFiles({
            files: [image, text] as unknown as FileList,
            items: [] as unknown as DataTransferItemList,
        })).toEqual([image])
    })

    it('falls back to items for contenteditable clipboard images', () => {
        const image = new File(['image'], 'pasted.png', { type: 'image/png' })

        expect(getClipboardImageFiles({
            files: [] as unknown as FileList,
            items: [{
                kind: 'file',
                type: 'image/png',
                getAsFile: () => image,
            }] as unknown as DataTransferItemList,
        })).toEqual([image])
    })
})
