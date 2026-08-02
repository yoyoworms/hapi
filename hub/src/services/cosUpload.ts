/**
 * Tencent COS upload service for HAPI Hub
 * Uploads files (images, etc.) to COS and returns public URLs
 */

import COS from 'cos-nodejs-sdk-v5'
import { randomUUID } from 'crypto'

const config = {
    SecretId: process.env.COS_SECRET_ID || '',
    SecretKey: process.env.COS_SECRET_KEY || '',
    Bucket: process.env.COS_BUCKET || 'video-1314491040',
    Region: process.env.COS_REGION || 'ap-guangzhou',
    CdnDomain: process.env.COS_CDN_DOMAIN || 'https://x.rattletrap.cn',
}

let cosClient: COS | null = null

function getClient(): COS {
    if (!cosClient) {
        cosClient = new COS({
            SecretId: config.SecretId,
            SecretKey: config.SecretKey,
        })
    }
    return cosClient
}

export function isCosConfigured(): boolean {
    return !!(config.SecretId && config.SecretKey && config.Bucket)
}

function getPublicUrl(key: string): string {
    if (config.CdnDomain) {
        return `${config.CdnDomain}/${key}`
    }
    return `https://${config.Bucket}.cos.${config.Region}.myqcloud.com/${key}`
}

function getExtFromMimeType(mimeType: string): string {
    const map: Record<string, string> = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/svg+xml': '.svg',
        'image/bmp': '.bmp',
        'video/mp4': '.mp4',
        'video/webm': '.webm',
        'application/pdf': '.pdf',
    }
    return map[mimeType] || ''
}

export function sanitizeCosFilename(filename: string): string {
    const basename = filename.replace(/\\/g, '/').split('/').pop() ?? ''
    const sanitized = basename
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/^\.+/, '')
        .replace(/_+/g, '_')
        .slice(0, 180)

    return sanitized || 'upload'
}

export function buildCosObjectKey(
    options: {
        filename?: string
        mimeType?: string
        namespace?: string
    },
    uniqueId: string = randomUUID(),
    now: Date = new Date()
): string {
    const date = now.toISOString().slice(0, 10).replace(/-/g, '')
    const ext = options.mimeType ? getExtFromMimeType(options.mimeType) : ''
    const basename = options.filename
        ? sanitizeCosFilename(options.filename)
        : `upload${ext}`
    const namespace = options.namespace || 'default'
    return `hapi/${namespace}/${date}/${uniqueId}-${basename}`
}

export interface CosUploadResult {
    success: boolean
    url?: string
    key?: string
    error?: string
}

export async function uploadToCos(
    buffer: Buffer,
    options: {
        filename?: string
        mimeType?: string
        namespace?: string
    } = {}
): Promise<CosUploadResult> {
    if (!isCosConfigured()) {
        return { success: false, error: 'COS not configured' }
    }

    const client = getClient()
    const key = buildCosObjectKey(options)

    try {
        await new Promise<void>((resolve, reject) => {
            client.putObject({
                Bucket: config.Bucket,
                Region: config.Region,
                Key: key,
                Body: buffer,
                ContentType: options.mimeType,
            }, (err) => {
                if (err) reject(err)
                else resolve()
            })
        })

        return {
            success: true,
            url: getPublicUrl(key),
            key,
        }
    } catch (error) {
        console.error('[COS] Upload failed:', error)
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        }
    }
}
