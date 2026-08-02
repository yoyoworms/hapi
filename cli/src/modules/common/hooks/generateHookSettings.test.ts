import { describe, expect, it } from 'vitest'
import { buildHookSettings } from './generateHookSettings'

describe('buildHookSettings', () => {
    it('registers only SessionStart by default', () => {
        const settings = buildHookSettings('forward-cmd')
        expect(Object.keys(settings.hooks)).toEqual(['SessionStart'])
        expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('forward-cmd')
    })

    it('adds permission-mode-carrying hooks when trackPermissionMode is set', () => {
        const settings = buildHookSettings('forward-cmd', undefined, true)
        expect(settings.hooks.UserPromptSubmit?.[0].hooks[0].command).toBe('forward-cmd')
        expect(settings.hooks.PreToolUse?.[0].matcher).toBe('*')
        expect(settings.hooks.PreToolUse?.[0].hooks[0].command).toBe('forward-cmd')
    })
})
