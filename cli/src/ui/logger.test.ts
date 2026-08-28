import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Logger } from './logger'

const originalDebug = process.env.DEBUG
const tempDirs: string[] = []

afterEach(() => {
    if (originalDebug === undefined) delete process.env.DEBUG
    else process.env.DEBUG = originalDebug
    for (const directory of tempDirs.splice(0)) {
        rmSync(directory, { recursive: true, force: true })
    }
})

function createLogger(): { logger: Logger; path: string } {
    const directory = mkdtempSync(join(tmpdir(), 'hapi-logger-test-'))
    tempDirs.push(directory)
    const path = join(directory, 'debug.log')
    return { logger: new Logger(path), path }
}

describe('Logger.debugLargeJson', () => {
    it('does not inspect large objects outside debug mode', () => {
        delete process.env.DEBUG
        const { logger, path } = createLogger()

        logger.debugLargeJson('spawn options', { token: 'sentinel-production-secret', model: 'safe' })

        const contents = readFileSync(path, 'utf8')
        expect(contents).toContain('skipping message inspection')
        expect(contents).not.toContain('sentinel-production-secret')
        expect(contents).not.toContain('safe')
    })

    it('redacts nested sensitive keys in debug mode instead of truncating secrets', () => {
        process.env.DEBUG = '1'
        const { logger, path } = createLogger()

        logger.debugLargeJson('spawn options', {
            token: 'sentinel-token-secret',
            nested: {
                CLI_API_TOKEN: 'sentinel-hub-secret',
                apiKey: 'sentinel-api-secret',
                authorization: 'Bearer sentinel-auth-secret',
                model: 'gpt-safe'
            }
        })

        const contents = readFileSync(path, 'utf8')
        expect(contents).toContain('[REDACTED]')
        expect(contents).toContain('gpt-safe')
        expect(contents).not.toContain('sentinel-')
    })
})

describe('Logger.debug', () => {
    it('serializes errors and circular values without throwing', () => {
        const { logger, path } = createLogger()
        const details: { self?: unknown } = {}
        details.self = details
        const error = new Error('codex model discovery failed', { cause: details })

        expect(() => logger.debug('Codex failure', error, details, 1n)).not.toThrow()

        const contents = readFileSync(path, 'utf8')
        expect(contents).toContain('codex model discovery failed')
        expect(contents).toContain('[Circular]')
        expect(contents).toContain('"1"')
    })
})
