import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { ScratchlistEntry } from '@/lib/scratchlist'
import type { ApiClient } from '@/api/client'

const fetchScratchlistAttachmentBlob = vi.fn()
const uploadFile = vi.fn()
const mockApi = {
    fetchScratchlistAttachmentBlob,
    uploadFile,
} as unknown as ApiClient
const mockSessionId = 'sess-test'

/**
 * Regression test for upstream review on PR #798 (HAPI Bot follow-up
 * after b256fe5):
 *
 *   > Found one major issue: promoting a scratchlist item to the
 *   > composer keeps scratchlist mode enabled, so the next send re-adds
 *   > it to the scratchlist instead of sending to chat.
 *
 * The fix is for ScratchlistDrawerHost to call `onExitScratchlistMode`
 * whenever it promotes an entry to the composer (since promoting means
 * "I want to send this for real now"). This test mocks the assistant-ui
 * runtime hook and asserts both the setText call AND the exit-mode call
 * fire when the operator clicks promote-to-composer.
 *
 * Promote-to-queue exits scratchlist mode after a successful send so the
 * operator can continue normal chat (issue #959). Rejected sends keep mode
 * on so the entry stays and the operator can retry.
 */

const setText = vi.fn()
const addAttachment = vi.fn()
let mockComposerText = ''
vi.mock('@assistant-ui/react', () => ({
    useAui: () => ({
        composer: () => ({
            setText,
            addAttachment,
            getState: () => ({ text: mockComposerText }),
        }),
    }),
    useAuiState: (selector: (state: { composer: { text: string } }) => unknown) => selector({
        composer: { text: mockComposerText },
    }),
}))

import { canPromoteScratchlistEntryAttachments } from './AssistantChat/ScratchlistPanel'
import { ScratchlistDrawerHost } from './SessionChat'

function makeEntry(overrides: Partial<ScratchlistEntry> & { id: string }): ScratchlistEntry {
    return { text: 'note', createdAt: 1000, ...overrides }
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>((res) => { resolve = res })
    return { promise, resolve }
}

const storedAttachment = {
    id: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
    filename: 'evidence.pdf',
    mimeType: 'application/pdf',
    size: 4,
    path: 'hapi-hub:scratchlist/default/sess-test/a1b2c3d4-e5f6-4789-a012-3456789abcde-evidence.pdf',
}

afterEach(() => {
    cleanup()
    setText.mockReset()
    addAttachment.mockReset()
    fetchScratchlistAttachmentBlob.mockReset()
    uploadFile.mockReset()
    mockComposerText = ''
})

describe('ScratchlistDrawerHost.onPromoteToComposer', () => {
    it('lets an inactive session promote a text-only entry to the composer', () => {
        const onExitScratchlistMode = vi.fn(() => true)
        const onSend = vi.fn(async () => true)
        const onMove = vi.fn()
        const onDelete = vi.fn()

        render(
            <I18nProvider>
                <ScratchlistDrawerHost
                    sessionId={mockSessionId}
                    api={mockApi}
                    entries={[makeEntry({ id: 'e1', text: 'queued thought' })]}
                    onMove={onMove}
                    onDelete={onDelete}
                    onSend={onSend}
                    onExitScratchlistMode={onExitScratchlistMode}
                    attachmentsSupported={false}
                />
            </I18nProvider>,
        )

        // The drawer renders a "promote to composer" button per entry.
        // Match by aria-label so we do not depend on icon/glyph copy.
        const promoteButtons = screen.getAllByRole('button', { name: /composer|edit/i })
        expect(promoteButtons.length).toBeGreaterThan(0)
        fireEvent.click(promoteButtons[0]!)

        expect(setText).toHaveBeenCalledWith('queued thought')
        expect(onExitScratchlistMode).toHaveBeenCalledTimes(1)
        // Promote-to-composer must NOT call onSend (that's promote-to-queue).
        expect(onSend).not.toHaveBeenCalled()
    })

    it('does not replace a composer draft when existing attachments lock its destination', () => {
        const onExitScratchlistMode = vi.fn(() => false)
        const onSend = vi.fn(async () => true)

        render(
            <I18nProvider>
                <ScratchlistDrawerHost
                    sessionId={mockSessionId}
                    api={mockApi}
                    entries={[makeEntry({ id: 'e1', text: 'would overwrite draft' })]}
                    onMove={vi.fn()}
                    onDelete={vi.fn()}
                    onSend={onSend}
                    onExitScratchlistMode={onExitScratchlistMode}
                    composerDestinationLocked
                />
            </I18nProvider>,
        )

        const promoteButton = screen.getByRole('button', {
            name: /Remove attachments before switching destination/,
        })
        expect(promoteButton).toBeDisabled()
        fireEvent.click(promoteButton)

        expect(onExitScratchlistMode).not.toHaveBeenCalled()
        expect(setText).not.toHaveBeenCalled()
        expect(onSend).not.toHaveBeenCalled()
    })

    it('does not overwrite existing unsent composer text', () => {
        mockComposerText = 'draft that must survive'
        const onExitScratchlistMode = vi.fn(() => true)
        const onSend = vi.fn(async () => true)

        render(
            <I18nProvider>
                <ScratchlistDrawerHost
                    sessionId={mockSessionId}
                    api={mockApi}
                    entries={[makeEntry({ id: 'e1', text: 'would overwrite draft' })]}
                    onMove={vi.fn()}
                    onDelete={vi.fn()}
                    onSend={onSend}
                    onExitScratchlistMode={onExitScratchlistMode}
                />
            </I18nProvider>,
        )

        const promoteButton = screen.getByRole('button', {
            name: /Clear the current draft before copying an entry/,
        })
        expect(promoteButton).toBeDisabled()
        fireEvent.click(promoteButton)

        expect(onExitScratchlistMode).not.toHaveBeenCalled()
        expect(setText).not.toHaveBeenCalled()
        expect(onSend).not.toHaveBeenCalled()
    })

    it('lets an inactive session promote a text-only entry to queue', async () => {
        const onExitScratchlistMode = vi.fn(() => true)
        const onSend = vi.fn(async () => true)
        const onMove = vi.fn()
        const onDelete = vi.fn()

        render(
            <I18nProvider>
                <ScratchlistDrawerHost
                    sessionId={mockSessionId}
                    api={mockApi}
                    entries={[makeEntry({ id: 'e1', text: 'send-to-queue text' })]}
                    onMove={onMove}
                    onDelete={onDelete}
                    onSend={onSend}
                    onExitScratchlistMode={onExitScratchlistMode}
                    attachmentsSupported={false}
                />
            </I18nProvider>,
        )

        const queueButtons = screen.getAllByRole('button', { name: /queue|send/i })
        expect(queueButtons.length).toBeGreaterThan(0)
        fireEvent.click(queueButtons[0]!)

        await waitFor(() => expect(onSend).toHaveBeenCalledWith('send-to-queue text', undefined))
        expect(onExitScratchlistMode).toHaveBeenCalledTimes(1)
        expect(setText).not.toHaveBeenCalled()
    })

    it('keeps the source entry until the queue send is confirmed', async () => {
        const delivery = deferred<boolean>()
        const onExitScratchlistMode = vi.fn(() => true)
        const onSend = vi.fn(() => delivery.promise)
        const onDelete = vi.fn()

        render(
            <I18nProvider>
                <ScratchlistDrawerHost
                    sessionId={mockSessionId}
                    api={mockApi}
                    entries={[makeEntry({ id: 'e1', text: 'durable until delivered' })]}
                    onMove={vi.fn()}
                    onDelete={onDelete}
                    onSend={onSend}
                    onExitScratchlistMode={onExitScratchlistMode}
                />
            </I18nProvider>,
        )

        fireEvent.click(screen.getAllByRole('button', { name: /queue|send/i })[0]!)
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
        expect(onDelete).not.toHaveBeenCalled()
        expect(onExitScratchlistMode).not.toHaveBeenCalled()

        delivery.resolve(true)
        await waitFor(() => expect(onDelete).toHaveBeenCalledWith('e1'))
        expect(onExitScratchlistMode).toHaveBeenCalledTimes(1)
    })

    it('blocks both attachment promotion paths while inactive', () => {
        const onExitScratchlistMode = vi.fn(() => true)
        const onSend = vi.fn(async () => true)

        render(
            <I18nProvider>
                <ScratchlistDrawerHost
                    sessionId={mockSessionId}
                    api={mockApi}
                    entries={[makeEntry({
                        id: 'e1',
                        text: 'send with evidence',
                        attachments: [storedAttachment],
                    })]}
                    onMove={vi.fn()}
                    onDelete={vi.fn()}
                    onSend={onSend}
                    onExitScratchlistMode={onExitScratchlistMode}
                    attachmentsSupported={false}
                />
            </I18nProvider>,
        )

        const composerButton = screen.getByRole('button', {
            name: 'Copy into composer: Attachments require an active session',
        })
        const queueButton = screen.getByRole('button', {
            name: 'Send to queue: Attachments require an active session',
        })
        expect(composerButton).toBeDisabled()
        expect(queueButton).toBeDisabled()

        // The same policy is called again by both host handlers, rather than
        // trusting only the disabled DOM affordance.
        expect(canPromoteScratchlistEntryAttachments(
            makeEntry({ id: 'guarded', attachments: [storedAttachment] }),
            false,
        )).toBe(false)
        expect(onExitScratchlistMode).not.toHaveBeenCalled()
        expect(onSend).not.toHaveBeenCalled()
        expect(setText).not.toHaveBeenCalled()
        expect(fetchScratchlistAttachmentBlob).not.toHaveBeenCalled()
        expect(uploadFile).not.toHaveBeenCalled()
    })

    it('keeps attachment promotion enabled for an active session', async () => {
        const onExitScratchlistMode = vi.fn(() => true)
        const onSend = vi.fn(async () => true)
        fetchScratchlistAttachmentBlob.mockResolvedValue(new Blob(['data'], {
            type: storedAttachment.mimeType,
        }))
        addAttachment.mockResolvedValue(undefined)

        render(
            <I18nProvider>
                <ScratchlistDrawerHost
                    sessionId={mockSessionId}
                    api={mockApi}
                    entries={[makeEntry({
                        id: 'e1',
                        text: 'edit with evidence',
                        attachments: [storedAttachment],
                    })]}
                    onMove={vi.fn()}
                    onDelete={vi.fn()}
                    onSend={onSend}
                    onExitScratchlistMode={onExitScratchlistMode}
                    attachmentsSupported
                />
            </I18nProvider>,
        )

        const composerButton = screen.getByRole('button', { name: 'Copy into composer' })
        expect(composerButton).not.toBeDisabled()
        fireEvent.click(composerButton)

        expect(onExitScratchlistMode).toHaveBeenCalledTimes(1)
        expect(setText).toHaveBeenCalledWith('edit with evidence')
        await waitFor(() => expect(addAttachment).toHaveBeenCalledTimes(1))
        expect(onSend).not.toHaveBeenCalled()
    })

    it('does NOT exit scratchlist mode when promote-to-queue send is rejected', async () => {
        const onExitScratchlistMode = vi.fn(() => true)
        const onSend = vi.fn(async () => false)
        const onMove = vi.fn()
        const onDelete = vi.fn()

        render(
            <I18nProvider>
                <ScratchlistDrawerHost
                    sessionId={mockSessionId}
                    api={mockApi}
                    entries={[makeEntry({ id: 'e1', text: 'send-to-queue text' })]}
                    onMove={onMove}
                    onDelete={onDelete}
                    onSend={onSend}
                    onExitScratchlistMode={onExitScratchlistMode}
                />
            </I18nProvider>,
        )

        const queueButtons = screen.getAllByRole('button', { name: /queue|send/i })
        fireEvent.click(queueButtons[0]!)

        await waitFor(() => expect(onSend).toHaveBeenCalledWith('send-to-queue text', undefined))
        expect(onExitScratchlistMode).not.toHaveBeenCalled()
        expect(setText).not.toHaveBeenCalled()
    })
})

describe('ScratchlistDrawer copy-to-clipboard action', () => {
    it('writes the entry text to the clipboard and flips the button label to "Copied!" briefly', async () => {
        // Mock navigator.clipboard so safeCopyToClipboard's primary path
        // resolves successfully (it tries this before the execCommand fallback).
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        })

        const onExitScratchlistMode = vi.fn(() => true)
        const onSend = vi.fn(async () => true)
        const onMove = vi.fn()
        const onDelete = vi.fn()

        render(
            <I18nProvider>
                <ScratchlistDrawerHost
                    sessionId={mockSessionId}
                    api={mockApi}
                    entries={[makeEntry({ id: 'e1', text: 'copy this' })]}
                    onMove={onMove}
                    onDelete={onDelete}
                    onSend={onSend}
                    onExitScratchlistMode={onExitScratchlistMode}
                />
            </I18nProvider>,
        )

        fireEvent.click(screen.getByRole('button', { name: 'Copy text to clipboard (not images)' }))

        await waitFor(() => expect(writeText).toHaveBeenCalledWith('copy this'))
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy(),
        )

        // Copy must NOT mutate the list — entry stays, no other handlers fire.
        expect(onDelete).not.toHaveBeenCalled()
        expect(onSend).not.toHaveBeenCalled()
        expect(setText).not.toHaveBeenCalled()
        expect(onExitScratchlistMode).not.toHaveBeenCalled()
    })
})
