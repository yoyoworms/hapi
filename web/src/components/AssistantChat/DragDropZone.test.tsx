import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'

const addAttachment = vi.fn()

vi.mock('@assistant-ui/react', () => ({
    useAui: () => ({
        composer: () => ({ addAttachment }),
    }),
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

import { DragDropZone } from './DragDropZone'

function createDropEvent(types: string[], files: File[]): Event {
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
        value: { types, files },
        configurable: true,
    })
    return event
}

describe('DragDropZone drop handling', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('adds dropped files as attachments and cancels the browser default', () => {
        const { container } = render(
            <DragDropZone>
                <div />
            </DragDropZone>
        )
        const zone = container.firstChild as HTMLElement
        const file = new File(['x'], 'a.txt', { type: 'text/plain' })
        const event = createDropEvent(['Files'], [file])

        fireEvent(zone, event)

        expect(event.defaultPrevented).toBe(true)
        expect(addAttachment).toHaveBeenCalledTimes(1)
        expect(addAttachment).toHaveBeenCalledWith(file)
    })

    it('ignores non-file drops so the browser keeps its default (e.g. text into composer)', () => {
        const { container } = render(
            <DragDropZone>
                <div />
            </DragDropZone>
        )
        const zone = container.firstChild as HTMLElement
        const event = createDropEvent(['text/plain'], [])

        fireEvent(zone, event)

        expect(event.defaultPrevented).toBe(false)
        expect(addAttachment).not.toHaveBeenCalled()
    })

    it('does not attach when disabled but still cancels the file default', () => {
        const { container } = render(
            <DragDropZone disabled>
                <div />
            </DragDropZone>
        )
        const zone = container.firstChild as HTMLElement
        const file = new File(['x'], 'a.txt', { type: 'text/plain' })
        const event = createDropEvent(['Files'], [file])

        fireEvent(zone, event)

        expect(event.defaultPrevented).toBe(true)
        expect(addAttachment).not.toHaveBeenCalled()
    })

    it('processes every dropped file sequentially even when one attachment rejects', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        addAttachment
            .mockRejectedValueOnce(new Error('first failed'))
            .mockResolvedValueOnce(undefined)
        const { container } = render(
            <DragDropZone>
                <div />
            </DragDropZone>
        )
        const zone = container.firstChild as HTMLElement
        const first = new File(['a'], 'a.txt', { type: 'text/plain' })
        const second = new File(['b'], 'b.txt', { type: 'text/plain' })

        fireEvent(zone, createDropEvent(['Files'], [first, second]))

        await waitFor(() => expect(addAttachment).toHaveBeenCalledTimes(2))
        expect(addAttachment).toHaveBeenNthCalledWith(1, first)
        expect(addAttachment).toHaveBeenNthCalledWith(2, second)
        await waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
            'Error adding dragged file:',
            expect.any(Error),
        ))
        errorSpy.mockRestore()
    })
})
