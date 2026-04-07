import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { safeStringify } from '@hapi/protocol'
import type { DecryptedMessage } from '@/types/api'
import type { NormalizedMessage } from '@/chat/types'
import { isCodexContent, isSkippableAgentContent, normalizeAgentRecord } from '@/chat/normalizeAgent'
import { normalizeUserRecord } from '@/chat/normalizeUser'
import { isClaudeChatVisibleMessage } from '@hapi/protocol/messages'
import { isObject } from '@hapi/protocol'

/** Skip raw (un-enveloped) messages whose data.type is not user-visible */
function isSkippableRawContent(content: unknown): boolean {
    if (!isObject(content)) return false

    // Skip raw event messages (usage, ready, etc.)
    if (content.type === 'event') return true

    // Skip non-visible output messages (rate_limit_event, etc.)
    if (content.type === 'output') {
        const data = isObject(content.data) ? content.data : null
        if (!data || typeof data.type !== 'string') return false
        return !isClaudeChatVisibleMessage({ type: data.type, subtype: data.subtype })
    }

    // Skip raw JSON with internal types (e.g. {"type":"usage",...})
    if (typeof content.type === 'string') {
        const internalTypes = new Set(['usage', 'ready', 'rate_limit_event', 'rate_limit_info'])
        if (internalTypes.has(content.type)) return true
    }

    return false
}

export function normalizeDecryptedMessage(message: DecryptedMessage): NormalizedMessage | null {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record) {
        // Skip raw messages with non-visible types (e.g. rate_limit_event)
        if (isSkippableRawContent(message.content)) {
            return null
        }
        return {
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'text', text: safeStringify(message.content), uuid: message.id, parentUUID: null }],
            status: message.status,
            originalText: message.originalText
        }
    }

    if (record.role === 'user') {
        const normalized = normalizeUserRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
        return normalized
            ? { ...normalized, status: message.status, originalText: message.originalText }
            : {
                id: message.id,
                localId: message.localId,
                createdAt: message.createdAt,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: safeStringify(record.content) },
                meta: record.meta,
                status: message.status,
                originalText: message.originalText
            }
    }
    if (record.role === 'agent') {
        if (isSkippableAgentContent(record.content)) {
            return null
        }
        const normalized = normalizeAgentRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
        if (!normalized && (isCodexContent(record.content) || isSkippableAgentContent(record.content))) {
            return null
        }
        return normalized
            ? { ...normalized, status: message.status, originalText: message.originalText }
            : {
                id: message.id,
                localId: message.localId,
                createdAt: message.createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'text', text: safeStringify(record.content), uuid: message.id, parentUUID: null }],
                meta: record.meta,
                status: message.status,
                originalText: message.originalText
            }
    }

    return {
        id: message.id,
        localId: message.localId,
        createdAt: message.createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'text', text: safeStringify(record.content), uuid: message.id, parentUUID: null }],
        meta: record.meta,
        status: message.status,
        originalText: message.originalText
    }
}
