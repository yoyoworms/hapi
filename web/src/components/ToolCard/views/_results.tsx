import { useState } from 'react'
import type { ToolViewComponent, ToolViewProps } from '@/components/ToolCard/views/_all'
import { isObject, safeStringify } from '@hapi/protocol'
import { CodeBlock } from '@/components/CodeBlock'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { ChecklistList, extractTodoChecklist } from '@/components/ToolCard/checklist'
import { basename, resolveDisplayPath } from '@/utils/path'

function parseToolUseError(message: string): { isToolUseError: boolean; errorMessage: string | null } {
    const regex = /<tool_use_error>(.*?)<\/tool_use_error>/s
    const match = message.match(regex)

    if (match) {
        return {
            isToolUseError: true,
            errorMessage: typeof match[1] === 'string' ? match[1].trim() : ''
        }
    }

    return { isToolUseError: false, errorMessage: null }
}

function extractTextFromContentBlock(block: unknown): string | null {
    if (typeof block === 'string') return block
    if (!isObject(block)) return null
    if (block.type === 'text' && typeof block.text === 'string') return block.text
    if (typeof block.text === 'string') return block.text
    return null
}

export function extractTextFromResult(result: unknown, depth: number = 0): string | null {
    if (depth > 2) return null
    if (result === null || result === undefined) return null
    if (typeof result === 'string') {
        const toolUseError = parseToolUseError(result)
        return toolUseError.isToolUseError ? (toolUseError.errorMessage ?? '') : result
    }

    if (Array.isArray(result)) {
        const parts = result
            .map(extractTextFromContentBlock)
            .filter((part): part is string => typeof part === 'string' && part.length > 0)
        return parts.length > 0 ? parts.join('\n') : null
    }

    if (!isObject(result)) return null

    if (typeof result.content === 'string') return result.content
    if (typeof result.text === 'string') return result.text
    if (typeof result.output === 'string') return result.output
    if (typeof result.error === 'string') return result.error
    if (typeof result.message === 'string') return result.message

    const contentArray = Array.isArray(result.content) ? result.content : null
    if (contentArray) {
        const parts = contentArray
            .map(extractTextFromContentBlock)
            .filter((part): part is string => typeof part === 'string' && part.length > 0)
        return parts.length > 0 ? parts.join('\n') : null
    }

    const nestedOutput = isObject(result.output) ? result.output : null
    if (nestedOutput) {
        if (typeof nestedOutput.content === 'string') return nestedOutput.content
        if (typeof nestedOutput.text === 'string') return nestedOutput.text
    }

    const nestedError = isObject(result.error) ? result.error : null
    if (nestedError) {
        if (typeof nestedError.message === 'string') return nestedError.message
        if (typeof nestedError.error === 'string') return nestedError.error
    }

    const nestedResult = isObject(result.result) ? result.result : null
    if (nestedResult) {
        const nestedText = extractTextFromResult(nestedResult, depth + 1)
        if (nestedText) return nestedText
    }

    const nestedData = isObject(result.data) ? result.data : null
    if (nestedData) {
        const nestedText = extractTextFromResult(nestedData, depth + 1)
        if (nestedText) return nestedText
    }

    return null
}

interface CodexBashOutput {
    exitCode: number | null
    wallTime: string | null
    output: string
}

function parseCodexBashOutput(text: string): CodexBashOutput | null {
    const exitMatch = text.match(/^Exit code:\s*(\d+)/m)
    const wallMatch = text.match(/^Wall time:\s*(.+)$/m)
    const outputMatch = text.match(/^Output:\n([\s\S]*)$/m)

    if (!exitMatch && !wallMatch && !outputMatch) return null

    return {
        exitCode: exitMatch ? parseInt(exitMatch[1], 10) : null,
        wallTime: wallMatch ? wallMatch[1].trim() : null,
        output: outputMatch ? outputMatch[1] : text
    }
}

export function getMutationResultRenderMode(text: string, state: string): { mode: 'code' | 'auto'; language?: string } {
    const isMultiline = text.split('\n').length > 3
    const mode = state === 'error' || isMultiline ? 'code' as const : 'auto' as const
    return { mode, language: mode === 'code' ? 'text' : undefined }
}

function looksLikeHtml(text: string): boolean {
    const trimmed = text.trimStart()
    return trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<div') || trimmed.startsWith('<span')
}

function looksLikeJson(text: string): boolean {
    const trimmed = text.trim()
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))
}

function renderText(text: string, opts: { mode: 'markdown' | 'code' | 'auto'; language?: string } = { mode: 'auto' }) {
    if (opts.mode === 'code') {
        return <CodeBlock code={text} language={opts.language ?? 'text'} />
    }

    if (opts.mode === 'markdown') {
        return <MarkdownRenderer content={text} />
    }

    if (looksLikeHtml(text) || looksLikeJson(text)) {
        return <CodeBlock code={text} language={looksLikeJson(text) ? 'json' : 'html'} />
    }

    return <MarkdownRenderer content={text} />
}

function placeholderForState(state: ToolViewProps['block']['tool']['state']): string {
    if (state === 'pending') return 'Waiting for permission…'
    if (state === 'running') return 'Running…'
    return '(no output)'
}

function RawJsonDevOnly(props: { value: unknown }) {
    if (!import.meta.env.DEV) return null
    if (props.value === null || props.value === undefined) return null

    return (
        <details className="mt-3">
            <summary className="cursor-pointer text-xs font-medium text-[var(--app-hint)]">
                Raw JSON
            </summary>
            <div className="mt-2">
                <CodeBlock code={safeStringify(props.value)} language="json" />
            </div>
        </details>
    )
}

function extractStdoutStderr(result: unknown): { stdout: string | null; stderr: string | null } | null {
    if (!isObject(result)) return null

    const stdout = typeof result.stdout === 'string' ? result.stdout : null
    const stderr = typeof result.stderr === 'string' ? result.stderr : null
    if (stdout !== null || stderr !== null) {
        return { stdout, stderr }
    }

    const nested = isObject(result.output) ? result.output : null
    if (nested) {
        const nestedStdout = typeof nested.stdout === 'string' ? nested.stdout : null
        const nestedStderr = typeof nested.stderr === 'string' ? nested.stderr : null
        if (nestedStdout !== null || nestedStderr !== null) {
            return { stdout: nestedStdout, stderr: nestedStderr }
        }
    }

    return null
}

function extractReadFileContent(result: unknown): { filePath: string | null; content: string } | null {
    if (!isObject(result)) return null
    const file = isObject(result.file) ? result.file : null
    if (!file) return null

    const content = typeof file.content === 'string' ? file.content : null
    if (content === null) return null

    const filePath = typeof file.filePath === 'string'
        ? file.filePath
        : typeof file.file_path === 'string'
            ? file.file_path
            : null

    return { filePath, content }
}

function extractLineList(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
}

function isProbablyMarkdownList(text: string): boolean {
    const trimmed = text.trimStart()
    return trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('1. ')
}

const AskUserQuestionResultView: ToolViewComponent = (props: ToolViewProps) => {
    const answers = props.block.tool.permission?.answers ?? null

    // If answers exist, AskUserQuestionView already shows them with highlighting
    // Return null to avoid duplicate display
    if (answers && Object.keys(answers).length > 0) {
        return null
    }

    // Fallback for tools without structured answers
    return <MarkdownResultView {...props} />
}

const BashResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    if (typeof result === 'string') {
        const toolUseError = parseToolUseError(result)
        const display = toolUseError.isToolUseError ? (toolUseError.errorMessage ?? '') : result
        return (
            <>
                <CodeBlock code={display} language="text" />
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const stdio = extractStdoutStderr(result)
    if (stdio) {
        return (
            <>
                <div className="flex flex-col gap-2">
                    {stdio.stdout ? <CodeBlock code={stdio.stdout} language="text" /> : null}
                    {stdio.stderr ? <CodeBlock code={stdio.stderr} language="text" /> : null}
                </div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'code', language: 'text' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const MarkdownResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const LineListResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (!text) {
        return (
            <>
                <div className="text-sm text-[var(--app-hint)]">(no output)</div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    if (isProbablyMarkdownList(text)) {
        return (
            <>
                <MarkdownRenderer content={text} />
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const lines = extractLineList(text)
    if (lines.length === 0) {
        return (
            <>
                <div className="text-sm text-[var(--app-hint)]">(no output)</div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="flex flex-col gap-1">
                {lines.map((line) => (
                    <div key={line} className="text-sm font-mono text-[var(--app-fg)] break-all">
                        {line}
                    </div>
                ))}
            </div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const ReadResultView: ToolViewComponent = (props: ToolViewProps) => {
    const { result, cosFileUrl } = props.block.tool

    // If we have a COS URL, show the file preview (image/video/pdf)
    if (cosFileUrl) {
        return <CosFilePreview url={cosFileUrl} />
    }

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const file = extractReadFileContent(result)
    if (file) {
        const path = file.filePath ? resolveDisplayPath(file.filePath, props.metadata) : null
        return (
            <>
                {path ? (
                    <div className="mb-2 text-xs text-[var(--app-hint)] font-mono break-all">
                        {basename(path)}
                    </div>
                ) : null}
                <CodeBlock code={file.content} language="text" />
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'code', language: 'text' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

function getFileTypeFromUrl(url: string): 'image' | 'video' | 'pdf' | 'other' {
    const lower = url.toLowerCase()
    if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)(\?|$)/.test(lower)) return 'image'
    if (/\.(mp4|webm|mov)(\?|$)/.test(lower)) return 'video'
    if (/\.pdf(\?|$)/.test(lower)) return 'pdf'
    return 'other'
}

function getFilenameFromUrl(url: string): string {
    try {
        const path = new URL(url).pathname
        return path.split('/').pop() || 'file'
    } catch {
        return 'file'
    }
}

function CosFilePreview({ url }: { url: string }) {
    const [expanded, setExpanded] = useState(false)
    const type = getFileTypeFromUrl(url)
    const filename = getFilenameFromUrl(url)

    if (type === 'image') {
        return (
            <div className="mt-2">
                <a href={url} target="_blank" rel="noopener noreferrer" className="block">
                    <div className="relative rounded-lg overflow-hidden border border-[var(--app-border)] bg-[var(--app-bg-secondary)] inline-block max-w-full">
                        <img
                            src={url}
                            alt={filename}
                            className="max-h-[400px] max-w-full object-contain cursor-pointer"
                            onClick={(e) => {
                                e.preventDefault()
                                setExpanded(!expanded)
                            }}
                            style={expanded ? { maxHeight: 'none' } : undefined}
                        />
                        <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-2 py-1 text-xs text-white truncate">
                            {filename}
                        </div>
                    </div>
                </a>
            </div>
        )
    }

    if (type === 'video') {
        return (
            <div className="mt-2">
                <div className="rounded-lg overflow-hidden border border-[var(--app-border)] bg-[var(--app-bg-secondary)] inline-block max-w-full">
                    <video
                        src={url}
                        controls
                        className="max-h-[400px] max-w-full"
                        preload="metadata"
                    />
                    <div className="px-2 py-1 text-xs text-[var(--app-hint)] truncate">
                        {filename}
                    </div>
                </div>
            </div>
        )
    }

    if (type === 'pdf') {
        return (
            <div className="mt-2">
                <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg-secondary)] hover:bg-[var(--app-bg-tertiary)] transition-colors max-w-sm"
                >
                    <svg className="w-5 h-5 text-red-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M4 18h12a2 2 0 002-2V6l-4-4H6a2 2 0 00-2 2v12a2 2 0 002 2zm8-14l4 4h-4V4zM6 2h6v4h4v10H6V2z"/>
                    </svg>
                    <span className="text-sm text-[var(--app-fg)] truncate">{filename}</span>
                </a>
            </div>
        )
    }

    // Generic file link
    return (
        <div className="mt-2">
            <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg-secondary)] hover:bg-[var(--app-bg-tertiary)] transition-colors max-w-sm"
            >
                <svg className="w-5 h-5 text-[var(--app-hint)] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
                <span className="text-sm text-[var(--app-fg)] truncate">{filename}</span>
            </a>
        </div>
    )
}

const MutationResultView: ToolViewComponent = (props: ToolViewProps) => {
    const { state, result, cosFileUrl } = props.block.tool

    if (result === undefined || result === null) {
        if (state === 'completed') {
            return (
                <>
                    <div className="text-sm text-[var(--app-hint)]">Done</div>
                    {cosFileUrl ? <CosFilePreview url={cosFileUrl} /> : null}
                </>
            )
        }
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(state)}</div>
    }

    const text = extractTextFromResult(result)
    if (typeof text === 'string' && text.trim().length > 0) {
        const className = state === 'error' ? 'text-red-600' : 'text-[var(--app-fg)]'
        const { mode, language } = getMutationResultRenderMode(text, state)
        return (
            <>
                <div className={`text-sm ${className}`}>
                    {renderText(text, { mode, language })}
                </div>
                {cosFileUrl ? <CosFilePreview url={cosFileUrl} /> : null}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">
                {state === 'completed' ? 'Done' : '(no output)'}
            </div>
            {cosFileUrl ? <CosFilePreview url={cosFileUrl} /> : null}
            <RawJsonDevOnly value={result} />
        </>
    )
}

const CodexPatchResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result
    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    if (result === undefined || result === null) {
        return props.block.tool.state === 'completed'
            ? <div className="text-sm text-[var(--app-hint)]">Done</div>
            : <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const CodexReasoningResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result
    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const CodexDiffResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result
    if (result === undefined || result === null) {
        return props.block.tool.state === 'completed'
            ? <div className="text-sm text-[var(--app-hint)]">Done</div>
            : <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'code', language: 'diff' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">Done</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const TodoWriteResultView: ToolViewComponent = (props: ToolViewProps) => {
    const todos = extractTodoChecklist(props.block.tool.input, props.block.tool.result)
    if (todos.length === 0) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    return <ChecklistList items={todos} />
}

const GenericResultView: ToolViewComponent = (props: ToolViewProps) => {
    const { result, cosFileUrl } = props.block.tool

    if (result === undefined || result === null) {
        return (
            <>
                <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
                {cosFileUrl ? <CosFilePreview url={cosFileUrl} /> : null}
            </>
        )
    }

    // Detect codex bash output format and render accordingly
    if (typeof result === 'string') {
        const parsed = parseCodexBashOutput(result)
        if (parsed) {
            return (
                <>
                    <div className="text-xs text-[var(--app-hint)] mb-2">
                        {parsed.exitCode !== null && `Exit code: ${parsed.exitCode}`}
                        {parsed.exitCode !== null && parsed.wallTime && ' · '}
                        {parsed.wallTime && `Wall time: ${parsed.wallTime}`}
                    </div>
                    {renderText(parsed.output.trim(), { mode: 'code' })}
                    {cosFileUrl ? <CosFilePreview url={cosFileUrl} /> : null}
                    <RawJsonDevOnly value={result} />
                </>
            )
        }
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                {cosFileUrl ? <CosFilePreview url={cosFileUrl} /> : null}
                {typeof result === 'object' ? <RawJsonDevOnly value={result} /> : null}
            </>
        )
    }

    if (typeof result === 'string') {
        return (
            <>
                {renderText(result, { mode: 'auto' })}
                {cosFileUrl ? <CosFilePreview url={cosFileUrl} /> : null}
            </>
        )
    }

    return (
        <>
            <CodeBlock code={safeStringify(result)} language="json" />
            {cosFileUrl ? <CosFilePreview url={cosFileUrl} /> : null}
        </>
    )
}

export const toolResultViewRegistry: Record<string, ToolViewComponent> = {
    Task: MarkdownResultView,
    Bash: BashResultView,
    Glob: LineListResultView,
    Grep: LineListResultView,
    LS: LineListResultView,
    Read: ReadResultView,
    Edit: MutationResultView,
    MultiEdit: MutationResultView,
    Write: MutationResultView,
    WebFetch: MarkdownResultView,
    WebSearch: MarkdownResultView,
    NotebookRead: ReadResultView,
    NotebookEdit: MutationResultView,
    TodoWrite: TodoWriteResultView,
    CodexReasoning: CodexReasoningResultView,
    CodexPatch: CodexPatchResultView,
    CodexDiff: CodexDiffResultView,
    AskUserQuestion: AskUserQuestionResultView,
    ExitPlanMode: MarkdownResultView,
    ask_user_question: AskUserQuestionResultView,
    exit_plan_mode: MarkdownResultView
}

export function getToolResultViewComponent(toolName: string): ToolViewComponent {
    if (toolName.startsWith('mcp__')) {
        return GenericResultView
    }
    return toolResultViewRegistry[toolName] ?? GenericResultView
}
