import {
    AssistantRuntimeProvider,
    type ChatModelAdapter,
    useLocalRuntime,
} from '@assistant-ui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addComposerInputHistory, getComposerInputHistory, HappyComposer } from './HappyComposer'
import { segmentsFromEditor } from './RichComposerInput'
import { serializeComposerSegments } from '@/lib/composerSegments'

vi.mock('@/components/AssistantChat/ComposerButtons', () => ({
    ComposerButtons: (props: { canSend: boolean; onSend: () => void }) => (
        <button type="button" disabled={!props.canSend} onClick={props.onSend}>
            Send
        </button>
    ),
}))

vi.mock('@/components/AssistantChat/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('@/hooks/useComposerDraft', () => ({
    useComposerDraft: () => ({
        sessionId: undefined,
        complete: true,
        restoredAny: false,
        hasStoredAttachments: false,
    }),
}))
vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        isTelegram: false,
        isTouch: false,
        haptic: {
            impact: () => {},
            notification: () => {},
            selection: () => {},
        },
    }),
}))
vi.mock('@/hooks/usePWAInstall', () => ({
    usePWAInstall: () => ({
        installState: 'idle',
        canInstall: false,
        canInstallIOS: false,
        isStandalone: false,
        isIOS: false,
        promptInstall: async () => false,
        dismissInstall: () => {},
    }),
}))
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

const adapter: ChatModelAdapter = {
    async *run() {},
}

function TestRuntime() {
    const runtime = useLocalRuntime(adapter)
    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <HappyComposer sessionId="session-a" />
        </AssistantRuntimeProvider>
    )
}

function serializedEditorText(editor: HTMLElement): string {
    return serializeComposerSegments(segmentsFromEditor(editor))
}

function replaceEditorText(editor: HTMLElement, text: string): void {
    const node = document.createTextNode(text)
    editor.replaceChildren(node)
    editor.focus()
    const range = document.createRange()
    range.setStart(node, text.length)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.input(editor)
}

function placeCaret(node: Text, offset: number): void {
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
}

function editorTextNodes(editor: HTMLElement): Text[] {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    let current = walker.nextNode()
    while (current) {
        if ((current.textContent ?? '').length > 0) nodes.push(current as Text)
        current = walker.nextNode()
    }
    return nodes
}

describe('HappyComposer per-session input history', () => {
    beforeEach(() => {
        window.localStorage.clear()
        window.history.replaceState({}, '', window.location.pathname)
    })

    it('walks backward and forward in the default rich composer and restores the draft', async () => {
        addComposerInputHistory('session-a', 'older prompt')
        addComposerInputHistory('session-a', 'newer prompt')
        render(<TestRuntime />)

        const editor = screen.getByTestId('rich-composer-input')
        replaceEditorText(editor, 'draft in progress')

        fireEvent.keyDown(editor, { key: 'ArrowUp' })
        await waitFor(() => expect(serializedEditorText(editor)).toBe('newer prompt'))

        fireEvent.keyDown(editor, { key: 'ArrowUp' })
        await waitFor(() => expect(serializedEditorText(editor)).toBe('older prompt'))

        fireEvent.keyDown(editor, { key: 'ArrowDown' })
        await waitFor(() => expect(serializedEditorText(editor)).toBe('newer prompt'))

        fireEvent.keyDown(editor, { key: 'ArrowDown' })
        await waitFor(() => expect(serializedEditorText(editor)).toBe('draft in progress'))
    })

    it('recreates mention chips from serialized history and leaves IME arrows alone', async () => {
        const referenced = '[Related session](/sessions/12345678-1234-1234-1234-123456789abc) inspect this'
        addComposerInputHistory('session-a', referenced)
        render(<TestRuntime />)

        const editor = screen.getByTestId('rich-composer-input')
        replaceEditorText(editor, '输入中')
        fireEvent.compositionStart(editor)
        fireEvent.keyDown(editor, { key: 'ArrowUp' })
        expect(serializedEditorText(editor)).toBe('输入中')
        fireEvent.compositionEnd(editor)

        fireEvent.keyDown(editor, { key: 'ArrowUp' })
        await waitFor(() => expect(serializedEditorText(editor)).toBe(referenced))
        expect(editor.querySelector('[data-composer-mention="session"]')).not.toBeNull()
    })

    it('lets rich multiline caret movement reach a boundary before changing history', async () => {
        addComposerInputHistory('session-a', 'older prompt')
        addComposerInputHistory('session-a', 'first line\nsecond line')
        render(<TestRuntime />)

        const editor = screen.getByTestId('rich-composer-input')
        fireEvent.keyDown(editor, { key: 'ArrowUp' })
        await waitFor(() => expect(serializedEditorText(editor)).toBe('first line\nsecond line'))

        const [firstLine, secondLine] = editorTextNodes(editor)
        expect(firstLine?.textContent).toBe('first line')
        expect(secondLine?.textContent).toBe('second line')

        placeCaret(secondLine!, secondLine!.length)
        fireEvent.keyUp(editor, { key: 'ArrowUp' })
        fireEvent.keyDown(editor, { key: 'ArrowUp' })
        expect(serializedEditorText(editor)).toBe('first line\nsecond line')

        placeCaret(firstLine!, 3)
        fireEvent.keyUp(editor, { key: 'ArrowUp' })
        fireEvent.keyDown(editor, { key: 'ArrowUp' })
        await waitFor(() => expect(serializedEditorText(editor)).toBe('older prompt'))
    })

    it('retains history navigation in the textarea kill-switch fallback', async () => {
        window.localStorage.setItem('hapi.composer.richMentions', '0')
        addComposerInputHistory('session-a', 'textarea prompt')
        render(<TestRuntime />)

        const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
        fireEvent.change(textarea, { target: { value: 'textarea draft' } })
        textarea.setSelectionRange(textarea.value.length, textarea.value.length)
        fireEvent.keyDown(textarea, { key: 'ArrowUp' })
        await waitFor(() => expect(textarea.value).toBe('textarea prompt'))

        fireEvent.keyDown(textarea, { key: 'ArrowDown' })
        await waitFor(() => expect(textarea.value).toBe('textarea draft'))
    })

    it('records a submitted rich-composer prompt', async () => {
        render(<TestRuntime />)

        const editor = screen.getByTestId('rich-composer-input')
        replaceEditorText(editor, 'send this prompt')
        const send = await screen.findByRole('button', { name: 'Send' })
        await waitFor(() => expect(send).toBeEnabled())
        fireEvent.click(send)

        expect(getComposerInputHistory('session-a')).toEqual(['send this prompt'])
    })
})
