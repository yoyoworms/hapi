import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentAccountLimit, AgentAccountStatus } from '@hapi/protocol/types'

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_USAGE_TIMEOUT_MS = 10_000

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
    return typeof value === 'object' && value !== null ? value as UnknownRecord : null
}

function asFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function resolveCredentialsPath(configDir?: string): string {
    const dir = configDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
    return join(dir, '.credentials.json')
}

export async function readClaudeOAuthAccessToken(configDir?: string): Promise<string | null> {
    try {
        const parsed = JSON.parse(await readFile(resolveCredentialsPath(configDir), 'utf8')) as unknown
        const root = asRecord(parsed)
        const oauth = asRecord(root?.claudeAiOauth)
        const token = oauth?.accessToken
        return typeof token === 'string' && token.trim() ? token.trim() : null
    } catch {
        return null
    }
}

function parseResetAt(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        if (value <= 0) return null
        return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value)
    }
    if (typeof value !== 'string' || !value.trim()) return null
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
}

function parseLimit(value: unknown, now: number): AgentAccountLimit | null {
    const record = asRecord(value)
    if (!record) return null

    const utilization = asFiniteNumber(record.utilization)
    const resetAt = parseResetAt(record.resets_at ?? record.resetsAt)
    if (utilization === null && resetAt === null) return null

    // The OAuth endpoint reports utilization in percentage points (0..100).
    // Unlike SDK rate-limit events, a value of 1 means 1%, not 100%.
    const clampedUtilization = utilization === null
        ? null
        : Math.max(0, Math.min(100, utilization))
    return {
        ...(clampedUtilization !== null ? { remainingPercent: 100 - clampedUtilization } : {}),
        ...(resetAt !== null ? {
            resetAt,
            remainingMs: Math.max(0, resetAt - now)
        } : {})
    }
}

export function parseClaudeUsageResponse(value: unknown, now = Date.now()): AgentAccountStatus | null {
    const root = asRecord(value)
    if (!root) return null

    const window = parseLimit(root.five_hour ?? root.fiveHour, now)
    const weekly = parseLimit(root.seven_day ?? root.sevenDay, now)
    if (!window && !weekly) return null

    return {
        provider: 'claude',
        accountLabel: 'Claude',
        window,
        weekly,
        updatedAt: now
    }
}

export async function fetchClaudeUsage(
    configDir?: string,
    now = Date.now(),
    fetchImpl: typeof fetch = fetch
): Promise<AgentAccountStatus | null> {
    const accessToken = await readClaudeOAuthAccessToken(configDir)
    if (!accessToken) return null

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CLAUDE_USAGE_TIMEOUT_MS)
    try {
        const response = await fetchImpl(CLAUDE_USAGE_URL, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json',
                'anthropic-version': '2023-06-01',
                'User-Agent': 'claude-code-usage/hapi'
            },
            signal: controller.signal
        })
        if (!response.ok) return null
        return parseClaudeUsageResponse(await response.json(), now)
    } catch {
        return null
    } finally {
        clearTimeout(timeout)
    }
}

export const CLAUDE_USAGE_REFRESH_INTERVAL_MS = 60_000
