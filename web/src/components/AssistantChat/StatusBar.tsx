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
    if (duration && pct) return `${duration} ${pct}`
    return duration ?? pct
}

function accountStatusFromClaudeUsage(usage: UsageResponse | null): AgentAccountStatus | null {
    if (!usage) return null
    const toLimit = (entry: { utilization: number; resets_at: string } | null) => {
        if (!entry) return null
        const resetAt = Date.parse(entry.resets_at)
        return {
            resetAt: Number.isFinite(resetAt) ? resetAt : null,
            remainingMs: Number.isFinite(resetAt) ? Math.max(0, resetAt - Date.now()) : null,
            remainingPercent: Math.max(0, Math.min(100, 100 - entry.utilization))
        }
    }
    return {
        provider: 'claude',
        accountLabel: usage.accountLabel ?? usage.subscriptionType ?? null,
        window: toLimit(usage.five_hour),
        weekly: toLimit(usage.seven_day ?? usage.seven_day_sonnet ?? usage.seven_day_opus),
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
    agentState: AgentState | null | undefined
    contextSize?: number
    usage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number } | null
    accountStatus?: AgentAccountStatus | null
    model?: string | null
    permissionMode?: PermissionMode
    collaborationMode?: CodexCollaborationMode
    agentFlavor?: string | null
    voiceStatus?: ConversationStatus
    onModelChange?: (model: string | null) => void
}) {
    const { t } = useTranslation()
    const claudeAccountStatus = useClaudeAccountStatus(props.agentFlavor === 'claude')
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
    const accountStatus = props.agentFlavor === 'claude'
        ? claudeAccountStatus ?? props.accountStatus ?? null
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

            <div className="flex items-center gap-2">
                {accountStatus && (accountStatus.accountLabel || accountLimitText) ? (
                    <span className="max-w-[42vw] truncate text-[10px] text-[var(--app-hint)]" title={accountTitle}>
                        {accountStatus.accountLabel ? `${accountStatus.accountLabel} ` : ''}{accountLimitText}
                    </span>
                ) : null}
                {props.usage ? (
                    <span className="text-[10px] text-[var(--app-hint)]">
                        {formatCost(props.usage.totalCostUsd)}
                    </span>
                ) : null}
                {props.model ? (
                    <span className="text-[10px] text-[var(--app-hint)]">
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
                <span className="text-[10px] text-[var(--app-hint)]">
                    v{__APP_VERSION__}
                </span>
            </div>
        </div>
    )
}
