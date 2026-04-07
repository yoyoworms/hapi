import { useMutation } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata, DecryptedMessage } from '@/types/api'
import { makeClientSideId } from '@/lib/messages'
import {
    appendOptimisticMessage,
    fetchLatestMessages,
    getMessageWindowState,
    removeOptimisticMessage,
    updateMessageStatus,
} from '@/lib/message-window-store'
import * as queue from '@/lib/message-queue-store'
import { usePlatform } from '@/hooks/usePlatform'

type SendMessageInput = {
    sessionId: string
    text: string
    localId: string
    createdAt: number
    attachments?: AttachmentMetadata[]
}

type BlockedReason = 'no-api' | 'no-session'

type UseSendMessageOptions = {
    resolveSessionId?: (sessionId: string) => Promise<string>
    onSessionResolved?: (sessionId: string) => void
    onBlocked?: (reason: BlockedReason) => void
    thinking?: boolean
}

function findMessageByLocalId(
    sessionId: string,
    localId: string,
): DecryptedMessage | null {
    const state = getMessageWindowState(sessionId)
    for (const message of state.messages) {
        if (message.localId === localId) return message
    }
    for (const message of state.pending) {
        if (message.localId === localId) return message
    }
    return null
}

export function useSendMessage(
    api: ApiClient | null,
    sessionId: string | null,
    options?: UseSendMessageOptions
): {
    sendMessage: (text: string, attachments?: AttachmentMetadata[]) => void
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

    // Subscribe to queue changes
    const queueState = useSyncExternalStore(
        useCallback((cb) => sessionId ? queue.subscribe(sessionId, cb) : () => {}, [sessionId]),
        useCallback(() => sessionId ? queue.getState(sessionId) : { items: [], inFlightLocalId: null }, [sessionId])
    )
    const queuedCount = queueState.items.length
    const hasPaused = queueState.items.some(m => m.phase === 'paused')

    const mutation = useMutation({
        mutationFn: async (input: SendMessageInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            await api.sendMessage(input.sessionId, input.text, input.localId, input.attachments)
        },
        onSuccess: (_, input) => {
            updateMessageStatus(input.sessionId, input.localId, 'sent')
            if (sessionId) queue.setInFlight(sessionId, null)
            haptic.notification('success')
            if (api) {
                const doFetch = () => fetchLatestMessages(api, input.sessionId, { incremental: true }).catch(() => {})
                doFetch()
                setTimeout(doFetch, 1000)
                setTimeout(doFetch, 3000)
            }
        },
        onError: (_, input) => {
            updateMessageStatus(input.sessionId, input.localId, 'failed')
            if (sessionId) {
                queue.setInFlight(sessionId, null)
                queue.pauseQueue(sessionId)
            }
            haptic.notification('error')
        },
    })

    // Dispatch a single message through the resolve → fetch → send pipeline
    const dispatchMessage = useCallback(async (
        targetApi: ApiClient,
        sid: string,
        text: string,
        localId: string,
        createdAt: number,
        attachments?: AttachmentMetadata[]
    ) => {
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
                }
            } catch (error) {
                haptic.notification('error')
                console.error('Failed to resolve session before send:', error)
                queue.setInFlight(sid, null)
                queue.pauseQueue(sid)
                return
            } finally {
                resolveGuardRef.current = false
                setIsResolving(false)
            }
        }
        await fetchLatestMessages(targetApi, targetSessionId, { incremental: true }).catch(() => {})

        // Update optimistic message status from queued to sending
        updateMessageStatus(targetSessionId, localId, 'sending')

        mutation.mutate({
            sessionId: targetSessionId,
            text,
            localId,
            createdAt,
            attachments,
        })
    }, [mutation, options, haptic])

    // Try to drain the queue — called when Claude finishes or dispatch completes
    const drainQueue = useCallback(() => {
        if (!api || !sessionId) return
        if (mutation.isPending || resolveGuardRef.current || drainingRef.current) return
        if (options?.thinking) return

        const next = queue.peek(sessionId)
        if (!next || next.phase === 'paused') return

        drainingRef.current = true
        const item = queue.dequeue(sessionId)!
        queue.setInFlight(sessionId, item.localId)

        void dispatchMessage(api, sessionId, item.text, item.localId, item.createdAt, item.attachments)
            .finally(() => { drainingRef.current = false })
    }, [api, sessionId, mutation.isPending, options?.thinking, dispatchMessage])

    // Drain when thinking transitions to false, or when mutation completes
    const prevThinkingRef = useRef(options?.thinking)
    useEffect(() => {
        const wasThinking = prevThinkingRef.current
        prevThinkingRef.current = options?.thinking
        if (wasThinking && !options?.thinking) {
            drainQueue()
        }
    }, [options?.thinking, drainQueue])

    // Also drain when mutation finishes (isPending goes false)
    const prevPendingRef = useRef(mutation.isPending)
    useEffect(() => {
        const wasPending = prevPendingRef.current
        prevPendingRef.current = mutation.isPending
        if (wasPending && !mutation.isPending) {
            drainQueue()
        }
    }, [mutation.isPending, drainQueue])

    const sendMessage = useCallback((text: string, attachments?: AttachmentMetadata[]) => {
        if (!api) {
            options?.onBlocked?.('no-api')
            haptic.notification('error')
            return
        }
        if (!sessionId) {
            options?.onBlocked?.('no-session')
            haptic.notification('error')
            return
        }

        const localId = makeClientSideId('local')
        const createdAt = Date.now()

        const busy = mutation.isPending || resolveGuardRef.current || options?.thinking

        if (busy) {
            // Enqueue and show optimistic bubble with 'queued' status
            queue.enqueue(sessionId, { localId, text, attachments, createdAt })
            const optimisticMessage: DecryptedMessage = {
                id: localId,
                seq: null,
                localId,
                content: {
                    role: 'user',
                    content: { type: 'text', text, attachments }
                },
                createdAt,
                status: 'queued',
                originalText: text,
            }
            appendOptimisticMessage(sessionId, optimisticMessage)
            haptic.impact('light')
        } else {
            // Dispatch immediately
            const optimisticMessage: DecryptedMessage = {
                id: localId,
                seq: null,
                localId,
                content: {
                    role: 'user',
                    content: { type: 'text', text, attachments }
                },
                createdAt,
                status: 'sending',
                originalText: text,
            }
            appendOptimisticMessage(sessionId, optimisticMessage)
            queue.setInFlight(sessionId, localId)
            void dispatchMessage(api, sessionId, text, localId, createdAt, attachments)
        }
    }, [api, sessionId, mutation.isPending, options?.thinking, options?.onBlocked, haptic, dispatchMessage])

    const retryMessage = useCallback((localId: string) => {
        if (!api || !sessionId) return
        if (mutation.isPending || resolveGuardRef.current) return

        const message = findMessageByLocalId(sessionId, localId)
        if (!message?.originalText) return

        updateMessageStatus(sessionId, localId, 'sending')
        queue.setInFlight(sessionId, localId)

        void dispatchMessage(api, sessionId, message.originalText, localId, message.createdAt)
    }, [api, sessionId, mutation.isPending, dispatchMessage])

    const cancelQueued = useCallback((localId: string) => {
        if (!sessionId) return
        queue.cancel(sessionId, localId)
        removeOptimisticMessage(sessionId, localId)
    }, [sessionId])

    const clearQueueFn = useCallback(() => {
        if (!sessionId) return
        const removed = queue.clearAll(sessionId)
        for (const item of removed) {
            removeOptimisticMessage(sessionId, item.localId)
        }
    }, [sessionId])

    const resumeQueueFn = useCallback(() => {
        if (!sessionId) return
        queue.resumeQueue(sessionId)
        drainQueue()
    }, [sessionId, drainQueue])

    return {
        sendMessage,
        retryMessage,
        isSending: mutation.isPending || isResolving,
        queuedCount,
        hasPaused,
        cancelQueued,
        clearQueue: clearQueueFn,
        resumeQueue: resumeQueueFn,
    }
}
