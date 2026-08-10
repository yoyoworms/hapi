import type { ReactElement, ReactNode } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'

vi.mock('@assistant-ui/react', () => ({
    ComposerPrimitive: {
        AddAttachment: ({ children, ...props }: { children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
            <button {...props}>{children}</button>
        ),
    },
}))

vi.mock('@/hooks/useComposerToolbarLayout', () => ({
    useComposerToolbarLayout: () => ({
        layout: {
            mode: 'left',
            left: ['attachment', 'piModel', 'piThinking', 'scratchlist', 'schedule'],
            right: [],
        },
    }),
}))

vi.mock('@/lib/use-fue', () => ({
    useFue: () => ({ status: 'acknowledged', engage: vi.fn(), dismiss: vi.fn() }),
}))

vi.mock('@/components/Fue', () => ({
    FueDot: () => null,
    FueCallout: () => null,
}))

vi.mock('./ScheduleTimePicker', () => ({
    ScheduleTimePicker: (props: { onSchedule: (value: { type: 'preset'; preset: '+5m' }) => void }) => (
        <button data-testid="mock-schedule-picker" onClick={() => props.onSchedule({ type: 'preset', preset: '+5m' })}>
            choose schedule
        </button>
    ),
}))

import { ComposerButtons } from './ComposerButtons'

const noop = () => {}

function renderInProviders(ui: ReactElement) {
    return render(<I18nProvider>{ui}</I18nProvider>)
}

function renderButtons(overrides: Partial<React.ComponentProps<typeof ComposerButtons>> = {}) {
    const props = {
        canSend: false,
        controlsDisabled: false,
        showSettingsButton: false,
        onSettingsToggle: noop,
        expanded: false,
        onExpandedToggle: noop,
        showTerminalButton: false,
        terminalDisabled: false,
        terminalLabel: 'Terminal',
        onTerminal: noop,
        showAbortButton: false,
        abortDisabled: false,
        isAborting: false,
        onAbort: noop,
        showSwitchButton: false,
        switchDisabled: false,
        isSwitching: false,
        onSwitch: noop,
        voiceEnabled: false,
        voiceStatus: 'disconnected' as const,
        onVoiceToggle: noop,
        onSend: noop,
        onSchedule: noop,
        onScratchlistToggle: noop,
        ...overrides,
    } as React.ComponentProps<typeof ComposerButtons>
    return renderInProviders(
        <ComposerButtons {...props} />,
    )
}

describe('ComposerButtons attachment invariants', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('closes an already-open schedule picker as soon as an attachment appears', () => {
        const onSchedule = vi.fn()
        const view = renderButtons({ onSchedule })
        fireEvent.click(screen.getByRole('button', { name: 'Schedule send' }))
        expect(screen.getByTestId('mock-schedule-picker')).toBeInTheDocument()

        view.rerender(
            <I18nProvider>
                <ComposerButtons
                    canSend={false}
                    controlsDisabled={false}
                    showSettingsButton={false}
                    onSettingsToggle={noop}
                    expanded={false}
                    onExpandedToggle={noop}
                    showTerminalButton={false}
                    terminalDisabled={false}
                    terminalLabel="Terminal"
                    onTerminal={noop}
                    showAbortButton={false}
                    abortDisabled={false}
                    isAborting={false}
                    onAbort={noop}
                    showSwitchButton={false}
                    switchDisabled={false}
                    isSwitching={false}
                    onSwitch={noop}
                    voiceEnabled={false}
                    voiceStatus="disconnected"
                    onVoiceToggle={noop}
                    onSend={noop}
                    onSchedule={onSchedule}
                    onScratchlistToggle={noop}
                    hasAttachments
                />
            </I18nProvider>,
        )

        expect(screen.queryByTestId('mock-schedule-picker')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Schedule send' })).toBeDisabled()
        expect(onSchedule).not.toHaveBeenCalled()
    })

    it('keeps an externally restored active schedule clearable when attachments already exist', () => {
        const onClearSchedule = vi.fn()
        renderButtons({
            hasAttachments: true,
            pendingSchedule: { type: 'preset', preset: '+5m' },
            onClearSchedule,
        })

        const scheduleButton = screen.getByRole('button', { name: 'Schedule send' })
        expect(scheduleButton).toBeEnabled()
        fireEvent.click(scheduleButton)
        expect(onClearSchedule).toHaveBeenCalledTimes(1)
    })

    it('keeps the mobile toolbar horizontally scrollable without shrinking controls', () => {
        renderButtons({
            piModelLabel: 'provider/extraordinarily-long-model-name',
            piThinkingLabel: 'extraordinarily-long-thinking-level',
        })

        const scroller = screen.getByTestId('composer-toolbar-scroll')
        expect(scroller).toHaveClass('min-w-0', 'overflow-x-auto', 'overscroll-x-contain')
        expect(scroller.firstElementChild).toHaveClass('w-max', 'min-w-full')

        const modelButton = within(scroller).getByRole('button', {
            name: 'provider/extraordinarily-long-model-name',
        })
        expect(modelButton).toHaveClass('max-w-32', 'shrink-0')
        expect(modelButton.querySelector('span')).toHaveClass('truncate')
        expect(within(scroller).getByRole('button', { name: 'Attach file' })).toHaveClass('shrink-0')
        expect(within(scroller).getByRole('button', { name: 'Schedule send' })).toHaveClass('shrink-0')
    })
})
