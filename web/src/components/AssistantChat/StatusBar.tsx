import {
    getCodexCollaborationModeLabel,
    getPermissionModeLabel,
    getPermissionModeTone,
    isPermissionModeAllowedForFlavor
} from '@hapi/protocol'
import type { PermissionModeTone } from '@hapi/protocol'
import { useEffect, useMemo, useState } from 'react'
import type { AgentAccountStatus, AgentState, CodexCollaborationMode, PermissionMode, UsageResponse } from '@/types/api'
import type { ConversationStatus } from '@/realtime/types'
import { getContextBudgetTokens } from '@/chat/modelConfig'
import { getClaudeModelLabel } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import type { LatestUsage } from '@/chat/reducer'

// Vibing messages for thinking state
const VIBING_MESSAGES = [
    "Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing",
    "Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing",
    "Cogitating", "Computing", "Combobulating", "Concocting", "Conjuring", "Considering",
    "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering",
    "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting",
    "Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting",
    "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching",
    "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring",
    "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering",
    "Musing", "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating",
    "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating",
    "Scheming", "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking",
    "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering",
    "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring",
    "Wibbling", "Wizarding", "Working", "Wrangling"
]

const PERMISSION_TONE_CLASSES: Record<PermissionModeTone, string> = {
    neutral: 'text-[var(--app-hint)]',
    info: 'text-blue-500',
    warning: 'text-amber-500',
    danger: 'text-red-500'
}

function getConnectionStatus(
    active: boolean,
    thinking: boolean,
    agentState: AgentState | null | undefined,
    voiceStatus: ConversationStatus | undefined,
    t: (key: string) => string
): { text: string; color: string; dotColor: string; isPulsing: boolean } {
    const hasPermissions = agentState?.requests && Object.keys(agentState.requests).length > 0

    // Voice connecting takes priority
    if (voiceStatus === 'connecting') {
        return {
            text: t('voice.connecting'),
            color: 'text-[#007AFF]',
            dotColor: 'bg-[#007AFF]',
            isPulsing: true
        }
    }

    if (!active) {
        return {
            text: t('misc.offline'),
            color: 'text-[#999]',
            dotColor: 'bg-[#999]',
            isPulsing: false
        }
    }

    if (hasPermissions) {
        return {
            text: t('misc.permissionRequired'),
            color: 'text-[#FF9500]',
            dotColor: 'bg-[#FF9500]',
            isPulsing: true
        }
    }

    if (thinking) {
        const vibingMessage = VIBING_MESSAGES[Math.floor(Math.random() * VIBING_MESSAGES.length)].toLowerCase() + '…'
        return {
            text: vibingMessage,
            color: 'text-[#007AFF]',
            dotColor: 'bg-[#007AFF]',
            isPulsing: true
        }
    }

    return {
        text: t('misc.online'),
        color: 'text-[#34C759]',
        dotColor: 'bg-[#34C759]',
        isPulsing: false
    }
}

function getContextWarning(contextSize: number, maxContextSize: number, t: (key: string, params?: Record<string, string | number>) => string): { text: string; color: string } | null {
    const percentageUsed = (contextSize / maxContextSize) * 100
    const percentageRemaining = Math.max(0, 100 - percentageUsed)

    const percent = Math.round(percentageRemaining)
    if (percentageRemaining <= 5) {
        return { text: t('misc.percentLeft', { percent }), color: 'text-red-500' }
    } else if (percentageRemaining <= 10) {
        return { text: t('misc.percentLeft', { percent }), color: 'text-amber-500' }
    } else {
        return { text: t('misc.percentLeft', { percent }), color: 'text-[var(--app-hint)]' }
    }
}

function formatTokenCount(tokens: number): string {
    if (tokens >= 1_000_000) {
        return `${(tokens / 1_000_000).toFixed(1)}M`
    }
    if (tokens >= 1_000) {
        return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}K`
    }
    return String(tokens)
}

function formatCost(cost: number): string {
    if (cost > 0 && cost < 0.01) return `$${cost.toFixed(3)}`
    return `$${cost.toFixed(2)}`
}

function formatDuration(ms: number | null | undefined): string | null {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return null
    const hours = Math.max(0, Math.floor(ms / 3_600_000))
    if (hours >= 24) {
        const days = Math.floor(hours / 24)
        const remainingHours = hours % 24
        return remainingHours > 0 ? `${days}d${remainingHours}h` : `${days}d`
    }
    if (hours > 0) return `${hours}h`
    const minutes = Math.max(0, Math.floor(ms / 60_000))
    return `${minutes}m`
}

function formatReset(resetAt: number | null | undefined): string | null {
    if (!resetAt) return null
    return new Date(resetAt).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    })
}

function formatLimit(limit: AgentAccountStatus['window']): string | null {
    if (!limit) return null
    const duration = formatDuration(limit.remainingMs ?? (limit.resetAt ? limit.resetAt - Date.now() : null))
    const pct = typeof limit.remainingPercent === 'number' && Number.isFinite(limit.remainingPercent)
        ? `${Math.round(Math.max(0, Math.min(100, limit.remainingPercent)))}%`
        : null
    return duration && pct ? `${duration} ${pct}` : duration ?? pct
}

function formatUsageText(
    usage: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number } | null | undefined,
    latestUsage: LatestUsage | null | undefined
): { text: string; title: string } | null {
    if (usage) {
        const totalTokens = usage.totalInputTokens + usage.totalOutputTokens
        return {
            text: `${formatCost(usage.totalCostUsd)} · ${formatTokenCount(totalTokens)} tok`,
            title: [
                `Cost: ${formatCost(usage.totalCostUsd)}`,
                `Input tokens: ${usage.totalInputTokens.toLocaleString()}`,
                `Output tokens: ${usage.totalOutputTokens.toLocaleString()}`,
                `Total tokens: ${totalTokens.toLocaleString()}`
            ].join('\n')
        }
    }

    if (!latestUsage) return null
    const inputTokens = latestUsage.inputTokens + latestUsage.cacheCreation + latestUsage.cacheRead
    const outputTokens = latestUsage.outputTokens
    const totalTokens = inputTokens + outputTokens
    if (totalTokens <= 0 && latestUsage.contextSize <= 0) return null

    return {
        text: `ctx ${formatTokenCount(latestUsage.contextSize)} · ${formatTokenCount(totalTokens)} tok`,
        title: [
            'Latest Claude Code usage from transcript',
            `Context tokens: ${latestUsage.contextSize.toLocaleString()}`,
            `Input tokens: ${latestUsage.inputTokens.toLocaleString()}`,
            `Cache creation: ${latestUsage.cacheCreation.toLocaleString()}`,
            `Cache read: ${latestUsage.cacheRead.toLocaleString()}`,
            `Output tokens: ${latestUsage.outputTokens.toLocaleString()}`
        ].join('\n')
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

function parseResetAt(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value
    if (typeof value === 'string' && value.trim()) {
        const asTimestamp = Number(value)
        if (Number.isFinite(asTimestamp)) return asTimestamp < 10_000_000_000 ? asTimestamp * 1000 : asTimestamp
        const parsed = Date.parse(value)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

function getLimitEntry(root: Record<string, unknown>, ...keys: string[]): AgentAccountStatus['window'] {
    for (const key of keys) {
        const entry = asRecord(root[key])
        if (!entry) continue
        const used = asNumber(
            entry.utilization
            ?? entry.used_percentage
            ?? entry.usedPercentage
            ?? entry.percent_used
            ?? entry.percentUsed
        )
        if (used === null) continue
        const usedPercent = Math.max(0, Math.min(100, used <= 1 ? used * 100 : used))
        const resetAt = parseResetAt(entry.resets_at ?? entry.resetsAt ?? entry.reset_at ?? entry.resetAt)
        return {
            resetAt,
            remainingMs: resetAt ? Math.max(0, resetAt - Date.now()) : null,
            remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent))
        }
    }
    return null
}

function accountStatusFromClaudeUsage(usage: UsageResponse | null): AgentAccountStatus | null {
    const root = asRecord(usage)
    if (!root) return null
    const rateLimits = asRecord(root.rate_limits ?? root.rateLimits) ?? root
    const window = getLimitEntry(rateLimits, 'five_hour', 'fiveHour')
    const weekly = getLimitEntry(rateLimits, 'seven_day', 'sevenDay', 'seven_day_sonnet', 'sevenDaySonnet', 'seven_day_opus', 'sevenDayOpus')
    if (!window && !weekly) return null
    return {
        provider: 'claude',
        accountLabel: usage?.accountLabel ?? usage?.subscriptionType ?? null,
        window,
        weekly,
        updatedAt: Date.now()
    }
}

function useClaudeAccountStatus(enabled: boolean): AgentAccountStatus | null {
    const { api } = useAppContext()
    const [status, setStatus] = useState<AgentAccountStatus | null>(null)

    useEffect(() => {
        if (!enabled || !api) {
            setStatus(null)
            return
        }

        let cancelled = false
        const load = async () => {
            try {
                const usage = await api.getUsage()
                if (!cancelled) setStatus(accountStatusFromClaudeUsage(usage))
            } catch {
                if (!cancelled) setStatus(null)
            }
        }

        void load()
        const timer = window.setInterval(load, 120_000)
        return () => {
            cancelled = true
            window.clearInterval(timer)
        }
    }, [api, enabled])

    return status
}

export function StatusBar(props: {
    active: boolean
    thinking: boolean
    sessionId?: string
    agentState: AgentState | null | undefined
    contextSize?: number
    usage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number } | null
    latestUsage?: LatestUsage | null
    accountStatus?: AgentAccountStatus | null
    model?: string | null
    permissionMode?: PermissionMode
    collaborationMode?: CodexCollaborationMode
    agentFlavor?: string | null
    voiceStatus?: ConversationStatus
    onModelChange?: (model: string | null) => void
}) {
    const { t } = useTranslation()
    const isClaudeFlavor = props.agentFlavor === 'claude' || props.agentFlavor === null
    const claudeAccountStatus = useClaudeAccountStatus(isClaudeFlavor)
    const connectionStatus = useMemo(
        () => getConnectionStatus(props.active, props.thinking, props.agentState, props.voiceStatus, t),
        [props.active, props.thinking, props.agentState, props.voiceStatus, t]
    )

    const contextWarning = useMemo(
        () => {
            if (props.contextSize === undefined) return null
            const maxContextSize = getContextBudgetTokens(props.model, props.agentFlavor)
            if (!maxContextSize) return null
            return getContextWarning(props.contextSize, maxContextSize, t)
        },
        [props.contextSize, props.model, props.agentFlavor, t]
    )

    const permissionMode = props.permissionMode
    const displayPermissionMode = permissionMode
        && permissionMode !== 'default'
        && isPermissionModeAllowedForFlavor(permissionMode, props.agentFlavor)
        ? permissionMode
        : null

    const permissionModeLabel = displayPermissionMode ? getPermissionModeLabel(displayPermissionMode) : null
    const permissionModeTone = displayPermissionMode ? getPermissionModeTone(displayPermissionMode) : null
    const permissionModeColor = permissionModeTone ? PERMISSION_TONE_CLASSES[permissionModeTone] : 'text-[var(--app-hint)]'
    const displayCollaborationMode = props.agentFlavor === 'codex' && props.collaborationMode === 'plan'
        ? props.collaborationMode
        : null
    const collaborationModeLabel = displayCollaborationMode
        ? getCodexCollaborationModeLabel(displayCollaborationMode)
        : null
    const accountStatus = isClaudeFlavor
        ? props.accountStatus ?? claudeAccountStatus ?? null
        : props.accountStatus ?? null
    const accountLimitText = accountStatus
        ? [formatLimit(accountStatus.window), formatLimit(accountStatus.weekly)].filter(Boolean).join(' · ')
        : ''
    const accountTitle = accountStatus
        ? [
            accountStatus.accountLabel ? `Account: ${accountStatus.accountLabel}` : null,
            accountStatus.window?.resetAt ? `Window reset: ${formatReset(accountStatus.window.resetAt)}` : null,
            accountStatus.weekly?.resetAt ? `Weekly reset: ${formatReset(accountStatus.weekly.resetAt)}` : null
        ].filter(Boolean).join('\n')
        : undefined
    const usageText = formatUsageText(props.usage, props.latestUsage)

    return (
        <div className="flex items-center justify-between px-2 pb-1">
            <div className="flex items-baseline gap-3">
                <div className="flex items-center gap-1.5">
                    <span
                        className={`h-2 w-2 rounded-full ${connectionStatus.dotColor} ${connectionStatus.isPulsing ? 'animate-pulse' : ''}`}
                    />
                    <span className={`text-xs ${connectionStatus.color}`}>
                        {connectionStatus.text}
                    </span>
                </div>
                {contextWarning ? (
                    <span className={`text-[10px] ${contextWarning.color}`}>
                        {contextWarning.text}
                    </span>
                ) : null}
            </div>

            <div className="flex min-w-0 items-center justify-end gap-2">
                {accountStatus && (accountStatus.accountLabel || accountLimitText) ? (
                    <span className="min-w-0 max-w-[46vw] truncate text-[10px] font-medium text-[var(--app-fg)]" title={accountTitle}>
                        {accountStatus.accountLabel ? `${accountStatus.accountLabel} ` : ''}{accountLimitText}
                    </span>
                ) : null}
                {usageText ? (
                    <span className="shrink-0 text-[10px] text-[var(--app-hint)]" title={usageText.title}>
                        {usageText.text}
                    </span>
                ) : null}
                {props.model ? (
                    <span className="hidden text-[10px] text-[var(--app-hint)] md:inline">
                        {getClaudeModelLabel(props.model)}
                    </span>
                ) : null}
                {collaborationModeLabel ? (
                    <span className="text-xs text-blue-500">
                        {collaborationModeLabel}
                    </span>
                ) : null}
                {displayPermissionMode ? (
                    <span className={`text-xs ${permissionModeColor}`}>
                        {permissionModeLabel}
                    </span>
                ) : null}
                <span className="hidden text-[10px] text-[var(--app-hint)] sm:inline">
                    v{__APP_VERSION__}
                </span>
            </div>
        </div>
    )
}
