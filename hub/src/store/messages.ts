import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type { StoredMessage } from './types'
import { decodeMessageContent, encodeMessageContent, truncateOversizedMessageContent } from './contentCodec'

type DbMessageRow = {
    id: string
    session_id: string
    // TEXT (plaintext JSON, legacy rows) or BLOB (zstd-compressed JSON) — see contentCodec.ts
    content: string | Uint8Array
    created_at: number
    seq: number
    local_id: string | null
    invoked_at: number | null
    scheduled_at: number | null
    content_uuid?: string | null
}

export type MessagePosition = {
    at: number
    seq: number
}

export class ImportedMessageConflictError extends Error {
    constructor(readonly localId: string) {
        super(`Imported message content changed for localId: ${localId}`)
        this.name = 'ImportedMessageConflictError'
    }
}

function extractContentUuid(content: unknown): string | null {
    if (typeof content !== 'object' || content === null) return null
    const record = content as Record<string, unknown>
    if (record.role !== 'agent' || typeof record.content !== 'object' || record.content === null) {
        return null
    }
    const inner = record.content as Record<string, unknown>
    if (inner.type !== 'output' || typeof inner.data !== 'object' || inner.data === null) {
        return null
    }
    const uuid = (inner.data as Record<string, unknown>).uuid
    return typeof uuid === 'string' ? uuid : null
}

function isAgentMessage(content: unknown): boolean {
    return typeof content === 'object' && content !== null
        && (content as Record<string, unknown>).role === 'agent'
}

function isUserMessage(content: unknown): boolean {
    return typeof content === 'object' && content !== null
        && (content as Record<string, unknown>).role === 'user'
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function extractTextMessage(content: unknown): string | null {
    if (typeof content !== 'object' || content === null) return null
    const outer = content as Record<string, unknown>
    if (typeof outer.content !== 'object' || outer.content === null) return null
    const inner = outer.content as Record<string, unknown>
    return inner.type === 'text' && typeof inner.text === 'string' ? inner.text : null
}

function extractCodexPayload(content: unknown): Record<string, unknown> | null {
    if (typeof content !== 'object' || content === null) return null
    const outer = content as Record<string, unknown>
    if (outer.role !== 'agent' || typeof outer.content !== 'object' || outer.content === null) return null
    const inner = outer.content as Record<string, unknown>
    if (inner.type !== 'codex' || typeof inner.data !== 'object' || inner.data === null) return null
    return inner.data as Record<string, unknown>
}

function getMessageMergeDedupeKey(content: unknown): string | null {
    const text = extractTextMessage(content)
    if (text !== null) {
        if (isUserMessage(content)) return `user:text:${text}`
        if (isAgentMessage(content)) return `agent:text:${text}`
    }

    const contentUuid = extractContentUuid(content)
    if (contentUuid) return `uuid:${contentUuid}`

    const codexPayload = extractCodexPayload(content)
    if (!codexPayload) return null
    const type = typeof codexPayload.type === 'string' ? codexPayload.type : null
    if (type === 'message' && typeof codexPayload.message === 'string') {
        return `codex:message:${codexPayload.message}`
    }
    if (type === 'reasoning' && typeof codexPayload.message === 'string') {
        return `codex:reasoning:${codexPayload.message}`
    }
    if (type === 'reasoning-delta' && typeof codexPayload.delta === 'string') {
        return `codex:reasoning-delta:${codexPayload.delta}`
    }
    if (type === 'token_count') return `codex:token_count:${stableStringify(codexPayload.info ?? null)}`
    if (type === 'tool-call') {
        return `codex:tool-call:${String(codexPayload.callId ?? '')}:${String(codexPayload.name ?? '')}:${stableStringify(codexPayload.input ?? null)}`
    }
    if (type === 'tool-call-result') {
        return `codex:tool-call-result:${String(codexPayload.callId ?? '')}:${stableStringify(codexPayload.output ?? null)}`
    }
    return null
}

export function addImportedMessage(
    db: Database,
    sessionId: string,
    content: unknown,
    localId: string,
    createdAt: number
): { message: StoredMessage; inserted: boolean } {
    const existing = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
    ).get(sessionId, localId) as DbMessageRow | undefined
    if (existing) {
        const message = toStoredMessage(existing)
        const canonicalContent = truncateOversizedMessageContent(content)
        if (!isDeepStrictEqual(message.content, canonicalContent)) throw new ImportedMessageConflictError(localId)
        return { message, inserted: false }
    }

    const now = Date.now()
    const stampedAt = Number.isFinite(createdAt) ? Math.min(createdAt, now) : now
    return db.transaction(() => {
        const previousHead = getNewestMessagePosition(db, sessionId)
        const msgSeqRow = db.prepare(
            'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
        ).get(sessionId) as { nextSeq: number }
        const id = randomUUID()
        db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at, content_uuid
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, NULL, @content_uuid
            )
        `).run({
            id,
            session_id: sessionId,
            content: encodeMessageContent(truncateOversizedMessageContent(content)),
            created_at: stampedAt,
            seq: msgSeqRow.nextSeq,
            local_id: localId,
            invoked_at: stampedAt,
            content_uuid: extractContentUuid(content)
        })
        if (previousHead && stampedAt < previousHead.at) bumpMessageEpoch(db, sessionId)
        const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
        if (!row) throw new Error('Failed to create imported message')
        return { message: toStoredMessage(row), inserted: true }
    })()
}

function toStoredMessage(row: DbMessageRow): StoredMessage {
    return {
        id: row.id,
        sessionId: row.session_id,
        content: decodeMessageContent(row.content),
        createdAt: row.created_at,
        seq: row.seq,
        localId: row.local_id,
        invokedAt: row.invoked_at ?? null,
        scheduledAt: row.scheduled_at ?? null
    }
}

export type CopyStoredMessageInput = Pick<
    StoredMessage,
    'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt'
>

export function addMessage(
    db: Database,
    sessionId: string,
    content: unknown,
    localId?: string,
    scheduledAt?: number | null,
    createdAt?: number
): StoredMessage {
    const now = Date.now()
    // Client-provided origin timestamp (e.g. a Claude transcript entry's own
    // `timestamp`), falling back to server-receive time when absent. Only
    // agent-message callers (sessionHandlers' `on('message')`) pass this today.
    const stampedAt = Number.isFinite(createdAt)
        ? Math.min(createdAt!, now)
        : now

    // Without a localId, invoked_at is stamped immediately below — there is no
    // ack path to flip it later.  A scheduled message in that state would be
    // skipped by the future-emit branch and never picked up by
    // getMatureScheduledMessages (which filters on invoked_at IS NULL), so
    // the schedule would be silently lost.
    if (scheduledAt != null && !localId) {
        throw new Error('addMessage: scheduledAt requires a localId for the ack flow')
    }

    if (localId) {
        const existing = db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
        ).get(sessionId, localId) as DbMessageRow | undefined
        if (existing) {
            return toStoredMessage(existing)
        }
    }

    // Agent output UUIDs survive Socket.IO reconnect-buffer replay. Persist the
    // dedup key because a reconnect creates a fresh handler-local Set and agent
    // messages have no localId unique constraint.
    const contentUuid = extractContentUuid(content)
    if (!localId && contentUuid) {
        const existing = db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND content_uuid = ? LIMIT 1'
        ).get(sessionId, contentUuid) as DbMessageRow | undefined
        if (existing) {
            return toStoredMessage(existing)
        }
    }

    const msgSeqRow = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { nextSeq: number }
    const msgSeq = msgSeqRow.nextSeq

    const id = randomUUID()
    const encoded = encodeMessageContent(truncateOversizedMessageContent(content))

    // Messages without a localId have no ack path (markMessagesInvoked matches by localId).
    // Treat them as already-invoked at insert time so they land in the thread normally instead
    // of being stuck in the queued floating bar forever. Stamped with `stampedAt` (the
    // client-provided createdAt when present) rather than server-now so getMessagesByPosition's
    // COALESCE(invoked_at, created_at) sort reflects the transcript's own jsonl order instead of
    // hub arrival order.
    const invokedAt = localId ? null : stampedAt

    return db.transaction(() => {
        const previousHead = getNewestMessagePosition(db, sessionId)
        db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at, content_uuid
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at, @content_uuid
            )
        `).run({
            id,
            session_id: sessionId,
            content: encoded,
            created_at: stampedAt,
            seq: msgSeq,
            local_id: localId ?? null,
            invoked_at: invokedAt,
            scheduled_at: scheduledAt ?? null,
            content_uuid: contentUuid
        })

        const positionAt = invokedAt ?? stampedAt
        if (previousHead && positionAt < previousHead.at) bumpMessageEpoch(db, sessionId)
        const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
        if (!row) throw new Error('Failed to create message')
        return toStoredMessage(row)
    })()
}

export function copyMessageToSession(
    db: Database,
    sessionId: string,
    message: CopyStoredMessageInput
): StoredMessage {
    const createdAt = Number.isFinite(message.createdAt) ? message.createdAt : Date.now()
    const nextSeq = getMaxSeq(db, sessionId) + 1

    let localId = message.localId
    if (localId) {
        const collision = db.prepare(
            'SELECT 1 FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
        ).get(sessionId, localId) as { 1: number } | undefined
        if (collision) {
            // 中文注释：重复会话合并时如果 localId 撞车，给复制进目标会话的消息生成一个新 localId，避免误判成同一条已存在消息。
            localId = `${localId}:merged:${randomUUID().slice(0, 8)}`
        }
    }

    if (message.scheduledAt != null && !localId && message.invokedAt === null) {
        // 中文注释：未来计划消息仍需要 ack 路径；异常情况下若源数据缺少 localId，这里补一个稳定可写的新值以保留调度语义。
        localId = `merged-scheduled:${randomUUID()}`
    }

    const invokedAt = localId ? message.invokedAt : (message.invokedAt ?? createdAt)
    const id = randomUUID()
    const contentUuid = extractContentUuid(message.content)
    db.prepare(`
        INSERT INTO messages (
            id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at, content_uuid
        ) VALUES (
            @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at, @content_uuid
        )
    `).run({
        id,
        session_id: sessionId,
        // Lossless re-encode only — copies move existing history between
        // sessions, so no truncation here even for pre-codec oversized rows.
        content: encodeMessageContent(message.content),
        created_at: createdAt,
        seq: nextSeq,
        local_id: localId ?? null,
        invoked_at: invokedAt ?? null,
        scheduled_at: message.scheduledAt ?? null,
        content_uuid: contentUuid
    })

    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
    if (!row) {
        throw new Error('Failed to copy message into target session')
    }

    // Copies preserve the source display timestamp, so a new high-seq row can
    // still land behind a Web client's cached composite tail cursor. Mark the
    // target history as structurally changed so incremental readers reset.
    bumpMessageEpoch(db, sessionId)
    return toStoredMessage(row)
}

/**
 * Batch-hydrate a fork child: one transaction, contiguous seq allocation,
 * single epoch bump. Avoids O(n) max-seq lookups and epoch writes.
 */
export function copyMessagesToSession(
    db: Database,
    sessionId: string,
    messages: CopyStoredMessageInput[]
): number {
    if (messages.length === 0) return 0

    return db.transaction(() => {
        let nextSeq = getMaxSeq(db, sessionId) + 1
        const insert = db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at, content_uuid
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at, @content_uuid
            )
        `)
        const collisionCheck = db.prepare(
            'SELECT 1 FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
        )

        for (const message of messages) {
            const createdAt = Number.isFinite(message.createdAt) ? message.createdAt : Date.now()
            let localId = message.localId
            if (localId) {
                const collision = collisionCheck.get(sessionId, localId) as { 1: number } | undefined
                if (collision) {
                    localId = `${localId}:merged:${randomUUID().slice(0, 8)}`
                }
            }
            if (message.scheduledAt != null && !localId && message.invokedAt === null) {
                localId = `merged-scheduled:${randomUUID()}`
            }
            const invokedAt = localId ? message.invokedAt : (message.invokedAt ?? createdAt)
            insert.run({
                id: randomUUID(),
                session_id: sessionId,
                content: encodeMessageContent(message.content),
                created_at: createdAt,
                seq: nextSeq,
                local_id: localId ?? null,
                invoked_at: invokedAt ?? null,
                scheduled_at: message.scheduledAt ?? null,
                content_uuid: extractContentUuid(message.content)
            })
            nextSeq += 1
        }

        bumpMessageEpoch(db, sessionId)
        return messages.length
    })()
}

export function getMessages(
    db: Database,
    sessionId: string,
    limit: number = 200
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200

    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
    ).all(sessionId, safeLimit) as DbMessageRow[]

    return rows.reverse().map(toStoredMessage)
}

export function getAllMessages(
    db: Database,
    sessionId: string
): StoredMessage[] {
    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC'
    ).all(sessionId) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

export function getMessagesAfterSeq(
    db: Database,
    sessionId: string,
    afterSeq: number
): StoredMessage[] {
    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC'
    ).all(sessionId, afterSeq) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

export function getFirstMessages(
    db: Database,
    sessionId: string,
    limit: number = 50
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 50

    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?'
    ).all(sessionId, safeLimit) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

/** CLI reconnect backfill: returns messages above the seq cursor that are
 *  deliverable now, i.e. excludes future-scheduled rows (scheduled_at > now).
 *  Without this filter, a CLI reconnect between schedule time and release time
 *  would replay future-scheduled rows via the normal message stream and the
 *  runner would consume them immediately, bypassing the mature-scan path.
 *  Only the CLI backfill route should use this; the Web thread API still calls
 *  byPosition / getMessages and needs the full set so scheduled rows surface in
 *  the queued floating bar. */
export function getDeliverableMessagesAfter(
    db: Database,
    sessionId: string,
    afterSeq: number,
    now: number,
    limit: number = 200
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const safeAfterSeq = Number.isFinite(afterSeq) ? afterSeq : 0

    const rows = db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ?
          AND seq > ?
          AND (scheduled_at IS NULL OR scheduled_at <= ?)
        ORDER BY seq ASC
        LIMIT ?
    `).all(sessionId, safeAfterSeq, now, safeLimit) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

/** Paginate messages by COALESCE(invoked_at, created_at) DESC, seq DESC.
 *  Results are returned in ascending display order. */
export function getMessagesByPosition(
    db: Database,
    sessionId: string,
    limit: number,
    before?: MessagePosition
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const beforeClause = before
        ? 'AND (COALESCE(invoked_at, created_at) < @beforeAt OR (COALESCE(invoked_at, created_at) = @beforeAt AND seq < @beforeSeq))'
        : ''
    const rows = db.prepare(`
        SELECT *, COALESCE(invoked_at, created_at) AS position_at
        FROM messages
        WHERE session_id = @sessionId
          ${beforeClause}
        ORDER BY position_at DESC, seq DESC
        LIMIT @limit
    `).all({
        sessionId,
        beforeAt: before?.at ?? null,
        beforeSeq: before?.seq ?? null,
        limit: safeLimit
    }) as DbMessageRow[]
    // Reverse so results are in ascending display order (oldest first)
    return rows.reverse().map(toStoredMessage)
}

/** Return messages strictly after a display-position cursor in ascending order.
 *  `until`, when supplied, is an inclusive fixed snapshot head so a catch-up
 *  loop does not chase messages appended while it is running. */
export function getMessagesAfterPosition(
    db: Database,
    sessionId: string,
    limit: number,
    after: MessagePosition,
    until?: MessagePosition
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const untilClause = until
        ? `AND (
            COALESCE(invoked_at, created_at) < @untilAt
            OR (COALESCE(invoked_at, created_at) = @untilAt AND seq <= @untilSeq)
        )`
        : ''
    const rows = db.prepare(`
        SELECT *, COALESCE(invoked_at, created_at) AS position_at
        FROM messages
        WHERE session_id = @sessionId
          AND (
            COALESCE(invoked_at, created_at) > @afterAt
            OR (COALESCE(invoked_at, created_at) = @afterAt AND seq > @afterSeq)
          )
          ${untilClause}
        ORDER BY position_at ASC, seq ASC
        LIMIT @limit
    `).all({
        sessionId,
        afterAt: after.at,
        afterSeq: after.seq,
        untilAt: until?.at ?? null,
        untilSeq: until?.seq ?? null,
        limit: safeLimit
    }) as DbMessageRow[]
    return rows.map(toStoredMessage)
}

export function getNewestMessagePosition(db: Database, sessionId: string): MessagePosition | null {
    const row = db.prepare(`
        SELECT COALESCE(invoked_at, created_at) AS position_at, seq
        FROM messages
        WHERE session_id = ?
        ORDER BY position_at DESC, seq DESC
        LIMIT 1
    `).get(sessionId) as { position_at: number; seq: number } | undefined
    return row ? { at: row.position_at, seq: row.seq } : null
}

export function getMessageEpoch(db: Database, sessionId: string): number {
    const row = db.prepare(
        'SELECT epoch FROM message_epochs WHERE session_id = ?'
    ).get(sessionId) as { epoch: number } | undefined
    return row?.epoch ?? 0
}

export function bumpMessageEpoch(db: Database, sessionId: string): number {
    db.prepare(`
        INSERT INTO message_epochs (session_id, epoch)
        VALUES (?, 1)
        ON CONFLICT(session_id) DO UPDATE SET epoch = epoch + 1
    `).run(sessionId)
    return getMessageEpoch(db, sessionId)
}

/** Returns user messages that have a localId but no invoked_at.
 *  Includes future scheduled messages — used to surface all queued messages
 *  (including scheduled) for the Web floating bar on refresh / secondary clients. */
export function getUninvokedLocalMessages(
    db: Database,
    sessionId: string
): StoredMessage[] {
    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND invoked_at IS NULL AND local_id IS NOT NULL ORDER BY seq ASC'
    ).all(sessionId) as DbMessageRow[]
    return rows.map(toStoredMessage)
}

export type LocalMessageState = {
    localId: string
    invokedAt: number | null
}

export function getLocalMessageStates(
    db: Database,
    sessionId: string,
    localIds: string[]
): LocalMessageState[] {
    if (localIds.length === 0) {
        return []
    }
    const placeholders = localIds.map(() => '?').join(', ')
    const rows = db.prepare(`
        SELECT local_id, invoked_at
        FROM messages
        WHERE session_id = ? AND local_id IN (${placeholders})
        ORDER BY seq ASC
    `).all(sessionId, ...localIds) as Array<{
        local_id: string
        invoked_at: number | null
    }>
    return rows.map((row) => ({
        localId: row.local_id,
        invokedAt: row.invoked_at
    }))
}

/** Returns scheduled messages across all sessions whose scheduled_at <= beforeTime
 *  and have not yet been invoked.  Used by the hub tick to emit mature messages to CLI.
 *  Ordered by scheduled_at ASC (oldest first). */
export function getMatureScheduledMessages(
    db: Database,
    beforeTime: number
): StoredMessage[] {
    const rows = db.prepare(
        'SELECT * FROM messages WHERE scheduled_at IS NOT NULL AND scheduled_at <= ? AND invoked_at IS NULL ORDER BY scheduled_at ASC'
    ).all(beforeTime) as DbMessageRow[]
    return rows.map(toStoredMessage)
}

/** Returns immediate-queued local messages for a session — i.e. rows that have
 *  no scheduled_at (scheduled_at IS NULL).  Used by the session-end sweep
 *  (sweepImmediateQueuedOnSessionEnd): these are messages the user posted to a
 *  CLI session that ended before the runner consumed them, so they cannot ever
 *  be delivered and must be force-invoked to clear the floating bar.
 *
 *  Scheduled rows (scheduled_at IS NOT NULL) are *deliberately excluded*, mature
 *  or not.  The mature-scan path (releaseMatureScheduledMessages) is the sole
 *  emit channel for scheduled rows and it does not write invoked_at — the CLI
 *  ack does.  If the session-end sweep stamped a mature scheduled row as
 *  invoked, a subsequent CLI re-attach would never see the row in the
 *  mature-scan results (it filters on invoked_at IS NULL), and the user's
 *  scheduled prompt would be silently dropped.  See HAPI Bot R4 finding. */
export function getImmediateQueuedLocalMessages(
    db: Database,
    sessionId: string
): StoredMessage[] {
    const rows = db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ?
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NULL
        ORDER BY seq ASC
    `).all(sessionId) as DbMessageRow[]
    return rows.map(toStoredMessage)
}

/**
 * Total messages persisted for a session - any role, any state (including
 * future-scheduled and never-invoked queued rows). Used as the
 * "is this session non-trivial?" signal for the cursor migrator's size
 * sanity check; intentionally broad so a session with 6 000 unread agent
 * outputs and zero invoked user turns still counts as non-trivial.
 * tiann/hapi#872.
 */
export function countMessages(db: Database, sessionId: string): number {
    const row = db.prepare(
        'SELECT COUNT(*) AS count FROM messages WHERE session_id = ?'
    ).get(sessionId) as { count: number } | undefined
    return row?.count ?? 0
}

/** Count uninvoked local messages scheduled for a future time (session list indicator). */
export function countFutureScheduledLocalMessages(
    db: Database,
    sessionId: string,
    now: number
): number {
    const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM messages
        WHERE session_id = ?
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
    `).get(sessionId, now) as { count: number } | undefined
    return row?.count ?? 0
}

/** Batch variant for GET /sessions — one query for all session IDs in a namespace. */
export function countFutureScheduledBySessionIds(
    db: Database,
    sessionIds: string[],
    now: number
): Map<string, number> {
    const counts = new Map<string, number>()
    if (sessionIds.length === 0) {
        return counts
    }

    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = db.prepare(`
        SELECT session_id, COUNT(*) AS count
        FROM messages
        WHERE session_id IN (${placeholders})
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
        GROUP BY session_id
    `).all(...sessionIds, now) as { session_id: string; count: number }[]

    for (const row of rows) {
        counts.set(row.session_id, row.count)
    }
    return counts
}

/** Earliest future scheduled_at per session (session-list clock tooltip). */
export function minFutureScheduledAtBySessionIds(
    db: Database,
    sessionIds: string[],
    now: number
): Map<string, number> {
    const nextAt = new Map<string, number>()
    if (sessionIds.length === 0) {
        return nextAt
    }

    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = db.prepare(`
        SELECT session_id, MIN(scheduled_at) AS next_at
        FROM messages
        WHERE session_id IN (${placeholders})
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
        GROUP BY session_id
    `).all(...sessionIds, now) as { session_id: string; next_at: number }[]

    for (const row of rows) {
        nextAt.set(row.session_id, row.next_at)
    }
    return nextAt
}

export function getMaxSeq(db: Database, sessionId: string): number {
    const row = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { maxSeq: number } | undefined
    return row?.maxSeq ?? 0
}

/**
 * Delete oldest delivered history beyond the per-session cap. Queued and
 * scheduled-but-uninvoked prompts are never eligible for retention pruning.
 */
export function pruneOldMessages(db: Database, keepPerSession: number): number {
    if (!Number.isFinite(keepPerSession) || keepPerSession <= 0) return 0
    const keep = Math.floor(keepPerSession)

    return db.transaction(() => {
        const affectedSessions = db.prepare(`
            SELECT DISTINCT session_id
            FROM (
                SELECT session_id,
                       ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq DESC) AS rn
                FROM messages
                WHERE invoked_at IS NOT NULL
            )
            WHERE rn > @keep
        `).all({ keep }) as Array<{ session_id: string }>

        if (affectedSessions.length === 0) return 0
        const result = db.prepare(`
            DELETE FROM messages
            WHERE id IN (
                SELECT id FROM (
                    SELECT id,
                           ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq DESC) AS rn
                    FROM messages
                    WHERE invoked_at IS NOT NULL
                )
                WHERE rn > @keep
            )
        `).run({ keep })

        if (result.changes > 0) {
            for (const { session_id: sessionId } of affectedSessions) {
                bumpMessageEpoch(db, sessionId)
            }
        }
        return result.changes ?? 0
    })()
}

export type CancelQueuedMessageResult =
    | { status: 'cancelled'; localId: string | null }
    | { status: 'invoked'; message: StoredMessage }

/** Delete a queued (invoked_at IS NULL) message by session + message id.
 *
 * Runs inside a transaction to eliminate the SELECT-then-DELETE race window.
 * Returns a discriminated union so callers can distinguish two zero-delete cases:
 *   - 'cancelled': row was absent (already cancelled, or wrong id/session) — treat as success.
 *   - 'invoked':   row exists but invoked_at IS NOT NULL (CLI consumed it first) —
 *                  caller must revert any optimistic removal using the returned row,
 *                  not a stale client-side snapshot, so invokedAt is authoritative.
 *
 * The invoked_at IS NULL guard ensures cancel and invoke are mutually exclusive at
 * the DB level (first-write-wins, mirrors markMessagesInvoked). */
export function cancelQueuedMessage(
    db: Database,
    sessionId: string,
    messageId: string
): CancelQueuedMessageResult {
    return db.transaction(() => {
        // Accept either the server-assigned uuid (id) or the client localId.
        // This handles the pre-echo window where the web client still holds
        // msg.id === localId and passes that as the messageId parameter.
        // Note: local_id = ? evaluates to NULL (no match) when local_id IS NULL,
        // which is safe — messages without a localId are inserted with invoked_at set
        // and are never queued, so they cannot reach this code path anyway.
        const row = db.prepare(`
            SELECT * FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?)
            LIMIT 1
        `).get(sessionId, messageId, messageId) as DbMessageRow | undefined

        if (!row) {
            // Row absent: already cancelled or wrong id — fold into 'cancelled'
            return { status: 'cancelled' as const, localId: null }
        }

        if (row.invoked_at !== null) {
            // CLI already consumed this message before the cancel arrived.
            // Return the full row so the web client can restore authoritative invoked state
            // rather than reverting to a stale queued snapshot (invokedAt: null).
            return { status: 'invoked' as const, message: toStoredMessage(row) }
        }

        const deleted = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?) AND invoked_at IS NULL
        `).run(sessionId, messageId, messageId)

        if (deleted.changes > 0) {
            bumpMessageEpoch(db, sessionId)
        }

        return { status: 'cancelled' as const, localId: row.local_id }
    })()
}

export type LookupQueuedMessageResult =
    | { status: 'absent' }
    | { status: 'invoked'; message: StoredMessage }
    | { status: 'queued'; localId: string | null; resolvedId: string; scheduledAt: number | null }

/** Look up a queued message without deleting it.
 *
 * Returns one of three discriminated states:
 *   - 'absent':  row not found (already cancelled or wrong id).
 *   - 'invoked': row exists but invoked_at IS NOT NULL (CLI consumed it first).
 *   - 'queued':  row exists and is cancellable; resolvedId is the server-assigned uuid.
 *
 * Used by the service layer to inspect state before issuing a CLI ack round-trip.
 * The actual DELETE (after CLI ack) is performed by deleteQueuedMessageById. */
export function lookupQueuedMessage(
    db: Database,
    sessionId: string,
    messageId: string
): LookupQueuedMessageResult {
    const row = db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ? AND (id = ? OR local_id = ?)
        LIMIT 1
    `).get(sessionId, messageId, messageId) as DbMessageRow | undefined

    if (!row) {
        return { status: 'absent' as const }
    }

    if (row.invoked_at !== null) {
        return { status: 'invoked' as const, message: toStoredMessage(row) }
    }

    return { status: 'queued' as const, localId: row.local_id, resolvedId: row.id, scheduledAt: row.scheduled_at }
}

/** Delete a queued (invoked_at IS NULL) message by id or local_id.
 *
 * This is the "confirmed DELETE" step after the service layer has received a
 * CLI ack with removed:true.  Uses the same first-write-wins guard as the
 * original cancelQueuedMessage. */
export function deleteQueuedMessageById(
    db: Database,
    sessionId: string,
    messageId: string
): boolean {
    return db.transaction(() => {
        const deleted = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?) AND invoked_at IS NULL
        `).run(sessionId, messageId, messageId)
        if (deleted.changes > 0) {
            bumpMessageEpoch(db, sessionId)
            return true
        }
        return false
    })()
}

/** Mark messages as invoked at the given server timestamp.
 *  Only updates rows whose local_id is in localIds.
 *  First-write-wins: rows with a non-NULL invoked_at are not updated.  A duplicate
 *  ack (e.g. a CLI re-emit) would otherwise re-stamp the timestamp and shuffle
 *  the message's position in the byPosition-ordered thread. */
export function markMessagesInvoked(
    db: Database,
    sessionId: string,
    localIds: string[],
    invokedAt: number
): number {
    if (localIds.length === 0) return 0
    const placeholders = localIds.map(() => '?').join(', ')
    return db.prepare(
        `UPDATE messages
         SET invoked_at = ?
         WHERE session_id = ?
           AND local_id IN (${placeholders})
           AND invoked_at IS NULL`
    ).run(invokedAt, sessionId, ...localIds).changes
}

/** Settle immediate queued rows on an archived clear source without touching
 * scheduled rows, which must remain uninvoked for transfer to the replacement. */
export function markUninvokedImmediateMessages(
    db: Database,
    sessionId: string,
    invokedAt: number
): string[] {
    const rows = db.prepare(`
        SELECT local_id FROM messages
        WHERE session_id = ?
          AND local_id IS NOT NULL
          AND scheduled_at IS NULL
          AND invoked_at IS NULL
        ORDER BY seq ASC
    `).all(sessionId) as Array<{ local_id: string }>
    if (rows.length === 0) return []

    db.prepare(`
        UPDATE messages
        SET invoked_at = ?
        WHERE session_id = ?
          AND local_id IS NOT NULL
          AND scheduled_at IS NULL
          AND invoked_at IS NULL
    `).run(invokedAt, sessionId)
    return rows.map((row) => row.local_id)
}

/**
 * Reassign only uninvoked scheduled rows when an archived OpenCode session
 * is replaced by /clear. The transaction preserves ids/localIds so the normal
 * scheduled-message ack path continues on the replacement session.
 */
export function moveUninvokedScheduledMessages(
    db: Database,
    fromSessionId: string,
    toSessionId: string
): number {
    if (fromSessionId === toSessionId) return 0

    const rows = db.prepare(`
        SELECT id FROM messages
        WHERE session_id = ?
          AND scheduled_at IS NOT NULL
          AND invoked_at IS NULL
        ORDER BY seq ASC
    `).all(fromSessionId) as Array<{ id: string }>
    if (rows.length === 0) return 0

    try {
        db.exec('BEGIN')
        let nextSeq = getMaxSeq(db, toSessionId)
        const update = db.prepare('UPDATE messages SET session_id = ?, seq = ? WHERE id = ?')
        for (const row of rows) {
            nextSeq += 1
            update.run(toSessionId, nextSeq, row.id)
        }
        bumpMessageEpoch(db, fromSessionId)
        bumpMessageEpoch(db, toSessionId)
        db.exec('COMMIT')
        return rows.length
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}

/**
 * Move every still-held prompt to a reserved replacement, preserving FIFO.
 * If both sessions already contain the same non-null localId, the replacement
 * row is authoritative (it represents the retry/new owner) and only the
 * uninvoked source duplicate is discarded.
 */
export function moveUninvokedMessages(db: Database, fromSessionId: string, toSessionId: string): number {
    if (fromSessionId === toSessionId) return 0
    return db.transaction(() => {
        const discarded = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ?
              AND invoked_at IS NULL
              AND local_id IS NOT NULL
              AND EXISTS (
                  SELECT 1 FROM messages AS target
                  WHERE target.session_id = ?
                    AND target.local_id = messages.local_id
              )
        `).run(fromSessionId, toSessionId).changes
        const rows = db.prepare(`
            SELECT id, session_id FROM messages
            WHERE session_id IN (?, ?) AND invoked_at IS NULL
            -- created_at is millisecond-granularity; rowid is the durable
            -- cross-session insertion order for ties within this database.
            ORDER BY created_at ASC,
                     rowid ASC,
                     seq ASC,
                     id ASC
        `).all(fromSessionId, toSessionId) as Array<{ id: string; session_id: string }>
        const moved = rows.filter((row) => row.session_id === fromSessionId).length
        if (discarded === 0 && moved === 0) return 0
        const invokedMax = db.prepare(`
            SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages
            WHERE session_id = ? AND invoked_at IS NOT NULL
        `).get(toSessionId) as { maxSeq: number }
        let nextSeq = invokedMax.maxSeq
        const update = db.prepare('UPDATE messages SET session_id = ?, seq = ? WHERE id = ?')
        for (const row of rows) update.run(toSessionId, ++nextSeq, row.id)
        bumpMessageEpoch(db, fromSessionId)
        bumpMessageEpoch(db, toSessionId)
        return discarded + moved
    })()
}

export function mergeSessionMessages(
    db: Database,
    fromSessionId: string,
    toSessionId: string
): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
    if (fromSessionId === toSessionId) {
        return { moved: 0, oldMaxSeq: 0, newMaxSeq: 0 }
    }

    const oldMaxSeq = getMaxSeq(db, fromSessionId)
    const newMaxSeq = getMaxSeq(db, toSessionId)

    try {
        db.exec('BEGIN')

        const fromRows = db.prepare(
            'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC'
        ).all(fromSessionId) as DbMessageRow[]
        const toRows = db.prepare(
            'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC'
        ).all(toSessionId) as DbMessageRow[]

        // Resumed/deduplicated sessions often contain a replayed prefix. Keep
        // the multiplicity found in the source, then append only target copies
        // beyond that multiplicity. Rows without a safe semantic key remain.
        const fromKeyCounts = new Map<string, number>()
        for (const row of fromRows) {
            const key = getMessageMergeDedupeKey(decodeMessageContent(row.content))
            if (!key) continue
            fromKeyCounts.set(key, (fromKeyCounts.get(key) ?? 0) + 1)
        }

        const toKeyCounts = new Map<string, number>()
        const mergedRows: DbMessageRow[] = [...fromRows]
        for (const row of toRows) {
            const key = getMessageMergeDedupeKey(decodeMessageContent(row.content))
            if (!key) {
                mergedRows.push(row)
                continue
            }
            const nextCount = (toKeyCounts.get(key) ?? 0) + 1
            toKeyCounts.set(key, nextCount)
            if (nextCount > (fromKeyCounts.get(key) ?? 0)) {
                mergedRows.push(row)
            }
        }

        db.prepare('DELETE FROM messages WHERE session_id = ?').run(fromSessionId)
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(toSessionId)

        const insert = db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at, content_uuid
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at, @content_uuid
            )
        `)
        const seenLocalIds = new Set<string>()
        for (let index = 0; index < mergedRows.length; index += 1) {
            const row = mergedRows[index]
            const localId = row.local_id && !seenLocalIds.has(row.local_id) ? row.local_id : null
            if (localId) seenLocalIds.add(localId)
            // Dropping a colliding localId severs its ACK path; force-invoke it
            // so the duplicate can never remain pinned in the queued bar.
            const invokedAt = row.invoked_at ?? (row.local_id && !localId ? row.created_at : null)
            insert.run({
                id: row.id,
                session_id: toSessionId,
                content: row.content,
                created_at: row.created_at,
                seq: index + 1,
                local_id: localId,
                invoked_at: invokedAt,
                scheduled_at: row.scheduled_at ?? null,
                content_uuid: row.content_uuid ?? extractContentUuid(decodeMessageContent(row.content))
            })
        }

        if (fromRows.length > 0) {
            bumpMessageEpoch(db, fromSessionId)
            bumpMessageEpoch(db, toSessionId)
        }

        db.exec('COMMIT')
        return { moved: fromRows.length, oldMaxSeq, newMaxSeq: mergedRows.length }
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}

/**
 * Truncate transcript at/after the message with `localId`, optionally replacing
 * the removed suffix with `replacement` messages. Bumps message epoch so web
 * clients reset their window.
 */
export function truncateMessagesFromLocalId(
    db: Database,
    sessionId: string,
    localId: string,
    replacement: Array<{
        content: unknown
        localId?: string | null
        createdAt?: number
        invokedAt?: number | null
    }> = []
): { deleted: number; inserted: number; epoch: number } {
    return db.transaction(() => {
        const target = db.prepare(`
            SELECT id, seq, COALESCE(invoked_at, created_at) AS position_at
            FROM messages
            WHERE session_id = ? AND local_id = ?
            LIMIT 1
        `).get(sessionId, localId) as { id: string; seq: number; position_at: number } | undefined

        if (!target) {
            throw new Error(`Message not found for localId: ${localId}`)
        }

        const deleted = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ?
              AND (
                COALESCE(invoked_at, created_at) > ?
                OR (COALESCE(invoked_at, created_at) = ? AND seq >= ?)
              )
        `).run(sessionId, target.position_at, target.position_at, target.seq)

        let inserted = 0
        for (const message of replacement) {
            const now = Date.now()
            const msgSeqRow = db.prepare(
                'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
            ).get(sessionId) as { nextSeq: number }
            const id = randomUUID()
            const createdAt = message.createdAt ?? now
            const invokedAt = message.invokedAt === undefined ? createdAt : message.invokedAt
            const rowLocalId = message.localId ?? null
            db.prepare(`
                INSERT INTO messages (id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at, content_uuid)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
            `).run(
                id,
                sessionId,
                encodeMessageContent(message.content),
                createdAt,
                msgSeqRow.nextSeq,
                rowLocalId,
                invokedAt,
                extractContentUuid(message.content)
            )
            inserted += 1
        }

        const epoch = bumpMessageEpoch(db, sessionId)
        return { deleted: deleted.changes, inserted, epoch }
    })()
}
