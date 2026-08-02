import { describe, expect, it } from 'vitest'
import {
    formatCodexReasoningLabel,
    formatCompactCodexReasoningLabel,
    shouldShowCodexReasoningLabel
} from './codexStatusLabels'

describe('codexStatusLabels', () => {
    it('formats unset and default effort as reasoning default', () => {
        expect(formatCodexReasoningLabel(null)).toBe('reasoning default')
        expect(formatCodexReasoningLabel(undefined)).toBe('reasoning default')
        expect(formatCodexReasoningLabel('default')).toBe('reasoning default')
        expect(formatCodexReasoningLabel('  DEFAULT  ')).toBe('reasoning default')
    })

    it('formats selected efforts', () => {
        expect(formatCodexReasoningLabel('xhigh')).toBe('reasoning xhigh')
        expect(formatCodexReasoningLabel('Ultra')).toBe('reasoning ultra')
    })

    it('can omit the reasoning field label', () => {
        expect(formatCodexReasoningLabel('xhigh', false)).toBe('xhigh')
        expect(formatCodexReasoningLabel(null, false)).toBe('default')
    })

    it('formats compact effort-only labels', () => {
        expect(formatCompactCodexReasoningLabel(null)).toBe('default')
        expect(formatCompactCodexReasoningLabel('default')).toBe('default')
        expect(formatCompactCodexReasoningLabel('xhigh')).toBe('xhigh')
        expect(formatCompactCodexReasoningLabel(' Ultra ')).toBe('ultra')
    })

    it('only shows the label for codex and opencode', () => {
        expect(shouldShowCodexReasoningLabel('codex')).toBe(true)
        expect(shouldShowCodexReasoningLabel('opencode')).toBe(true)
        expect(shouldShowCodexReasoningLabel('claude')).toBe(false)
        expect(shouldShowCodexReasoningLabel(null)).toBe(false)
    })
})
