import { describe, expect, it } from 'vitest'
import type { ChatBlock } from '@/chat/types'
import { formatCodexCommentaryProgress, getLatestCodexCommentaryProgress } from '@/chat/codexProgress'

describe('Codex commentary progress', () => {
    it('turns model commentary into a compact readable status', () => {
        expect(formatCodexCommentaryProgress(
            '**初步定位完成。** 下一步检查 `SessionChat.tsx` 的同步边界。'
        )).toBe('初步定位完成。 下一步检查 SessionChat.tsx 的同步边界。')
    })

    it('uses only commentary from the current turn', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'agent-text', id: 'old', localId: null, createdAt: 10,
                text: '旧进度', phase: 'commentary'
            },
            {
                kind: 'user-text', id: 'user', localId: null, createdAt: 20,
                text: 'new task'
            },
            {
                kind: 'agent-text', id: 'final', localId: null, createdAt: 21,
                text: '最终回答', phase: 'final_answer'
            },
            {
                kind: 'agent-text', id: 'progress', localId: null, createdAt: 22,
                text: '正在验证修复', phase: 'commentary'
            }
        ]

        expect(getLatestCodexCommentaryProgress(blocks, 20)).toBe('正在验证修复')
        expect(getLatestCodexCommentaryProgress(blocks, 23)).toBeNull()
    })
})
