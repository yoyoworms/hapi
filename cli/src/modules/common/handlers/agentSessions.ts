import { logger } from '@/ui/logger'
import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { getErrorMessage, rpcError } from '../rpcResponses'
import { getProjectPath } from '@/claude/utils/path'

interface ListAgentSessionsRequest {
    directory: string
    agent: string
}

interface AgentSessionEntry {
    sessionId: string
    modifiedAt: number
    sizeBytes: number
    valid: boolean
}

interface ListAgentSessionsResponse {
    success: boolean
    sessions?: AgentSessionEntry[]
    error?: string
}

const MAX_RESULTS = 20

/**
 * Lightweight check: read first 4KB of a JSONL file to see if it contains
 * at least one line with a `uuid` field (indicates a real conversation message).
 */
function isValidSessionFile(filePath: string): boolean {
    try {
        const CHUNK_SIZE = 4096
        const fd = openSync(filePath, 'r')
        const buffer = Buffer.alloc(CHUNK_SIZE)
        const bytesRead = readSync(fd, buffer, 0, CHUNK_SIZE, 0)
        closeSync(fd)

        const content = buffer.toString('utf-8', 0, bytesRead)
        const lines = content.split('\n')
        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            try {
                const parsed = JSON.parse(trimmed)
                if (typeof parsed.uuid === 'string') {
                    return true
                }
            } catch {
                // Skip malformed lines
            }
        }
        return false
    } catch {
        return false
    }
}

function listClaudeSessions(directory: string): AgentSessionEntry[] {
    const projectDir = getProjectPath(directory)

    let entries: string[]
    try {
        entries = readdirSync(projectDir)
    } catch {
        logger.debug(`[agentSessions] Cannot read project dir: ${projectDir}`)
        return []
    }

    const sessions: AgentSessionEntry[] = []

    for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue

        const sessionId = entry.slice(0, -6) // Remove .jsonl
        // Basic UUID format check
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) {
            continue
        }

        const filePath = join(projectDir, entry)
        try {
            const stats = statSync(filePath)
            sessions.push({
                sessionId,
                modifiedAt: stats.mtimeMs,
                sizeBytes: stats.size,
                valid: isValidSessionFile(filePath)
            })
        } catch {
            // Skip files we can't stat
        }
    }

    // Sort by modification time, most recent first
    sessions.sort((a, b) => b.modifiedAt - a.modifiedAt)

    return sessions.slice(0, MAX_RESULTS)
}

export function registerAgentSessionHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListAgentSessionsRequest, ListAgentSessionsResponse>('list-agent-sessions', async (data) => {
        logger.debug('[agentSessions] List sessions request:', data.directory, data.agent)

        try {
            let sessions: AgentSessionEntry[]

            switch (data.agent) {
                case 'claude':
                    sessions = listClaudeSessions(data.directory)
                    break
                default:
                    // Other agents not yet supported
                    sessions = []
            }

            return { success: true, sessions }
        } catch (error) {
            logger.debug('[agentSessions] Failed to list sessions:', error)
            return rpcError(getErrorMessage(error, 'Failed to list agent sessions'))
        }
    })
}
