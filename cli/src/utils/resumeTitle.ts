import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const UUID_LIKE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function normalizeTitle(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

function isSessionIdLike(value: string): boolean {
    return UUID_LIKE_PATTERN.test(value.trim())
}

export function extractClaudeResumeTitle(args: string[] | undefined): string | undefined {
    if (!args || args.length === 0) return undefined

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg !== '--resume') continue

        const candidate = normalizeTitle(args[i + 1])
        if (!candidate || candidate.startsWith('-')) return undefined
        if (isSessionIdLike(candidate)) return undefined
        return candidate
    }

    return undefined
}

export function extractClaudeResumeSessionId(args: string[] | undefined): string | undefined {
    if (!args || args.length === 0) return undefined

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg !== '--resume') continue

        const candidate = normalizeTitle(args[i + 1])
        if (!candidate || candidate.startsWith('-')) return undefined
        if (!isSessionIdLike(candidate)) return undefined
        return candidate
    }

    return undefined
}

export function resolveCodexResumeTitle(sessionId: string | undefined): string | undefined {
    const id = normalizeTitle(sessionId)
    if (!id) return undefined

    const indexPath = join(homedir(), '.codex', 'session_index.jsonl')
    if (!existsSync(indexPath)) return undefined

    try {
        const lines = readFileSync(indexPath, 'utf8').split('\n')
        let title: string | undefined
        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            const record = JSON.parse(trimmed) as { id?: unknown; thread_name?: unknown; title?: unknown; name?: unknown }
            if (record.id !== id) continue
            title = normalizeTitle(record.thread_name) ?? normalizeTitle(record.title) ?? normalizeTitle(record.name) ?? title
        }
        return title
    } catch {
        return undefined
    }
}
