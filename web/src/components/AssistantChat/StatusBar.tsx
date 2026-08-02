import {
    getClaudeModelLabel,
    getCodexCollaborationModeLabel,
    getPermissionModeLabel,
    getPermissionModeTone,
    isPermissionModeAllowedForFlavor
} from '@hapi/protocol'
import type { PermissionModeTone } from '@hapi/protocol'
import * as Popover from '@radix-ui/react-popover'
import { useMemo } from 'react'
import type { AgentAccountStatus, AgentState, CodexCollaborationMode, PermissionMode } from '@/types/api'
import type { ConversationStatus } from '@/realtime/types'
import type { ThreadGoal } from '@/types/api'
import { getContextBudgetTokens } from '@/chat/modelConfig'
import {
    formatCodexReasoningLabel,
    formatCompactCodexReasoningLabel,
    shouldShowCodexReasoningLabel
} from '@/lib/codexStatusLabels'
import { isFastServiceTier } from './codexFastMode'
import { useTranslation } from '@/lib/use-translation'
import { useSessionHeaderMetadata } from '@/hooks/useSessionHeaderMetadata'
import type { PlanProgress } from '@/chat/planProgress'
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
    backgroundTaskCount: number,
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

    if (backgroundTaskCount > 0) {
        return {
            text: `${backgroundTaskCount} background task${backgroundTaskCount > 1 ? 's' : ''} running`,
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

function getContextWarning(contextSize: number, maxContextSize: number): { color: string } | null {
    const percentageUsed = (contextSize / maxContextSize) * 100
    const percentageRemaining = Math.max(0, 100 - percentageUsed)

    if (percentageRemaining <= 5) {
        return { color: 'text-red-500' }
    } else if (percentageRemaining <= 10) {
        return { color: 'text-amber-500' }
    } else {
        return { color: 'text-[var(--app-hint)]' }
    }
}

function formatTokenCount(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${Math.round(value / 1_000)}k`
    return String(value)
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

export function formatAccountLimit(limit: AgentAccountStatus['window']): string | null {
    if (!limit) return null
    const duration = formatDuration(limit.remainingMs ?? (limit.resetAt ? limit.resetAt - Date.now() : null))
    const percentage = typeof limit.remainingPercent === 'number' && Number.isFinite(limit.remainingPercent)
        ? `${Math.round(Math.max(0, Math.min(100, limit.remainingPercent)))}%`
        : null
    // Keep the compact status focused on quota. Exact reset time remains in
    // the title; the duration is only a fallback for providers without a
    // percentage so mobile does not show duplicated labels such as
    // "7d 5d20h 83%".
    return percentage ?? duration
}

export function formatUsageText(
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
            'Latest agent usage from transcript',
            `Context tokens: ${latestUsage.contextSize.toLocaleString()}`,
            `Input tokens: ${latestUsage.inputTokens.toLocaleString()}`,
            `Cache creation: ${latestUsage.cacheCreation.toLocaleString()}`,
            `Cache read: ${latestUsage.cacheRead.toLocaleString()}`,
            `Output tokens: ${latestUsage.outputTokens.toLocaleString()}`
        ].join('\n')
    }
}

function getContextPercentages(contextSize: number, maxContextSize: number): {
    usedPercentage: number
    remainingPercentage: number
} {
    const usedPercentage = Math.min(100, Math.max(0, Math.round((contextSize / maxContextSize) * 100)))
    return { usedPercentage, remainingPercentage: 100 - usedPercentage }
}

export function formatContextUsageLabel(contextSize: number, maxContextSize: number | null | undefined): string {
    if (!maxContextSize) return `${formatTokenCount(contextSize)} used`
    const { usedPercentage } = getContextPercentages(contextSize, maxContextSize)
    return `${usedPercentage}% · ${formatTokenCount(contextSize)} / ${formatTokenCount(maxContextSize)}`
}

export function formatCompactContextUsageLabel(contextSize: number, maxContextSize: number | null | undefined): string {
    if (!maxContextSize) return `ctx ${formatTokenCount(contextSize)}`
    const { remainingPercentage } = getContextPercentages(contextSize, maxContextSize)
    return `ctx ${formatTokenCount(maxContextSize)} (${remainingPercentage}% left)`
}

export function getContextUsageDetails(
    contextSize: number,
    maxContextSize: number | null | undefined,
    contextCacheRead: number | null | undefined
): {
    cacheRead: string | null
    used: string
    usedPercentage: number | null
    remaining: string | null
    remainingPercentage: number | null
} {
    if (!maxContextSize) {
        return {
            cacheRead: contextCacheRead && contextCacheRead > 0 ? formatTokenCount(contextCacheRead) : null,
            used: formatTokenCount(contextSize),
            usedPercentage: null,
            remaining: null,
            remainingPercentage: null
        }
    }

    const { usedPercentage, remainingPercentage } = getContextPercentages(contextSize, maxContextSize)
    return {
        cacheRead: contextCacheRead && contextCacheRead > 0 ? formatTokenCount(contextCacheRead) : null,
        used: formatTokenCount(contextSize),
        usedPercentage,
        remaining: formatTokenCount(Math.max(0, maxContextSize - contextSize)),
        remainingPercentage
    }
}

export function shouldShowCodexFastBadge(
    agentFlavor: string | null | undefined,
    serviceTier: string | null | undefined
): boolean {
    return agentFlavor === 'codex' && isFastServiceTier(serviceTier)
}

export function getVisibleCodexPlanProgress(
    agentFlavor: string | null | undefined,
    progress: PlanProgress | null | undefined,
    thinking: boolean
): PlanProgress | null {
    if (agentFlavor !== 'codex' || !progress || !thinking) return null
    return progress
}

export function StatusBar(props: {
    active: boolean
    thinking: boolean
    agentState: AgentState | null | undefined
    backgroundTaskCount?: number
    contextSize?: number
    latestUsage?: LatestUsage | null
    usage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number } | null
    accountStatus?: AgentAccountStatus | null
    contextCacheRead?: number
    contextWindow?: number | null
    /**
     * Model to use for the context-window fallback heuristic when
     * contextWindow is absent. Falls back to `model`. Callers pass the
     * usage-bearing message's own model here so local Claude sessions (whose
     * session.model is often null) still resolve a plausible window.
     */
    contextModel?: string | null
    model?: string | null
    modelReasoningEffort?: string | null
    serviceTier?: string | null
    permissionMode?: PermissionMode
    collaborationMode?: CodexCollaborationMode
    threadGoal?: ThreadGoal | null
    planProgress?: PlanProgress | null
    agentFlavor?: string | null
    voiceStatus?: ConversationStatus
}) {
    const { t } = useTranslation()
    const { preferences: headerMetadata } = useSessionHeaderMetadata()
    const connectionStatus = useMemo(
        () => getConnectionStatus(props.active, props.thinking, props.agentState, props.voiceStatus, props.backgroundTaskCount ?? 0, t),
        [props.active, props.thinking, props.agentState, props.voiceStatus, props.backgroundTaskCount, t]
    )

    const contextHeuristicModel = props.contextModel ?? props.model
    const contextWarning = useMemo(
        () => {
            if (props.contextSize === undefined) return null
            const maxContextSize = props.contextWindow ?? getContextBudgetTokens(contextHeuristicModel, props.agentFlavor)
            if (!maxContextSize) return null
            return getContextWarning(props.contextSize, maxContextSize)
        },
        [props.contextSize, props.contextWindow, contextHeuristicModel, props.agentFlavor]
    )
    const contextUsageLabel = useMemo(() => {
        if (props.contextSize === undefined) return null
        const maxContextSize = props.contextWindow ?? getContextBudgetTokens(contextHeuristicModel, props.agentFlavor)
        return formatContextUsageLabel(props.contextSize, maxContextSize)
    }, [props.contextSize, props.contextWindow, contextHeuristicModel, props.agentFlavor])
    const compactContextUsageLabel = useMemo(() => {
        if (props.contextSize === undefined) return null
        const maxContextSize = props.contextWindow ?? getContextBudgetTokens(contextHeuristicModel, props.agentFlavor)
        return formatCompactContextUsageLabel(props.contextSize, maxContextSize)
    }, [props.contextSize, props.contextWindow, contextHeuristicModel, props.agentFlavor])
    const contextUsageDetails = useMemo(() => {
        if (props.contextSize === undefined) return null
        const maxContextSize = props.contextWindow ?? getContextBudgetTokens(contextHeuristicModel, props.agentFlavor)
        return getContextUsageDetails(props.contextSize, maxContextSize, props.contextCacheRead)
    }, [props.contextSize, props.contextCacheRead, props.contextWindow, contextHeuristicModel, props.agentFlavor])
    const contextUsedPercentage = contextUsageDetails?.usedPercentage ?? null

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
    const accountStatus = props.accountStatus ?? null
    const accountWindowText = accountStatus ? formatAccountLimit(accountStatus.window) : null
    const accountWeeklyText = accountStatus ? formatAccountLimit(accountStatus.weekly) : null
    const accountLimitText = accountStatus
        ? [
            accountWindowText ? t('status.accountWindow', { value: accountWindowText }) : null,
            accountWeeklyText ? t('status.accountWeekly', { value: accountWeeklyText }) : null
        ]
            .filter(Boolean)
            .join(' · ')
        : ''
    const accountTitle = accountStatus
        ? [
            accountStatus.accountLabel ? `Account: ${accountStatus.accountLabel}` : null,
            accountStatus.window?.resetAt ? `Window reset: ${formatReset(accountStatus.window.resetAt)}` : null,
            accountStatus.weekly?.resetAt ? `Weekly reset: ${formatReset(accountStatus.weekly.resetAt)}` : null
        ].filter(Boolean).join('\n')
        : undefined
    const usageText = formatUsageText(props.usage, props.latestUsage)
    const displaysCodexReasoning = shouldShowCodexReasoningLabel(props.agentFlavor)
    const codexReasoningLabel = displaysCodexReasoning
        ? formatCodexReasoningLabel(props.modelReasoningEffort, headerMetadata.showLabels)
        : null
    const compactCodexReasoningLabel = displaysCodexReasoning
        ? formatCompactCodexReasoningLabel(props.modelReasoningEffort)
        : null
    const codexFastMode = shouldShowCodexFastBadge(props.agentFlavor, props.serviceTier)
    const goalLabel = props.agentFlavor === 'codex' && props.threadGoal
        ? props.threadGoal.status === 'active'
            ? 'goal'
            : `goal ${props.threadGoal.status === 'budgetLimited' ? 'limited' : props.threadGoal.status}`
        : null
    const planProgress = getVisibleCodexPlanProgress(
        props.agentFlavor,
        props.planProgress,
        props.thinking
    )

    return (
        <div className="flex min-w-0 items-baseline justify-between gap-2 px-2 pb-1">
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <div className="relative top-px sm:top-0.5 flex shrink-0 items-center gap-1.5">
                    <span
                        className={`h-2 w-2 rounded-full ${connectionStatus.dotColor} ${connectionStatus.isPulsing ? 'animate-pulse' : ''}`}
                    />
                    <span className={`whitespace-nowrap text-xs ${connectionStatus.color}`}>
                        {connectionStatus.text}
                    </span>
                </div>
                {planProgress ? (
                    <span
                        data-testid="codex-plan-progress"
                        className="min-w-0 flex-1 truncate text-[10px] text-[var(--app-link)] sm:max-w-[48vw] sm:flex-none"
                        title={planProgress.explanation ?? planProgress.currentStep ?? undefined}
                    >
                        {t('status.planProgress', {
                            completed: planProgress.completed,
                            total: planProgress.total
                        })}
                        {planProgress.currentStep ? ` · ${planProgress.currentStep}` : null}
                    </span>
                ) : null}
                {contextUsageLabel ? (
                    <Popover.Root>
                        <Popover.Trigger asChild>
                            <button
                                type="button"
                                aria-label={t('misc.contextDetails')}
                                className={`${planProgress ? 'hidden sm:inline-flex' : ''} min-w-0 cursor-pointer whitespace-nowrap rounded-sm bg-transparent p-0 text-[10px] leading-4 outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-link)] ${contextWarning?.color ?? 'text-[var(--app-hint)]'}`}
                            >
                                <span className="sm:hidden">{compactContextUsageLabel}</span>
                                <span className="hidden items-center gap-2 sm:inline-flex">
                                    {contextUsedPercentage !== null ? (
                                        <span
                                            aria-hidden="true"
                                            className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-[var(--app-link-muted)]"
                                        >
                                            <span
                                                className="block h-full rounded-full bg-current"
                                                style={{ width: `${contextUsedPercentage}%` }}
                                            />
                                        </span>
                                    ) : null}
                                    <span>{contextUsageLabel}</span>
                                </span>
                            </button>
                        </Popover.Trigger>
                        <Popover.Portal>
                            <Popover.Content
                                side="top"
                                align="start"
                                sideOffset={6}
                                collisionPadding={8}
                                className="z-50 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-lg"
                            >
                                <div className="flex max-w-[min(22rem,calc(100vw-1rem))] flex-col gap-1 text-xs leading-tight text-[var(--app-fg)]">
                                    {contextUsageDetails?.cacheRead ? (
                                        <span className="break-words">
                                            {t('misc.contextCache', { value: contextUsageDetails.cacheRead })}
                                        </span>
                                    ) : null}
                                    <span className="break-words">
                                        {contextUsageDetails?.usedPercentage === null
                                            ? t('misc.contextUsedTokens', { value: contextUsageDetails.used })
                                            : t('misc.contextUsed', {
                                                value: contextUsageDetails?.used ?? '',
                                                percent: contextUsageDetails?.usedPercentage ?? 0
                                            })}
                                    </span>
                                    {contextUsageDetails?.remaining && contextUsageDetails.remainingPercentage !== null ? (
                                        <span className="break-words">
                                            {t('misc.contextRemaining', {
                                                value: contextUsageDetails.remaining,
                                                percent: contextUsageDetails.remainingPercentage
                                            })}
                                        </span>
                                    ) : null}
                                </div>
                            </Popover.Content>
                        </Popover.Portal>
                    </Popover.Root>
                ) : null}
            </div>

            <div className="flex min-w-0 shrink-0 items-baseline gap-2">
                {accountStatus && (accountStatus.accountLabel || accountLimitText) ? (
                    <span
                        data-testid="account-usage-status"
                        className={`${planProgress ? 'hidden sm:inline-flex' : 'inline-flex'} min-w-0 items-baseline text-[10px] font-medium text-[var(--app-fg)]`}
                        title={accountTitle}
                    >
                        {accountStatus.accountLabel ? (
                            <span className={`${accountLimitText ? 'hidden sm:inline' : 'inline'} max-w-[24vw] truncate`}>
                                {accountStatus.accountLabel}{accountLimitText ? '\u00a0' : ''}
                            </span>
                        ) : null}
                        {accountLimitText ? <span className="shrink-0 whitespace-nowrap">{accountLimitText}</span> : null}
                    </span>
                ) : null}
                {usageText ? (
                    <span
                        data-testid="session-usage-status"
                        className="hidden shrink-0 text-[10px] text-[var(--app-hint)] sm:inline"
                        title={usageText.title}
                    >
                        {usageText.text}
                    </span>
                ) : null}
                {codexReasoningLabel ? (
                    <span className={`${planProgress ? 'hidden sm:inline' : ''} whitespace-nowrap text-xs text-[var(--app-hint)]`}>
                        <span className="sm:hidden">{compactCodexReasoningLabel}</span>
                        <span className="hidden sm:inline">{codexReasoningLabel}</span>
                    </span>
                ) : null}
                {codexFastMode ? (
                    <span className={`${planProgress ? 'hidden sm:inline' : ''} whitespace-nowrap text-xs text-[#34C759]`}>
                        fast
                    </span>
                ) : null}
                {goalLabel ? (
                    <span className={`${planProgress ? 'hidden sm:inline' : ''} whitespace-nowrap text-xs text-[var(--app-link)]`}>
                        {goalLabel}
                    </span>
                ) : null}
                {props.model ? (
                    <span className="hidden text-[10px] text-[var(--app-hint)] md:inline">
                        {getClaudeModelLabel(props.model) ?? props.model}
                    </span>
                ) : null}
                {collaborationModeLabel ? (
                    <span className="whitespace-nowrap text-xs text-blue-500">
                        {collaborationModeLabel}
                    </span>
                ) : null}
                {displayPermissionMode ? (
                    <span className={`whitespace-nowrap text-xs ${permissionModeColor}`}>
                        {permissionModeLabel}
                    </span>
                ) : null}
            </div>
        </div>
    )
}
