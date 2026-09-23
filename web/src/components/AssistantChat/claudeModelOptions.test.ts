import { describe, expect, it } from 'vitest'
import { getClaudeComposerModelOptions, getNextClaudeComposerModel } from './claudeModelOptions'

describe('getClaudeComposerModelOptions', () => {
    it('renders the discovered catalog and keeps an active unknown model visible', () => {
        const catalog = [
            { value: 'sonnet', label: 'Sonnet 5.5' },
            { value: 'opus[1m]', label: 'Opus 5.5 (1M)' },
        ]
        expect(getClaudeComposerModelOptions('claude-custom', catalog)).toEqual([
            { value: null, label: 'Default' },
            { value: 'claude-custom', label: 'claude-custom' },
            ...catalog,
        ])
    })

    it('does not duplicate the active discovered model', () => {
        expect(getClaudeComposerModelOptions('opus', [{ value: 'opus', label: 'Opus 5.5' }])).toEqual([
            { value: null, label: 'Default' },
            { value: 'opus', label: 'Opus 5.5' },
        ])
    })
})

describe('getNextClaudeComposerModel', () => {
    it('cycles through the discovered catalog', () => {
        expect(getNextClaudeComposerModel('sonnet', [
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'opus', label: 'Opus' },
        ])).toBe('opus')
    })
})
