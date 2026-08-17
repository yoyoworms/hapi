import { describe, expect, it } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import { formatTaskChildLabel } from '@/components/ToolCard/helpers'

function tool(input: unknown): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 1,
        invokedAt: null,
        tool: {
            id: 'tool-1',
            name: 'CodexBash',
            state: 'running',
            input,
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            result: null,
        },
        children: [],
    }
}

const translate = (key: string): string => ({
    'toolGroup.friendly.inspectFiles': 'Inspect project files',
    'toolGroup.friendly.searchContent': 'Search project content',
    'toolGroup.friendly.runCommands': 'Run project commands',
    'toolGroup.friendly.editFiles': 'Edit project files',
    'toolGroup.friendly.openWeb': 'Browse web content',
    'toolGroup.friendly.genericCommand': 'Run command',
    'toolGroup.friendly.genericTool': 'Use tool',
    'toolGroup.codex.explored': 'Explored',
}[key] ?? key)

describe('formatTaskChildLabel', () => {
    it('keeps raw child commands out of the agent activity summary', () => {
        const label = formatTaskChildLabel(tool({
            command: '/bin/zsh -lc "cat secret.env && bun test"'
        }), null, translate)

        expect(label).toBe('Inspect project files')
        expect(label).not.toContain('secret.env')
        expect(label).not.toContain('/bin/zsh')
    })
})
