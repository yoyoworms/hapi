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

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value)
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`
    }
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function extractTextMessage(content: unknown): string | null {
    if (typeof content !== 'object' || content === null) return null
    const c = content as Record<string, unknown>
    if (typeof c.content !== 'object' || c.content === null) return null
    const inner = c.content as Record<string, unknown>
    if (inner.type !== 'text' || typeof inner.text !== 'string') return null
    return inner.text
}

function extractCodexPayload(content: unknown): Record<string, unknown> | null {
    if (typeof content !== 'object' || content === null) return null
    const c = content as Record<string, unknown>
    if (c.role !== 'agent' || typeof c.content !== 'object' || c.content === null) return null
    const inner = c.content as Record<string, unknown>
    if (inner.type !== 'codex' || typeof inner.data !== 'object' || inner.data === null) return null
    return inner.data as Record<string, unknown>
}

function getMessageMergeDedupeKey(content: unknown): string | null {
    const text = extractTextMessage(content)
    if (text !== null) {
        if (isUserMessage(content)) {
            return `user:text:${text}`
        }
        if (isAgentMessage(content)) {
            return `agent:text:${text}`
        }
    }

    const contentUuid = extractContentUuid(content)
    if (contentUuid) {
        return `uuid:${contentUuid}`
    }

    const codexPayload = extractCodexPayload(content)
    if (codexPayload) {
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
        if (type === 'token_count') {
            return `codex:token_count:${stableStringify(codexPayload.info ?? null)}`
        }
        if (type === 'tool-call') {
            return `codex:tool-call:${String(codexPayload.callId ?? '')}:${String(codexPayload.name ?? '')}:${stableStringify(codexPayload.input ?? null)}`
        }
        if (type === 'tool-call-result') {
            return `codex:tool-call-result:${String(codexPayload.callId ?? '')}:${stableStringify(codexPayload.output ?? null)}`
        }
    }

    return null
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

    if (!localId) {
        const dedupeKey = getMessageMergeDedupeKey(content)
        if (dedupeKey) {
            const latest = db.prepare(
                'SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1'
            ).get(sessionId) as DbMessageRow | undefined
            if (latest && getMessageMergeDedupeKey(safeJsonParse(latest.content)) === dedupeKey) {
                return toStoredMessage(latest)
            }
        }
    }

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

        const fromRows = db.prepare(
            'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC'
        ).all(fromSessionId) as DbMessageRow[]
        const toRows = db.prepare(
            'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC'
        ).all(toSessionId) as DbMessageRow[]

        const fromKeyCounts = new Map<string, number>()
        for (const row of fromRows) {
            const key = getMessageMergeDedupeKey(safeJsonParse(row.content))
            if (!key) continue
            fromKeyCounts.set(key, (fromKeyCounts.get(key) ?? 0) + 1)
        }

        const toKeyCounts = new Map<string, number>()
        const mergedRows: DbMessageRow[] = [...fromRows]
        for (const row of toRows) {
            const key = getMessageMergeDedupeKey(safeJsonParse(row.content))
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
                id, session_id, content, created_at, seq, local_id
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id
            )
        `)
        const seenLocalIds = new Set<string>()
        for (let index = 0; index < mergedRows.length; index += 1) {
            const row = mergedRows[index]
            const localId = row.local_id && !seenLocalIds.has(row.local_id) ? row.local_id : null
            if (localId) {
                seenLocalIds.add(localId)
            }
            insert.run({
                id: row.id,
                session_id: toSessionId,
                content: row.content,
                created_at: row.created_at,
                seq: index + 1,
                local_id: localId
            })
        }

        db.exec('COMMIT')
        return { moved: fromRows.length, oldMaxSeq, newMaxSeq: mergedRows.length }
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}
