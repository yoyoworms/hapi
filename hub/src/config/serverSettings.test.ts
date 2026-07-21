import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadServerSettings } from './serverSettings'

function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'hapi-server-settings-test-'))
}

describe('loadServerSettings', () => {
    let dir: string | null = null
    const originalAutoArchiveIdleHours = process.env.HAPI_AUTO_ARCHIVE_IDLE_HOURS

    afterEach(() => {
        if (dir) {
            rmSync(dir, { recursive: true, force: true })
            dir = null
        }
        if (originalAutoArchiveIdleHours === undefined) {
            delete process.env.HAPI_AUTO_ARCHIVE_IDLE_HOURS
        } else {
            process.env.HAPI_AUTO_ARCHIVE_IDLE_HOURS = originalAutoArchiveIdleHours
        }
    })

    it('rejects old webapp settings fields instead of migrating them', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            webappHost: '0.0.0.0',
            webappPort: 3007,
            webappUrl: 'http://localhost:3007',
        }))

        await expect(loadServerSettings(dir)).rejects.toThrow('Unsupported old settings field')
    })

    it('defaults auto-archive to 48 hours', async () => {
        dir = makeTempDir()
        delete process.env.HAPI_AUTO_ARCHIVE_IDLE_HOURS

        const result = await loadServerSettings(dir)

        expect(result.settings.autoArchiveIdleHours).toBe(48)
        expect(result.sources.autoArchiveIdleHours).toBe('default')
    })

    it('loads and persists the environment auto-archive setting', async () => {
        dir = makeTempDir()
        process.env.HAPI_AUTO_ARCHIVE_IDLE_HOURS = '0'

        const result = await loadServerSettings(dir)
        const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
            autoArchiveIdleHours?: number
        }

        expect(result.settings.autoArchiveIdleHours).toBe(0)
        expect(result.sources.autoArchiveIdleHours).toBe('env')
        expect(saved.autoArchiveIdleHours).toBe(0)
    })

    it('rejects invalid auto-archive settings', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ autoArchiveIdleHours: -1 }))
        delete process.env.HAPI_AUTO_ARCHIVE_IDLE_HOURS

        await expect(loadServerSettings(dir)).rejects.toThrow('autoArchiveIdleHours')
    })

    it('rejects an empty environment auto-archive setting instead of treating it as disabled', async () => {
        dir = makeTempDir()
        process.env.HAPI_AUTO_ARCHIVE_IDLE_HOURS = ''

        await expect(loadServerSettings(dir)).rejects.toThrow('HAPI_AUTO_ARCHIVE_IDLE_HOURS')
    })
})
