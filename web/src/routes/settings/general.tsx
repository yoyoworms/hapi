import { useTranslation, type Locale } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { SettingsChoiceGroup, SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'

const locales: ReadonlyArray<{ value: Locale; label: string }> = [
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
]

export default function SettingsGeneralPage() {
    const { t, locale, setLocale } = useTranslation()
    const { signOut } = useAppContext()
    return (
        <SettingsPageContent title={t('settings.general.title')} description={t('settings.general.description')}>
            <SettingsSection>
                <SettingsChoiceGroup label={t('settings.language.label')} value={locale} options={locales} onChange={setLocale} />
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
