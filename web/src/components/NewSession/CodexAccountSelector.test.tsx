import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ApiError, type ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { CodexAccountSelector } from './CodexAccountSelector'

describe('CodexAccountSelector', () => {
    it('loads runner-local accounts and selects the HAPI default', async () => {
        const onChange = vi.fn()
        const api = {
            getMachineCodexAccounts: vi.fn().mockResolvedValue({
                success: true,
                defaultAccountId: 'managed-1',
                accounts: [
                    {
                        id: 'system',
                        label: 'system@example.com',
                        kind: 'system',
                        isDefault: false,
                        authenticated: true,
                        planType: 'pro'
                    },
                    {
                        id: 'managed-1',
                        label: 'managed@example.com',
                        kind: 'managed',
                        isDefault: true,
                        authenticated: true,
                        planType: 'plus',
                        primaryLimit: { usedPercent: 25, resetsAt: 123 }
                    }
                ]
            })
        } as unknown as ApiClient

        render(
            <I18nProvider>
                <CodexAccountSelector
                    api={api}
                    machineId="machine-1"
                    value={null}
                    isDisabled={false}
                    onChange={onChange}
                />
            </I18nProvider>
        )

        await waitFor(() => expect(onChange).toHaveBeenCalledWith('managed-1'))
        expect(screen.getByRole('option', {
            name: /managed@example\.com · plus · 25% · default/i
        })).toBeInTheDocument()
    })

    it('keeps and marks the account used by the current session instead of selecting the runner default', async () => {
        const onChange = vi.fn()
        const api = {
            getMachineCodexAccounts: vi.fn().mockResolvedValue({
                success: true,
                defaultAccountId: 'system',
                accounts: [
                    {
                        id: 'system',
                        label: 'default@example.com',
                        kind: 'system',
                        isDefault: true,
                        authenticated: true
                    },
                    {
                        id: 'managed-1',
                        label: 'current@example.com',
                        kind: 'managed',
                        isDefault: false,
                        authenticated: true,
                        primaryLimit: { usedPercent: 25, resetsAt: 123 }
                    }
                ]
            })
        } as unknown as ApiClient

        render(
            <I18nProvider>
                <CodexAccountSelector
                    api={api}
                    machineId="machine-1"
                    value="managed-1"
                    currentAccountId="managed-1"
                    isDisabled={false}
                    onChange={onChange}
                />
            </I18nProvider>
        )

        const select = await screen.findByRole('combobox')
        await waitFor(() => expect(select).toHaveValue('managed-1'))
        expect(screen.getByRole('option', {
            name: /current@example\.com · 25% · current/i
        })).toBeInTheDocument()
        expect(onChange).toHaveBeenLastCalledWith('managed-1')
        expect(onChange).not.toHaveBeenCalledWith(null)
        expect(onChange).not.toHaveBeenCalledWith('system')
    })

    it('keeps a missing current account selected instead of falling back to the runner default', async () => {
        const onChange = vi.fn()
        const api = {
            getMachineCodexAccounts: vi.fn().mockResolvedValue({
                success: true,
                defaultAccountId: 'system',
                accounts: [{
                    id: 'system',
                    label: 'default@example.com',
                    kind: 'system',
                    isDefault: true,
                    authenticated: true
                }]
            })
        } as unknown as ApiClient

        render(
            <I18nProvider>
                <CodexAccountSelector
                    api={api}
                    machineId="machine-1"
                    value="missing-current"
                    currentAccountId="missing-current"
                    currentAccountLabel="old@example.com"
                    isDisabled={false}
                    onChange={onChange}
                />
            </I18nProvider>
        )

        const select = await screen.findByRole('combobox')
        await waitFor(() => expect(select).toHaveValue('missing-current'))
        expect(screen.getByRole('option', {
            name: /old@example\.com · current · signed out/i
        })).toBeInTheDocument()
        expect(onChange).toHaveBeenLastCalledWith('missing-current')
        expect(onChange).not.toHaveBeenCalledWith('system')
    })

    it('keeps the current session account when the runner account list cannot load', async () => {
        const onChange = vi.fn()
        const api = {
            getMachineCodexAccounts: vi.fn().mockRejectedValue(new ApiError(
                'Runner update required',
                409,
                'runner_update_required'
            ))
        } as unknown as ApiClient

        render(
            <I18nProvider>
                <CodexAccountSelector
                    api={api}
                    machineId="machine-1"
                    value="managed-1"
                    currentAccountId="managed-1"
                    isDisabled={false}
                    onChange={onChange}
                />
            </I18nProvider>
        )

        expect(await screen.findByText(/runner does not support hapi account management/i))
            .toBeInTheDocument()
        expect(onChange).toHaveBeenLastCalledWith('managed-1')
        expect(onChange).not.toHaveBeenCalledWith(null)
    })

    it('can make the selected account the HAPI default', async () => {
        const setDefault = vi.fn().mockResolvedValue({
            success: true,
            defaultAccountId: 'managed-1',
            accounts: [{
                id: 'managed-1',
                label: 'managed@example.com',
                kind: 'managed',
                isDefault: true,
                authenticated: true
            }]
        })
        const api = {
            getMachineCodexAccounts: vi.fn().mockResolvedValue({
                success: true,
                defaultAccountId: 'system',
                accounts: [
                    {
                        id: 'system',
                        label: 'system@example.com',
                        kind: 'system',
                        isDefault: true,
                        authenticated: true
                    },
                    {
                        id: 'managed-1',
                        label: 'managed@example.com',
                        kind: 'managed',
                        isDefault: false,
                        authenticated: true
                    }
                ]
            }),
            setMachineDefaultCodexAccount: setDefault
        } as unknown as ApiClient

        render(
            <I18nProvider>
                <CodexAccountSelector
                    api={api}
                    machineId="machine-1"
                    value="managed-1"
                    isDisabled={false}
                    onChange={vi.fn()}
                />
            </I18nProvider>
        )

        fireEvent.click(await screen.findByRole('button', { name: /make default/i }))
        await waitFor(() => {
            expect(setDefault).toHaveBeenCalledWith('machine-1', 'managed-1')
        })
    })

    it('adds and selects a runner-local custom API endpoint', async () => {
        const onChange = vi.fn()
        const addEndpoint = vi.fn().mockResolvedValue({
            success: true,
            defaultAccountId: 'system',
            accounts: [{
                id: 'api-1',
                label: 'Company proxy',
                kind: 'api',
                isDefault: false,
                authenticated: true,
                baseUrl: 'https://api.example.com/v1',
                model: 'company-model'
            }]
        })
        const api = {
            getMachineCodexAccounts: vi.fn().mockResolvedValue({
                success: true,
                defaultAccountId: 'system',
                accounts: [{
                    id: 'system',
                    label: 'system@example.com',
                    kind: 'system',
                    isDefault: true,
                    authenticated: true
                }]
            }),
            addMachineCodexApiEndpoint: addEndpoint
        } as unknown as ApiClient

        render(
            <I18nProvider>
                <CodexAccountSelector
                    api={api}
                    machineId="machine-1"
                    value="system"
                    isDisabled={false}
                    onChange={onChange}
                />
            </I18nProvider>
        )

        fireEvent.click(await screen.findByRole('button', { name: /add api/i }))
        fireEvent.change(screen.getByPlaceholderText(/name, e\.g\. company proxy/i), {
            target: { value: 'Company proxy' }
        })
        fireEvent.change(screen.getByPlaceholderText(/api base url/i), {
            target: { value: 'https://api.example.com/v1' }
        })
        fireEvent.change(screen.getByPlaceholderText(/^api key$/i), {
            target: { value: 'secret-key' }
        })
        fireEvent.change(screen.getByPlaceholderText(/^model id$/i), {
            target: { value: 'company-model' }
        })
        fireEvent.click(screen.getByRole('button', { name: /save endpoint/i }))

        await waitFor(() => {
            expect(addEndpoint).toHaveBeenCalledWith('machine-1', {
                label: 'Company proxy',
                baseUrl: 'https://api.example.com/v1',
                apiKey: 'secret-key',
                model: 'company-model'
            })
            expect(onChange).toHaveBeenCalledWith('api-1')
        })
    })

    it('requires the ChatGPT device-code setting before starting account login', async () => {
        const startLogin = vi.fn().mockResolvedValue({
            success: true,
            attemptId: 'attempt-1',
            accountId: 'managed-1',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'ABCD-1234'
        })
        const api = {
            getMachineCodexAccounts: vi.fn().mockResolvedValue({
                success: true,
                defaultAccountId: 'system',
                accounts: [{
                    id: 'system',
                    label: 'system@example.com',
                    kind: 'system',
                    isDefault: true,
                    authenticated: true
                }]
            }),
            startMachineCodexAccountLogin: startLogin,
            getMachineCodexAccountLoginStatus: vi.fn().mockResolvedValue({
                success: true,
                status: 'pending'
            })
        } as unknown as ApiClient
        const open = vi.spyOn(window, 'open').mockImplementation(() => null)

        render(
            <I18nProvider>
                <CodexAccountSelector
                    api={api}
                    machineId="machine-1"
                    value="system"
                    isDisabled={false}
                    onChange={vi.fn()}
                />
            </I18nProvider>
        )

        fireEvent.click(await screen.findByRole('button', { name: /add account/i }))
        expect(startLogin).not.toHaveBeenCalled()
        expect(screen.getByText(/enable device-code authorization first/i)).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /open chatgpt security settings/i }))
            .toHaveAttribute('href', 'https://chatgpt.com/#settings/Security')

        fireEvent.click(screen.getByRole('button', { name: /enabled, continue/i }))
        await waitFor(() => {
            expect(startLogin).toHaveBeenCalledWith('machine-1')
            expect(open).toHaveBeenCalledWith(
                'https://auth.openai.com/codex/device',
                '_blank',
                'noopener,noreferrer'
            )
        })
        expect(await screen.findByText('ABCD-1234')).toBeInTheDocument()

        open.mockRestore()
    })

    it('clears another machine’s accounts and explains when the selected runner needs an update', async () => {
        const onChange = vi.fn()
        const api = {
            getMachineCodexAccounts: vi.fn().mockImplementation(async (machineId: string) => {
                if (machineId === 'machine-1') {
                    return {
                        success: true,
                        defaultAccountId: 'managed-1',
                        accounts: [{
                            id: 'managed-1',
                            label: 'first-machine@example.com',
                            kind: 'managed',
                            isDefault: true,
                            authenticated: true
                        }]
                    }
                }
                throw new ApiError(
                    'Runner update required',
                    409,
                    'runner_update_required'
                )
            })
        } as unknown as ApiClient

        const view = render(
            <I18nProvider>
                <CodexAccountSelector
                    api={api}
                    machineId="machine-1"
                    value={null}
                    isDisabled={false}
                    onChange={onChange}
                />
            </I18nProvider>
        )

        expect(await screen.findByRole('option', {
            name: /first-machine@example\.com/i
        })).toBeInTheDocument()

        view.rerender(
            <I18nProvider>
                <CodexAccountSelector
                    api={api}
                    machineId="machine-2"
                    value="managed-1"
                    isDisabled={false}
                    onChange={onChange}
                />
            </I18nProvider>
        )

        expect(await screen.findByText(/runner does not support hapi account management/i))
            .toBeInTheDocument()
        expect(screen.queryByRole('option', {
            name: /first-machine@example\.com/i
        })).toBeNull()
        expect(screen.queryByRole('button', { name: /add account/i })).toBeNull()
        expect(onChange).toHaveBeenLastCalledWith(null)
    })
})
