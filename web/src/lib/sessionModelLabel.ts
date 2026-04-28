import { getClaudeModelLabel } from '@hapi/protocol'

type SessionModelSource = {
    model?: string | null
}

export type SessionModelLabel = {
    key: 'session.item.model'
    value: string
}

function formatKnownClaudeModel(model: string): string | null {
    const presetLabel = getClaudeModelLabel(model)
    if (presetLabel) return presetLabel

    const normalized = model.trim().toLowerCase()
    const family = normalized.includes('opus') ? 'Opus'
        : normalized.includes('sonnet') ? 'Sonnet'
            : normalized.includes('haiku') ? 'Haiku'
                : null
    if (!family) return null

    const version = normalized.match(/(?:opus|sonnet|haiku)-([0-9]+)-([0-9]+)/)
    const suffix = normalized.includes('[1m]') ? ' 1M' : ''
    return version ? `${family} ${version[1]}.${version[2]}${suffix}` : `${family}${suffix}`
}

export function getSessionModelLabel(session: SessionModelSource): SessionModelLabel | null {
    const explicitModel = typeof session.model === 'string' ? session.model.trim() : ''
    if (explicitModel) {
        return {
            key: 'session.item.model',
            value: formatKnownClaudeModel(explicitModel) ?? explicitModel
        }
    }

    return null
}
