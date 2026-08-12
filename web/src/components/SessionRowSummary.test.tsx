import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionRowSummary } from './SessionRowSummary'

afterEach(() => cleanup())

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: 'session-1',
        active: true,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: { name: 'Pinned task', path: '/work/hapi', flavor: 'codex' },
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides,
    }
}

function renderSummary(session: SessionSummary) {
    return render(
        <I18nProvider>
            <SessionRowSummary session={session} showDetailedStatus={false} />
        </I18nProvider>
    )
}

describe('SessionRowSummary pin indicator', () => {
    it('shows a project pin icon on a project-pinned row', () => {
        renderSummary(makeSession({ pinned: true }))

        expect(screen.getByLabelText('Pinned in project').querySelector('svg')).not.toBeNull()
    })

    it('shows a distinct global pin label on a globally pinned row', () => {
        renderSummary(makeSession({ globalPinned: true }))

        expect(screen.getByLabelText('Pinned globally').querySelector('svg')).not.toBeNull()
    })

    it('does not render a pin indicator on an unpinned row', () => {
        renderSummary(makeSession())

        expect(screen.queryByLabelText(/Pinned/)).toBeNull()
    })
})

describe('SessionRowSummary plan progress', () => {
    it('hides an idle Codex plan snapshot that was not finalized', () => {
        renderSummary(makeSession({
            thinking: false,
            todoProgress: { completed: 0, total: 6 }
        }))

        expect(screen.queryByText('0/6')).toBeNull()
    })

    it('shows Codex plan progress while the turn is working', () => {
        renderSummary(makeSession({
            thinking: true,
            todoProgress: { completed: 0, total: 6 }
        }))

        expect(screen.getByText('0/6')).toBeInTheDocument()
    })


    it('keeps non-Codex durable todo progress visible while idle', () => {
        renderSummary(makeSession({
            metadata: { name: 'Claude task', path: '/work/hapi', flavor: 'claude' },
            thinking: false,
            todoProgress: { completed: 1, total: 3 }
        }))

        expect(screen.getByText('1/3')).toBeInTheDocument()
    })
})
