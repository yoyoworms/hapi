import { useEffect, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'

type ShareSessionDialogProps = {
    isOpen: boolean
    onClose: () => void
    sessionId: string
    api: ApiClient | null
}

function buildShareUrl(token: string): string {
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    return `${origin}/s/${encodeURIComponent(token)}`
}

/**
 * Owner-facing dialog to create / show / revoke a single-session share link.
 * Anyone with the link can open and drive that one session without logging in.
 */
export function ShareSessionDialog(props: ShareSessionDialogProps) {
    const { t } = useTranslation()
    const toast = useToast()
    const [token, setToken] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!props.isOpen || !props.api) return
        setError(null)
        setLoading(true)
        let cancelled = false
        void (async () => {
            try {
                const result = await props.api!.getSessionShare(props.sessionId)
                if (!cancelled) setToken(result.token)
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load share status')
            } finally {
                if (!cancelled) setLoading(false)
            }
        })()
        return () => { cancelled = true }
    }, [props.isOpen, props.api, props.sessionId])

    const handleCreate = async () => {
        if (!props.api) return
        setBusy(true)
        setError(null)
        try {
            const result = await props.api.createSessionShare(props.sessionId)
            setToken(result.token)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to create share link')
        } finally {
            setBusy(false)
        }
    }

    const handleRevoke = async () => {
        if (!props.api) return
        setBusy(true)
        setError(null)
        try {
            await props.api.revokeSessionShare(props.sessionId)
            setToken(null)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to revoke share link')
        } finally {
            setBusy(false)
        }
    }

    const handleCopy = async () => {
        if (!token) return
        const url = buildShareUrl(token)
        try {
            await navigator.clipboard.writeText(url)
            toast.addToast({ title: t('session.share.copied'), body: '', sessionId: props.sessionId, url: '' })
        } catch {
            setError('Copy failed — select and copy the link manually.')
        }
    }

    const url = token ? buildShareUrl(token) : null

    return (
        <Dialog open={props.isOpen} onOpenChange={(open) => { if (!open) props.onClose() }}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t('session.share.title')}</DialogTitle>
                    <DialogDescription>{t('session.share.description')}</DialogDescription>
                </DialogHeader>

                {error ? <div className="text-sm text-red-600">{error}</div> : null}

                {loading ? (
                    <div className="py-4 text-sm text-[var(--app-hint)]">{t('misc.loading')}</div>
                ) : url ? (
                    <div className="flex flex-col gap-3">
                        <div className="break-all rounded-md bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-fg)]">
                            {url}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button onClick={handleCopy} disabled={busy}>{t('session.share.copy')}</Button>
                            <Button variant="secondary" onClick={handleRevoke} disabled={busy}>
                                {t('session.share.revoke')}
                            </Button>
                        </div>
                        <p className="text-xs text-[var(--app-hint)]">{t('session.share.warning')}</p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-3">
                        <p className="text-sm text-[var(--app-hint)]">{t('session.share.notShared')}</p>
                        <Button onClick={handleCreate} disabled={busy}>{t('session.share.create')}</Button>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    )
}
