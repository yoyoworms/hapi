import type { Database } from 'bun:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { decodeMessageContent, encodeMessageContent, truncateOversizedMessageContent } from './contentCodec'
import { prepareCached } from './statementCache'
import { indexMessageContent, removeMessageContentSearchIndex } from './messageContentSearch'

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {}
}

function comparable(content: unknown): unknown {
    const envelope = record(content)
    const payload = record(envelope.content)
    const data = record(payload.data)
    if (envelope.role !== 'agent' || payload.type !== 'codex' || data.type !== 'message'
        || typeof data.message !== 'string') return null
    const { id: _id, ...body } = data
    const { codexHistoryAliases: _aliases, ...meta } = record(envelope.meta)
    return { ...envelope, content: { ...payload, data: body }, meta }
}

/** Legacy thread/read rebuilds assistant item ids as item-N. Keep an alias on
 * the original row so older, already-running CLIs can reconnect safely too.
 * Claim each original once: identical messages within a turn are separate
 * occurrences, not a reason to discard conversation content. */
export function resolveCodexHistoryReplay(
    db: Database, sessionId: string, content: unknown, localId: string
): string | null {
    const match = /^(codex:[^:]+:[^:]+:)item-\d+:agent_message$/.exec(localId)
    const incoming = comparable(truncateOversizedMessageContent(content))
    if (!match || !incoming) return null
    const prefix = match[1]
    const rows = prepareCached(db, `
        SELECT id, local_id, content FROM messages INDEXED BY idx_messages_local_id
        WHERE session_id = ? AND local_id IS NOT NULL
          AND local_id >= ? AND local_id < ?
          AND local_id GLOB '*:agent_message'
        ORDER BY seq ASC
    `).all(sessionId, prefix, `${prefix}\uffff`) as Array<{
        id: string; local_id: string; content: string | Uint8Array
    }>
    const candidates: Array<{ id: string; content: Record<string, unknown> }> = []
    for (const row of rows) {
        if (/^item-\d+:agent_message$/.test(row.local_id.slice(prefix.length))) continue
        const original = record(decodeMessageContent(row.content))
        if (!isDeepStrictEqual(incoming, comparable(original))) continue
        const aliases = record(original.meta).codexHistoryAliases
        if (Array.isArray(aliases) && aliases.includes(localId)) return row.id
        if (!Array.isArray(aliases) || aliases.length === 0) candidates.push({ id: row.id, content: original })
    }
    const candidate = candidates[0]
    if (!candidate) return null
    const updated = { ...candidate.content, meta: {
        ...record(candidate.content.meta), codexHistoryAliases: [localId]
    } }
    prepareCached(db, 'UPDATE messages SET content = ? WHERE id = ? AND session_id = ?')
        .run(encodeMessageContent(updated), candidate.id, sessionId)
    return candidate.id
}

/** A message may have first arrived through a legacy snapshot while the hub
 * was offline. Adopt that row when a new CLI supplies its native origin, rather
 * than inserting a second copy under the recovered live id. */
export function restoreCodexHistoryOrigin(
    db: Database, sessionId: string, content: unknown, localId: string, at: number
): string | null {
    const match = /^(codex:[^:]+:[^:]+:)([^:]+):agent_message$/.exec(localId)
    const incoming = comparable(truncateOversizedMessageContent(content))
    if (!match || /^item-\d+$/.test(match[2]) || !incoming || !Number.isFinite(at)) return null
    const prefix = match[1]
    const rows = prepareCached(db, `
        SELECT id, local_id, content, seq FROM messages INDEXED BY idx_messages_local_id
        WHERE session_id = ? AND local_id IS NOT NULL
          AND local_id >= ? AND local_id < ?
          AND local_id GLOB '*:item-*:agent_message'
        ORDER BY seq ASC
    `).all(sessionId, prefix, `${prefix}\uffff`) as Array<{ id: string; local_id: string; content: string | Uint8Array; seq: number }>
    for (const row of rows) {
        if (!/^item-\d+:agent_message$/.test(row.local_id.slice(prefix.length))) continue
        if (!isDeepStrictEqual(incoming, comparable(decodeMessageContent(row.content)))) continue
        const envelope = record(truncateOversizedMessageContent(content))
        const updated = { ...envelope, meta: { ...record(envelope.meta), codexHistoryAliases: [row.local_id] } }
        return db.transaction(() => {
            prepareCached(db, `UPDATE messages SET local_id = ?, content = ?, created_at = ?, invoked_at = ?
                WHERE session_id = ? AND id = ?`).run(localId, encodeMessageContent(updated), at, at, sessionId, row.id)
            indexMessageContent(db, { id: row.id, sessionId, content: updated, seq: row.seq, createdAt: at, invokedAt: at })
            prepareCached(db, `INSERT INTO message_epochs (session_id, epoch) VALUES (?, 1)
                ON CONFLICT(session_id) DO UPDATE SET epoch = epoch + 1`).run(sessionId)
            return row.id
        })()
    }
    return null
}

/** Explicit repair only; normal reads never mutate or sweep history. */
export function repairCodexHistoryReplays(db: Database, sessionId: string): Array<{ removedId: string; originalId: string }> {
    return db.transaction(() => {
        const rows = prepareCached(db, `
            SELECT id, local_id, content, seq FROM messages
            WHERE session_id = ? AND local_id GLOB 'codex:*:item-*:agent_message'
            ORDER BY seq ASC
        `).all(sessionId) as Array<{ id: string; local_id: string; content: string | Uint8Array; seq: number }>
        const head = prepareCached(db, 'SELECT MAX(seq) AS seq FROM messages WHERE session_id = ?')
            .get(sessionId) as { seq: number | null }
        const repaired: Array<{ removedId: string; originalId: string }> = []
        for (const row of rows) {
            // addMessage allocates MAX(seq)+1. Retain the current high-water
            // row until newer traffic arrives, so a repair cannot reuse seqs
            // already observed by CLI consumers.
            if (row.seq === head.seq) continue
            const originalId = resolveCodexHistoryReplay(db, sessionId, decodeMessageContent(row.content), row.local_id)
            if (!originalId) continue
            removeMessageContentSearchIndex(db, row.id)
            prepareCached(db, 'DELETE FROM messages WHERE session_id = ? AND id = ?').run(sessionId, row.id)
            repaired.push({ removedId: row.id, originalId })
        }
        if (repaired.length > 0) {
            prepareCached(db, `INSERT INTO message_epochs (session_id, epoch) VALUES (?, 1)
                ON CONFLICT(session_id) DO UPDATE SET epoch = epoch + 1`).run(sessionId)
        }
        return repaired
    })()
}
