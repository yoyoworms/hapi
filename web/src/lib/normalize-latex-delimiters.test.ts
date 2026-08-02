import { describe, expect, it } from 'vitest'

import { normalizeLatexDelimiters } from './normalize-latex-delimiters'

describe('normalizeLatexDelimiters', () => {
    it('converts Codex block and inline LaTeX delimiters', () => {
        expect(normalizeLatexDelimiters([
            '\\[',
            '企业价值=\\sum_{t=1}^{n} \\frac{FCF_t}{(1+r)^t}',
            '\\]',
            '',
            '- \\(FCF_t\\)：未来第t年的自由现金流',
            '- \\(r\\)：折现率',
            '',
            '\\[ SPCX：-5\\%\\sim-12\\% \\]'
        ].join('\n'))).toBe([
            '$$',
            '企业价值=\\sum_{t=1}^{n} \\frac{FCF_t}{(1+r)^t}',
            '$$',
            '',
            '- $$FCF_t$$：未来第t年的自由现金流',
            '- $$r$$：折现率',
            '',
            '$$ SPCX：-5\\%\\sim-12\\% $$'
        ].join('\n'))
    })

    it('does not modify fenced or inline code', () => {
        const markdown = [
            '```tex',
            '\\[x^2\\]',
            '```',
            '',
            'Keep `\\(inline\\)` literal.'
        ].join('\n')
        expect(normalizeLatexDelimiters(markdown)).toBe(markdown)
    })

    it('leaves incomplete streaming delimiters unchanged', () => {
        expect(normalizeLatexDelimiters('Working: \\[x^2')).toBe('Working: \\[x^2')
        expect(normalizeLatexDelimiters('Working: \\(x')).toBe('Working: \\(x')
    })

    it('does not reinterpret escaped backslashes as math delimiters', () => {
        const markdown = String.raw`Literal path-like text: \\(value\\)`
        expect(normalizeLatexDelimiters(markdown)).toBe(markdown)
    })
})
