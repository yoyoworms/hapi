/** Labels shared by SessionHeader and composer StatusBar for Codex/OpenCode. */

export function formatCompactCodexReasoningLabel(effort?: string | null): string {
    const normalized = effort?.trim().toLowerCase()
    if (!normalized || normalized === 'default') return 'default'
    return normalized
}

export function formatCodexReasoningLabel(effort?: string | null, showLabel = true): string {
    const value = formatCompactCodexReasoningLabel(effort)
    return showLabel ? `reasoning ${value}` : value
}

export function shouldShowCodexReasoningLabel(agentFlavor: string | null | undefined): boolean {
    return agentFlavor === 'codex' || agentFlavor === 'opencode'
}
