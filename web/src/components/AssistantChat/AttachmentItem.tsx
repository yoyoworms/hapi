import { AttachmentPrimitive, useThreadComposerAttachment } from '@assistant-ui/react'
import { Spinner } from '@/components/Spinner'

function ErrorIcon() {
    return (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="11" r="0.75" fill="currentColor" />
        </svg>
    )
}

function RemoveIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <line x1="3" y1="3" x2="9" y2="9" />
            <line x1="9" y1="3" x2="3" y2="9" />
        </svg>
    )
}

export function AttachmentItem() {
    const { name, status } = useThreadComposerAttachment()
    const isUploading = status.type === 'running'
    const isError = status.type === 'incomplete'

    return (
        <AttachmentPrimitive.Root className="flex min-w-0 max-w-full items-center gap-2 rounded-lg bg-[var(--app-subtle-bg)] px-3 py-2 text-base text-[var(--app-fg)]">
            {isUploading ? <Spinner size="sm" label={null} className="text-[var(--app-hint)]" /> : null}
            {isError ? (
                <span className="shrink-0 text-red-500" aria-label="Upload failed" title="Upload failed">
                    <ErrorIcon />
                </span>
            ) : null}
            <span className={`min-w-0 max-w-[150px] flex-1 truncate ${isError ? 'text-red-500 line-through' : ''}`}>{name}</span>
            {isError ? (
                <span aria-hidden="true" className="hidden shrink-0 whitespace-nowrap text-xs text-red-500 sm:inline">
                    Upload failed
                </span>
            ) : null}
            <AttachmentPrimitive.Remove
                className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
                aria-label="Remove attachment"
                title="Remove attachment"
            >
                <RemoveIcon />
            </AttachmentPrimitive.Remove>
        </AttachmentPrimitive.Root>
    )
}
