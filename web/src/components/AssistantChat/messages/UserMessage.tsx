import { memo } from 'react'
import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { MessageStatusIndicator } from '@/components/AssistantChat/messages/MessageStatusIndicator'
import { MessageAttachments } from '@/components/AssistantChat/messages/MessageAttachments'
import { UserBubbleContent, getUserBubbleClassName, shouldShowMessageStatus } from '@/components/AssistantChat/messages/user-bubble'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { MessageActions } from '@/components/AssistantChat/messages/MessageActions'
import { CloseIcon } from '@/components/icons'

function formatTimestamp(date: Date): string {
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    return `${hours}:${minutes}`
}

function HappyUserMessageImpl() {
    const ctx = useHappyChatContext()
    const role = useAssistantState(({ message }) => message.role)
    const messageId = useAssistantState(({ message }) => message.id)
    const text = useAssistantState(({ message }) => {
        if (message.role !== 'user') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
    })
    const status = useAssistantState(({ message }) => {
        if (message.role !== 'user') return undefined
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.status
    })
    const localId = useAssistantState(({ message }) => {
        if (message.role !== 'user') return null
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.localId ?? null
    })
    const attachments = useAssistantState(({ message }) => {
        if (message.role !== 'user') return undefined
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.attachments
    })
    const showTimestamp = useAssistantState(({ message }) => {
        if (message.role !== 'user') return false
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.showTimestamp ?? false
    })
    const createdAt = useAssistantState(({ message }) => message.createdAt)
    const isCliOutput = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const cliText = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
    })
    if (role !== 'user') return null
    const canRetry = status === 'failed' && typeof localId === 'string' && Boolean(ctx.onRetryMessage)
    const onRetry = canRetry ? () => ctx.onRetryMessage!(localId) : undefined
    const isQueued = status === 'queued' || status === 'paused'
    const canCancel = isQueued && typeof localId === 'string' && Boolean(ctx.onCancelQueued)
    const showStatus = shouldShowMessageStatus(status)

    if (isCliOutput) {
        return (
            <MessagePrimitive.Root
                id={getConversationMessageAnchorId(messageId)}
                className="happy-message scroll-mt-4 px-1 min-w-0 max-w-full overflow-x-clip"
            >
                <div className="ml-auto w-full max-w-[92%]">
                    <CliOutputBlock text={cliText} />
                    <MessageActions align="end" copyText={cliText} />
                </div>
            </MessagePrimitive.Root>
        )
    }

    const hasText = text.length > 0
    const hasAttachments = attachments && attachments.length > 0

    return (
        <>
            {showTimestamp && createdAt ? (
                <div className="w-full py-1 -mb-1 text-center text-xs text-[var(--app-hint)]">
                    {formatTimestamp(createdAt)}
                </div>
            ) : null}
            <MessagePrimitive.Root
                id={getConversationMessageAnchorId(messageId)}
                className={`happy-message flex flex-col items-end scroll-mt-4 ${isQueued ? 'opacity-60' : ''}`}
            >
            <div className={`${getUserBubbleClassName(status)} ${isQueued ? 'border-l-2 border-dashed border-[var(--app-hint)]' : ''}`}>
                <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                        {hasText ? <UserBubbleContent text={text} /> : null}
                        {hasAttachments ? <MessageAttachments attachments={attachments} /> : null}
                    </div>
                    {(showStatus || isQueued) && (
                        <div className="happy-message-actions-first-line flex shrink-0 items-center gap-1">
                            {isQueued ? (
                                <span className="whitespace-nowrap text-[10px] text-[var(--app-hint)]">
                                    {status === 'paused' ? 'paused' : 'queued'}
                                </span>
                            ) : null}
                            {canCancel ? (
                                <button
                                    type="button"
                                    title="Cancel"
                                    aria-label="Cancel queued message"
                                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] hover:bg-[var(--app-chat-user-chip-bg)] hover:text-[var(--app-fg)]"
                                    onClick={() => ctx.onCancelQueued!(localId!)}
                                >
                                    <CloseIcon className="h-3.5 w-3.5" />
                                </button>
                            ) : null}
                            {showStatus && !isQueued ? <MessageStatusIndicator status={status} onRetry={onRetry} /> : null}
                        </div>
                    )}
                </div>
            </div>
                <MessageActions align="end" copyText={!isQueued && hasText ? text : undefined} />
            </MessagePrimitive.Root>
        </>
    )
}

export const HappyUserMessage = memo(HappyUserMessageImpl)
