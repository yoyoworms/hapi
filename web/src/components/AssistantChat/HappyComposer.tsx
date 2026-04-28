import { getCodexCollaborationModeOptions, getPermissionModeOptionsForFlavor } from '@hapi/protocol'
import { ComposerPrimitive, useAssistantApi, useAssistantState } from '@assistant-ui/react'
import {
    type ChangeEvent as ReactChangeEvent,
    type ClipboardEvent as ReactClipboardEvent,
    type FormEvent as ReactFormEvent,
    type KeyboardEvent as ReactKeyboardEvent,
    type SyntheticEvent as ReactSyntheticEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState
} from 'react'
import type { AgentState, AttachmentMetadata, CodexCollaborationMode, PermissionMode } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
// import type { ConversationStatus } from '@/realtime/types' // voice disabled
import { useActiveWord } from '@/hooks/useActiveWord'
import { useActiveSuggestions } from '@/hooks/useActiveSuggestions'
import { applySuggestion } from '@/utils/applySuggestion'
import { uploadedAttachmentPaths } from '@/lib/attachmentAdapter'
import { usePlatform } from '@/hooks/usePlatform'
import { usePWAInstall } from '@/hooks/usePWAInstall'
import { supportsEffort, supportsModelChange } from '@hapi/protocol'
import { markSkillUsed } from '@/lib/recent-skills'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { Autocomplete } from '@/components/ChatInput/Autocomplete'
import { StatusBar } from '@/components/AssistantChat/StatusBar'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { ComposerButtons } from '@/components/AssistantChat/ComposerButtons'
import { AttachmentItem } from '@/components/AssistantChat/AttachmentItem'
import { useTranslation } from '@/lib/use-translation'
import { getModelOptionsForFlavor, getNextModelForFlavor } from './modelOptions'
import { getClaudeComposerEffortOptions } from './claudeEffortOptions'
import type { LatestUsage } from '@/chat/reducer'

export interface TextInputState {
    text: string
    selection: { start: number; end: number }
}

const defaultSuggestionHandler = async (): Promise<Suggestion[]> => []

function QuickPermissionBar({ agentState }: { agentState?: AgentState | null }) {
    const ctx = useHappyChatContext()
    const [loading, setLoading] = useState(false)

    const pendingRequests = useMemo(() => {
        if (!agentState?.requests) return []
        return Object.keys(agentState.requests)
    }, [agentState?.requests])

    if (pendingRequests.length === 0) return null

    const handleApprove = async () => {
        setLoading(true)
        try {
            for (const id of pendingRequests) {
                await ctx.api.approvePermission(ctx.sessionId, id)
            }
        } catch {}
        setLoading(false)
    }

    const handleDeny = async () => {
        setLoading(true)
        try {
            for (const id of pendingRequests) {
                await ctx.api.denyPermission(ctx.sessionId, id)
            }
        } catch {}
        setLoading(false)
    }

    return (
        <div className="flex items-center gap-2 px-1 py-1.5">
            <span className="text-xs text-[#FF9500] flex-1">{pendingRequests.length} permission{pendingRequests.length > 1 ? 's' : ''} pending</span>
            <button
                type="button"
                disabled={loading}
                onClick={handleApprove}
                className="px-3 py-1 text-xs rounded-full bg-emerald-500/15 text-emerald-600 font-medium disabled:opacity-50"
            >
                Allow
            </button>
            <button
                type="button"
                disabled={loading}
                onClick={handleDeny}
                className="px-3 py-1 text-xs rounded-full bg-red-500/15 text-red-600 font-medium disabled:opacity-50"
            >
                Deny
            </button>
        </div>
    )
}

// Draft store: persist composer text per session across switches
const draftStore = new Map<string, string>()
const inputHistoryStore: Record<string, string[]> = (() => {
    if (typeof window === 'undefined') return {}
    try {
        const raw = window.localStorage.getItem('hapi:composer-input-history:v2')
        const parsed = raw ? JSON.parse(raw) : {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
        const result: Record<string, string[]> = {}
        for (const [sessionId, value] of Object.entries(parsed)) {
            if (typeof sessionId !== 'string' || !Array.isArray(value)) continue
            const history = value
                .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
                .slice(-100)
            if (history.length > 0) {
                result[sessionId] = history
            }
        }
        return result
    } catch {
        return {}
    }
})()

function persistInputHistory(): void {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem('hapi:composer-input-history:v2', JSON.stringify(inputHistoryStore))
    } catch {}
}

function getInputHistory(sessionId: string | undefined): string[] {
    if (!sessionId) return []
    return inputHistoryStore[sessionId] ?? []
}

function addInputHistory(sessionId: string | undefined, text: string): void {
    if (!sessionId) return
    const entry = text.trim()
    if (!entry) return
    const history = inputHistoryStore[sessionId] ?? []
    const last = history[history.length - 1]
    if (last === entry) return
    history.push(entry)
    if (history.length > 100) {
        history.splice(0, history.length - 100)
    }
    inputHistoryStore[sessionId] = history
    persistInputHistory()
}

function isCaretOnFirstLine(el: HTMLTextAreaElement): boolean {
    return el.value.lastIndexOf('\n', Math.max(0, el.selectionStart - 1)) === -1
}

function isCaretOnLastLine(el: HTMLTextAreaElement): boolean {
    return el.value.indexOf('\n', el.selectionEnd) === -1
}

export function HappyComposer(props: {
    sessionId?: string
    disabled?: boolean
    permissionMode?: PermissionMode
    collaborationMode?: CodexCollaborationMode
    model?: string | null
    effort?: string | null
    active?: boolean
    allowSendWhenInactive?: boolean
    thinking?: boolean
    agentState?: AgentState | null
    contextSize?: number
    latestUsage?: LatestUsage | null
    usage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number } | null
    accountStatus?: import('@/types/api').Session['accountStatus']
    controlledByUser?: boolean
    agentFlavor?: string | null
    onCollaborationModeChange?: (mode: CodexCollaborationMode) => void
    onPermissionModeChange?: (mode: PermissionMode) => void
    onModelChange?: (model: string | null) => void
    onEffortChange?: (effort: string | null) => void
    onSwitchToRemote?: () => void
    onTerminal?: () => void
    terminalUnsupported?: boolean
    autocompletePrefixes?: string[]
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    onDirectSend?: (text: string, attachments?: AttachmentMetadata[]) => void
    queuedCount?: number
    hasPausedQueue?: boolean
    onClearQueue?: () => void
    onResumeQueue?: () => void
}) {
    const { t } = useTranslation()
    const {
        disabled = false,
        permissionMode: rawPermissionMode,
        collaborationMode: rawCollaborationMode,
        model: rawModel,
        effort: rawEffort,
        active = true,
        allowSendWhenInactive = false,
        thinking = false,
        agentState,
        contextSize,
        controlledByUser = false,
        agentFlavor,
        onCollaborationModeChange,
        onPermissionModeChange,
        onModelChange,
        onEffortChange,
        onSwitchToRemote,
        onTerminal,
        terminalUnsupported = false,
        autocompletePrefixes = ['@', '/', '$'],
        autocompleteSuggestions = defaultSuggestionHandler,
    } = props

    // Use ?? so missing values fall back to default (destructuring defaults only handle undefined)
    const permissionMode = rawPermissionMode ?? 'default'
    const collaborationMode = rawCollaborationMode ?? 'default'
    const model = rawModel ?? null
    const effort = rawEffort ?? null

    const { sessionId } = props
    const api = useAssistantApi()
    const composerText = useAssistantState(({ composer }) => composer.text)
    const attachments = useAssistantState(({ composer }) => composer.attachments)
    const threadIsRunning = useAssistantState(({ thread }) => thread.isRunning)
    const threadIsDisabled = useAssistantState(({ thread }) => thread.isDisabled)

    // Save draft on unmount or session change, restore on mount
    const composerTextRef = useRef(composerText)
    composerTextRef.current = composerText
    const prevSessionIdRef = useRef(sessionId)

    useEffect(() => {
        historyIndexRef.current = null
        historyDraftRef.current = ''
        if (sessionId) {
            const draft = draftStore.get(sessionId)
            if (draft) {
                api.composer().setText(draft)
            }
        }
        return () => {
            const id = prevSessionIdRef.current
            if (id) {
                const text = composerTextRef.current
                if (text.trim()) {
                    draftStore.set(id, text)
                } else {
                    draftStore.delete(id)
                }
            }
        }
    }, [sessionId, api])
    prevSessionIdRef.current = sessionId

    // threadIsDisabled kept for hook order but not used — queue allows sending while thinking
    const controlsDisabled = disabled || (!active && !allowSendWhenInactive)
    const trimmed = composerText.trim()
    const hasText = trimmed.length > 0
    const hasAttachments = attachments.length > 0
    const attachmentsReady = !hasAttachments || attachments.every((attachment) => {
        if (attachment.status.type === 'complete') {
            return true
        }
        if (attachment.status.type !== 'requires-action') {
            return false
        }
        const path = (attachment as { path?: string }).path
        return typeof path === 'string' && path.length > 0
    })
    const canSend = (hasText || hasAttachments) && attachmentsReady && !controlsDisabled

    const [inputState, setInputState] = useState<TextInputState>({
        text: '',
        selection: { start: 0, end: 0 }
    })
    const [showSettings, setShowSettings] = useState(false)
    const [isAborting, setIsAborting] = useState(false)
    const [isSwitching, setIsSwitching] = useState(false)
    const [showContinueHint, setShowContinueHint] = useState(false)

    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const prevControlledByUser = useRef(controlledByUser)
    const historyIndexRef = useRef<number | null>(null)
    const historyDraftRef = useRef('')

    useEffect(() => {
        setInputState((prev) => {
            if (prev.text === composerText) return prev
            // When syncing from composerText, update selection to end of text
            // This ensures activeWord detection works correctly
            const newPos = composerText.length
            return { text: composerText, selection: { start: newPos, end: newPos } }
        })
    }, [composerText])

    // Track one-time "continue" hint after switching from local to remote.
    useEffect(() => {
        if (prevControlledByUser.current === true && controlledByUser === false) {
            setShowContinueHint(true)
        }
        if (controlledByUser) {
            setShowContinueHint(false)
        }
        prevControlledByUser.current = controlledByUser
    }, [controlledByUser])

    const { haptic: platformHaptic, isTouch } = usePlatform()
    const { isStandalone, isIOS } = usePWAInstall()
    const isIOSPWA = isIOS && isStandalone
    const bottomPaddingClass = isIOSPWA ? 'pb-0' : 'pb-3'
    const activeWord = useActiveWord(inputState.text, inputState.selection, autocompletePrefixes)
    const [suggestions, selectedIndex, moveUp, moveDown, clearSuggestions] = useActiveSuggestions(
        activeWord,
        autocompleteSuggestions,
        { clampSelection: true, wrapAround: true }
    )

    const haptic = useCallback((type: 'light' | 'success' | 'error' = 'light') => {
        if (type === 'light') {
            platformHaptic.impact('light')
        } else if (type === 'success') {
            platformHaptic.notification('success')
        } else {
            platformHaptic.notification('error')
        }
    }, [platformHaptic])

    const handleSuggestionSelect = useCallback((index: number) => {
        const suggestion = suggestions[index]
        if (!suggestion || !textareaRef.current) return
        if (suggestion.text.startsWith('$')) {
            markSkillUsed(suggestion.text.slice(1))
        }

        // For Codex user prompts with content, expand the content instead of command name
        let textToInsert = suggestion.text
        let addSpace = true
        if (agentFlavor === 'codex' && suggestion.source !== 'builtin' && suggestion.content) {
            textToInsert = suggestion.content
            addSpace = false
        }

        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            textToInsert,
            autocompletePrefixes,
            addSpace
        )

        api.composer().setText(result.text)
        setInputState({
            text: result.text,
            selection: { start: result.cursorPosition, end: result.cursorPosition }
        })

        setTimeout(() => {
            const el = textareaRef.current
            if (!el) return
            el.setSelectionRange(result.cursorPosition, result.cursorPosition)
            try {
                el.focus({ preventScroll: true })
            } catch {
                el.focus()
            }
        }, 0)

        haptic('light')
    }, [api, suggestions, inputState, autocompletePrefixes, haptic, agentFlavor])

    const abortDisabled = controlsDisabled || isAborting || !thinking
    const switchDisabled = controlsDisabled || isSwitching || !controlledByUser
    const showSwitchButton = Boolean(controlledByUser && onSwitchToRemote)
    const showTerminalButton = Boolean(onTerminal || terminalUnsupported)
    const terminalDisabled = controlsDisabled || terminalUnsupported
    const terminalLabel = terminalUnsupported ? t('terminal.unsupportedWindows') : t('composer.terminal')

    useEffect(() => {
        if (!isAborting) return
        if (thinking) return
        setIsAborting(false)
    }, [isAborting, thinking])

    useEffect(() => {
        if (!isSwitching) return
        if (controlledByUser) return
        setIsSwitching(false)
    }, [isSwitching, controlledByUser])

    const handleAbort = useCallback(() => {
        if (abortDisabled) return
        haptic('error')
        setIsAborting(true)
        api.thread().cancelRun()
    }, [abortDisabled, api, haptic])

    const handleSwitch = useCallback(async () => {
        if (switchDisabled || !onSwitchToRemote) return
        haptic('light')
        setIsSwitching(true)
        try {
            await onSwitchToRemote()
        } catch {
            setIsSwitching(false)
        }
    }, [switchDisabled, onSwitchToRemote, haptic])

    const permissionModeOptions = useMemo(
        () => getPermissionModeOptionsForFlavor(agentFlavor),
        [agentFlavor]
    )
    const collaborationModeOptions = useMemo(
        () => agentFlavor === 'codex' ? getCodexCollaborationModeOptions() : [],
        [agentFlavor]
    )
    const claudeModelOptions = useMemo(
        () => getModelOptionsForFlavor(agentFlavor, model),
        [agentFlavor, model]
    )
    const claudeEffortOptions = useMemo(
        () => getClaudeComposerEffortOptions(effort),
        [effort]
    )
    const permissionModes = useMemo(
        () => permissionModeOptions.map((option) => option.mode),
        [permissionModeOptions]
    )

    const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        const key = e.key

        // Avoid intercepting IME composition keystrokes (Enter, arrows, etc.)
        if (e.nativeEvent.isComposing) {
            return
        }

        // Enter sends, Shift+Enter inserts newline
        if (key === 'Enter' && !e.shiftKey && !isTouch) {
            e.preventDefault()
            if (!canSend) return
            handleSend()
            setShowContinueHint(false)
            return
        }

        if (suggestions.length > 0) {
            if (key === 'ArrowUp') {
                e.preventDefault()
                moveUp()
                return
            }
            if (key === 'ArrowDown') {
                e.preventDefault()
                moveDown()
                return
            }
            if ((key === 'Enter' || key === 'Tab') && !e.shiftKey) {
                e.preventDefault()
                const indexToSelect = selectedIndex >= 0 ? selectedIndex : 0
                handleSuggestionSelect(indexToSelect)
                return
            }
            if (key === 'Escape') {
                e.preventDefault()
                clearSuggestions()
                return
            }
        }

        const inputHistory = getInputHistory(sessionId)
        if ((key === 'ArrowUp' || key === 'ArrowDown') && inputHistory.length > 0) {
            const el = textareaRef.current
            if (!el) return

            const canNavigateUp = key === 'ArrowUp'
                && el.selectionStart === el.selectionEnd
                && isCaretOnFirstLine(el)
            const canNavigateDown = key === 'ArrowDown'
                && el.selectionStart === el.selectionEnd
                && (historyIndexRef.current !== null || isCaretOnLastLine(el))

            if (canNavigateUp || canNavigateDown) {
                e.preventDefault()

                if (key === 'ArrowUp') {
                    if (historyIndexRef.current === null) {
                        historyDraftRef.current = composerTextRef.current
                        historyIndexRef.current = inputHistory.length - 1
                    } else {
                        historyIndexRef.current = Math.max(0, historyIndexRef.current - 1)
                    }
                } else if (historyIndexRef.current !== null) {
                    if (historyIndexRef.current >= inputHistory.length - 1) {
                        historyIndexRef.current = null
                    } else {
                        historyIndexRef.current += 1
                    }
                }

                const nextText = historyIndexRef.current === null
                    ? historyDraftRef.current
                    : inputHistory[historyIndexRef.current] ?? ''
                const cursorPosition = nextText.length
                api.composer().setText(nextText)
                setInputState({
                    text: nextText,
                    selection: { start: cursorPosition, end: cursorPosition }
                })
                setTimeout(() => {
                    const input = textareaRef.current
                    if (!input) return
                    input.setSelectionRange(cursorPosition, cursorPosition)
                }, 0)
                return
            }
        }

        if (key === 'Escape' && thinking) {
            e.preventDefault()
            handleAbort()
            return
        }

        if (key === 'Tab' && e.shiftKey && onPermissionModeChange && permissionModes.length > 0) {
            e.preventDefault()
            const currentIndex = permissionModes.indexOf(permissionMode)
            const nextIndex = (currentIndex + 1) % permissionModes.length
            const nextMode = permissionModes[nextIndex] ?? 'default'
            onPermissionModeChange(nextMode)
            haptic('light')
        }
    }, [
        suggestions,
        selectedIndex,
        moveUp,
        moveDown,
        clearSuggestions,
        handleSuggestionSelect,
        threadIsRunning,
        handleAbort,
        onPermissionModeChange,
        permissionMode,
        permissionModes,
        canSend,
        api,
        haptic,
        sessionId
    ])

    useEffect(() => {
        const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'm' && (e.metaKey || e.ctrlKey) && onModelChange && supportsModelChange(agentFlavor)) {
                e.preventDefault()
                onModelChange(getNextModelForFlavor(agentFlavor, model))
                haptic('light')
            }
        }

        window.addEventListener('keydown', handleGlobalKeyDown)
        return () => window.removeEventListener('keydown', handleGlobalKeyDown)
    }, [model, onModelChange, haptic, agentFlavor])

    const handleChange = useCallback((e: ReactChangeEvent<HTMLTextAreaElement>) => {
        const selection = {
            start: e.target.selectionStart,
            end: e.target.selectionEnd
        }
        historyIndexRef.current = null
        historyDraftRef.current = ''
        setInputState({ text: e.target.value, selection })
    }, [])

    const handleSelect = useCallback((e: ReactSyntheticEvent<HTMLTextAreaElement>) => {
        const target = e.target as HTMLTextAreaElement
        setInputState(prev => ({
            ...prev,
            selection: { start: target.selectionStart, end: target.selectionEnd }
        }))
    }, [])

    const handlePaste = useCallback(async (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
        const files = Array.from(e.clipboardData?.files || [])
        const imageFiles = files.filter(file => file.type.startsWith('image/'))

        if (imageFiles.length === 0) return

        e.preventDefault()

        try {
            for (const file of imageFiles) {
                await api.composer().addAttachment(file)
            }
        } catch (error) {
            console.error('Error adding pasted image:', error)
        }
    }, [api])

    const handleSettingsToggle = useCallback(() => {
        haptic('light')
        setShowSettings(prev => !prev)
    }, [haptic])

    const handleSubmit = useCallback((event?: ReactFormEvent<HTMLFormElement>) => {
        if (event && !attachmentsReady) {
            event.preventDefault()
            return
        }
        setShowContinueHint(false)
    }, [attachmentsReady])

    const handlePermissionChange = useCallback((mode: PermissionMode) => {
        if (!onPermissionModeChange || controlsDisabled) return
        onPermissionModeChange(mode)
        setShowSettings(false)
        haptic('light')
    }, [onPermissionModeChange, controlsDisabled, haptic])

    const handleCollaborationChange = useCallback((mode: CodexCollaborationMode) => {
        if (!onCollaborationModeChange || controlsDisabled) return
        onCollaborationModeChange(mode)
        setShowSettings(false)
        haptic('light')
    }, [onCollaborationModeChange, controlsDisabled, haptic])

    const handleModelChange = useCallback((nextModel: string | null) => {
        if (!onModelChange || controlsDisabled) return
        onModelChange(nextModel)
        setShowSettings(false)
        haptic('light')
    }, [onModelChange, controlsDisabled, haptic])

    const handleEffortChange = useCallback((nextEffort: string | null) => {
        if (!onEffortChange || controlsDisabled) return
        onEffortChange(nextEffort)
        setShowSettings(false)
        haptic('light')
    }, [onEffortChange, controlsDisabled, haptic])

    const showCollaborationSettings = Boolean(onCollaborationModeChange && collaborationModeOptions.length > 0)
    const showPermissionSettings = Boolean(onPermissionModeChange && permissionModeOptions.length > 0)
    const showModelSettings = Boolean(onModelChange && supportsModelChange(agentFlavor))
    const showEffortSettings = Boolean(onEffortChange && supportsEffort(agentFlavor))
    const showSettingsButton = Boolean(showCollaborationSettings || showPermissionSettings || showModelSettings || showEffortSettings)
    const showAbortButton = true
    const voiceEnabled = false

    const handleSend = useCallback(() => {
        if (sessionId) draftStore.delete(sessionId)
        const textToRecord = composerTextRef.current
        addInputHistory(sessionId, textToRecord)
        historyIndexRef.current = null
        historyDraftRef.current = ''
        // When thinking, api.composer().send() is blocked by the library.
        // Bypass by reading text directly and calling onDirectSend.
        if (thinking && props.onDirectSend) {
            const text = composerTextRef.current.trim()
            if (!text && attachments.length === 0) return
            // Extract attachment metadata from the shared upload map
            const attachmentMetas: AttachmentMetadata[] = []
            for (const att of attachments) {
                const uploaded = uploadedAttachmentPaths.get(att.id)
                if (uploaded) {
                    attachmentMetas.push({
                        id: att.id,
                        filename: att.name,
                        mimeType: att.contentType ?? 'application/octet-stream',
                        size: (att as any).file?.size ?? 0,
                        path: uploaded.path,
                        previewUrl: uploaded.previewUrl
                    })
                }
            }
            props.onDirectSend(text, attachmentMetas.length > 0 ? attachmentMetas : undefined)
            api.composer().setText('')
            // Clear attachments after send - try multiple approaches since
            // assistant-ui may block some operations during thinking state
            const attIds = attachments.map(a => a.id)
            for (const id of attIds) {
                uploadedAttachmentPaths.delete(id)
                try { (api.composer() as unknown as { removeAttachment?: (id: string) => void }).removeAttachment?.(id) } catch {}
            }
            // Fallback: reset the entire composer if attachments persist
            try { api.composer().reset() } catch {}
            return
        }
        api.composer().send()
    }, [api, sessionId, thinking, props.onDirectSend, attachments])

    const overlays = useMemo(() => {
        if (showSettings && (showCollaborationSettings || showPermissionSettings || showModelSettings || showEffortSettings)) {
            return (
                <div className="absolute bottom-[100%] mb-2 w-full">
                    <FloatingOverlay maxHeight={320}>
                        {showCollaborationSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.collaborationMode')}
                                </div>
                                {collaborationModeOptions.map((option) => (
                                    <button
                                        key={option.mode}
                                        type="button"
                                        disabled={controlsDisabled}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            controlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => handleCollaborationChange(option.mode)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                collaborationMode === option.mode
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {collaborationMode === option.mode && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className={collaborationMode === option.mode ? 'text-[var(--app-link)]' : ''}>
                                            {option.label}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : null}

                        {showCollaborationSettings && (showPermissionSettings || showModelSettings || showEffortSettings) ? (
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />
                        ) : null}

                        {showPermissionSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.permissionMode')}
                                </div>
                                {permissionModeOptions.map((option) => (
                                    <button
                                        key={option.mode}
                                        type="button"
                                        disabled={controlsDisabled}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            controlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => handlePermissionChange(option.mode)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                permissionMode === option.mode
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {permissionMode === option.mode && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className={permissionMode === option.mode ? 'text-[var(--app-link)]' : ''}>
                                            {option.label}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : null}

                        {(showCollaborationSettings || showPermissionSettings) && (showModelSettings || showEffortSettings) ? (
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />
                        ) : null}

                        {showModelSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.model')}
                                </div>
                                {claudeModelOptions.map((option) => (
                                    <button
                                        key={option.value ?? 'auto'}
                                        type="button"
                                        disabled={controlsDisabled}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            controlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => handleModelChange(option.value)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                model === option.value
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {model === option.value && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className={model === option.value ? 'text-[var(--app-link)]' : ''}>
                                            {option.label}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : null}

                        {showModelSettings && showEffortSettings ? (
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />
                        ) : null}

                        {showEffortSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.effort')}
                                </div>
                                {claudeEffortOptions.map((option) => (
                                    <button
                                        key={option.value ?? 'auto'}
                                        type="button"
                                        disabled={controlsDisabled}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            controlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => handleEffortChange(option.value)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                effort === option.value
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {effort === option.value && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className={effort === option.value ? 'text-[var(--app-link)]' : ''}>
                                            {option.label}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </FloatingOverlay>
                </div>
            )
        }

        if (suggestions.length > 0) {
            return (
                <div className="absolute bottom-[100%] mb-2 w-full">
                    <FloatingOverlay>
                        <Autocomplete
                            suggestions={suggestions}
                            selectedIndex={selectedIndex}
                            onSelect={(index) => handleSuggestionSelect(index)}
                        />
                    </FloatingOverlay>
                </div>
            )
        }

        return null
    }, [
        showSettings,
        showCollaborationSettings,
        showPermissionSettings,
        showModelSettings,
        showEffortSettings,
        claudeModelOptions,
        claudeEffortOptions,
        suggestions,
        selectedIndex,
        controlsDisabled,
        collaborationMode,
        permissionMode,
        model,
        effort,
        collaborationModeOptions,
        permissionModeOptions,
        handleCollaborationChange,
        handlePermissionChange,
        handleModelChange,
        handleEffortChange,
        handleSuggestionSelect,
        t
    ])

    return (
        <div className={`px-3 ${bottomPaddingClass} pt-2 bg-[var(--app-bg)]`}>
            <div className="mx-auto w-full max-w-content">
                <ComposerPrimitive.Root className="relative" onSubmit={handleSubmit}>
                    {overlays}

                    {/* QuickPermissionBar removed: PermissionFooter inside tool cards handles approvals */}

                    <StatusBar
                        active={active}
                        thinking={thinking}
                        sessionId={props.sessionId}
                        agentState={agentState}
                        contextSize={contextSize}
                        usage={props.usage}
                        accountStatus={props.accountStatus}
                        model={model}
                        permissionMode={permissionMode}
                        collaborationMode={collaborationMode}
                        agentFlavor={agentFlavor}
                        voiceStatus={undefined}
                        latestUsage={props.latestUsage}
                    />

                    <div className="overflow-hidden rounded-[20px] bg-[var(--app-secondary-bg)]">
                        {attachments.length > 0 ? (
                            <div className="flex flex-wrap gap-2 px-4 pt-3">
                                <ComposerPrimitive.Attachments components={{ Attachment: AttachmentItem }} />
                            </div>
                        ) : null}

                        <div className="flex items-center px-4 py-3">
                            <ComposerPrimitive.Input
                                ref={textareaRef}
                                autoFocus={!controlsDisabled && !isTouch}
                                placeholder={showContinueHint ? t('misc.typeMessage') : t('misc.typeAMessage')}
                                disabled={controlsDisabled}
                                maxRows={5}
                                submitOnEnter={false}
                                cancelOnEscape={false}
                                onChange={handleChange}
                                onSelect={handleSelect}
                                onKeyDown={handleKeyDown}
                                onPaste={handlePaste}
                                className="flex-1 resize-none bg-transparent text-base leading-snug text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                            />
                        </div>

                        <ComposerButtons
                            canSend={canSend}
                            controlsDisabled={controlsDisabled}
                            showSettingsButton={showSettingsButton}
                            onSettingsToggle={handleSettingsToggle}
                            showTerminalButton={showTerminalButton}
                            terminalDisabled={terminalDisabled}
                            terminalLabel={terminalLabel}
                            onTerminal={onTerminal ?? (() => {})}
                            showAbortButton={showAbortButton}
                            abortDisabled={abortDisabled}
                            isAborting={isAborting}
                            onAbort={handleAbort}
                            showSwitchButton={showSwitchButton}
                            switchDisabled={switchDisabled}
                            isSwitching={isSwitching}
                            onSwitch={handleSwitch}
                            voiceEnabled={false}
                            voiceStatus={'disconnected'}
                            onVoiceToggle={() => {}}

                            onSend={handleSend}
                        />
                    </div>
                </ComposerPrimitive.Root>
            </div>
        </div>
    )
}
