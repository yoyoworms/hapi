import { useCallback, useEffect, useMemo, useRef } from 'react'
import { clearDraft, getDraft, saveDraft } from '@/lib/composer-drafts'
import {
    clearDraftAttachments,
    getDraftAttachments,
    saveDraftAttachments,
    type AttachmentDraftInput,
} from '@/lib/composer-attachment-drafts'

const DRAFT_SAVE_DEBOUNCE_MS = 250

function attachmentDraftSetsEqual(
    left: readonly AttachmentDraftInput[],
    right: readonly AttachmentDraftInput[],
): boolean {
    if (left.length !== right.length) return false
    return left.every((attachment, index) => {
        const other = right[index]
        return other !== undefined
            && attachment.id === other.id
            && attachment.file === other.file
            && attachment.path === other.path
            && attachment.previewUrl === other.previewUrl
    })
}

export type ComposerDraftController = Readonly<{
    /** Snapshot the draft before assistant-ui clears it synchronously. */
    prepareForSubmit: (textOverride?: string) => void
    /** Finalize a destination (currently scratchlist) that has durably accepted it. */
    completeSubmission: () => void
    /** Rehydrate the retained attachment snapshot after an async rejection. */
    restoreAttachments: (draftSessionId?: string) => Promise<void>
}>

/**
 * Manages draft save/restore lifecycle for a composer.
 *
 * assistant-ui clears text before invoking `onNew` and removes attachments
 * before the async destination settles. `prepareForSubmit` snapshots both and
 * marks the next empty transition as transient. A later success explicitly
 * clears that snapshot; a rejection restores it.
 */
export function useComposerDraft(
    sessionId: string | undefined,
    composerText: string,
    attachments: readonly AttachmentDraftInput[],
    canRestoreAttachments: boolean,
    setText: (text: string) => void,
    addAttachment: (file: File) => Promise<void>,
): ComposerDraftController {
    const composerTextRef = useRef(composerText)
    composerTextRef.current = composerText
    const attachmentsRef = useRef(attachments)
    attachmentsRef.current = attachments
    const addAttachmentRef = useRef(addAttachment)
    addAttachmentRef.current = addAttachment
    const setTextRef = useRef(setText)
    setTextRef.current = setText

    const draftReadyRef = useRef(false)
    const attachmentsReadyRef = useRef(false)
    const pendingTextClearRef = useRef(false)
    const pendingAttachmentsClearRef = useRef(false)
    const preserveEmptyTextDraftRef = useRef(false)
    const preserveEmptyAttachmentDraftRef = useRef(false)
    const previousHasAttachmentsRef = useRef(attachments.length > 0)
    const lastPersistedAttachmentSetRef = useRef<{
        sessionId: string
        attachments: readonly AttachmentDraftInput[]
    } | null>(null)
    const attachmentRestoreOccupiedRef = useRef(false)
    const pendingAttachmentRestoreSessionRef = useRef<string | null>(null)
    const restoreQueueRef = useRef<Promise<void>>(Promise.resolve())
    const lifecycleGenerationRef = useRef(0)

    const restoreAttachments = useCallback(async (draftSessionId?: string): Promise<void> => {
        const sourceSessionId = draftSessionId ?? sessionId
        if (!sourceSessionId) return
        if (!canRestoreAttachments) {
            // A session can become inactive between upload and POST failure.
            // Remember the source so reopening it can finish the restoration.
            pendingAttachmentRestoreSessionRef.current = sourceSessionId
            return
        }
        pendingAttachmentRestoreSessionRef.current = null
        const generation = lifecycleGenerationRef.current

        const task = restoreQueueRef.current.catch(() => {}).then(async () => {
            if (generation !== lifecycleGenerationRef.current) return
            if (attachmentsRef.current.length > 0 || attachmentRestoreOccupiedRef.current) return

            const files = await getDraftAttachments(sourceSessionId)
            if (generation !== lifecycleGenerationRef.current) return
            if (attachmentsRef.current.length > 0 || attachmentRestoreOccupiedRef.current) return
            if (files.length === 0) return

            // Reserve the empty composer before the first await. Mount restore,
            // local rejection, and route-level mutation errors can all arrive
            // together; only the first may add this attachment set.
            attachmentRestoreOccupiedRef.current = true
            let restored = 0
            for (const file of files) {
                if (generation !== lifecycleGenerationRef.current) break
                try {
                    await addAttachmentRef.current(file)
                    restored += 1
                } catch {
                    // One corrupt/expired draft must not block the rest.
                }
            }
            if (restored === 0) attachmentRestoreOccupiedRef.current = false
        })
        restoreQueueRef.current = task
        await task
    }, [canRestoreAttachments, sessionId])

    useEffect(() => {
        if (!sessionId) return

        lifecycleGenerationRef.current += 1
        const generation = lifecycleGenerationRef.current
        let disposed = false
        const frame = requestAnimationFrame(() => {
            const draft = getDraft(sessionId)
            if (draft && !composerTextRef.current && !preserveEmptyTextDraftRef.current) {
                setTextRef.current(draft)
            }
            draftReadyRef.current = true
            if (canRestoreAttachments) {
                const requestedSource = pendingAttachmentRestoreSessionRef.current
                if (preserveEmptyAttachmentDraftRef.current && !requestedSource) {
                    attachmentsReadyRef.current = true
                    return
                }
                void restoreAttachments(requestedSource ?? sessionId).finally(() => {
                    if (!disposed && generation === lifecycleGenerationRef.current) {
                        attachmentsReadyRef.current = true
                    }
                })
            }
        })

        return () => {
            disposed = true
            cancelAnimationFrame(frame)
            lifecycleGenerationRef.current += 1
            if (draftReadyRef.current) {
                if (!(composerTextRef.current.length === 0 && preserveEmptyTextDraftRef.current)) {
                    saveDraft(sessionId, composerTextRef.current)
                }
            }
            if (attachmentsRef.current.length > 0) {
                saveDraftAttachments(sessionId, [...attachmentsRef.current])
            } else if (
                canRestoreAttachments
                && attachmentsReadyRef.current
                && !preserveEmptyAttachmentDraftRef.current
            ) {
                saveDraftAttachments(sessionId, [])
            }
            draftReadyRef.current = false
            attachmentsReadyRef.current = false
            previousHasAttachmentsRef.current = attachmentsRef.current.length > 0
            attachmentRestoreOccupiedRef.current = false
        }
    }, [sessionId, canRestoreAttachments, restoreAttachments])

    // Persist while the operator types. An empty transition immediately after
    // prepareForSubmit is assistant-ui's optimistic clear, not user deletion.
    useEffect(() => {
        if (!sessionId) return
        if (composerText.length === 0 && pendingTextClearRef.current) {
            pendingTextClearRef.current = false
            preserveEmptyTextDraftRef.current = true
            return
        }
        if (composerText.length > 0) {
            pendingTextClearRef.current = false
            preserveEmptyTextDraftRef.current = false
        } else if (preserveEmptyTextDraftRef.current) {
            return
        }

        const timer = window.setTimeout(() => {
            if (draftReadyRef.current) {
                saveDraft(sessionId, composerTextRef.current)
            }
        }, DRAFT_SAVE_DEBOUNCE_MS)
        return () => window.clearTimeout(timer)
    }, [sessionId, composerText])

    // Attachment files are persisted on every semantic composer update. This
    // makes the File objects available even though assistant-ui removes its
    // chips before the async mutation can fail.
    useEffect(() => {
        if (!sessionId) return
        const hasAttachments = attachments.length > 0
        const previouslyHadAttachments = previousHasAttachmentsRef.current
        previousHasAttachmentsRef.current = hasAttachments

        if (hasAttachments) {
            preserveEmptyAttachmentDraftRef.current = false
            if (draftReadyRef.current) {
                const previous = lastPersistedAttachmentSetRef.current
                if (
                    previous?.sessionId !== sessionId
                    || !attachmentDraftSetsEqual(previous.attachments, attachments)
                ) {
                    saveDraftAttachments(sessionId, [...attachments])
                    lastPersistedAttachmentSetRef.current = {
                        sessionId,
                        attachments: [...attachments],
                    }
                }
            }
            return
        }

        if (previouslyHadAttachments) {
            attachmentRestoreOccupiedRef.current = false
        }
        if (pendingAttachmentsClearRef.current && previouslyHadAttachments) {
            pendingAttachmentsClearRef.current = false
            preserveEmptyAttachmentDraftRef.current = true
            return
        }
        if (preserveEmptyAttachmentDraftRef.current) return
        if (previouslyHadAttachments) {
            // A visible chip removed by the operator is authoritative even if
            // the session became inactive meanwhile. Otherwise reopening can
            // resurrect a file the user explicitly discarded.
            clearDraftAttachments(sessionId)
            lastPersistedAttachmentSetRef.current = { sessionId, attachments: [] }
            return
        }
        if (canRestoreAttachments && attachmentsReadyRef.current) {
            // Manual removal of the last chip must remove the saved draft.
            clearDraftAttachments(sessionId)
            lastPersistedAttachmentSetRef.current = { sessionId, attachments: [] }
        }
    }, [sessionId, attachments, canRestoreAttachments])

    useEffect(() => {
        if (!sessionId || typeof window === 'undefined') return
        let persistedForCurrentBackground = false
        const persistNow = () => {
            if (
                draftReadyRef.current
                && !(composerTextRef.current.length === 0 && preserveEmptyTextDraftRef.current)
            ) {
                saveDraft(sessionId, composerTextRef.current)
            }
            if (attachmentsRef.current.length > 0) {
                saveDraftAttachments(sessionId, [...attachmentsRef.current])
            } else if (
                canRestoreAttachments
                && attachmentsReadyRef.current
                && !preserveEmptyAttachmentDraftRef.current
            ) {
                saveDraftAttachments(sessionId, [])
            }
        }
        const persistOncePerBackground = () => {
            if (persistedForCurrentBackground) return
            persistedForCurrentBackground = true
            persistNow()
        }
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                persistOncePerBackground()
            } else {
                persistedForCurrentBackground = false
            }
        }
        const handlePageShow = () => {
            persistedForCurrentBackground = false
        }
        window.addEventListener('pagehide', persistOncePerBackground)
        window.addEventListener('pageshow', handlePageShow)
        document.addEventListener('visibilitychange', handleVisibilityChange)
        return () => {
            window.removeEventListener('pagehide', persistOncePerBackground)
            window.removeEventListener('pageshow', handlePageShow)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [sessionId, canRestoreAttachments])

    const prepareForSubmit = useCallback((textOverride?: string) => {
        if (!sessionId) return
        // Synchronous cache updates guarantee restoration even if the user
        // sends before the normal debounce/IndexedDB write has settled.
        const submittedText = textOverride ?? composerTextRef.current
        if (submittedText.length > 0) {
            saveDraft(sessionId, submittedText)
            pendingTextClearRef.current = true
        }
        if (attachmentsRef.current.length > 0) {
            const current = attachmentsRef.current
            const previous = lastPersistedAttachmentSetRef.current
            if (
                previous?.sessionId !== sessionId
                || !attachmentDraftSetsEqual(previous.attachments, current)
            ) {
                saveDraftAttachments(sessionId, [...current])
                lastPersistedAttachmentSetRef.current = {
                    sessionId,
                    attachments: [...current],
                }
            }
            pendingAttachmentsClearRef.current = true
        }
    }, [sessionId])

    const completeSubmission = useCallback(() => {
        if (!sessionId) return
        pendingTextClearRef.current = false
        pendingAttachmentsClearRef.current = false

        if (composerTextRef.current.length === 0) {
            clearDraft(sessionId)
        } else {
            saveDraft(sessionId, composerTextRef.current)
        }
        preserveEmptyTextDraftRef.current = false

        if (attachmentsRef.current.length === 0) {
            clearDraftAttachments(sessionId)
            lastPersistedAttachmentSetRef.current = { sessionId, attachments: [] }
        } else {
            saveDraftAttachments(sessionId, [...attachmentsRef.current])
            lastPersistedAttachmentSetRef.current = {
                sessionId,
                attachments: [...attachmentsRef.current],
            }
        }
        preserveEmptyAttachmentDraftRef.current = false
    }, [sessionId])

    return useMemo(() => ({
        prepareForSubmit,
        completeSubmission,
        restoreAttachments,
    }), [completeSubmission, prepareForSubmit, restoreAttachments])
}
