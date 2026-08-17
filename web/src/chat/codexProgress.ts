import type { ChatBlock } from '@/chat/types'

const MAX_CODEX_PROGRESS_LENGTH = 96

export function formatCodexCommentaryProgress(text: string): string | null {
    const compact = text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\[([^\]]+)]\([^\s)]+\)/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/[`~]/g, '')
        .replace(/(?:^|\n)\s*(?:#{1,6}|[-+>])\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    if (!compact) return null
    return compact.length > MAX_CODEX_PROGRESS_LENGTH
        ? `${compact.slice(0, MAX_CODEX_PROGRESS_LENGTH - 1).trimEnd()}…`
        : compact
}

export function getLatestCodexCommentaryProgress(
    blocks: readonly ChatBlock[],
    currentTurnStartedAt: number
): string | null {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index]
        if (block.createdAt < currentTurnStartedAt) break
        if (block.kind !== 'agent-text' || block.phase !== 'commentary') continue
        const progress = formatCodexCommentaryProgress(block.text)
        if (progress) return progress
    }
    return null
}
