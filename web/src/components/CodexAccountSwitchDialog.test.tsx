import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import type { Session } from '@/types/api'

vi.mock('@/components/NewSession/CodexAccountSelector', () => ({
    CodexAccountSelector: (props: { onChange: (accountId: string | null) => void }) => (
        <button type="button" onClick={() => props.onChange(null)}>
            Clear account selection
        </button>
    )
}))

import {
    CodexAccountSwitchDialog,
    resolveSessionCodexAccountId
} from './CodexAccountSwitchDialog'

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

describe('CodexAccountSwitchDialog', () => {
    it('does not offer a switch when no target account is selected', () => {
        const resumeSession = vi.fn()
        const session = {
            id: 'session-1',
            metadata: {
                machineId: 'machine-1',
                flavor: 'codex',
                codexAccountId: 'current-1'
            }
        } as unknown as Session

        render(
            <I18nProvider>
                <CodexAccountSwitchDialog
                    isOpen={true}
                    onClose={vi.fn()}
                    session={session}
                    api={{ resumeSession } as unknown as ApiClient}
                    onSwitched={vi.fn()}
                />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: 'Clear account selection' }))

        expect(screen.getByRole('button', { name: /switch and continue/i })).toBeDisabled()
        expect(resumeSession).not.toHaveBeenCalled()
    })
})
