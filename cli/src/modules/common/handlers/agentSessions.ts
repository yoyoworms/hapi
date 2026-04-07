import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { getProjectPath } from '@/claude/utils/path'
import { logger } from '@/ui/logger'
import { getErrorMessage, rpcError } from '../rpcResponses'

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
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function isValidSessionFile(filePath: string): boolean {
    try {
        const chunkSize = 4096
        const fd = openSync(filePath, 'r')
        const buffer = Buffer.alloc(chunkSize)
        const bytesRead = readSync(fd, buffer, 0, chunkSize, 0)
        closeSync(fd)

        const content = buffer.toString('utf-8', 0, bytesRead)
        for (const line of content.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed) continue
            try {
                const parsed = JSON.parse(trimmed) as { uuid?: unknown }
                if (typeof parsed.uuid === 'string') {
                    return true
                }
            } catch {
                // Ignore malformed JSONL rows.
            }
        }
    } catch {
        return false
    }

    return false
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

        const sessionId = entry.slice(0, -'.jsonl'.length)
        if (!SESSION_ID_PATTERN.test(sessionId)) continue

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
            // Ignore files that disappear mid-scan.
        }
    }

    sessions.sort((a, b) => b.modifiedAt - a.modifiedAt)
    return sessions.slice(0, MAX_RESULTS)
}

export function registerAgentSessionHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListAgentSessionsRequest, ListAgentSessionsResponse>('list-agent-sessions', async (data) => {
        logger.debug('[agentSessions] List sessions request:', data.directory, data.agent)

        try {
            switch (data.agent) {
                case 'claude':
                    return {
                        success: true,
                        sessions: listClaudeSessions(data.directory)
                    }
                default:
                    return {
                        success: true,
                        sessions: []
                    }
            }
        } catch (error) {
            logger.debug('[agentSessions] Failed to list sessions:', error)
            return rpcError(getErrorMessage(error, 'Failed to list agent sessions'))
        }
    })
}
