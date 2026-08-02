import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FormHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    addComposerInputHistory,
    getComposerInputHistory,
    HappyComposer,
} from './HappyComposer'

type TestAuiState = {
    composer: {
        text: string
        attachments: TestAttachment[]
    }
    thread: {
        isRunning: boolean
        isDisabled: boolean
    }
}

type TestAttachment = {
    id: string
    name: string
    contentType: string
    status:
        | { type: 'complete' }
        | { type: 'incomplete'; reason: 'error' }
    file: File
}

const harness = vi.hoisted(() => ({
    composerText: '',
    attachments: [] as TestAttachment[],
    isTouch: false,
    threadIsRunning: false,
    setText: vi.fn<(text: string) => void>(),
    send: vi.fn<() => void>(),
    addAttachment: vi.fn<(file: File) => Promise<void>>(),
    prepareForSubmit: vi.fn<() => void>(),
    completeSubmission: vi.fn<() => void>(),
    restoreAttachments: vi.fn<(sessionId?: string) => Promise<void>>(),
    draftAttachments: [] as unknown[],
    cancelRun: vi.fn<() => Promise<void>>(),
    hapticImpact: vi.fn<(style: string) => void>(),
    hapticNotification: vi.fn<(style: string) => void>(),
    moveUp: vi.fn<() => void>(),
    moveDown: vi.fn<() => void>(),
    clearSuggestions: vi.fn<() => void>(),
}))

vi.mock('@assistant-ui/react', async () => {
    const React = await import('react')

    type ComposerInputProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
        maxRows?: number
        submitOnEnter?: boolean
        cancelOnEscape?: boolean
    }

    return {
        useAui: () => ({
            composer: () => ({
                setText: harness.setText,
                send: harness.send,
                addAttachment: harness.addAttachment,
                getState: () => ({
                    text: harness.composerText,
                    attachments: harness.attachments,
                }),
            }),
            thread: () => ({ cancelRun: harness.cancelRun }),
        }),
        useAuiState: (selector: (state: TestAuiState) => unknown) => selector({
            composer: { text: harness.composerText, attachments: harness.attachments },
            thread: { isRunning: harness.threadIsRunning, isDisabled: false },
        }),
        ComposerPrimitive: {
            Root: (props: FormHTMLAttributes<HTMLFormElement>) => React.createElement('form', props),
            Input: React.forwardRef<HTMLTextAreaElement, ComposerInputProps>((props, ref) => {
                const { maxRows: _maxRows, submitOnEnter: _submitOnEnter, cancelOnEscape: _cancelOnEscape, ...textareaProps } = props
                return React.createElement('textarea', {
                    ...textareaProps,
                    ref,
                    'aria-label': 'composer input',
                    defaultValue: harness.composerText,
                })
            }),
            Attachments: () => null,
        },
    }
})

vi.mock('@/components/AssistantChat/RichComposerInput', async () => {
    const React = await import('react')
    return {
        RichComposerInput: React.forwardRef(() => React.createElement('div', {
            'data-testid': 'rich-composer-input',
        })),
    }
})

vi.mock('@/components/AssistantChat/StatusBar', () => ({
    StatusBar: () => null,
}))

vi.mock('@/components/AssistantChat/ComposerButtons', async () => {
    const React = await import('react')
    return {
        ComposerButtons: (props: {
            canSend: boolean
            onSend: () => void
            abortDisabled: boolean
            onAbort: () => void
        }) => React.createElement(React.Fragment, null,
            React.createElement('button', {
                type: 'button',
                disabled: !props.canSend,
                onClick: props.onSend,
            }, 'Send'),
            React.createElement('button', {
                type: 'button',
                disabled: props.abortDisabled,
                onClick: props.onAbort,
            }, 'Abort'),
        ),
    }
})

vi.mock('@/hooks/useActiveWord', () => ({
    useActiveWord: () => null,
}))

vi.mock('@/hooks/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [
        [],
        -1,
        harness.moveUp,
        harness.moveDown,
        harness.clearSuggestions,
    ],
}))

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        isTouch: harness.isTouch,
        haptic: {
            impact: harness.hapticImpact,
            notification: harness.hapticNotification,
        },
    }),
}))

vi.mock('@/hooks/usePWAInstall', () => ({
    usePWAInstall: () => ({ isStandalone: false, isIOS: false }),
}))

vi.mock('@/hooks/useComposerEnterBehavior', () => ({
    useComposerEnterBehavior: () => ({ composerEnterBehavior: 'send' }),
}))

vi.mock('@/hooks/useComposerDraft', () => ({
    useComposerDraft: (...args: unknown[]) => {
        harness.draftAttachments = (args[2] as unknown[] | undefined) ?? []
        return {
            prepareForSubmit: harness.prepareForSubmit,
            completeSubmission: harness.completeSubmission,
            restoreAttachments: harness.restoreAttachments,
        }
    },
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

describe('composer input history storage', () => {
    beforeEach(() => {
        window.localStorage.removeItem('hapi:composer-input-history:v2')
    })

    it('persists isolated, trimmed, adjacent-deduplicated session histories', () => {
        addComposerInputHistory('session-a', '  first prompt  ')
        addComposerInputHistory('session-a', 'first prompt')
        addComposerInputHistory('session-a', 'second prompt')
        addComposerInputHistory('session-b', 'other session')

        expect(getComposerInputHistory('session-a')).toEqual(['first prompt', 'second prompt'])
        expect(getComposerInputHistory('session-b')).toEqual(['other session'])
        expect(getComposerInputHistory(undefined)).toEqual([])
    })

    it('keeps only the latest 100 non-empty entries and tolerates corrupt storage', () => {
        for (let index = 1; index <= 101; index += 1) {
            addComposerInputHistory('session-a', `prompt ${index}`)
        }

        const history = getComposerInputHistory('session-a')
        expect(history).toHaveLength(100)
        expect(history[0]).toBe('prompt 2')
        expect(history[99]).toBe('prompt 101')

        window.localStorage.setItem('hapi:composer-input-history:v2', '{invalid json')
        expect(getComposerInputHistory('session-a')).toEqual([])
    })

    it('bounds global storage with session LRU and rejects giant entries', () => {
        for (let index = 0; index < 25; index += 1) {
            addComposerInputHistory(`session-${index}`, `prompt ${index}`)
        }

        expect(getComposerInputHistory('session-4')).toEqual([])
        expect(getComposerInputHistory('session-5')).toEqual(['prompt 5'])
        expect(getComposerInputHistory('session-24')).toEqual(['prompt 24'])

        addComposerInputHistory('session-24', 'x'.repeat(20_001))
        expect(getComposerInputHistory('session-24')).toEqual(['prompt 24'])
    })

    it('prunes oversized legacy storage before writing a new entry', () => {
        const oversized = Object.fromEntries(
            Array.from({ length: 20 }, (_, sessionIndex) => [
                `legacy-${sessionIndex}`,
                Array.from(
                    { length: 40 },
                    (_, entryIndex) => `${sessionIndex}:${entryIndex}:${'x'.repeat(1_000)}`
                ),
            ])
        )
        window.localStorage.setItem(
            'hapi:composer-input-history:v2',
            JSON.stringify(oversized)
        )

        addComposerInputHistory('newest-session', 'kept')

        const raw = window.localStorage.getItem('hapi:composer-input-history:v2') ?? ''
        expect(raw.length).toBeLessThanOrEqual(500_000)
        expect(getComposerInputHistory('newest-session')).toEqual(['kept'])
    })
})

describe('HappyComposer textarea keyboard contracts', () => {
    beforeEach(() => {
        window.localStorage.clear()
        harness.composerText = 'draft in progress'
        harness.attachments = []
        harness.isTouch = false
        harness.threadIsRunning = false
        harness.setText.mockClear()
        harness.send.mockClear()
        harness.addAttachment.mockReset()
        harness.addAttachment.mockResolvedValue(undefined)
        harness.prepareForSubmit.mockReset()
        harness.completeSubmission.mockReset()
        harness.restoreAttachments.mockReset()
        harness.restoreAttachments.mockResolvedValue(undefined)
        harness.draftAttachments = []
        harness.cancelRun.mockReset()
        harness.cancelRun.mockResolvedValue(undefined)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('defaults to the textarea and walks backward/forward through per-session history', () => {
        addComposerInputHistory('session-a', 'older prompt')
        addComposerInputHistory('session-a', 'newer prompt')
        render(<HappyComposer sessionId="session-a" />)

        expect(screen.queryByTestId('rich-composer-input')).not.toBeInTheDocument()
        const input = screen.getByRole('textbox', { name: 'composer input' }) as HTMLTextAreaElement
        input.setSelectionRange(0, 0)

        fireEvent.keyDown(input, { key: 'ArrowUp' })
        expect(harness.setText).toHaveBeenLastCalledWith('newer prompt')

        fireEvent.keyDown(input, { key: 'ArrowUp' })
        expect(harness.setText).toHaveBeenLastCalledWith('older prompt')

        fireEvent.keyDown(input, { key: 'ArrowDown' })
        expect(harness.setText).toHaveBeenLastCalledWith('newer prompt')

        fireEvent.keyDown(input, { key: 'ArrowDown' })
        expect(harness.setText).toHaveBeenLastCalledWith('draft in progress')
    })

    it('does not leave a recalled multiline entry until ArrowDown is pressed on its last line', () => {
        addComposerInputHistory('session-a', 'first line\nsecond line')
        render(<HappyComposer sessionId="session-a" />)

        const input = screen.getByRole('textbox', { name: 'composer input' }) as HTMLTextAreaElement
        input.setSelectionRange(0, 0)
        fireEvent.keyDown(input, { key: 'ArrowUp' })
        expect(harness.setText).toHaveBeenCalledTimes(1)

        input.value = 'first line\nsecond line'
        input.setSelectionRange(3, 3)
        fireEvent.keyDown(input, { key: 'ArrowDown' })
        expect(harness.setText).toHaveBeenCalledTimes(1)

        input.setSelectionRange(input.value.length, input.value.length)
        fireEvent.keyDown(input, { key: 'ArrowDown' })
        expect(harness.setText).toHaveBeenLastCalledWith('draft in progress')
    })

    it('does not move to older history while ArrowUp is navigating inside a recalled multiline entry', () => {
        addComposerInputHistory('session-a', 'older prompt')
        addComposerInputHistory('session-a', 'first line\nsecond line')
        render(<HappyComposer sessionId="session-a" />)

        const input = screen.getByRole('textbox', { name: 'composer input' }) as HTMLTextAreaElement
        input.setSelectionRange(0, 0)
        fireEvent.keyDown(input, { key: 'ArrowUp' })
        expect(harness.setText).toHaveBeenLastCalledWith('first line\nsecond line')

        input.value = 'first line\nsecond line'
        input.setSelectionRange(input.value.length, input.value.length)
        fireEvent.keyDown(input, { key: 'ArrowUp' })
        expect(harness.setText).toHaveBeenCalledTimes(1)

        input.setSelectionRange(3, 3)
        fireEvent.keyDown(input, { key: 'ArrowUp' })
        expect(harness.setText).toHaveBeenLastCalledWith('older prompt')
    })

    it('leaves touch Enter for newline insertion and sends from the button', () => {
        harness.isTouch = true
        render(<HappyComposer sessionId="session-a" />)

        const input = screen.getByRole('textbox', { name: 'composer input' })
        expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true)
        expect(harness.send).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        expect(harness.send).toHaveBeenCalledTimes(1)
        expect(harness.prepareForSubmit).toHaveBeenCalledWith('draft in progress')
        expect(harness.prepareForSubmit.mock.invocationCallOrder[0]).toBeLessThan(
            harness.send.mock.invocationCallOrder[0]!
        )
        expect(getComposerInputHistory('session-a')).toEqual(['draft in progress'])
    })

    it('keeps desktop plain Enter as send', () => {
        render(<HappyComposer sessionId="session-a" />)

        const input = screen.getByRole('textbox', { name: 'composer input' })
        expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
        expect(harness.send).toHaveBeenCalledTimes(1)
    })

    it('blocks attachment paste when the session cannot upload and shows a local alert', () => {
        render(<HappyComposer sessionId="session-a" attachmentsSupported={false} />)
        const image = new File(['image'], 'pasted.png', { type: 'image/png' })

        fireEvent.paste(screen.getByRole('textbox', { name: 'composer input' }), {
            clipboardData: {
                files: [image],
                items: [],
            },
        })

        expect(harness.addAttachment).not.toHaveBeenCalled()
        expect(screen.getByRole('alert')).toHaveTextContent('composer.attachUnavailableInactive')
    })

    it('blocks attachment paste while a schedule is active', () => {
        render(
            <HappyComposer
                sessionId="session-a"
                pendingSchedule={{ type: 'absolute', ms: Date.now() + 60_000 }}
                onSchedule={() => undefined}
            />
        )
        const image = new File(['image'], 'pasted.png', { type: 'image/png' })

        fireEvent.paste(screen.getByRole('textbox', { name: 'composer input' }), {
            clipboardData: {
                files: [image],
                items: [],
            },
        })

        expect(harness.addAttachment).not.toHaveBeenCalled()
        expect(screen.getByRole('alert')).toHaveTextContent('composer.attachBlockedBySchedule')
    })

    it('uploads pasted images sequentially and one failure does not block the others', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        harness.addAttachment.mockImplementation((file) => file.name === 'bad.png'
            ? Promise.reject(new Error('upload failed'))
            : Promise.resolve())
        render(<HappyComposer sessionId="session-a" />)
        const good = new File(['good'], 'good.png', { type: 'image/png' })
        const bad = new File(['bad'], 'bad.png', { type: 'image/png' })

        fireEvent.paste(screen.getByRole('textbox', { name: 'composer input' }), {
            clipboardData: {
                files: [bad, good],
                items: [],
            },
        })

        await waitFor(() => expect(harness.addAttachment).toHaveBeenCalledTimes(2))
        expect(harness.addAttachment).toHaveBeenCalledWith(bad)
        expect(harness.addAttachment).toHaveBeenCalledWith(good)
        expect(await screen.findByRole('alert')).toHaveTextContent('composer.attachmentAddFailed')
        errorSpy.mockRestore()
    })

    it('preserves text from a mixed text-and-image clipboard payload', async () => {
        render(<HappyComposer sessionId="session-a" />)
        const image = new File(['image'], 'mixed.png', { type: 'image/png' })
        const event = new Event('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'clipboardData', {
            value: {
                files: [image],
                items: [],
                getData: (type: string) => type === 'text/plain' ? 'keep this text' : '',
            },
        })

        fireEvent(screen.getByRole('textbox', { name: 'composer input' }), event)

        // The textarea's native/default path owns insertion of the text. The
        // attachment handler must not cancel it merely because an image exists.
        expect(event.defaultPrevented).toBe(false)
        await waitFor(() => expect(harness.addAttachment).toHaveBeenCalledWith(image))
    })

    it('reports attachments and blocks the illegal schedule-plus-attachment send state', () => {
        harness.attachments = [{
            id: 'attachment-1',
            name: 'image.png',
            contentType: 'image/png',
            status: { type: 'complete' },
            file: new File(['image'], 'image.png', { type: 'image/png' }),
        }]
        const onAttachmentsChange = vi.fn<(hasAttachments: boolean) => void>()
        const { unmount } = render(
            <HappyComposer
                sessionId="session-a"
                pendingSchedule={{ type: 'absolute', ms: Date.now() + 60_000 }}
                onSchedule={() => undefined}
                onAttachmentsChange={onAttachmentsChange}
            />
        )

        expect(onAttachmentsChange).toHaveBeenCalledWith(true)
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
        fireEvent.keyDown(screen.getByRole('textbox', { name: 'composer input' }), { key: 'Enter' })
        expect(harness.send).not.toHaveBeenCalled()

        unmount()
        expect(onAttachmentsChange).toHaveBeenLastCalledWith(false)
    })

    it('blocks existing attachment sends when an active session becomes inactive', () => {
        harness.attachments = [{
            id: 'attachment-1',
            name: 'image.png',
            contentType: 'image/png',
            status: { type: 'complete' },
            file: new File(['image'], 'image.png', { type: 'image/png' }),
        }]
        const view = render(
            <HappyComposer sessionId="session-a" attachmentsSupported />
        )
        expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()

        view.rerender(
            <HappyComposer sessionId="session-a" attachmentsSupported={false} />
        )

        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
        expect(screen.getByRole('alert')).toHaveTextContent('composer.attachUnavailableInactive')
        fireEvent.keyDown(screen.getByRole('textbox', { name: 'composer input' }), { key: 'Enter' })
        expect(harness.send).not.toHaveBeenCalled()
    })

    it('does not persist an incomplete attachment as a resumable draft', () => {
        harness.attachments = [{
            id: 'attachment-failed',
            name: 'oversized.bin',
            contentType: 'application/octet-stream',
            status: { type: 'incomplete', reason: 'error' },
            file: new File(['too large'], 'oversized.bin'),
        }]

        render(<HappyComposer sessionId="session-a" />)

        expect(harness.draftAttachments).toEqual([])
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    })

    it('surfaces a rejected stop and re-enables Abort instead of spinning forever', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        harness.threadIsRunning = true
        harness.cancelRun.mockRejectedValue(new Error('turn id is no longer active'))
        render(<HappyComposer sessionId="session-a" />)

        const abort = screen.getByRole('button', { name: 'Abort' })
        fireEvent.click(abort)

        expect(await screen.findByTestId('composer-abort-error')).toHaveTextContent('composer.abortFailed')
        expect(abort).toBeEnabled()
        expect(errorSpy).toHaveBeenCalledWith(
            'Failed to stop the active task:',
            expect.any(Error),
        )
        errorSpy.mockRestore()
    })

    it('restores text, schedule, and attachment drafts after a mutation failure', async () => {
        harness.composerText = ''
        const onSchedule = vi.fn()
        const scheduledAt = Date.now() + 60_000
        render(
            <HappyComposer
                sessionId="session-a"
                onSchedule={onSchedule}
                sendError={{
                    id: 1,
                    text: 'retry with image',
                    message: 'network failed',
                    scheduledAt,
                    attachments: [{
                        id: 'attachment-1',
                        filename: 'image.png',
                        mimeType: 'image/png',
                        size: 5,
                        path: '/tmp/image.png',
                    }],
                    attachmentDraftSessionId: 'draft-session',
                }}
            />
        )

        expect(harness.setText).toHaveBeenCalledWith('retry with image')
        expect(onSchedule).toHaveBeenCalledWith({ type: 'absolute', ms: scheduledAt })
        expect(harness.restoreAttachments).toHaveBeenCalledWith('draft-session')
    })

    it('applies scratchlist clear/restore outcomes after their async destination settles', () => {
        harness.composerText = ''
        const { rerender } = render(
            <HappyComposer
                sessionId="session-a"
                composerDraftAction={{
                    id: 1,
                    action: 'restore',
                    text: 'scratch note',
                    scheduledAt: null,
                }}
            />
        )

        expect(harness.setText).toHaveBeenCalledWith('scratch note')

        rerender(
            <HappyComposer
                sessionId="session-a"
                composerDraftAction={{
                    id: 2,
                    action: 'clear',
                    text: 'scratch note',
                    scheduledAt: null,
                }}
            />
        )
        expect(harness.completeSubmission).toHaveBeenCalledTimes(1)
    })
})
