import { useTranslation, type Locale } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { CompanionPairing } from '@/components/settings/CompanionPairing'
import { SettingsChoiceGroup, SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'

const locales: ReadonlyArray<{ value: Locale; label: string }> = [
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
]

export default function SettingsGeneralPage() {
    const { t, locale, setLocale } = useTranslation()
    const { baseUrl, signOut } = useAppContext()
    return (
        <SettingsPageContent description={t('settings.general.description')}>
            <SettingsSection title={t('settings.language.label')}>
                <SettingsChoiceGroup hideLabel label={t('settings.language.label')} value={locale} options={locales} onChange={setLocale} />
            </SettingsSection>
            <SettingsSection title={t('settings.companion.title')}>
                <div className="px-3 py-3">
                    <CompanionPairing baseUrl={baseUrl} />
                </div>
            </SettingsSection>
            {signOut ? (
                <SettingsSection title={t('settings.account.title')}>
                    <button
                        type="button"
                        onClick={() => {
                            if (window.confirm(t('settings.account.signOutConfirm'))) signOut()
                        }}
                        className="flex min-h-12 w-full items-center px-3 py-3 text-left text-red-500 transition-colors hover:bg-[var(--app-subtle-bg)]"
                    >
                        {t('settings.account.signOut')}
                    </button>
                </SettingsSection>
            ) : null}
        </SettingsPageContent>
    )
}
