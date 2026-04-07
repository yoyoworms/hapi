import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { LazyRainbowText } from '@/components/LazyRainbowText'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { MessageStatusIndicator } from '@/components/AssistantChat/messages/MessageStatusIndicator'
import { MessageAttachments } from '@/components/AssistantChat/messages/MessageAttachments'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { CopyIcon, CheckIcon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'

function formatTimestamp(date: Date): string {
    const h = date.getHours().toString().padStart(2, '0')
    const m = date.getMinutes().toString().padStart(2, '0')
    return `${h}:${m}`
}

export function HappyUserMessage() {
    const ctx = useHappyChatContext()
    const { copied, copy } = useCopyToClipboard()
    const role = useAssistantState(({ message }) => message.role)
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

    const userBubbleClass = `w-fit min-w-0 max-w-[92%] ml-auto rounded-xl px-3 py-2 shadow-sm ${
        isQueued
            ? 'bg-[var(--app-secondary-bg)] opacity-60 border-l-2 border-dashed border-[var(--app-hint)]'
            : 'bg-[var(--app-secondary-bg)]'
    } text-[var(--app-fg)]`

    if (isCliOutput) {
        return (
            <MessagePrimitive.Root className="px-1 min-w-0 max-w-full overflow-x-hidden">
                <div className="ml-auto w-full max-w-[92%]">
                    <CliOutputBlock text={cliText} />
                </div>
            </MessagePrimitive.Root>
        )
    }

    const hasText = text.length > 0
    const hasAttachments = attachments && attachments.length > 0

    return (
        <>
            {showTimestamp && createdAt && (
                <div className="w-full text-center text-xs text-[var(--app-hint)] py-1 -mb-1">
                    {formatTimestamp(createdAt)}
                </div>
            )}
            <MessagePrimitive.Root className={`${userBubbleClass} group/msg`}>
                <div className="flex items-end gap-2">
                    <div className="flex-1 min-w-0">
                        {hasText && <LazyRainbowText text={text} />}
                        {hasAttachments && <MessageAttachments attachments={attachments} />}
                    </div>
                    <div className="shrink-0 self-end pb-0.5 flex items-center gap-1">
                        {isQueued && (
                            <span className="text-[10px] text-[var(--app-hint)] whitespace-nowrap">
                                {status === 'paused' ? '⏸ paused' : '⏳ queued'}
                            </span>
                        )}
                        {canCancel && (
                            <button
                                type="button"
                                title="Cancel"
                                className="opacity-60 hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-[var(--app-subtle-bg)]"
                                onClick={() => ctx.onCancelQueued!(localId!)}
                            >
                                <svg className="h-3.5 w-3.5 text-[var(--app-hint)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                        )}
                        {!isQueued && hasText && (
                            <button
                                type="button"
                                title="Copy"
                                className="opacity-60 sm:opacity-0 sm:group-hover/msg:opacity-100 transition-[opacity,background-color] p-0.5 rounded hover:bg-[var(--app-subtle-bg)]"
                                onClick={() => copy(text)}
                            >
                                {copied
                                    ? <CheckIcon className="h-3.5 w-3.5 text-green-500" />
                                    : <CopyIcon className="h-3.5 w-3.5 text-[var(--app-hint)]" />}
                            </button>
                        )}
                        {status && !isQueued && <MessageStatusIndicator status={status} onRetry={onRetry} />}
                    </div>
                </div>
            </MessagePrimitive.Root>
        </>
    )
}
