import type { Session } from '@hapi/protocol/types'

export const AUTO_ARCHIVE_SWEEP_INTERVAL_MS = 15 * 60 * 1_000
export const AUTO_ARCHIVE_INITIAL_DELAY_MS = 60 * 1_000

export type AutoArchiveBlockReason =
    | 'not-runner-session'
    | 'not-running'
    | 'pinned'
    | 'local-control'
    | 'thinking'
    | 'background-tasks'
    | 'pending-request'
    | 'active-team-member'
    | 'queued-message'
    | 'not-idle-long-enough'

export function getAutoArchiveReason(idleHours: number): string {
    return `Auto-archived after ${idleHours} hours of inactivity`
}

function getLastMeaningfulActivityAt(session: Session): number {
    return Math.max(
        session.createdAt,
        session.updatedAt,
        session.metadata?.lifecycleStateSince ?? 0
    )
}

export function getAutoArchiveBlockReason(
    session: Session,
    now: number,
    idleMs: number,
    hasQueuedMessages: boolean
): AutoArchiveBlockReason | null {
    const metadata = session.metadata
    if (!metadata || (metadata.startedBy !== 'runner' && metadata.startedFromRunner !== true)) {
        return 'not-runner-session'
    }
    if (metadata.lifecycleState !== 'running') {
        return 'not-running'
    }
    if (metadata.pinnedAt != null) {
        return 'pinned'
    }
    if (session.agentState?.controlledByUser === true) {
        return 'local-control'
    }
    if (session.thinking) {
        return 'thinking'
    }
    if ((session.backgroundTaskCount ?? 0) > 0) {
        return 'background-tasks'
    }
    if (Object.keys(session.agentState?.requests ?? {}).length > 0) {
        return 'pending-request'
    }
    if (session.teamState?.members?.some((member) => member.status === 'active')) {
        return 'active-team-member'
    }
    if (hasQueuedMessages) {
        return 'queued-message'
    }
    if (now - getLastMeaningfulActivityAt(session) < idleMs) {
        return 'not-idle-long-enough'
    }
    return null
}

type AutoArchiveLogger = Pick<Console, 'info' | 'warn'>

export interface AutoArchiveServiceOptions {
    idleHours: number
    getSessions: () => Session[]
    getSession: (sessionId: string) => Session | undefined
    hasQueuedMessages: (sessionId: string) => boolean
    archiveSession: (sessionId: string, reason: string) => Promise<void>
    initialDelayMs?: number
    sweepIntervalMs?: number
    logger?: AutoArchiveLogger
}

export class AutoArchiveService {
    private readonly idleMs: number
    private readonly reason: string
    private readonly logger: AutoArchiveLogger
    private initialTimer: ReturnType<typeof setTimeout> | null = null
    private sweepTimer: ReturnType<typeof setInterval> | null = null
    private sweepPromise: Promise<string[]> | null = null

    constructor(private readonly options: AutoArchiveServiceOptions) {
        this.idleMs = options.idleHours * 60 * 60 * 1_000
        this.reason = getAutoArchiveReason(options.idleHours)
        this.logger = options.logger ?? console
    }

    start(): void {
        if (this.options.idleHours <= 0 || this.initialTimer || this.sweepTimer) {
            return
        }

        this.initialTimer = setTimeout(() => {
            this.initialTimer = null
            void this.sweep()
            this.sweepTimer = setInterval(
                () => void this.sweep(),
                this.options.sweepIntervalMs ?? AUTO_ARCHIVE_SWEEP_INTERVAL_MS
            )
        }, this.options.initialDelayMs ?? AUTO_ARCHIVE_INITIAL_DELAY_MS)
    }

    stop(): void {
        if (this.initialTimer) {
            clearTimeout(this.initialTimer)
            this.initialTimer = null
        }
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer)
            this.sweepTimer = null
        }
    }

    async sweep(now: number = Date.now()): Promise<string[]> {
        if (this.options.idleHours <= 0) {
            return []
        }
        if (this.sweepPromise) {
            return this.sweepPromise
        }

        this.sweepPromise = this.runSweep(now)
        try {
            return await this.sweepPromise
        } finally {
            this.sweepPromise = null
        }
    }

    private async runSweep(now: number): Promise<string[]> {
        const archived: string[] = []

        for (const snapshot of this.options.getSessions()) {
            const preliminaryReason = getAutoArchiveBlockReason(snapshot, now, this.idleMs, false)
            if (preliminaryReason) {
                continue
            }

            const latest = this.options.getSession(snapshot.id)
            if (!latest) {
                continue
            }
            const blockReason = getAutoArchiveBlockReason(
                latest,
                now,
                this.idleMs,
                this.options.hasQueuedMessages(latest.id)
            )
            if (blockReason) {
                continue
            }

            try {
                await this.options.archiveSession(latest.id, this.reason)
                archived.push(latest.id)
                this.logger.info(`[AutoArchive] Archived idle session ${latest.id}`)
            } catch (error) {
                this.logger.warn(`[AutoArchive] Failed to archive session ${latest.id}`, error)
            }
        }

        return archived
    }
}
