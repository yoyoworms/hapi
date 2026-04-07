/**
 * Detects image/media files in Write tool calls and uploads them to COS via Hub
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { logger } from '@/lib'
import { configuration } from '@/configuration'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov'])
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, '.pdf'])

const MIME_MAP: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.pdf': 'application/pdf',
}

const MAX_UPLOAD_SIZE = 20 * 1024 * 1024 // 20MB

export function isMediaFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase()
    return MEDIA_EXTENSIONS.has(ext)
}

export function isImageFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase()
    return IMAGE_EXTENSIONS.has(ext)
}

function getMimeType(filePath: string): string {
    const ext = extname(filePath).toLowerCase()
    return MIME_MAP[ext] || 'application/octet-stream'
}

/**
 * Upload a file to COS via Hub's CLI endpoint
 * Returns the public URL or null on failure
 */
export async function uploadFileToCos(
    filePath: string,
    cliApiToken: string
): Promise<string | null> {
    try {
        if (!existsSync(filePath)) {
            logger.debug(`[fileUploader] File not found: ${filePath}`)
            return null
        }

        const stat = statSync(filePath)
        if (stat.size === 0 || stat.size > MAX_UPLOAD_SIZE) {
            logger.debug(`[fileUploader] File too large or empty: ${filePath} (${stat.size} bytes)`)
            return null
        }

        const buffer = readFileSync(filePath)
        const mimeType = getMimeType(filePath)
        const filename = basename(filePath)

        const url = `${configuration.apiUrl}/cli/files/upload`
        logger.debug(`[fileUploader] Uploading ${filename} (${mimeType}, ${buffer.length} bytes) to ${url}`)

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${cliApiToken}`,
                'Content-Type': mimeType,
                'X-Filename': filename,
                'X-Mime-Type': mimeType,
            },
            body: buffer,
        })

        if (!response.ok) {
            const errorText = await response.text()
            logger.debug(`[fileUploader] Upload failed: ${response.status} ${errorText}`)
            return null
        }

        const result = await response.json() as { url?: string }
        if (result.url) {
            logger.info(`[fileUploader] Uploaded ${filename} → ${result.url}`)
            return result.url
        }

        return null
    } catch (error) {
        logger.debug(`[fileUploader] Upload error: ${error}`)
        return null
    }
}

/**
 * Tracks Write/Read tool calls and uploads media files on successful completion
 */
export class FileUploadTracker {
    // Map tool_use_id → file path for tool calls targeting media files
    private pendingFiles = new Map<string, string>()
    private cliApiToken: string

    constructor(cliApiToken: string) {
        this.cliApiToken = cliApiToken
    }

    /**
     * Track assistant messages for Write/Read tool calls with media file paths
     */
    onAssistantMessage(content: any[]): void {
        for (const block of content) {
            if (block.type === 'tool_use' && block.id) {
                const name = block.name
                const input = block.input as any

                // Write tool with file_path
                if ((name === 'Write' || name === 'write') && input?.file_path) {
                    if (isMediaFile(input.file_path)) {
                        this.pendingFiles.set(block.id, input.file_path)
                        logger.debug(`[fileUploader] Tracking Write for media file: ${input.file_path} (${block.id})`)
                    }
                }

                // Read tool with file_path
                if ((name === 'Read' || name === 'read') && input?.file_path) {
                    if (isMediaFile(input.file_path)) {
                        this.pendingFiles.set(block.id, input.file_path)
                        logger.debug(`[fileUploader] Tracking Read for media file: ${input.file_path} (${block.id})`)
                    }
                }
            }
        }
    }

    /**
     * Check tool results and upload media files
     * Returns map of tool_use_id → COS URL for successful uploads
     */
    async onToolResults(content: any[]): Promise<Map<string, string>> {
        const uploads = new Map<string, string>()

        for (const block of content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
                const filePath = this.pendingFiles.get(block.tool_use_id)
                if (filePath && !block.is_error) {
                    this.pendingFiles.delete(block.tool_use_id)
                    const url = await uploadFileToCos(filePath, this.cliApiToken)
                    if (url) {
                        uploads.set(block.tool_use_id, url)
                    }
                } else if (block.is_error) {
                    this.pendingFiles.delete(block.tool_use_id)
                }
            }
        }

        return uploads
    }

    reset(): void {
        this.pendingFiles.clear()
    }
}
