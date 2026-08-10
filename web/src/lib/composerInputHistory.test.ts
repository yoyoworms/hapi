import { beforeEach, describe, expect, it } from 'vitest'
import { addComposerInputHistory, getComposerInputHistory } from './composerInputHistory'

const STORAGE_KEY = 'hapi:composer-input-history:v2'

describe('composer input history storage', () => {
    beforeEach(() => {
        window.localStorage.removeItem(STORAGE_KEY)
    })

    it('persists isolated, trimmed, adjacent-deduplicated session histories', () => {
        addComposerInputHistory('session-a', '  first prompt  ')
        addComposerInputHistory('session-a', 'first prompt')
        addComposerInputHistory('session-a', 'second prompt')
        addComposerInputHistory('session-b', 'other session')

        expect(getComposerInputHistory('session-a')).toEqual(['first prompt', 'second prompt'])
        expect(getComposerInputHistory('session-b')).toEqual(['other session'])
        expect(getComposerInputHistory(undefined)).toEqual([])
    })

    it('keeps the latest 100 entries and tolerates corrupt storage', () => {
        for (let index = 1; index <= 101; index += 1) {
            addComposerInputHistory('session-a', `prompt ${index}`)
        }

        const history = getComposerInputHistory('session-a')
        expect(history).toHaveLength(100)
        expect(history[0]).toBe('prompt 2')
        expect(history[99]).toBe('prompt 101')

        window.localStorage.setItem(STORAGE_KEY, '{invalid json')
        expect(getComposerInputHistory('session-a')).toEqual([])
    })

    it('bounds global storage with session LRU and rejects giant entries', () => {
        for (let index = 0; index < 25; index += 1) {
            addComposerInputHistory(`session-${index}`, `prompt ${index}`)
        }

        expect(getComposerInputHistory('session-4')).toEqual([])
        expect(getComposerInputHistory('session-5')).toEqual(['prompt 5'])
        expect(getComposerInputHistory('session-24')).toEqual(['prompt 24'])

        addComposerInputHistory('session-24', 'x'.repeat(20_001))
        expect(getComposerInputHistory('session-24')).toEqual(['prompt 24'])
    })

    it('prunes oversized legacy storage before writing a new entry', () => {
        const oversized = Object.fromEntries(
            Array.from({ length: 20 }, (_, sessionIndex) => [
                `legacy-${sessionIndex}`,
                Array.from(
                    { length: 40 },
                    (_, entryIndex) => `${sessionIndex}:${entryIndex}:${'x'.repeat(1_000)}`,
                ),
            ]),
        )
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(oversized))

        addComposerInputHistory('newest-session', 'kept')

        const raw = window.localStorage.getItem(STORAGE_KEY) ?? ''
        expect(raw.length).toBeLessThanOrEqual(500_000)
        expect(getComposerInputHistory('newest-session')).toEqual(['kept'])
    })
})
