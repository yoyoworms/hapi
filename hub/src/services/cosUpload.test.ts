import { describe, expect, it } from 'bun:test'

import { buildCosObjectKey, sanitizeCosFilename } from './cosUpload'

describe('COS object keys', () => {
    const now = new Date('2026-08-02T12:00:00.000Z')

    it('uses a unique id even when uploads have the same filename', () => {
        const first = buildCosObjectKey(
            { filename: 'screenshot.png', namespace: 'user-1' },
            '11111111-1111-4111-8111-111111111111',
            now
        )
        const second = buildCosObjectKey(
            { filename: 'screenshot.png', namespace: 'user-1' },
            '22222222-2222-4222-8222-222222222222',
            now
        )

        expect(first).not.toBe(second)
        expect(first).toBe('hapi/user-1/20260802/11111111-1111-4111-8111-111111111111-screenshot.png')
        expect(second).toBe('hapi/user-1/20260802/22222222-2222-4222-8222-222222222222-screenshot.png')
    })

    it('uses only a sanitized basename from a client filename', () => {
        expect(sanitizeCosFilename('../folder\\bad name?<.png')).toBe('bad_name_.png')
        expect(buildCosObjectKey(
            { filename: '../folder\\bad name?<.png' },
            '33333333-3333-4333-8333-333333333333',
            now
        )).toBe('hapi/default/20260802/33333333-3333-4333-8333-333333333333-bad_name_.png')
    })

    it('keeps the MIME-derived extension for unnamed uploads', () => {
        expect(buildCosObjectKey(
            { mimeType: 'image/jpeg' },
            '44444444-4444-4444-8444-444444444444',
            now
        )).toBe('hapi/default/20260802/44444444-4444-4444-8444-444444444444-upload.jpg')
    })
})
