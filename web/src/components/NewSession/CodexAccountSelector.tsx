import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
    CodexAccountLoginStartResponse,
    CodexAccountSummary
} from '@hapi/protocol/apiTypes'

import { ApiError, type ApiClient } from '@/api/client'
import { InfoIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'

const CHATGPT_SECURITY_SETTINGS_URL = 'https://chatgpt.com/#settings/Security'

type LoginFlow = {
    attemptId: string
    verificationUrl: string
    userCode: string
}

function formatUsedPercent(value: number | null | undefined): string | null {
    if (typeof value !== 'number') return null
    return `${Math.round(value)}%`
}

function accountOptionLabel(account: CodexAccountSummary): string {
    if (account.kind === 'api') {
        return `${account.label} · API · ${account.model ?? ''}`.replace(/\s+$/, '')
    }
    const usage = [
        formatUsedPercent(account.primaryLimit?.usedPercent),
        formatUsedPercent(account.secondaryLimit?.usedPercent)
    ].filter((value): value is string => Boolean(value))
    const suffix = usage.length > 0 ? ` · ${usage.join(' / ')}` : ''
    const plan = account.planType ? ` · ${account.planType}` : ''
    return `${account.label}${plan}${suffix}`
}

function requiresRunnerUpdate(error: unknown): boolean {
    if (error instanceof ApiError && error.code === 'runner_update_required') return true
    const message = error instanceof Error ? error.message : String(error)
    return /RPC handler not registered:.*listCodexAccounts/i.test(message)
}

export function CodexAccountSelector(props: {
    api: ApiClient
    machineId: string | null
    value: string | null
    /** Account that owns an existing session; preferred over the runner default. */
    currentAccountId?: string | null
    /** Used only when the current account is no longer returned by the runner. */
    currentAccountLabel?: string | null
    isDisabled: boolean
    onChange: (accountId: string | null) => void
}) {
    const { t } = useTranslation()
    const [accounts, setAccounts] = useState<CodexAccountSummary[]>([])
    const [defaultAccountId, setDefaultAccountId] = useState('system')
    const [isLoading, setIsLoading] = useState(false)
    const [isStartingLogin, setIsStartingLogin] = useState(false)
    const [isSettingDefault, setIsSettingDefault] = useState(false)
    const [isAddingEndpoint, setIsAddingEndpoint] = useState(false)
    const [showEndpointForm, setShowEndpointForm] = useState(false)
    const [showDeviceAuthSetup, setShowDeviceAuthSetup] = useState(false)
    const [endpointLabel, setEndpointLabel] = useState('')
    const [endpointBaseUrl, setEndpointBaseUrl] = useState('')
    const [endpointApiKey, setEndpointApiKey] = useState('')
    const [endpointModel, setEndpointModel] = useState('')
    const [loginFlow, setLoginFlow] = useState<LoginFlow | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [runnerUpdateRequired, setRunnerUpdateRequired] = useState(false)
    const loadSequenceRef = useRef(0)
    const currentAccountId = props.currentAccountId?.trim() || null

    const loadAccounts = useCallback(async () => {
        const sequence = ++loadSequenceRef.current
        setAccounts([])
        setDefaultAccountId('system')
        setRunnerUpdateRequired(false)
        setError(null)
        // New-session selectors must clear another machine's selection. An
        // existing-session switcher instead keeps its current identity until
        // the runner list arrives, so opening the dialog cannot silently jump
        // to the runner's saved default.
        if (!currentAccountId) props.onChange(null)
        if (!props.machineId) {
            setIsLoading(false)
            return
        }
        setIsLoading(true)
        try {
            const result = await props.api.getMachineCodexAccounts(props.machineId)
            if (sequence !== loadSequenceRef.current) return
            if (!result.success) {
                throw new Error(result.error || t('newSession.codexAccount.loadFailed'))
            }
            setAccounts(result.accounts)
            setDefaultAccountId(result.defaultAccountId)
            const fallback = result.accounts.find(
                (account) => account.id === result.defaultAccountId && account.authenticated
            ) ?? result.accounts.find((account) => account.authenticated)
                ?? result.accounts[0]
            if (currentAccountId) {
                props.onChange(currentAccountId)
            } else if (fallback) {
                props.onChange(fallback.id)
            }
        } catch (loadError) {
            if (sequence !== loadSequenceRef.current) return
            setAccounts([])
            props.onChange(null)
            if (requiresRunnerUpdate(loadError)) {
                setRunnerUpdateRequired(true)
            } else {
                setError(loadError instanceof Error ? loadError.message : t('newSession.codexAccount.loadFailed'))
            }
        } finally {
            if (sequence === loadSequenceRef.current) setIsLoading(false)
        }
    }, [props.api, props.machineId, props.onChange, currentAccountId, t])

    useEffect(() => {
        void loadAccounts()
        return () => {
            loadSequenceRef.current += 1
        }
    }, [loadAccounts])

    useEffect(() => {
        setShowEndpointForm(false)
        setShowDeviceAuthSetup(false)
        setLoginFlow(null)
        setEndpointLabel('')
        setEndpointBaseUrl('')
        setEndpointApiKey('')
        setEndpointModel('')
    }, [props.machineId])

    useEffect(() => {
        if (!loginFlow || !props.machineId) return
        let disposed = false
        let polling = false
        const poll = async () => {
            if (polling || disposed) return
            polling = true
            try {
                const result = await props.api.getMachineCodexAccountLoginStatus(
                    props.machineId!,
                    loginFlow.attemptId
                )
                if (disposed || result.status === 'pending') return
                if (result.status === 'completed' && result.account) {
                    setLoginFlow(null)
                    await loadAccounts()
                    props.onChange(result.account.id)
                    return
                }
                setLoginFlow(null)
                setError(result.error || t('newSession.codexAccount.loginFailed'))
            } catch (pollError) {
                if (!disposed) {
                    setError(pollError instanceof Error ? pollError.message : t('newSession.codexAccount.loginFailed'))
                }
            } finally {
                polling = false
            }
        }
        void poll()
        const interval = window.setInterval(() => void poll(), 2_000)
        return () => {
            disposed = true
            window.clearInterval(interval)
        }
    }, [loadAccounts, loginFlow, props.api, props.machineId, props.onChange, t])

    const selectedAccount = useMemo(
        () => accounts.find((account) => account.id === props.value) ?? null,
        [accounts, props.value]
    )
    const currentAccountMissing = Boolean(
        currentAccountId && !accounts.some((account) => account.id === currentAccountId)
    )

    const handleStartLogin = async () => {
        if (!props.machineId || isStartingLogin) return
        setIsStartingLogin(true)
        setError(null)
        try {
            const result: CodexAccountLoginStartResponse = await props.api.startMachineCodexAccountLogin(props.machineId)
            if (
                !result.success
                || !result.attemptId
                || !result.verificationUrl
                || !result.userCode
            ) {
                throw new Error(result.error || t('newSession.codexAccount.loginFailed'))
            }
            setLoginFlow({
                attemptId: result.attemptId,
                verificationUrl: result.verificationUrl,
                userCode: result.userCode
            })
            setShowDeviceAuthSetup(false)
            window.open(result.verificationUrl, '_blank', 'noopener,noreferrer')
        } catch (loginError) {
            setError(loginError instanceof Error ? loginError.message : t('newSession.codexAccount.loginFailed'))
        } finally {
            setIsStartingLogin(false)
        }
    }

    const handleSetDefault = async () => {
        if (!props.machineId || !selectedAccount || isSettingDefault) return
        setIsSettingDefault(true)
        setError(null)
        try {
            const result = await props.api.setMachineDefaultCodexAccount(props.machineId, selectedAccount.id)
            if (!result.success) {
                throw new Error(result.error || t('newSession.codexAccount.defaultFailed'))
            }
            setAccounts(result.accounts)
            setDefaultAccountId(result.defaultAccountId)
        } catch (defaultError) {
            setError(defaultError instanceof Error ? defaultError.message : t('newSession.codexAccount.defaultFailed'))
        } finally {
            setIsSettingDefault(false)
        }
    }

    const handleAddEndpoint = async () => {
        if (!props.machineId || isAddingEndpoint) return
        setIsAddingEndpoint(true)
        setError(null)
        try {
            const result = await props.api.addMachineCodexApiEndpoint(props.machineId, {
                label: endpointLabel,
                baseUrl: endpointBaseUrl,
                apiKey: endpointApiKey,
                model: endpointModel
            })
            if (!result.success) {
                throw new Error(result.error || t('newSession.codexAccount.endpointFailed'))
            }
            setAccounts(result.accounts)
            setDefaultAccountId(result.defaultAccountId)
            const added = result.accounts.find((account) =>
                account.kind === 'api'
                && account.label === endpointLabel.trim()
                && account.baseUrl === endpointBaseUrl.trim().replace(/\/$/, '')
            )
            if (added) props.onChange(added.id)
            setEndpointLabel('')
            setEndpointBaseUrl('')
            setEndpointApiKey('')
            setEndpointModel('')
            setShowEndpointForm(false)
        } catch (endpointError) {
            setError(endpointError instanceof Error
                ? endpointError.message
                : t('newSession.codexAccount.endpointFailed'))
        } finally {
            setIsAddingEndpoint(false)
        }
    }

    return (
        <div className="flex flex-col gap-2 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-xs font-medium text-[var(--app-hint)]">
                        {t('newSession.codexAccount.title')}
                    </div>
                    <div className="text-[11px] text-[var(--app-hint)]">
                        {t('newSession.codexAccount.description')}
                    </div>
                </div>
                {!runnerUpdateRequired ? <div className="flex shrink-0 items-center gap-1.5">
                    <button
                        type="button"
                        className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1.5 text-xs text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-50"
                        disabled={props.isDisabled || !props.machineId || isAddingEndpoint}
                        onClick={() => setShowEndpointForm((visible) => !visible)}
                    >
                        {t('newSession.codexAccount.addEndpoint')}
                    </button>
                    <button
                        type="button"
                        className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1.5 text-xs text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-50"
                        disabled={props.isDisabled || !props.machineId || isStartingLogin || Boolean(loginFlow)}
                        onClick={() => {
                            setError(null)
                            setShowDeviceAuthSetup(true)
                        }}
                    >
                        {isStartingLogin
                            ? t('newSession.codexAccount.startingLogin')
                            : t('newSession.codexAccount.add')}
                    </button>
                </div> : null}
            </div>

            {showDeviceAuthSetup && !loginFlow ? (
                <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm">
                    <div className="flex gap-2.5">
                        <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--app-link)]" />
                        <div className="min-w-0 flex-1">
                            <div className="font-medium text-[var(--app-fg)]">
                                {t('newSession.codexAccount.deviceSetupTitle')}
                            </div>
                            <div className="mt-1 text-xs leading-5 text-[var(--app-hint)]">
                                {t('newSession.codexAccount.deviceSetupDescription')}
                            </div>
                            <div className="mt-3 flex flex-wrap justify-end gap-2">
                                <a
                                    className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-1.5 text-xs text-[var(--app-link)] hover:bg-[var(--app-secondary-bg)]"
                                    href={CHATGPT_SECURITY_SETTINGS_URL}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    {t('newSession.codexAccount.deviceOpenSettings')}
                                </a>
                                <button
                                    type="button"
                                    className="rounded-md bg-[var(--app-button)] px-3 py-1.5 text-xs text-[var(--app-button-text)] disabled:opacity-50"
                                    disabled={isStartingLogin}
                                    onClick={() => void handleStartLogin()}
                                >
                                    {isStartingLogin
                                        ? t('newSession.codexAccount.startingLogin')
                                        : t('newSession.codexAccount.deviceContinue')}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {showEndpointForm ? (
                <div className="grid gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3">
                    <input
                        className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-2 text-sm"
                        value={endpointLabel}
                        onChange={(event) => setEndpointLabel(event.target.value)}
                        placeholder={t('newSession.codexAccount.endpointLabel')}
                        disabled={isAddingEndpoint}
                    />
                    <input
                        className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-2 text-sm"
                        value={endpointBaseUrl}
                        onChange={(event) => setEndpointBaseUrl(event.target.value)}
                        placeholder={t('newSession.codexAccount.endpointBaseUrl')}
                        inputMode="url"
                        disabled={isAddingEndpoint}
                    />
                    <input
                        className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-2 text-sm"
                        value={endpointApiKey}
                        onChange={(event) => setEndpointApiKey(event.target.value)}
                        placeholder={t('newSession.codexAccount.endpointApiKey')}
                        type="password"
                        autoComplete="off"
                        disabled={isAddingEndpoint}
                    />
                    <input
                        className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-2 text-sm"
                        value={endpointModel}
                        onChange={(event) => setEndpointModel(event.target.value)}
                        placeholder={t('newSession.codexAccount.endpointModel')}
                        disabled={isAddingEndpoint}
                    />
                    <div className="text-[11px] text-[var(--app-hint)]">
                        {t('newSession.codexAccount.endpointSecurity')}
                    </div>
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            className="px-2 py-1.5 text-xs text-[var(--app-hint)]"
                            onClick={() => setShowEndpointForm(false)}
                            disabled={isAddingEndpoint}
                        >
                            {t('button.cancel')}
                        </button>
                        <button
                            type="button"
                            className="rounded-md bg-[var(--app-button)] px-3 py-1.5 text-xs text-[var(--app-button-text)] disabled:opacity-50"
                            onClick={() => void handleAddEndpoint()}
                            disabled={isAddingEndpoint || !endpointLabel.trim() || !endpointBaseUrl.trim() || !endpointApiKey.trim() || !endpointModel.trim()}
                        >
                            {isAddingEndpoint
                                ? t('newSession.codexAccount.endpointAdding')
                                : t('newSession.codexAccount.endpointAdd')}
                        </button>
                    </div>
                </div>
            ) : null}

            {accounts.length > 0 ? <div className="flex items-center gap-2">
                <select
                    className="min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-2 text-sm text-[var(--app-fg)] disabled:opacity-50"
                    value={props.value ?? ''}
                    disabled={props.isDisabled || isLoading || accounts.length === 0}
                    onChange={(event) => props.onChange(event.target.value)}
                >
                    {currentAccountMissing && currentAccountId ? (
                        <option value={currentAccountId} disabled>
                            {props.currentAccountLabel?.trim() || currentAccountId}
                            {` · ${t('newSession.codexAccount.current')} · ${t('newSession.codexAccount.signedOut')}`}
                        </option>
                    ) : null}
                    {accounts.map((account) => (
                        <option key={account.id} value={account.id} disabled={!account.authenticated}>
                            {accountOptionLabel(account)}
                            {account.id === defaultAccountId ? ` · ${t('newSession.codexAccount.default')}` : ''}
                            {account.id === currentAccountId ? ` · ${t('newSession.codexAccount.current')}` : ''}
                            {!account.authenticated ? ` · ${t('newSession.codexAccount.signedOut')}` : ''}
                        </option>
                    ))}
                </select>
                {selectedAccount && selectedAccount.id !== defaultAccountId ? (
                    <button
                        type="button"
                        className="shrink-0 text-xs text-[var(--app-link)] disabled:opacity-50"
                        disabled={props.isDisabled || isSettingDefault}
                        onClick={() => void handleSetDefault()}
                    >
                        {t('newSession.codexAccount.makeDefault')}
                    </button>
                ) : null}
            </div> : null}

            {runnerUpdateRequired ? (
                <div className="flex gap-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3">
                    <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--app-link)]" />
                    <div className="text-xs leading-5 text-[var(--app-hint)]">
                        {t('newSession.codexAccount.runnerUpdateRequired')}
                    </div>
                </div>
            ) : null}

            {loginFlow ? (
                <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm">
                    <div className="font-medium text-[var(--app-fg)]">
                        {t('newSession.codexAccount.deviceTitle')}
                    </div>
                    <div className="mt-1 text-xs text-[var(--app-hint)]">
                        {t('newSession.codexAccount.deviceDescription')}
                    </div>
                    <a
                        className="mt-2 inline-block text-xs text-[var(--app-link)] underline"
                        href={CHATGPT_SECURITY_SETTINGS_URL}
                        target="_blank"
                        rel="noreferrer"
                    >
                        {t('newSession.codexAccount.deviceOpenSettings')}
                    </a>
                    <div className="mt-3 flex items-center justify-between gap-3">
                        <a
                            className="min-w-0 truncate text-xs text-[var(--app-link)] underline"
                            href={loginFlow.verificationUrl}
                            target="_blank"
                            rel="noreferrer"
                        >
                            {loginFlow.verificationUrl}
                        </a>
                        <button
                            type="button"
                            className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-1.5 font-mono text-base font-semibold tracking-wider text-[var(--app-fg)]"
                            onClick={() => void navigator.clipboard.writeText(loginFlow.userCode)}
                            title={t('button.copy')}
                        >
                            {loginFlow.userCode}
                        </button>
                    </div>
                    <div className="mt-2 text-xs text-[var(--app-hint)]">
                        {t('newSession.codexAccount.waiting')}
                    </div>
                </div>
            ) : null}

            {isLoading ? (
                <div className="text-xs text-[var(--app-hint)]">{t('newSession.codexAccount.loading')}</div>
            ) : null}
            {error ? <div className="text-xs text-red-600">{error}</div> : null}
        </div>
    )
}
