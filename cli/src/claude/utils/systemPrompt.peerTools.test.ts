import { describe, expect, it, vi } from 'vitest'

/**
 * Peer-tools citation steer across all three flavors.
 *
 * The gate is resolved either at import time (citation block baked into
 * module-level prompt consts, feature shape) or at call time
 * (getSystemPrompt(env) resolving per call, stack shape). Setting the env
 * before import AND keeping it set through the assertions covers both
 * shapes; each mode re-imports the modules fresh via vi.resetModules().
 */
async function importFlavorPrompts(disabled: boolean, enabled = true) {
    vi.resetModules()
    const prev = process.env.HAPI_DISABLE_PEER_TOOLS
    const previousEnabled = process.env.HAPI_ENABLE_PEER_COLLABORATION
    if (enabled) process.env.HAPI_ENABLE_PEER_COLLABORATION = '1'
    else delete process.env.HAPI_ENABLE_PEER_COLLABORATION
    if (disabled) process.env.HAPI_DISABLE_PEER_TOOLS = '1'
    else delete process.env.HAPI_DISABLE_PEER_TOOLS
    const [claude, codex, opencode] = await Promise.all([
        import('./systemPrompt'),
        import('../../codex/utils/systemPrompt'),
        import('../../opencode/utils/systemPrompt'),
    ])
    const restore = () => {
        if (previousEnabled === undefined) delete process.env.HAPI_ENABLE_PEER_COLLABORATION
        else process.env.HAPI_ENABLE_PEER_COLLABORATION = previousEnabled
        if (prev === undefined) delete process.env.HAPI_DISABLE_PEER_TOOLS
        else process.env.HAPI_DISABLE_PEER_TOOLS = prev
    }
    return { claude, codex, opencode, restore }
}

describe('peer-tools citation steer across flavors', () => {
    it('treats citations as reference context without enabling collaboration by default', async () => {
        const { claude, codex, opencode, restore } = await importFlavorPrompts(false, false)
        try {
            for (const prompt of [claude.getSystemPrompt(), codex.TITLE_INSTRUCTION, opencode.TITLE_INSTRUCTION, opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION]) {
                expect(prompt).toContain('disabled for this session by default')
                expect(prompt).not.toContain('Call "')
                expect(prompt).not.toContain('auto (default)')
            }
        } finally { restore() }
    })

    it('replaces the citation tool steer with the disabled notice when HAPI_DISABLE_PEER_TOOLS is set', async () => {
        const { claude, codex, opencode, restore } = await importFlavorPrompts(true)
        try {
            const claudePrompt = claude.getSystemPrompt()
            expect(claudePrompt).toContain('are disabled on this machine')
            expect(claudePrompt).not.toContain('Call "mcp__hapi__inspect_peer"')

            expect(codex.TITLE_INSTRUCTION).toContain('are disabled on this machine')
            expect(codex.TITLE_INSTRUCTION).not.toContain('Call "functions.hapi__inspect_peer"')

            expect(opencode.TITLE_INSTRUCTION).toContain('are disabled on this machine')
            expect(opencode.TITLE_INSTRUCTION).not.toContain('Call "hapi_inspect_peer"')

            expect(opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION).toContain('are disabled on this machine')
            expect(opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION).not.toContain('Call "hapi_inspect_peer"')
            for (const prompt of [claudePrompt, codex.TITLE_INSTRUCTION, opencode.TITLE_INSTRUCTION, opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION]) {
                expect(prompt).not.toContain('auto (default)')
            }
        } finally {
            restore()
        }
    })

    it('keeps the citation tool steer when explicitly enabled', async () => {
        const { claude, codex, opencode, restore } = await importFlavorPrompts(false)
        try {
            expect(claude.getSystemPrompt()).toContain('Call "mcp__hapi__inspect_peer"')
            expect(codex.TITLE_INSTRUCTION).toContain('Call "functions.hapi__inspect_peer"')
            expect(opencode.TITLE_INSTRUCTION).toContain('Call "hapi_inspect_peer"')
            expect(opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION).toContain('Call "hapi_inspect_peer"')
            for (const prompt of [claude.getSystemPrompt(), codex.TITLE_INSTRUCTION, opencode.TITLE_INSTRUCTION, opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION]) {
                expect(prompt).toContain('auto (default)')
                expect(prompt).toContain('Prefer auto for routine collaboration')
                expect(prompt).toContain('steer: use for important, time-sensitive findings the peer needs to know now')
                expect(prompt).toContain('does not abort the current turn or guarantee an immediate response')
                expect(prompt).toContain('do not resend automatically')
            }
        } finally {
            restore()
        }
    })
})
