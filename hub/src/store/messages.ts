import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import type { StoredMessage } from './types'
import { safeJsonParse } from './json'

type DbMessageRow = {
    id: string
    session_id: string
    content: string
    created_at: number
    seq: number
    local_id: string | null
}

function toStoredMessage(row: DbMessageRow): StoredMessage {
    return {
        id: row.id,
        sessionId: row.session_id,
        content: safeJsonParse(row.content),
        createdAt: row.created_at,
        seq: row.seq,
        localId: row.local_id
    }
}

function extractContentUuid(content: unknown): string | null {
    if (typeof content !== 'object' || content === null) return null
    const c = content as Record<string, unknown>
    // agent output messages: { role: 'agent', content: { type: 'output', data: { uuid: '...' } } }
    if (c.role === 'agent' && typeof c.content === 'object' && c.content !== null) {
        const inner = c.content as Record<string, unknown>
        if (inner.type === 'output' && typeof inner.data === 'object' && inner.data !== null) {
            const data = inner.data as Record<string, unknown>
            if (typeof data.uuid === 'string') return data.uuid
        }
    }
    return null
}

/**
 * Extract the generation timestamp from an agent message's content.
 * Agent messages have: { role: 'agent', content: { type: 'output', data: { timestamp: '2026-...' } } }
 * or top-level: { timestamp: '...' }
 */
function extractAgentTimestamp(content: unknown): number | null {
    if (typeof content !== 'object' || content === null) return null
    const c = content as Record<string, unknown>
    // Check top-level timestamp
    if (typeof c.timestamp === 'string') {
        const ts = new Date(c.timestamp).getTime()
        if (!isNaN(ts)) return ts
    }
    // Check nested content.data.timestamp
    if (c.role === 'agent' && typeof c.content === 'object' && c.content !== null) {
        const inner = c.content as Record<string, unknown>
        if (typeof inner.data === 'object' && inner.data !== null) {
            const data = inner.data as Record<string, unknown>
            if (typeof data.timestamp === 'string') {
                const ts = new Date(data.timestamp).getTime()
                if (!isNaN(ts)) return ts
            }
        }
    }
    return null
}

function isAgentMessage(content: unknown): boolean {
    if (typeof content !== 'object' || content === null) return false
    return (content as Record<string, unknown>).role === 'agent'
}

function isUserMessage(content: unknown): boolean {
    if (typeof content !== 'object' || content === null) return false
    return (content as Record<string, unknown>).role === 'user'
}

export function addMessage(
    db: Database,
    sessionId: string,
    content: unknown,
    localId?: string,
    clockOffset?: number
): StoredMessage {
    const now = Date.now()

    if (localId) {
        const existing = db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
        ).get(sessionId, localId) as DbMessageRow | undefined
        if (existing) {
            return toStoredMessage(existing)
        }
    }

    // Deduplicate agent messages by content uuid (handles concurrent inserts via retry)
    const contentUuid = extractContentUuid(content)

    const msgSeqRow = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { nextSeq: number }
    const msgSeq = msgSeqRow.nextSeq

    const createdAt = now

    const id = randomUUID()
    const json = JSON.stringify(content)

    db.prepare(`
        INSERT INTO messages (
            id, session_id, content, created_at, seq, local_id
        ) VALUES (
            @id, @session_id, @content, @created_at, @seq, @local_id
        )
    `).run({
        id,
        session_id: sessionId,
        content: json,
        created_at: createdAt,
        seq: msgSeq,
        local_id: localId ?? null
    })

    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
    if (!row) {
        throw new Error('Failed to create message')
    }
    return toStoredMessage(row)
}

export function getMessages(
    db: Database,
    sessionId: string,
    limit: number = 200,
    beforeSeq?: number
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200

    const rows = (beforeSeq !== undefined && beforeSeq !== null && Number.isFinite(beforeSeq))
        ? db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'
        ).all(sessionId, beforeSeq, safeLimit) as DbMessageRow[]
        : db.prepare(
            'SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
        ).all(sessionId, safeLimit) as DbMessageRow[]

    return rows.reverse().map(toStoredMessage)
}

export function getMessagesAfter(
    db: Database,
    sessionId: string,
    afterSeq: number,
    limit: number = 200
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const safeAfterSeq = Number.isFinite(afterSeq) ? afterSeq : 0

    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
    ).all(sessionId, safeAfterSeq, safeLimit) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

export function getMaxSeq(db: Database, sessionId: string): number {
    const row = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { maxSeq: number } | undefined
    return row?.maxSeq ?? 0
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

        if (newMaxSeq > 0 && oldMaxSeq > 0) {
            db.prepare(
                'UPDATE messages SET seq = seq + ? WHERE session_id = ?'
            ).run(oldMaxSeq, toSessionId)
        }

        const collisions = db.prepare(`
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
            INTERSECT
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
        `).all(toSessionId, fromSessionId) as Array<{ local_id: string }>

        if (collisions.length > 0) {
            const localIds = collisions.map((row) => row.local_id)
            const placeholders = localIds.map(() => '?').join(', ')
            db.prepare(
                `UPDATE messages SET local_id = NULL WHERE session_id = ? AND local_id IN (${placeholders})`
            ).run(fromSessionId, ...localIds)
        }

        const result = db.prepare(
            'UPDATE messages SET session_id = ? WHERE session_id = ?'
        ).run(toSessionId, fromSessionId)

        db.exec('COMMIT')
        return { moved: result.changes, oldMaxSeq, newMaxSeq }
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}
