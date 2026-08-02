type Fence = {
    marker: '`' | '~'
    length: number
}

function isUnescapedBackslash(source: string, index: number): boolean {
    let precedingBackslashes = 0
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
        precedingBackslashes += 1
    }
    return precedingBackslashes % 2 === 0
}

function findClosingDelimiter(
    source: string,
    from: number,
    closingCharacter: ']' | ')'
): number {
    for (let index = from; index < source.length - 1; index += 1) {
        if (
            source[index] === '\\'
            && source[index + 1] === closingCharacter
            && isUnescapedBackslash(source, index)
        ) {
            return index
        }
    }
    return -1
}

function readFence(line: string): Fence | null {
    const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line)
    const markerRun = match?.[1]
    if (!markerRun) return null
    return {
        marker: markerRun[0] as Fence['marker'],
        length: markerRun.length
    }
}

function closesFence(line: string, fence: Fence): boolean {
    const trimmed = line.replace(/^ {0,3}/, '')
    let length = 0
    while (trimmed[length] === fence.marker) length += 1
    return length >= fence.length && /^[ \t]*$/.test(trimmed.slice(length))
}

/**
 * remark-math intentionally only parses dollar-delimited math. Codex and
 * other agents also emit the standard LaTeX `\(...\)` and `\[...\]` forms,
 * which CommonMark otherwise treats as escaped punctuation and displays as
 * plain parentheses/brackets.
 *
 * Convert complete delimiter pairs before Markdown parsing. Fenced and inline
 * code remain byte-for-byte unchanged, and incomplete streaming pairs are left
 * alone until the closing delimiter arrives.
 */
export function normalizeLatexDelimiters(markdown: string): string {
    let result = ''
    let index = 0
    let lineStart = true
    let fence: Fence | null = null
    let inlineCodeTicks = 0

    while (index < markdown.length) {
        if (lineStart) {
            const newlineIndex = markdown.indexOf('\n', index)
            const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex
            const line = markdown.slice(index, lineEnd)

            if (fence) {
                result += markdown.slice(index, newlineIndex === -1 ? lineEnd : lineEnd + 1)
                if (closesFence(line, fence)) fence = null
                index = newlineIndex === -1 ? lineEnd : lineEnd + 1
                lineStart = true
                continue
            }

            if (inlineCodeTicks === 0) {
                const openingFence = readFence(line)
                if (openingFence) {
                    fence = openingFence
                    result += markdown.slice(index, newlineIndex === -1 ? lineEnd : lineEnd + 1)
                    index = newlineIndex === -1 ? lineEnd : lineEnd + 1
                    lineStart = true
                    continue
                }
            }
        }

        const character = markdown[index]

        if (character === '\n') {
            result += character
            index += 1
            lineStart = true
            continue
        }
        lineStart = false

        if (character === '`') {
            let tickCount = 1
            while (markdown[index + tickCount] === '`') tickCount += 1
            result += markdown.slice(index, index + tickCount)
            if (inlineCodeTicks === 0) {
                inlineCodeTicks = tickCount
            } else if (inlineCodeTicks === tickCount) {
                inlineCodeTicks = 0
            }
            index += tickCount
            continue
        }

        if (
            inlineCodeTicks === 0
            && character === '\\'
            && isUnescapedBackslash(markdown, index)
        ) {
            const openingCharacter = markdown[index + 1]
            const closingCharacter = openingCharacter === '['
                ? ']'
                : openingCharacter === '('
                    ? ')'
                    : null
            const closingIndex = closingCharacter
                ? findClosingDelimiter(markdown, index + 2, closingCharacter)
                : -1
            if (closingIndex !== -1) {
                result += '$$'
                index += 2
                result += markdown.slice(index, closingIndex)
                result += '$$'
                index = closingIndex + 2
                continue
            }
        }

        result += character
        index += 1
    }

    return result
}
