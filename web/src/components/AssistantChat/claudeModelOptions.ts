export type ClaudeComposerModelOption = {
    value: string | null
    label: string
}

function normalizeClaudeComposerModel(model?: string | null): string | null {
    const trimmedModel = model?.trim()
    if (!trimmedModel || trimmedModel === 'auto' || trimmedModel === 'default') return null
    return trimmedModel
}

/**
 * Claude Code owns the model catalog. HAPI only renders the machine-discovered
 * options passed by the caller and keeps the active model visible while a
 * discovery request is pending or unavailable.
 */
export function getClaudeComposerModelOptions(
    currentModel?: string | null,
    availableOptions: ClaudeComposerModelOption[] = []
): ClaudeComposerModelOption[] {
    const normalizedCurrentModel = normalizeClaudeComposerModel(currentModel)
    const options: ClaudeComposerModelOption[] = [{ value: null, label: 'Default' }]
    for (const option of availableOptions) {
        if (option.value == null || option.value === 'auto' || option.value === 'default') continue
        if (options.some((candidate) => candidate.value === option.value)) continue
        options.push(option)
    }
    if (normalizedCurrentModel && !options.some((option) => option.value === normalizedCurrentModel)) {
        options.splice(1, 0, { value: normalizedCurrentModel, label: normalizedCurrentModel })
    }
    return options
}

export function getNextClaudeComposerModel(
    currentModel?: string | null,
    availableOptions: ClaudeComposerModelOption[] = []
): string | null {
    const normalizedCurrentModel = normalizeClaudeComposerModel(currentModel)
    const options = getClaudeComposerModelOptions(normalizedCurrentModel, availableOptions)
    const currentIndex = options.findIndex((option) => option.value === normalizedCurrentModel)
    if (currentIndex === -1) return options[0]?.value ?? null
    return options[(currentIndex + 1) % options.length]?.value ?? null
}
