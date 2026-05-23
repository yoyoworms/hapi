import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import { seedMessageWindowFromSession, fetchLatestMessages } from '@/lib/message-window-store'
import type {
    AttachmentMetadata,
    CodexCollaborationMode,
    DecryptedMessage,
    PermissionMode,
    Session,
    SlashCommand
} from '@/types/api'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { buildConversationOutline } from '@/chat/outline'
import { buildVisibleChatBlocks, isToolGroupBlock, type ToolGroupBlock } from '@/chat/toolGroups'
import { isQueuedForInvocation, mergeMessages } from '@/lib/messages'
import { HappyComposer } from '@/components/AssistantChat/HappyComposer'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { resolvePendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { QueuedMessagesBar } from '@/components/AssistantChat/QueuedMessagesBar'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { createAttachmentAdapter } from '@/lib/attachmentAdapter'
import { useTranslation } from '@/lib/use-translation'
import { SessionHeader } from '@/components/SessionHeader'
import { TeamPanel } from '@/components/TeamPanel'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useCodexModels } from '@/hooks/queries/useCodexModels'
import { useOpencodeModels } from '@/hooks/queries/useOpencodeModels'
import { useVoiceOptional } from '@/lib/voice-context'
import { RealtimeVoiceSession, registerSessionStore, registerVoiceHooksStore, voiceHooks } from '@/realtime'
import { isRemoteTerminalSupported } from '@/utils/terminalSupport'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'

/**
 * Returns whether a PendingSchedule should trigger an auto-clear timer.
 *
 * Only 'absolute' schedules expire (the chosen instant passes).
 * 'preset' schedules are relative to send time and have no fixed expiry.
 *
 * Used both by the auto-clear useEffect and by unit tests, so a future
 * variant of PendingSchedule only needs to update this single helper.
 */
export function shouldAutoClearPendingSchedule(pending: PendingSchedule | null): boolean {
    return pending !== null && pending.type === 'absolute'
}

function isUninvokedScheduledMessage(message: DecryptedMessage): boolean {
    return message.invokedAt == null && message.scheduledAt != null
}

export function buildGoalStateMessages(
    messages: DecryptedMessage[],
    pendingMessages: DecryptedMessage[] = []
): DecryptedMessage[] {
    const eligibleMessages = messages.filter((message) => !isUninvokedScheduledMessage(message))
    const eligiblePendingMessages = pendingMessages.filter((message) => !isUninvokedScheduledMessage(message))
    return eligiblePendingMessages.length > 0
        ? mergeMessages(eligibleMessages, eligiblePendingMessages)
        : eligibleMessages
}

function getOutlineTitle(session: Session): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.summary?.text) {
        return session.metadata.summary.text
    }
    if (session.metadata?.path) {
        return session.metadata.path
    }
    return session.id.slice(0, 8)
}

function hasAbortableAgentRun(blocks: readonly ChatBlock[]): boolean {
    for (const block of blocks) {
        if (block.kind === 'tool-call') {
            if (
                block.tool.name === 'CodexAgent'
                && (block.tool.state === 'running' || block.tool.state === 'pending')
            ) {
                return true
            }
            if (hasAbortableAgentRun(block.children)) {
                return true
            }
        }
    }
    return false
}

export function SessionChat(props: {
    api: ApiClient
    session: Session
    messages: DecryptedMessage[]
    pendingMessages?: DecryptedMessage[]
    messagesWarning: string | null
    hasMoreMessages: boolean
    isLoadingMessages: boolean
    isLoadingMoreMessages: boolean
    isSending: boolean
    pendingCount: number
    messagesVersion: number
    onBack: () => void
    onRefresh: () => void
    onLoadMore: () => Promise<unknown>
    // Resolves true when the send was accepted by the underlying mutation, false when
    // pre-mutation guards (no-api / no-session / pending) rejected the call OR async
    // inactive-session resume failed. Composer state that should only be cleared on
    // actual send (pendingSchedule) must await this — see handleSend below.
    onSend: (text: string, attachments?: AttachmentMetadata[], scheduledAt?: number | null) => Promise<boolean>
    onFlushPending: () => void
    onAtBottomChange: (atBottom: boolean) => void
    onRetryMessage?: (localId: string) => void
    onCancelQueued?: (localId: string) => void
    queuedCount?: number
    hasPausedQueue?: boolean
    onClearQueue?: () => void
    onResumeQueue?: () => void
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    availableSlashCommands?: readonly SlashCommand[]
}) {
    const { haptic } = usePlatform()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const sessionInactive = !props.session.active
    const terminalSupported = isRemoteTerminalSupported(props.session.metadata)
    const { terminalToolDisplayMode } = useTerminalToolDisplayMode()
    const normalizedCacheRef = useRef<Map<string, { source: DecryptedMessage; normalized: NormalizedMessage | null }>>(new Map())
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const visibleGroupsRef = useRef<ToolGroupBlock[]>([])
    const [forceScrollToken, setForceScrollToken] = useState(0)
    const [outlineOpen, setOutlineOpen] = useState(false)
    const agentFlavor = props.session.metadata?.flavor ?? null
    const controlledByUser = props.session.agentState?.controlledByUser === true
    const codexCollaborationModeSupported = agentFlavor === 'codex' && !controlledByUser
    const codexModelsState = useCodexModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'codex' && props.session.active && !controlledByUser
    })
    const codexModelOptions = useMemo(() => {
        if (agentFlavor !== 'codex') {
            return undefined
        }

        const options: Array<{ value: string | null; label: string }> = []
        for (const codexModel of codexModelsState.models) {
            options.push({
                value: codexModel.id,
                label: codexModel.displayName
            })
        }
        return options
    }, [agentFlavor, codexModelsState.models])
    const opencodeModelsState = useOpencodeModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'opencode' && props.session.active
    })
    const opencodeModelOptions = useMemo(() => {
        if (agentFlavor !== 'opencode') {
            return undefined
        }

        return opencodeModelsState.availableModels.map((opencodeModel) => ({
            value: opencodeModel.modelId,
            label: opencodeModel.name ?? opencodeModel.modelId
        }))
    }, [agentFlavor, opencodeModelsState.availableModels])
    const {
        abortSession,
        switchSession,
        setPermissionMode,
        setCollaborationMode,
        setModel,
        setModelReasoningEffort,
        setEffort
    } = useSessionActions(
        props.api,
        props.session.id,
        agentFlavor,
        codexCollaborationModeSupported
    )
    const [headerResuming, setHeaderResuming] = useState(false)

    // Track session id to clear caches when it changes
    const prevSessionIdRef = useRef<string | null>(null)

    useEffect(() => {
        normalizedCacheRef.current.clear()
        blocksByIdRef.current.clear()
        visibleGroupsRef.current = []
        setOutlineOpen(false)
    }, [props.session.id])

    // Exclude user messages that haven't been invoked yet — those appear in the
    // QueuedMessagesBar above the composer, not in the thread timeline. The
    // `isQueuedForInvocation` predicate is shared with the window store and the
    // floating bar so the three views never disagree about queued state.
    const visibleMessages = useMemo(
        () => props.messages.filter((m) => !isQueuedForInvocation(m)),
        [props.messages]
    )

    const normalizedMessages: NormalizedMessage[] = useMemo(() => {
        // Clear caches immediately when session changes (before useEffect runs)
        if (prevSessionIdRef.current !== null && prevSessionIdRef.current !== props.session.id) {
            normalizedCacheRef.current.clear()
            blocksByIdRef.current.clear()
            visibleGroupsRef.current = []
        }
        prevSessionIdRef.current = props.session.id

        const cache = normalizedCacheRef.current
        const normalized: NormalizedMessage[] = []
        const seen = new Set<string>()
        for (const message of visibleMessages) {
            seen.add(message.id)
            const cached = cache.get(message.id)
            if (cached && cached.source === message) {
                if (cached.normalized) normalized.push(cached.normalized)
                continue
            }
            const next = normalizeDecryptedMessage(message)
            cache.set(message.id, { source: message, normalized: next })
            if (next) normalized.push(next)
        }
        for (const id of cache.keys()) {
            if (!seen.has(id)) {
                cache.delete(id)
            }
        }
        return normalized
    }, [visibleMessages])

    const goalStateSourceMessages = useMemo(
        () => buildGoalStateMessages(props.messages, props.pendingMessages ?? []),
        [props.messages, props.pendingMessages]
    )

    const normalizedGoalStateMessages: NormalizedMessage[] = useMemo(() => {
        const normalized: NormalizedMessage[] = []
        for (const message of goalStateSourceMessages) {
            const next = normalizeDecryptedMessage(message)
            if (next) normalized.push(next)
        }
        return normalized
    }, [goalStateSourceMessages])

    const reduced = useMemo(
        () => reduceChatBlocks(normalizedMessages, props.session.agentState, {
            goalStateMessages: normalizedGoalStateMessages
        }),
        [normalizedMessages, normalizedGoalStateMessages, props.session.agentState]
    )
    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks]
    )
    const hasRunningChildAgent = useMemo(
        () => hasAbortableAgentRun(reduced.blocks),
        [reduced.blocks]
    )

    useEffect(() => {
        blocksByIdRef.current = reconciled.byId
    }, [reconciled.byId])

    const visibleBlocks = useMemo(
        () => buildVisibleChatBlocks(reconciled.blocks, {
            hasMoreMessages: props.hasMoreMessages,
            previousGroups: visibleGroupsRef.current
        }),
        [reconciled.blocks, props.hasMoreMessages]
    )

    useEffect(() => {
        visibleGroupsRef.current = visibleBlocks.filter(isToolGroupBlock)
    }, [visibleBlocks])

    const outlineItems = useMemo(
        () => buildConversationOutline(reconciled.blocks),
        [reconciled.blocks]
    )

    const outlineTitle = useMemo(
        () => getOutlineTitle(props.session),
        [props.session]
    )

    // Permission mode change handler
    const handlePermissionModeChange = useCallback(async (mode: PermissionMode) => {
        try {
            await setPermissionMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set permission mode:', e)
        }
    }, [setPermissionMode, props.onRefresh, haptic])

    const handleCollaborationModeChange = useCallback(async (mode: CodexCollaborationMode) => {
        try {
            await setCollaborationMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set collaboration mode:', e)
        }
    }, [setCollaborationMode, props.onRefresh, haptic])

    // Model mode change handler
    const handleModelChange = useCallback(async (model: string | null) => {
        try {
            await setModel(model)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model:', e)
        }
    }, [setModel, props.onRefresh, haptic])

    const handleModelReasoningEffortChange = useCallback(async (modelReasoningEffort: string | null) => {
        try {
            await setModelReasoningEffort(modelReasoningEffort)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model reasoning effort:', e)
        }
    }, [setModelReasoningEffort, props.onRefresh, haptic])

    const handleEffortChange = useCallback(async (effort: string | null) => {
        try {
            await setEffort(effort)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set effort:', e)
        }
    }, [setEffort, props.onRefresh, haptic])

    // Abort handler
    const handleAbort = useCallback(async () => {
        await abortSession()
        props.onRefresh()
    }, [abortSession, props.onRefresh])

    // Switch to remote handler
    const handleSwitchToRemote = useCallback(async () => {
        await switchSession()
        props.onRefresh()
    }, [switchSession, props.onRefresh])

    const handleViewFiles = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId: props.session.id }
        })
    }, [navigate, props.session.id])

    const handleViewTerminal = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId/terminal',
            params: { sessionId: props.session.id }
        })
    }, [navigate, props.session.id])

    // Scheduled message state — lifted here so useHappyRuntime can read the ref.
    //
    // pendingSchedule holds what the user selected (preset or absolute ms).
    // The ref is read at send time; resolvePendingSchedule converts it to an
    // absolute epoch-ms using Date.now() at that moment (send-time base for presets).
    const [pendingSchedule, setPendingSchedule] = useState<PendingSchedule | null>(null)
    const pendingScheduleRef = useRef<PendingSchedule | null>(null)
    // Keep render ref in sync so onNew can snapshot at send time
    pendingScheduleRef.current = pendingSchedule

    // Auto-clear absolute-type pendingSchedule when the chosen time expires so
    // the composer clock button doesn't stay active past the scheduled instant.
    // Preset-type schedules are relative so they don't expire until send — the
    // shouldAutoClearPendingSchedule predicate is the single source of truth so
    // adding a new PendingSchedule variant only needs to update that helper.
    useEffect(() => {
        if (!shouldAutoClearPendingSchedule(pendingSchedule)) return
        // Narrowed to 'absolute' by the predicate above.
        const ms = (pendingSchedule as Extract<PendingSchedule, { type: 'absolute' }>).ms
        const remaining = ms - Date.now()
        if (remaining <= 0) {
            setPendingSchedule(null)
            return
        }
        const timer = setTimeout(() => setPendingSchedule(null), remaining)
        return () => clearTimeout(timer)
    }, [pendingSchedule])

    const handleSend = useCallback(async (text: string, attachments?: AttachmentMetadata[], scheduledAt?: number | null) => {
        const accepted = await props.onSend(text, attachments, scheduledAt)
        if (!accepted) return
        // Clear pendingSchedule only after the mutation is actually accepted —
        // covers both pre-mutation guards AND async inactive-session resume
        // failure. SessionChat is the single owner of schedule clear (HappyComposer
        // no longer clears on its own send path).
        setPendingSchedule(null)
        setForceScrollToken((token) => token + 1)
    }, [props.onSend])

    const attachmentAdapter = useMemo(() => {
        if (!props.session.active) {
            return undefined
        }
        return createAttachmentAdapter(props.api, props.session.id)
    }, [props.api, props.session.id, props.session.active])

    const runtime = useHappyRuntime({
        session: props.session,
        blocks: visibleBlocks,
        isSending: props.isSending,
        isRunning: props.session.thinking || hasRunningChildAgent,
        onSendMessage: handleSend,
        onAbort: handleAbort,
        attachmentAdapter,
        allowSendWhenInactive: true,
        pendingScheduleRef
    })

    return (
        <div className="flex h-full min-h-0 flex-col">
            <SessionHeader
                session={props.session}
                onBack={props.onBack}
                onViewFiles={props.session.metadata?.path ? handleViewFiles : undefined}
                onOpenOutline={() => setOutlineOpen(true)}
                api={props.api}
                onSessionDeleted={props.onBack}
                onResuming={setHeaderResuming}
            />

            {props.session.teamState && (
                <TeamPanel teamState={props.session.teamState} />
            )}

            {sessionInactive ? (
                <InactiveSessionBanner api={props.api} sessionId={props.session.id} externalResuming={headerResuming} />
            ) : null}

            <AssistantRuntimeProvider runtime={runtime}>
                <HappyChatProvider value={{
                    api: props.api,
                    sessionId: props.session.id,
                    metadata: props.session.metadata ?? null,
                    terminalToolDisplayMode,
                    disabled: sessionInactive,
                    onRefresh: props.onRefresh,
                    onRetryMessage: props.onRetryMessage,
                    onCancelQueued: props.onCancelQueued,
                    hasMoreMessages: props.hasMoreMessages,
                    isLoadingMoreMessages: props.isLoadingMoreMessages,
                    loadOlderMessagesPreservingScroll: async () => false
                }}>
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <HappyThread
                        key={props.session.id}
                        api={props.api}
                        sessionId={props.session.id}
                        metadata={props.session.metadata}
                        disabled={sessionInactive}
                        onRefresh={props.onRefresh}
                        onRetryMessage={props.onRetryMessage}
                        onFlushPending={props.onFlushPending}
                        onAtBottomChange={props.onAtBottomChange}
                        isLoadingMessages={props.isLoadingMessages}
                        messagesWarning={props.messagesWarning}
                        hasMoreMessages={props.hasMoreMessages}
                        isLoadingMoreMessages={props.isLoadingMoreMessages}
                        onLoadMore={props.onLoadMore}
                        pendingCount={props.pendingCount}
                        rawMessagesCount={visibleMessages.length}
                        normalizedMessagesCount={normalizedMessages.length}
                        messagesVersion={props.messagesVersion}
                        forceScrollToken={forceScrollToken}
                        outlineOpen={outlineOpen}
                        outlineTitle={outlineTitle}
                        outlineItems={outlineItems}
                        onOutlineOpenChange={setOutlineOpen}
                    />

                    {codexCollaborationModeSupported && codexModelsState.error ? (
                        <div className="px-3 pb-2">
                            <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-red-600">
                                {t('session.codexModelsLoadFailed')}: {codexModelsState.error}
                            </div>
                        </div>
                    ) : null}

                    <div className="px-3">
                        <QueuedMessagesBar
                            sessionId={props.session.id}
                            api={props.api}
                            onEdit={({ pendingSchedule: restored }) => {
                                // Restore the schedule so the clock button re-activates
                                setPendingSchedule(restored)
                            }}
                        />
                    </div>

                    <HappyComposer
                        key={props.session.id}
                        sessionId={props.session.id}
                        disabled={props.isSending}
                        pendingSchedule={pendingSchedule}
                        onSchedule={setPendingSchedule}
                        onClearSchedule={() => setPendingSchedule(null)}
                        permissionMode={props.session.permissionMode}
                        collaborationMode={codexCollaborationModeSupported ? props.session.collaborationMode : undefined}
                        threadGoal={reduced.latestGoal}
                        model={props.session.model}
                        modelReasoningEffort={agentFlavor === 'codex' ? props.session.modelReasoningEffort : undefined}
                        effort={props.session.effort}
                        agentFlavor={agentFlavor}
                        availableModelOptions={
                            agentFlavor === 'codex'
                                ? codexModelOptions
                                : agentFlavor === 'opencode'
                                    ? opencodeModelOptions
                                    : undefined
                        }
                        active={props.session.active}
                        allowSendWhenInactive
                        thinking={props.session.thinking}
                        agentState={props.session.agentState}
                        backgroundTaskCount={props.session.backgroundTaskCount}
                        contextSize={reduced.latestUsage?.contextSize}
                        latestUsage={reduced.latestUsage}
                        usage={props.session.usage}
                        accountStatus={props.session.accountStatus}
                        contextCacheRead={reduced.latestUsage?.cacheRead}
                        contextWindow={reduced.latestUsage?.contextWindow}
                        controlledByUser={controlledByUser}
                        onCollaborationModeChange={
                            codexCollaborationModeSupported && props.session.active && !controlledByUser
                                ? handleCollaborationModeChange
                                : undefined
                        }
                        onPermissionModeChange={handlePermissionModeChange}
                        onModelChange={
                            agentFlavor === 'codex'
                                ? (props.session.active && !controlledByUser && !codexModelsState.error ? handleModelChange : undefined)
                                : handleModelChange
                        }
                        onModelReasoningEffortChange={
                            agentFlavor === 'codex' && props.session.active && !controlledByUser
                                ? handleModelReasoningEffortChange
                                : undefined
                        }
                        onEffortChange={handleEffortChange}
                        onSwitchToRemote={handleSwitchToRemote}
                        onTerminal={props.session.active && terminalSupported ? handleViewTerminal : undefined}
                        terminalUnsupported={props.session.active && !terminalSupported}
                        autocompleteSuggestions={props.autocompleteSuggestions}
                        onDirectSend={handleSend}
                        queuedCount={props.queuedCount ?? 0}
                        hasPausedQueue={props.hasPausedQueue ?? false}
                        onClearQueue={props.onClearQueue}
                        onResumeQueue={props.onResumeQueue}
                    />
                </div>
                </HappyChatProvider>
            </AssistantRuntimeProvider>

        </div>
    )
}

function InactiveSessionBanner({ api, sessionId, externalResuming }: { api: ApiClient; sessionId: string; externalResuming?: boolean }) {
    const { t } = useTranslation()
    const [expanded, setExpanded] = useState(false)
    const [loading, setLoading] = useState(false)
    const [sessions, setSessions] = useState<Array<{ sessionId: string; modifiedAt: number; sizeBytes: number; valid: boolean }>>([])
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [resuming, setResuming] = useState<string | null>(null)
    const navigate = useNavigate()

    const isResuming = resuming !== null || externalResuming

    // One-click resume: just call resume without override, hub auto-discovers
    const handleQuickResume = useCallback(async () => {
        setResuming('quick')
        setError(null)
        try {
            const resolvedId = await api.resumeSession(sessionId)
            if (resolvedId !== sessionId) {
                seedMessageWindowFromSession(sessionId, resolvedId)
            }
            try { await fetchLatestMessages(api, resolvedId) } catch {}
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: resolvedId },
                replace: true
            })
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Resume failed')
            setResuming(null)
        }
    }, [api, sessionId, navigate])

    const handleBrowse = useCallback(async () => {
        if (expanded) {
            setExpanded(false)
            return
        }
        setExpanded(true)
        setLoading(true)
        setError(null)
        try {
            const result = await api.getResumeOptions(sessionId)
            setSessions(result.sessions.filter(s => s.valid))
            setCurrentSessionId(result.currentSessionId)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to scan')
        } finally {
            setLoading(false)
        }
    }, [api, sessionId, expanded])

    const handleResume = useCallback(async (targetSessionId: string) => {
        setResuming(targetSessionId)
        setError(null)
        try {
            const resolvedId = await api.resumeSession(sessionId, { resumeWithSessionId: targetSessionId })
            if (resolvedId !== sessionId) {
                seedMessageWindowFromSession(sessionId, resolvedId)
            }
            try { await fetchLatestMessages(api, resolvedId) } catch {}
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: resolvedId },
                replace: true
            })
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Resume failed')
            setResuming(null)
        }
    }, [api, sessionId, navigate])

    const formatTime = (ms: number) => {
        const diff = Date.now() - ms
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
        return new Date(ms).toLocaleDateString()
    }

    const formatSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes}B`
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`
        return `${(bytes / 1048576).toFixed(1)}MB`
    }

    return (
        <div className="px-3 pt-3">
            <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                    <span className="text-[var(--app-hint)]">
                        {isResuming ? t('resume.resuming') : t('resume.inactiveBanner')}
                    </span>
                    <div className="flex shrink-0 items-center gap-1.5">
                        <button
                            onClick={handleBrowse}
                            disabled={isResuming}
                            className="rounded px-2 py-1 text-xs text-[var(--app-hint)] hover:bg-[var(--app-accent)]/10 disabled:opacity-50"
                        >
                            {expanded ? t('button.cancel') : t('resume.chooseSession')}
                        </button>
                        <button
                            onClick={handleQuickResume}
                            disabled={isResuming}
                            className="rounded-md bg-[var(--app-accent)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                        >
                            {isResuming ? t('resume.resuming') : t('resume.resumeButton')}
                        </button>
                    </div>
                </div>

                {error && (
                    <div className="mt-2 rounded bg-red-50 px-2 py-1.5 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">
                        {error}
                    </div>
                )}

                {expanded && (
                    <div className="mt-2 border-t border-[var(--app-border)] pt-2">
                        {loading ? (
                            <div className="py-2 text-center text-xs text-[var(--app-hint)]">{t('resume.scanning')}</div>
                        ) : sessions.length === 0 ? (
                            <div className="py-2 text-center text-xs text-[var(--app-hint)]">{t('resume.noSessions')}</div>
                        ) : (
                            <div className="flex flex-col gap-1">
                                {sessions.map((s) => (
                                    <button
                                        key={s.sessionId}
                                        onClick={() => handleResume(s.sessionId)}
                                        disabled={isResuming}
                                        className="flex items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--app-accent)]/10 disabled:opacity-50"
                                    >
                                        <span className="font-mono truncate max-w-[60%]">
                                            {s.sessionId.slice(0, 8)}...
                                            {s.sessionId === currentSessionId && (
                                                <span className="ml-1 rounded bg-[var(--app-accent)]/20 px-1 text-[var(--app-accent)]">{t('resume.current')}</span>
                                            )}
                                        </span>
                                        <span className="flex items-center gap-2 text-[var(--app-hint)]">
                                            <span>{formatSize(s.sizeBytes)}</span>
                                            <span>{formatTime(s.modifiedAt)}</span>
                                            {resuming === s.sessionId && <span className="animate-pulse">...</span>}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
