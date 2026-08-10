const INPUT_HISTORY_STORAGE_KEY = 'hapi:composer-input-history:v2'
const MAX_INPUT_HISTORY_ENTRIES = 100
const MAX_INPUT_HISTORY_SESSIONS = 20
const MAX_INPUT_HISTORY_ENTRY_CHARS = 20_000

// localStorage is commonly capped around a few MiB and is shared with more
// important HAPI preferences/caches. Keep this convenience feature well below
// that ceiling (JSON length is a conservative-enough proxy for stored bytes).
const MAX_INPUT_HISTORY_SERIALIZED_CHARS = 500_000

type InputHistoryStore = Record<string, string[]>

/**
 * Keep newest sessions and newest entries first in the retention decision,
 * while preserving oldest -> newest iteration order in the returned store.
 * Object insertion order acts as a small LRU: every add refreshes its key.
 */
function pruneInputHistoryStore(store: InputHistoryStore): InputHistoryStore {
    const sessions = Object.entries(store).slice(-MAX_INPUT_HISTORY_SESSIONS)
    const keptNewestFirst: Array<[string, string[]]> = []
    let remaining = MAX_INPUT_HISTORY_SERIALIZED_CHARS - 2

    for (let sessionIndex = sessions.length - 1; sessionIndex >= 0; sessionIndex -= 1) {
        const [sessionId, rawHistory] = sessions[sessionIndex]!
        const propertyCost = JSON.stringify(sessionId).length
            + 3 // colon + array brackets
            + (keptNewestFirst.length > 0 ? 1 : 0) // property comma
        if (propertyCost >= remaining) break

        const history = rawHistory
            .filter((item): item is string => (
                typeof item === 'string'
                && item.trim().length > 0
                && item.length <= MAX_INPUT_HISTORY_ENTRY_CHARS
            ))
            .slice(-MAX_INPUT_HISTORY_ENTRIES)
        if (history.length === 0) continue

        const keptEntriesNewestFirst: string[] = []
        let sessionRemaining = remaining - propertyCost
        for (let entryIndex = history.length - 1; entryIndex >= 0; entryIndex -= 1) {
            const entry = history[entryIndex]!
            const entryCost = JSON.stringify(entry).length
                + (keptEntriesNewestFirst.length > 0 ? 1 : 0)
            if (entryCost > sessionRemaining) break
            keptEntriesNewestFirst.push(entry)
            sessionRemaining -= entryCost
        }

        // If this session's newest valid entry does not fit, an older session
        // must not displace it merely because its strings happen to be shorter.
        if (keptEntriesNewestFirst.length === 0) break
        keptNewestFirst.push([sessionId, keptEntriesNewestFirst.reverse()])
        remaining = sessionRemaining
    }

    return Object.fromEntries(keptNewestFirst.reverse())
}

function readInputHistoryStore(): InputHistoryStore {
    if (typeof window === 'undefined') return {}
    try {
        const raw = window.localStorage.getItem(INPUT_HISTORY_STORAGE_KEY)
        const parsed: unknown = raw ? JSON.parse(raw) : {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

        const result: InputHistoryStore = {}
        for (const [sessionId, value] of Object.entries(parsed)) {
            if (!Array.isArray(value)) continue
            const history = value
                .filter((item): item is string => (
                    typeof item === 'string'
                    && item.trim().length > 0
                    && item.length <= MAX_INPUT_HISTORY_ENTRY_CHARS
                ))
                .slice(-MAX_INPUT_HISTORY_ENTRIES)
            if (history.length > 0) result[sessionId] = history
        }
        return pruneInputHistoryStore(result)
    } catch {
        return {}
    }
}

function writeInputHistoryStore(store: InputHistoryStore): void {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(
            INPUT_HISTORY_STORAGE_KEY,
            JSON.stringify(pruneInputHistoryStore(store)),
        )
    } catch {
        // History is a convenience. If the origin is already near quota, free
        // its allocation rather than pinning a stale value and starving drafts.
        try {
            window.localStorage.removeItem(INPUT_HISTORY_STORAGE_KEY)
        } catch {
            // Storage can be unavailable (private / locked-down mode).
        }
    }
}

export function getComposerInputHistory(sessionId: string | undefined): string[] {
    if (!sessionId) return []
    return readInputHistoryStore()[sessionId] ?? []
}

export function addComposerInputHistory(sessionId: string | undefined, text: string): void {
    if (!sessionId) return
    const entry = text.trim()
    if (!entry || entry.length > MAX_INPUT_HISTORY_ENTRY_CHARS) return

    const store = readInputHistoryStore()
    const history = store[sessionId] ?? []
    if (history[history.length - 1] === entry) return

    history.push(entry)
    delete store[sessionId]
    store[sessionId] = history.slice(-MAX_INPUT_HISTORY_ENTRIES)
    writeInputHistoryStore(store)
}
