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
import { HappyComposer } from '@/components/AssistantChat/HappyComposer'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { createAttachmentAdapter } from '@/lib/attachmentAdapter'
import { findUnsupportedCodexBuiltinSlashCommand } from '@/lib/codexSlashCommands'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { SessionHeader } from '@/components/SessionHeader'
import { TeamPanel } from '@/components/TeamPanel'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useVoiceOptional } from '@/lib/voice-context'
import { RealtimeVoiceSession, registerSessionStore, registerVoiceHooksStore, voiceHooks } from '@/realtime'
import { isRemoteTerminalSupported } from '@/utils/terminalSupport'

export function SessionChat(props: {
    api: ApiClient
    session: Session
    messages: DecryptedMessage[]
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
    onSend: (text: string, attachments?: AttachmentMetadata[]) => void
    onFlushPending: () => void
    onAtBottomChange: (atBottom: boolean) => void
    onRetryMessage?: (localId: string) => void
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    availableSlashCommands?: readonly SlashCommand[]
}) {
    const { haptic } = usePlatform()
    const { addToast } = useToast()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const sessionInactive = !props.session.active
    const terminalSupported = isRemoteTerminalSupported(props.session.metadata)
    const normalizedCacheRef = useRef<Map<string, { source: DecryptedMessage; normalized: NormalizedMessage | null }>>(new Map())
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const [forceScrollToken, setForceScrollToken] = useState(0)
    const agentFlavor = props.session.metadata?.flavor ?? null
    const controlledByUser = props.session.agentState?.controlledByUser === true
    const codexCollaborationModeSupported = agentFlavor === 'codex' && !controlledByUser
    const { abortSession, switchSession, setPermissionMode, setCollaborationMode, setModel, setEffort } = useSessionActions(
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
    }, [props.session.id])

    const normalizedMessages: NormalizedMessage[] = useMemo(() => {
        // Clear caches immediately when session changes (before useEffect runs)
        if (prevSessionIdRef.current !== null && prevSessionIdRef.current !== props.session.id) {
            normalizedCacheRef.current.clear()
            blocksByIdRef.current.clear()
        }
        prevSessionIdRef.current = props.session.id

        const cache = normalizedCacheRef.current
        const normalized: NormalizedMessage[] = []
        const seen = new Set<string>()
        for (const message of props.messages) {
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
    }, [props.messages])

    const reduced = useMemo(
        () => reduceChatBlocks(normalizedMessages, props.session.agentState),
        [normalizedMessages, props.session.agentState]
    )
    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks]
    )

    useEffect(() => {
        blocksByIdRef.current = reconciled.byId
    }, [reconciled.byId])

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

    const handleSend = useCallback((text: string, attachments?: AttachmentMetadata[]) => {
        if (agentFlavor === 'codex') {
            const unsupportedCommand = findUnsupportedCodexBuiltinSlashCommand(
                text,
                props.availableSlashCommands ?? []
            )
            if (unsupportedCommand) {
                haptic.notification('error')
                addToast({
                    title: t('composer.codexSlashUnsupported.title'),
                    body: t('composer.codexSlashUnsupported.body', { command: `/${unsupportedCommand}` }),
                    sessionId: props.session.id,
                    url: `/sessions/${props.session.id}`
                })
                return
            }
        }

        props.onSend(text, attachments)
        setForceScrollToken((token) => token + 1)
    }, [agentFlavor, props.availableSlashCommands, props.onSend, props.session.id, addToast, haptic, t])

    const attachmentAdapter = useMemo(() => {
        if (!props.session.active) {
            return undefined
        }
        return createAttachmentAdapter(props.api, props.session.id)
    }, [props.api, props.session.id, props.session.active])

    const runtime = useHappyRuntime({
        session: props.session,
        blocks: reconciled.blocks,
        isSending: props.isSending,
        onSendMessage: handleSend,
        onAbort: handleAbort,
        attachmentAdapter,
        allowSendWhenInactive: true
    })

    return (
        <div className="flex h-full min-h-0 flex-col">
            <SessionHeader
                session={props.session}
                onBack={props.onBack}
                onViewFiles={props.session.metadata?.path ? handleViewFiles : undefined}
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
                        rawMessagesCount={props.messages.length}
                        normalizedMessagesCount={normalizedMessages.length}
                        messagesVersion={props.messagesVersion}
                        forceScrollToken={forceScrollToken}
                    />

                    <HappyComposer
                        sessionId={props.session.id}
                        disabled={props.isSending}
                        permissionMode={props.session.permissionMode}
                        collaborationMode={codexCollaborationModeSupported ? props.session.collaborationMode : undefined}
                        model={props.session.model}
                        effort={props.session.effort}
                        agentFlavor={agentFlavor}
                        active={props.session.active}
                        allowSendWhenInactive
                        thinking={props.session.thinking}
                        agentState={props.session.agentState}
                        contextSize={reduced.latestUsage?.contextSize}
                        controlledByUser={controlledByUser}
                        onCollaborationModeChange={
                            codexCollaborationModeSupported && props.session.active && !controlledByUser
                                ? handleCollaborationModeChange
                                : undefined
                        }
                        onPermissionModeChange={handlePermissionModeChange}
                        onModelChange={handleModelChange}
                        onEffortChange={handleEffortChange}
                        onSwitchToRemote={handleSwitchToRemote}
                        onTerminal={props.session.active && terminalSupported ? handleViewTerminal : undefined}
                        terminalUnsupported={props.session.active && !terminalSupported}
                        autocompleteSuggestions={props.autocompleteSuggestions}
                    />
                </div>
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
            const resolvedId = await api.resumeSession(sessionId, targetSessionId)
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
