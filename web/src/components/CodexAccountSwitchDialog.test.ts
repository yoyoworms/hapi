import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/api'
import { resolveSessionCodexAccountId } from './CodexAccountSwitchDialog'

function sessionWithMetadata(metadata: Record<string, unknown>): Session {
    return { metadata } as unknown as Session
}

describe('resolveSessionCodexAccountId', () => {
    it('uses the canonical account that owns the current session', () => {
        expect(resolveSessionCodexAccountId(sessionWithMetadata({
            codexAccountId: 'current-1'
        }))).toBe('current-1')
        expect(resolveSessionCodexAccountId(sessionWithMetadata({
            codexAccountId: ' current-2 '
        }))).toBe('current-2')
    })

    it('keeps sessions without account metadata on the system identity', () => {
        expect(resolveSessionCodexAccountId(sessionWithMetadata({
            unrelatedField: 'source-1'
        }))).toBe('system')
        expect(resolveSessionCodexAccountId(sessionWithMetadata({}))).toBe('system')
    })
})
