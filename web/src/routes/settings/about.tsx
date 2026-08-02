import { useEffect, useState } from 'react'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import type { UsageResponse } from '@/types/api'
import { SettingsPageContent, SettingsRow, SettingsSection } from '@/components/settings/SettingsPrimitives'

function formatResetTime(isoString: string): string {
    const diffMs = new Date(isoString).getTime() - Date.now()
    if (diffMs <= 0) return 'now'
    const hours = Math.floor(diffMs / 3_600_000)
    const minutes = Math.floor((diffMs % 3_600_000) / 60_000)
    if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

function UsageBar(props: { label: string; utilization: number; resetsAt: string; resetsInLabel: string }) {
    const pct = Math.min(100, Math.max(0, props.utilization))
    const color = pct >= 80
        ? 'var(--app-error, #ef4444)'
        : pct >= 50
            ? 'var(--app-warning, #f59e0b)'
            : 'var(--app-success, #22c55e)'
    return (
        <div className="px-3 py-3">
            <div className="mb-1 flex items-center justify-between gap-3">
                <span className="text-sm text-[var(--app-fg)]">{props.label}</span>
                <span className="text-xs text-[var(--app-hint)]">{pct}% · {props.resetsInLabel} {formatResetTime(props.resetsAt)}</span>
            </div>
            <div className="h-2 overflow-clip rounded-full bg-[var(--app-secondary-bg)]">
                <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
            </div>
        </div>
    )
}

export default function SettingsAboutPage() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const [usage, setUsage] = useState<UsageResponse | null>(null)
    const [usageLoading, setUsageLoading] = useState(true)

    useEffect(() => {
        let cancelled = false
        if (typeof api.getUsage !== 'function') {
            setUsageLoading(false)
            return
        }
        api.getUsage()
            .then((value) => { if (!cancelled) setUsage(value) })
            .catch(() => { if (!cancelled) setUsage(null) })
            .finally(() => { if (!cancelled) setUsageLoading(false) })
        return () => { cancelled = true }
    }, [api])

    const usageBuckets = [
        ['five_hour', t('settings.usage.fiveHour')],
        ['seven_day', t('settings.usage.sevenDay')],
        ['seven_day_opus', t('settings.usage.sevenDayOpus')],
        ['seven_day_sonnet', t('settings.usage.sevenDaySonnet')],
    ] as const

    const clearCache = async () => {
        if (!window.confirm(t('settings.cache.clearConfirm'))) return
        try {
            const registrations = await navigator.serviceWorker?.getRegistrations()
            for (const registration of registrations ?? []) await registration.unregister()
            const keys = await caches?.keys()
            for (const key of keys ?? []) await caches.delete(key)
        } finally {
            window.location.reload()
        }
    }

    return (
        <SettingsPageContent description={t('settings.about.description')}>
            <SettingsSection title={t('settings.usage.title')}>
                {usageLoading ? (
                    <div className="px-3 py-3 text-sm text-[var(--app-hint)]">Loading...</div>
                ) : usage ? (
                    <>
                        {usage.subscriptionType ? (
                            <SettingsRow label={t('settings.usage.plan')} trailing={<span className="capitalize text-[var(--app-hint)]">{usage.subscriptionType}</span>} />
                        ) : null}
                        {usageBuckets.map(([key, label]) => {
                            const bucket = usage[key]
                            return bucket ? (
                                <UsageBar key={key} label={label} utilization={bucket.utilization} resetsAt={bucket.resets_at} resetsInLabel={t('settings.usage.resetsIn')} />
                            ) : null
                        })}
                    </>
                ) : (
                    <div className="px-3 py-3 text-sm text-[var(--app-hint)]">{t('settings.usage.unavailable')}</div>
                )}
            </SettingsSection>
            <SettingsSection>
                <SettingsRow label={t('settings.about.website')} trailing={
                    <a href="https://hapi.run" target="_blank" rel="noopener noreferrer" className="text-[var(--app-link)] hover:underline">hapi.run</a>
                } />
                <SettingsRow label={t('settings.about.appVersion')} trailing={<span className="text-[var(--app-hint)]">{__APP_VERSION__}</span>} />
                <SettingsRow label={t('settings.about.protocolVersion')} trailing={<span className="text-[var(--app-hint)]">{PROTOCOL_VERSION}</span>} />
            </SettingsSection>
            <SettingsSection title={t('settings.cache.title')}>
                <button type="button" onClick={() => void clearCache()} className="flex min-h-12 w-full items-center px-3 py-3 text-left text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]">
                    {t('settings.cache.clear')}
                </button>
            </SettingsSection>
        </SettingsPageContent>
    )
}
