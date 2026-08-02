import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { getClipboardImageFiles } from '@/lib/clipboardAttachments'
import { RichComposerInput } from './RichComposerInput'

describe('RichComposerInput clipboard attachments', () => {
    it('delegates an items-only clipboard image to the attachment paste handler', () => {
        const image = new File(['image'], 'pasted.png', { type: 'image/png' })
        const addAttachment = vi.fn()
        const onPaste = vi.fn((event: React.ClipboardEvent<HTMLDivElement>) => {
            for (const file of getClipboardImageFiles(event.clipboardData)) {
                addAttachment(file)
            }
            event.preventDefault()
        })

        render(
            <RichComposerInput
                value=""
                onValueChange={vi.fn()}
                onMirrorChange={vi.fn()}
                onPaste={onPaste}
            />
        )

        fireEvent.paste(screen.getByTestId('rich-composer-input'), {
            clipboardData: {
                files: [],
                items: [{
                    kind: 'file',
                    type: 'image/png',
                    getAsFile: () => image,
                }],
                getData: () => '',
            },
        })

        expect(onPaste).toHaveBeenCalledTimes(1)
        expect(addAttachment).toHaveBeenCalledWith(image)
    })

    it('keeps the rich plain-text paste path when the parent does not consume it', () => {
        const onValueChange = vi.fn()
        const onPaste = vi.fn()

        render(
            <RichComposerInput
                value=""
                onValueChange={onValueChange}
                onMirrorChange={vi.fn()}
                onPaste={onPaste}
            />
        )

        fireEvent.paste(screen.getByTestId('rich-composer-input'), {
            clipboardData: {
                files: [],
                items: [],
                getData: () => 'plain text',
            },
        })

        expect(onPaste).toHaveBeenCalledTimes(1)
        expect(onValueChange).toHaveBeenCalledWith('plain text')
    })
})
