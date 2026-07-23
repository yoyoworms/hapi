import { useEffect, useState } from 'react'

import type { Session } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { CodexAccountSelector } from '@/components/NewSession/CodexAccountSelector'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

export function CodexAccountSwitchDialog(props: {
    isOpen: boolean
    onClose: () => void
    session: Session
    api: ApiClient
    onSwitched: (sessionId: string) => void
}) {
    const { t } = useTranslation()
    const machineId = props.session.metadata?.machineId ?? null
    const currentAccountId = props.session.metadata?.codexAccountId ?? 'system'
    const [accountId, setAccountId] = useState<string | null>(currentAccountId)
    const [isSwitching, setIsSwitching] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!props.isOpen) return
        setAccountId(currentAccountId)
        setError(null)
    }, [currentAccountId, props.isOpen])

    const handleSwitch = async () => {
        if (!accountId || accountId === currentAccountId) {
            props.onClose()
            return
        }
        setIsSwitching(true)
        setError(null)
        try {
            const sessionId = await props.api.resumeSession(props.session.id, {
                codexAccountId: accountId
            })
            props.onSwitched(sessionId)
            props.onClose()
        } catch (switchError) {
            setError(switchError instanceof Error
                ? switchError.message
                : t('codexAccountSwitch.failed'))
        } finally {
            setIsSwitching(false)
        }
    }

    return (
        <Dialog open={props.isOpen} onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t('codexAccountSwitch.title')}</DialogTitle>
                    <DialogDescription>{t('codexAccountSwitch.description')}</DialogDescription>
                </DialogHeader>

                {machineId ? (
                    <div className="mt-3 rounded-lg border border-[var(--app-border)]">
                        <CodexAccountSelector
                            api={props.api}
                            machineId={machineId}
                            value={accountId}
                            isDisabled={isSwitching}
                            onChange={setAccountId}
                        />
                    </div>
                ) : (
                    <div className="mt-3 text-sm text-red-600">
                        {t('codexAccountSwitch.noMachine')}
                    </div>
                )}

                {error ? (
                    <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                        {error}
                    </div>
                ) : null}

                <div className="mt-4 flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={props.onClose} disabled={isSwitching}>
                        {t('button.cancel')}
                    </Button>
                    <Button
                        type="button"
                        onClick={() => void handleSwitch()}
                        disabled={!machineId || isSwitching || accountId === currentAccountId}
                    >
                        {isSwitching
                            ? t('codexAccountSwitch.switching')
                            : t('codexAccountSwitch.confirm')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
