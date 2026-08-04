import type { Session } from '../sync/syncEngine'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import type { NotificationSendContext } from '../notifications/notificationSendContext'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { SSEManager } from '../sse/sseManager'
import type { PushPayload, PushService } from './pushService'

export class PushNotificationChannel implements NotificationChannel {
    constructor(
        private readonly pushService: PushService,
        private readonly sseManager: SSEManager,
        _appUrl: string
    ) {}

    /**
     * Debug observability: gated on `HAPI_NOTIFY_DEBUG=1`. Lets the operator
     * see which branch each notification took so we can root-cause "still
     * getting PWA notifications" reports without committing permanent log
     * spam to the hub journal.
     */
    private logBranch(method: string, namespace: string, branch: string, extra: string = ''): void {
        if (process.env.HAPI_NOTIFY_DEBUG !== '1') return
        const note = extra ? ` ${extra}` : ''
        console.log(`[Push.${method}] ns=${namespace} ${branch}${note}`)
    }

    async sendPermissionRequest(session: Session, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        const name = getSessionName(session)
        const requests = session.agentState?.requests ?? null
        const requestEntries = requests ? Object.entries(requests) : []
        const [requestId, request] = requestEntries[0] ?? [undefined, null]
        const toolName = request?.tool ? ` (${request.tool})` : ''

        const payload: PushPayload = {
            title: 'Permission Request',
            body: `${name}${toolName}`,
            tag: `permission-${session.id}`,
            data: {
                type: 'permission-request',
                sessionId: session.id,
                url: this.buildSessionPath(session.id),
                requestId
            }
        }

        await this.deliverWebAndToast(session, payload, ctx, 'permission')
    }

    async sendReady(session: Session, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)

        const payload: PushPayload = {
            title: 'Ready for input',
            body: `${agentName} is waiting in ${name}`,
            tag: `ready-${session.id}`,
            data: {
                type: 'ready',
                sessionId: session.id,
                url: this.buildSessionPath(session.id)
            }
        }

        await this.deliverWebAndToast(session, payload, ctx, 'ready')
    }

    async sendTaskNotification(session: Session, notification: TaskNotification, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const normalizedStatus = notification.status?.trim().toLowerCase()
        const isFailure = normalizedStatus === 'failed'
            || normalizedStatus === 'error'
            || normalizedStatus === 'killed'
            || normalizedStatus === 'aborted'

        const payload: PushPayload = {
            title: isFailure ? 'Task failed' : 'Task completed',
            body: `${agentName} · ${name} · ${notification.summary}`,
            data: {
                type: 'task-notification',
                sessionId: session.id,
                url: this.buildSessionPath(session.id)
            }
        }

        await this.deliverWebAndToast(session, payload, ctx, 'task')
    }

    private async deliverWebAndToast(
        session: Session,
        payload: PushPayload,
        ctx: NotificationSendContext | undefined,
        method: 'permission' | 'ready' | 'task'
    ): Promise<void> {
        if (ctx?.nativeGate?.sent) {
            this.logBranch(method, session.namespace, 'defer-to-native', 'fcm-delivered-this-dispatch')
            return
        }

        const url = payload.data?.url ?? this.buildSessionPath(session.id)
        const delivered = await this.sseManager.sendToast(session.namespace, {
            type: 'toast',
            data: {
                title: payload.title,
                body: payload.body,
                sessionId: session.id,
                url
            }
        })
        this.logBranch(
            method,
            session.namespace,
            delivered > 0 ? 'sse-toast-delivered' : 'sse-toast-zero',
            `count=${delivered}`
        )

        // Hub visibility is namespace-wide, so a visible desktop tab cannot
        // tell us whether a different device's PWA is hidden. Always dispatch
        // Web Push; the service worker performs the correct per-device check
        // and suppresses its OS notification only when that device is visible.
        this.logBranch(method, session.namespace, 'web-push-fired')
        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    private buildSessionPath(sessionId: string): string {
        return `/sessions/${sessionId}`
    }
}
