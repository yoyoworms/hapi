import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar } from './StatusBar'

describe('StatusBar context details popover', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('keeps stable connection labels in English and offsets the whole left status', () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        const { rerender } = render(
            <I18nProvider>
                <StatusBar active thinking={false} agentState={null} />
            </I18nProvider>
        )

        const onlineLabel = screen.getByText('online')
        expect(onlineLabel.className.split(' ')).not.toContain('top-px')
        expect(onlineLabel.previousElementSibling?.className.split(' ')).not.toContain('top-px')
        expect(onlineLabel.parentElement?.className.split(' ')).toContain('top-px')
        expect(onlineLabel.parentElement?.className.split(' ')).toContain('sm:top-0.5')

        rerender(
            <I18nProvider>
                <StatusBar active={false} thinking={false} agentState={null} />
            </I18nProvider>
        )

        const offlineLabel = screen.getByText('offline')
        expect(offlineLabel.className.split(' ')).toContain('text-[#999]')
        expect(offlineLabel.className.split(' ')).not.toContain('top-px')
        expect(offlineLabel.previousElementSibling?.className.split(' ')).toContain('bg-[#999]')
        expect(offlineLabel.previousElementSibling?.className.split(' ')).not.toContain('top-px')
        expect(offlineLabel.parentElement?.className.split(' ')).toContain('top-px')
        expect(offlineLabel.parentElement?.className.split(' ')).toContain('sm:top-0.5')

        rerender(
            <I18nProvider>
                <StatusBar active thinking agentState={null} />
            </I18nProvider>
        )

        const thinkingLabel = screen.getByText(/…$/)
        expect(thinkingLabel.className.split(' ')).not.toContain('top-px')
        expect(thinkingLabel.previousElementSibling?.className.split(' ')).not.toContain('top-px')
        expect(thinkingLabel.parentElement?.className.split(' ')).toContain('top-px')
        expect(thinkingLabel.parentElement?.className.split(' ')).toContain('sm:top-0.5')
    })

    it('uses an effort-only reasoning label on mobile and the full label on desktop', () => {
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="codex"
                    model="gpt-5.6-sol"
                    modelReasoningEffort="xhigh"
                />
            </I18nProvider>
        )

        expect(screen.getByText('xhigh').className.split(' ')).toContain('sm:hidden')
        const desktopLabel = screen.getByText('reasoning xhigh')
        expect(desktopLabel.className.split(' ')).toContain('hidden')
        expect(desktopLabel.className.split(' ')).toContain('sm:inline')
        expect(screen.getByText('gpt-5.6-sol')).toBeInTheDocument()
    })

    it('renders the current account quota and session usage on the right side', () => {
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="codex"
                    accountStatus={{
                        provider: 'codex',
                        accountLabel: 'current@example.com',
                        window: { remainingMs: 3_600_000, remainingPercent: 72 },
                        weekly: { remainingMs: 5 * 86_400_000 + 20 * 3_600_000, remainingPercent: 41 },
                        updatedAt: 1
                    }}
                    usage={{
                        totalCostUsd: 0.25,
                        totalInputTokens: 1_000,
                        totalOutputTokens: 200
                    }}
                />
            </I18nProvider>
        )

        expect(screen.getByTestId('account-usage-status')).toHaveTextContent('current@example.com')
        expect(screen.getByText('current@example.com').className.split(' ')).toContain('hidden')
        const mobileAccountUsage = screen.getByTestId('account-usage-mobile')
        expect(mobileAccountUsage).toHaveTextContent('5h 72% (1h)7d 41% (5d20h)')
        expect(mobileAccountUsage.className.split(' ')).toContain('flex-col')
        expect(mobileAccountUsage.className.split(' ')).toContain('sm:hidden')
        const desktopAccountUsage = screen.getByTestId('account-usage-desktop')
        expect(desktopAccountUsage).toHaveTextContent('5h 72% (1h) · 7d 41% (5d20h)')
        expect(desktopAccountUsage.className.split(' ')).toContain('hidden')
        expect(desktopAccountUsage.className.split(' ')).toContain('sm:inline')
        const sessionUsage = screen.getByTestId('session-usage-status')
        expect(sessionUsage).toHaveTextContent('$0.25 · 1k tok')
        expect(sessionUsage.className.split(' ')).toContain('hidden')
        expect(sessionUsage.className.split(' ')).toContain('sm:inline')
    })

    it('keeps the visible reset countdown moving while the session is idle', () => {
        const now = new Date('2026-08-06T12:00:00+08:00')
        vi.useFakeTimers()
        vi.setSystemTime(now)
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="codex"
                    accountStatus={{
                        provider: 'codex',
                        weekly: {
                            remainingPercent: 100,
                            resetAt: now.getTime() + 2 * 3_600_000
                        },
                        updatedAt: 1
                    }}
                />
            </I18nProvider>
        )

        expect(screen.getByTestId('account-usage-mobile')).toHaveTextContent('7d 100% (2h)')
        act(() => {
            vi.advanceTimersByTime(61 * 60_000)
        })
        expect(screen.getByTestId('account-usage-mobile')).toHaveTextContent('7d 100% (59m)')
    })

    it('opens from the mobile-accessible context trigger and keeps the requested detail order', async () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    contextSize={90_000}
                    contextCacheRead={86_000}
                    contextWindow={258_000}
                />
            </I18nProvider>
        )

        const connectionLabel = screen.getByText('online')
        const leftStatusGroup = connectionLabel.parentElement?.parentElement
        const statusBar = leftStatusGroup?.parentElement
        const rightStatusGroup = statusBar?.lastElementChild
        expect(statusBar?.className.split(' ')).toContain('items-baseline')
        expect(leftStatusGroup?.className.split(' ')).toContain('items-baseline')
        expect(rightStatusGroup?.className.split(' ')).toContain('items-baseline')
        expect(connectionLabel.className.split(' ')).not.toContain('top-px')
        expect(connectionLabel.previousElementSibling?.className.split(' ')).not.toContain('top-px')
        expect(connectionLabel.parentElement?.className.split(' ')).toContain('top-px')
        expect(connectionLabel.parentElement?.className.split(' ')).toContain('sm:top-0.5')
        expect(leftStatusGroup?.className.split(' ')).toContain('gap-2')
        expect(leftStatusGroup?.className.split(' ')).not.toContain('sm:gap-3')
        expect(rightStatusGroup?.className.split(' ')).toContain('gap-2')

        const trigger = screen.getByRole('button', { name: '上下文详情' })
        expect(trigger.className.split(' ')).not.toContain('relative')
        expect(trigger.className.split(' ')).not.toContain('-top-px')
        expect(trigger.className.split(' ')).toContain('text-[10px]')
        expect(trigger.className.split(' ')).toContain('leading-4')
        expect(trigger.className.split(' ')).toContain('text-[var(--app-hint)]')
        expect(trigger.textContent).toBe('ctx 258k (65% left)35% · 90k / 258k')
        expect(trigger.className.split(' ')).not.toContain('hidden')
        const progressTrack = trigger.querySelector('[aria-hidden="true"]')
        expect((progressTrack?.firstElementChild as HTMLElement | null)?.style.width).toBe('35%')

        fireEvent.click(trigger)

        const cacheLine = await screen.findByText('缓存：86k')
        const details = cacheLine.parentElement
        expect(details?.textContent).toBe('缓存：86k使用：90k（35%）剩余：168k（65%）')
        expect(screen.queryByText('上下文详情')).toBeNull()
    })

    it('localizes the popover content without localizing the external left label', async () => {
        localStorage.setItem('hapi-lang', 'en')
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    contextSize={90_000}
                    contextCacheRead={86_000}
                    contextWindow={258_000}
                />
            </I18nProvider>
        )

        const trigger = screen.getByRole('button', { name: 'Context details' })
        expect(trigger.textContent).toContain('ctx 258k (65% left)')

        fireEvent.click(trigger)

        const cacheLine = await screen.findByText('Cache: 86k')
        expect(cacheLine.parentElement?.textContent).toBe('Cache: 86kUsed: 90k (35%)Remaining: 168k (65%)')
    })
})
