import { useMutation } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata, DecryptedMessage } from '@/types/api'
import { makeClientSideId } from '@/lib/messages'
import {
    appendOptimisticMessage,
    syncTailMessages,
    getMessageWindowState,
    removeOptimisticMessage,
    updateMessageStatus,
} from '@/lib/message-window-store'
import * as queue from '@/lib/message-queue-store'
import { usePlatform } from '@/hooks/usePlatform'

type SendMessageInput = {
    sessionId: string
    /**
     * Session whose composer owns the persisted File snapshot. `null` means
     * this send originated outside the composer (for example scratchlist move)
     * and therefore must not clear or restore the operator's current draft.
     */
    draftSessionId: string | null
    text: string
    localId: string
    createdAt: number
    attachments?: AttachmentMetadata[]
    scheduledAt?: number | null
    sourceCodexSessionId?: string | null
}

type BlockedReason = 'no-api' | 'no-session' | 'pending'

/**
 * Information about a send that the underlying mutation rejected.
 *
 * Surfaced via the `onError` option so the consumer can keep the typed
 * text in the composer (composer must NOT clear on 4xx/5xx or network
 * failure) and render an inline affordance.
 *
 * - `sessionId` is the session the failed send was actually targeting
 *   (post-`resolveSessionId`).  Inactive-session resume can resolve a
 *   target id, kick off async navigation, and then have the POST fail
 *   before navigation completes; without this id the consumer would
 *   restore the text into the wrong composer (the old session) and the
 *   sessionId-change effect would clear it again.
 * - `text` is the original input the user typed, captured before the
 *   mutation cleared the composer.
 * - `error` is the raw thrown value (typically `Error`) so the consumer
 *   can inspect status / message.
 * - `scheduledAt` is the absolute epoch-ms the send was bound for, or
 *   null for an immediate send.  Carried through so a failed scheduled
 *   send can be restored as a scheduled send instead of silently
 *   downgrading to immediate -- `SessionChat.handleSend` clears the
 *   pendingSchedule the moment the mutation is accepted, so without
 *   this the schedule is gone by the time onError fires.
 *
 * Attachment sends use the same single retry surface. Their File objects
 * are retained by useComposerDraft and rehydrated from `draftSessionId`.
 */
export type SendErrorInfo = {
    sessionId: string
    draftSessionId: string
    text: string
    attachments?: AttachmentMetadata[]
    error: unknown
    scheduledAt: number | null
}

export type SendSuccessInfo = {
    sessionId: string
    draftSessionId: string | null
    sourceCodexSessionId: string | null
}

type UseSendMessageOptions = {
    resolveSessionId?: (sessionId: string) => Promise<string>
    onSessionResolved?: (sessionId: string) => void
    onBlocked?: (reason: BlockedReason) => void
    onSuccess?: (info: SendSuccessInfo) => void
    // Fork uses `thinking`; upstream renamed to `isSessionThinking`. Accept both.
    thinking?: boolean
    onError?: (info: SendErrorInfo) => void
    isSessionThinking?: boolean
    /** Captured into each mutation so a later route change cannot clear another session's import marker. */
    sourceCodexSessionId?: string | null
}

/** Create an optimistic message for display. Extracted as an extension point
 *  so a future floating-UI PR can route queued messages to a separate area. */
function createOptimisticMessage(input: SendMessageInput, status: 'queued' | 'sending'): DecryptedMessage {
    return {
        id: input.localId,
        seq: null,
        localId: input.localId,
        content: {
            role: 'user',
            content: {
                type: 'text',
                text: input.text,
                attachments: input.attachments
            }
        },
        createdAt: input.createdAt,
        // Explicit null so the strict-null queued check matches. A pre-V8 hub
        // response that omits the field entirely (`undefined`) is treated as
        // already-invoked and stays in the thread, not the floating bar.
        invokedAt: null,
        scheduledAt: input.scheduledAt ?? null,
        status,
        originalText: input.text,
    }
}

function findMessageByLocalId(
    sessionId: string,
    localId: string,
): DecryptedMessage | null {
    const state = getMessageWindowState(sessionId)
    for (const message of state.messages) {
        if (message.localId === localId) return message
    }
    return null
}

/** Pull attachments off a stored optimistic user message.  The schema types
 *  `content` as `unknown`, so this is a defensive narrow: we accept only the
 *  exact shape `createOptimisticMessage` produces (`role: 'user'`, text-typed
 *  content, attachments array) and return undefined otherwise.  Used by
 *  retryMessage so an attachment send retried from the failed-bubble button
 *  re-fires with its attachments instead of becoming a text-only send. */
function getMessageAttachments(message: DecryptedMessage): AttachmentMetadata[] | undefined {
    const content = message.content as unknown
    if (
        typeof content !== 'object' ||
        content === null
    ) {
        return undefined
    }
    const outer = content as { role?: unknown; content?: unknown }
    if (outer.role !== 'user') return undefined
    const inner = outer.content as { type?: unknown; attachments?: unknown } | null
    if (!inner || inner.type !== 'text') return undefined
    if (!Array.isArray(inner.attachments) || inner.attachments.length === 0) {
        return undefined
    }
    return inner.attachments as AttachmentMetadata[]
}

export function useSendMessage(
    api: ApiClient | null,
    sessionId: string | null,
    options?: UseSendMessageOptions
): {
    // Resolves true when a mutation was actually started, false when the call was
    // rejected pre-mutation (no-api / no-session / pending) OR the async
    // resolveSessionId step threw. Async is required because inactive-session
    // resume happens before mutation.mutate(), and a sync `true` would let the
    // caller clear UI state (e.g. pendingSchedule) before knowing whether
    // resume succeeded — see SessionChat.handleSend.
    sendMessage: (text: string, attachments?: AttachmentMetadata[], scheduledAt?: number | null) => Promise<boolean>
    /**
     * Resolves only after the Hub has accepted the message. Unlike
     * `sendMessage`, a locally queued item does not resolve early. This is for
     * move semantics such as scratchlist -> queue, where deleting the source
     * before the POST succeeds would lose the only durable copy on failure.
     */
    sendMessageConfirmed: (text: string, attachments?: AttachmentMetadata[], scheduledAt?: number | null) => Promise<boolean>
    retryMessage: (localId: string) => void
    isSending: boolean
    queuedCount: number
    hasPaused: boolean
    cancelQueued: (localId: string) => void
    clearQueue: () => void
    resumeQueue: () => void
} {
    const { haptic } = usePlatform()
    const [isResolving, setIsResolving] = useState(false)
    const resolveGuardRef = useRef(false)
    const drainingRef = useRef(false)
    const releaseTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    // `thinking` is the fork's name; upstream renamed to `isSessionThinking`. Honor either.
    const thinkingFlag = Boolean(options?.thinking ?? options?.isSessionThinking)
    const thinkingRef = useRef(thinkingFlag)
    const mutationPendingRef = useRef(false)
    const deliveryWaitersRef = useRef(new Map<string, {
        sessionId: string
        phase: 'queued' | 'dispatching'
        resolve: (delivered: boolean) => void
    }>())

    const settleDeliveryWaiter = useCallback((localId: string, delivered: boolean) => {
        const waiter = deliveryWaitersRef.current.get(localId)
        if (!waiter) return
        deliveryWaitersRef.current.delete(localId)
        waiter.resolve(delivered)
    }, [])

    // Subscribe to queue changes — getState returns a stable reference when empty
    const queueState = useSyncExternalStore(
        useCallback((cb) => sessionId ? queue.subscribe(sessionId, cb) : () => {}, [sessionId]),
        useCallback(() => queue.getState(sessionId ?? ''), [sessionId])
    )
    const queuedCount = queueState.items.length
    const hasPaused = queueState.items.some(m => m.phase === 'paused')

    const clearTurnReleaseTimer = useCallback(() => {
        if (releaseTurnTimerRef.current !== null) {
            clearTimeout(releaseTurnTimerRef.current)
            releaseTurnTimerRef.current = null
        }
    }, [])

    const clearTurnLock = useCallback((sid: string) => {
        clearTurnReleaseTimer()
        queue.setInFlight(sid, null)
    }, [clearTurnReleaseTimer])

    const scheduleTurnLockRelease = useCallback((sid: string, localId: string) => {
        clearTurnReleaseTimer()
        releaseTurnTimerRef.current = setTimeout(() => {
            if (mutationPendingRef.current || resolveGuardRef.current || thinkingRef.current) {
                return
            }
            if (queue.getState(sid).inFlightLocalId !== localId) {
                return
            }
            clearTurnLock(sid)
        }, 1500)
    }, [clearTurnLock, clearTurnReleaseTimer])

    useEffect(() => {
        thinkingRef.current = thinkingFlag
    }, [thinkingFlag])

    useEffect(() => () => {
        clearTurnReleaseTimer()
    }, [clearTurnReleaseTimer])

    const cancelQueuedDeliveryWaiters = useCallback((
        shouldCancel: (waiter: { sessionId: string }) => boolean,
    ) => {
        for (const [localId, waiter] of deliveryWaitersRef.current) {
            if (waiter.phase !== 'queued') continue
            if (!shouldCancel(waiter)) continue
            queue.cancel(waiter.sessionId, localId)
            removeOptimisticMessage(waiter.sessionId, localId)
            deliveryWaitersRef.current.delete(localId)
            waiter.resolve(false)
        }
    }, [])

    useEffect(() => () => {
        // Undispatched local items are safe to cancel, so their callers can
        // clean temporary staging files. A dispatching request is different:
        // resolving it false here could delete an upload after the Hub has
        // accepted its message. Keep it alive until mutation success/error.
        cancelQueuedDeliveryWaiters(() => true)
    }, [cancelQueuedDeliveryWaiters])

    // A still-local confirmation belongs to the route that initiated it. If the
    // operator navigates away before dispatch, cancel it and keep the durable
    // scratchlist source. Dispatching confirmations intentionally survive the
    // route change and settle from the Hub result.
    useEffect(() => {
        cancelQueuedDeliveryWaiters((waiter) => waiter.sessionId !== sessionId)
    }, [cancelQueuedDeliveryWaiters, sessionId])

    const mutation = useMutation({
        mutationFn: async (input: SendMessageInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            await api.sendMessage(input.sessionId, input.text, input.localId, input.attachments, input.scheduledAt)
        },
        onSuccess: (_, input) => {
            updateMessageStatus(
                input.sessionId,
                input.localId,
                thinkingRef.current ? 'queued' : 'sent'
            )
            if (!thinkingRef.current) {
                scheduleTurnLockRelease(input.sessionId, input.localId)
            }
            haptic.notification('success')
            // Settle the move before invoking optional UI bookkeeping. A
            // consumer callback must never be able to strand the confirmation.
            settleDeliveryWaiter(input.localId, true)
            try {
                options?.onSuccess?.({
                    sessionId: input.sessionId,
                    draftSessionId: input.draftSessionId,
                    sourceCodexSessionId: input.sourceCodexSessionId ?? null,
                })
            } catch (error) {
                // Delivery is already authoritative. UI/storage bookkeeping
                // must not make TanStack reinterpret a successful POST as a
                // mutation failure and restore/delete the wrong source.
                console.error('Post-send bookkeeping failed:', error)
            }
            if (api) {
                const doFetch = () => syncTailMessages(api, input.sessionId, { ensureAfterCurrent: true }).catch(() => {})
                doFetch()
                setTimeout(doFetch, 1000)
                setTimeout(doFetch, 3000)
            }
        },
        onError: (error, input) => {
            // Fork: stop the optimistic queue so later queued messages don't
            // fire against a session that just failed to accept this one.
            clearTurnLock(input.sessionId)
            queue.pauseQueue(input.sessionId)
            // A move waiting behind this failed request would otherwise sit in
            // a paused local queue forever (there is no durable waiter after a
            // reload). Reject it while its scratchlist source is still intact.
            cancelQueuedDeliveryWaiters((waiter) => waiter.sessionId === input.sessionId)
            // The composer is the sole retry surface for every failed send.
            // Keeping a failed optimistic row as well would duplicate both
            // content and retry actions. Attachment File objects are retained
            // separately by the composer draft controller.
            removeOptimisticMessage(input.sessionId, input.localId)
            haptic.notification('error')
            settleDeliveryWaiter(input.localId, false)
            // External move-style sends retain their own durable source. Do not
            // route their failure through the composer restore channel: doing
            // so can overwrite an unrelated draft that the operator is typing.
            if (input.draftSessionId !== null) {
                try {
                    options?.onError?.({
                        sessionId: input.sessionId,
                        draftSessionId: input.draftSessionId,
                        text: input.text,
                        attachments: input.attachments,
                        error,
                        scheduledAt: input.scheduledAt ?? null
                    })
                } catch (callbackError) {
                    console.error('Failed to report send error:', callbackError)
                }
            }
        },
    })

    useEffect(() => {
        mutationPendingRef.current = mutation.isPending
    }, [mutation.isPending])

    // Dispatch a single message through the resolve → fetch → send pipeline.
    // Returns true once the mutation has been started, false if resolveSessionId
    // threw (caller can clear pendingSchedule, etc.).
    const dispatchMessage = useCallback(async (
        targetApi: ApiClient,
        sid: string,
        text: string,
        localId: string,
        createdAt: number,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        draftSessionId: string | null = sid,
        sourceCodexSessionId: string | null = null,
    ): Promise<boolean> => {
        let targetSessionId = sid
        if (options?.resolveSessionId) {
            resolveGuardRef.current = true
            setIsResolving(true)
            try {
                const resolved = await options.resolveSessionId(sid)
                if (resolved && resolved !== sid) {
                    options.onSessionResolved?.(resolved)
                    queue.moveSession(sid, resolved)
                    targetSessionId = resolved
                    for (const waiter of deliveryWaitersRef.current.values()) {
                        if (waiter.sessionId === sid) waiter.sessionId = resolved
                    }
                }
            } catch (error) {
                haptic.notification('error')
                console.error('Failed to resolve session before send:', error)
                // Fork: stop the optimistic queue so later messages don't fire
                // against a session that just failed to resolve.
                clearTurnLock(sid)
                queue.pauseQueue(sid)
                cancelQueuedDeliveryWaiters((waiter) => waiter.sessionId === sid)
                removeOptimisticMessage(sid, localId)
                // #918: surface the failure via onError so the route can render
                // an inline affordance instead of silently swallowing the
                // typed text.  This covers the "no resume target" branch
                // (inactiveSessionCanResume === false) and also any failure
                // from api.resumeSession itself. The mutation never started,
                // but sendMessage already inserted its optimistic row before
                // awaiting resolution, so remove it before restoring the
                // composer. Key by the ORIGINAL sessionId because navigation
                // hasn't happened yet -- the operator is still on the
                // archived session's route.
                settleDeliveryWaiter(localId, false)
                if (draftSessionId !== null) {
                    try {
                        options?.onError?.({
                            sessionId: sid,
                            draftSessionId,
                            text,
                            attachments,
                            error,
                            scheduledAt: scheduledAt ?? null
                        })
                    } catch (callbackError) {
                        console.error('Failed to report send error:', callbackError)
                    }
                }
                return false
            } finally {
                resolveGuardRef.current = false
                setIsResolving(false)
            }
        }
        await syncTailMessages(targetApi, targetSessionId, { ensureAfterCurrent: true }).catch(() => {})

        // Update optimistic message status from queued to sending
        updateMessageStatus(targetSessionId, localId, 'sending')

        mutation.mutate({
            sessionId: targetSessionId,
            draftSessionId,
            text,
            localId,
            createdAt,
            attachments,
            scheduledAt: scheduledAt ?? null,
            sourceCodexSessionId,
        })
        return true
    }, [cancelQueuedDeliveryWaiters, clearTurnLock, mutation, options, haptic, settleDeliveryWaiter])

    // Try to drain the queue — called when Claude finishes or dispatch completes
    const drainQueue = useCallback(() => {
        if (!api || !sessionId) return
        if (mutation.isPending || resolveGuardRef.current || drainingRef.current || queueState.inFlightLocalId) return
        if (thinkingFlag) return

        const next = queue.peek(sessionId)
        if (!next || next.phase === 'paused') return

        drainingRef.current = true
        const item = queue.dequeue(sessionId)!
        queue.setInFlight(sessionId, item.localId)
        const waiter = deliveryWaitersRef.current.get(item.localId)
        if (waiter) {
            waiter.phase = 'dispatching'
            waiter.sessionId = sessionId
        }

        void dispatchMessage(
            api,
            sessionId,
            item.text,
            item.localId,
            item.createdAt,
            item.attachments,
            item.scheduledAt,
            item.draftSessionId === undefined ? sessionId : item.draftSessionId,
            item.sourceCodexSessionId ?? null,
        )
            .finally(() => { drainingRef.current = false })
    }, [api, sessionId, mutation.isPending, thinkingFlag, queueState.inFlightLocalId, dispatchMessage])

    // Release the current turn lock and try the next queued item when Claude
    // actually finishes thinking.
    const prevThinkingRef = useRef(thinkingFlag)
    useEffect(() => {
        const wasThinking = prevThinkingRef.current
        prevThinkingRef.current = thinkingFlag
        if (thinkingFlag) {
            clearTurnReleaseTimer()
            return
        }
        if (wasThinking && !thinkingFlag) {
            if (sessionId && queueState.inFlightLocalId) {
                clearTurnLock(sessionId)
            }
            drainQueue()
        }
    }, [thinkingFlag, sessionId, queueState.inFlightLocalId, clearTurnLock, clearTurnReleaseTimer, drainQueue])

    // On mount, restore optimistic bubbles for any persisted queued messages
    useEffect(() => {
        if (!sessionId) return
        const state = queue.getState(sessionId)
        for (const item of state.items) {
            appendOptimisticMessage(sessionId, {
                id: item.localId,
                seq: null,
                localId: item.localId,
                content: {
                    role: 'user',
                    content: { type: 'text', text: item.text, attachments: item.attachments }
                },
                createdAt: item.createdAt,
                invokedAt: null,
                scheduledAt: item.scheduledAt ?? null,
                status: 'queued',
                originalText: item.text,
            })
        }
    }, [sessionId])

    // Also try draining on mount/reconnect once the queue exists and the session is idle.
    useEffect(() => {
        if (queuedCount > 0) {
            drainQueue()
        }
    }, [queuedCount, queueState.inFlightLocalId, mutation.isPending, thinkingFlag, drainQueue])

    const sendMessageInternal = useCallback(async (
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        awaitDelivery = false,
    ): Promise<boolean> => {
        if (!api) {
            options?.onBlocked?.('no-api')
            haptic.notification('error')
            return false
        }
        if (!sessionId) {
            options?.onBlocked?.('no-session')
            haptic.notification('error')
            return false
        }

        const localId = makeClientSideId('local')
        const createdAt = Date.now()
        const sourceCodexSessionId = options?.sourceCodexSessionId ?? null
        const busy = mutation.isPending || resolveGuardRef.current
        let deliveryPromise: Promise<boolean> | null = null
        if (awaitDelivery) {
            deliveryPromise = new Promise<boolean>((resolve) => {
                deliveryWaitersRef.current.set(localId, {
                    sessionId,
                    phase: busy ? 'queued' : 'dispatching',
                    resolve,
                })
            })
        }
        const draftSessionId = awaitDelivery ? null : sessionId

        if (busy) {
            // Enqueue and show optimistic bubble with 'queued' status
            queue.enqueue(sessionId, {
                localId,
                text,
                attachments,
                createdAt,
                scheduledAt: scheduledAt ?? null,
                draftSessionId,
                sourceCodexSessionId,
            })
            appendOptimisticMessage(sessionId, createOptimisticMessage({
                sessionId,
                draftSessionId,
                text,
                localId,
                createdAt,
                attachments,
                scheduledAt,
            }, 'queued'))
            haptic.impact('light')
        } else {
            // Dispatch immediately
            appendOptimisticMessage(sessionId, createOptimisticMessage({
                sessionId,
                draftSessionId,
                text,
                localId,
                createdAt,
                attachments,
                scheduledAt,
            }, 'sending'))
            queue.setInFlight(sessionId, localId)
            // Await dispatchMessage so the caller learns whether the async
            // resolveSessionId step succeeded — needed to clear pendingSchedule
            // only on actual send. dispatchMessage returns false when resolve threw.
            const accepted = await dispatchMessage(
                api,
                sessionId,
                text,
                localId,
                createdAt,
                attachments,
                scheduledAt,
                draftSessionId,
                sourceCodexSessionId,
            )
            if (!accepted) {
                settleDeliveryWaiter(localId, false)
                return false
            }
        }
        if (deliveryPromise) return await deliveryPromise
        return true
    }, [api, sessionId, mutation.isPending, options, haptic, dispatchMessage, settleDeliveryWaiter])

    const sendMessage = useCallback((
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
    ) => sendMessageInternal(text, attachments, scheduledAt), [sendMessageInternal])

    const sendMessageConfirmed = useCallback((
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
    ) => sendMessageInternal(text, attachments, scheduledAt, true), [sendMessageInternal])

    const retryMessage = useCallback((localId: string) => {
        if (!api || !sessionId) return
        if (mutation.isPending || resolveGuardRef.current || queueState.inFlightLocalId) return

        const message = findMessageByLocalId(sessionId, localId)
        if (!message?.originalText) return

        updateMessageStatus(sessionId, localId, 'sending')
        queue.setInFlight(sessionId, localId)

        void dispatchMessage(
            api,
            sessionId,
            message.originalText,
            localId,
            message.createdAt,
            getMessageAttachments(message),
            message.scheduledAt ?? null,
            sessionId,
            options?.sourceCodexSessionId ?? null,
        )
    }, [api, sessionId, mutation.isPending, queueState.inFlightLocalId, dispatchMessage, options?.sourceCodexSessionId])

    const cancelQueued = useCallback((localId: string) => {
        if (!sessionId) return
        queue.cancel(sessionId, localId)
        removeOptimisticMessage(sessionId, localId)
        settleDeliveryWaiter(localId, false)
    }, [sessionId, settleDeliveryWaiter])

    const clearQueueFn = useCallback(() => {
        if (!sessionId) return
        const removed = queue.clearAll(sessionId)
        for (const item of removed) {
            removeOptimisticMessage(sessionId, item.localId)
            settleDeliveryWaiter(item.localId, false)
        }
    }, [sessionId, settleDeliveryWaiter])

    const resumeQueueFn = useCallback(() => {
        if (!sessionId) return
        queue.resumeQueue(sessionId)
        drainQueue()
    }, [sessionId, drainQueue])

    return {
        sendMessage,
        sendMessageConfirmed,
        retryMessage,
        isSending: mutation.isPending || isResolving,
        queuedCount,
        hasPaused,
        cancelQueued,
        clearQueue: clearQueueFn,
        resumeQueue: resumeQueueFn,
    }
}
