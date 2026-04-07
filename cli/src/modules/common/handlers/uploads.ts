import { logger } from '@/ui/logger'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { getErrorMessage, rpcError } from '../rpcResponses'
import { getHapiBlobsDir } from '@/constants/uploadPaths'

interface UploadFileRequest {
    sessionId?: string
    filename: string
    content: string  // base64 encoded
    mimeType: string
}

interface UploadFileResponse {
    success: boolean
    path?: string
    error?: string
}

interface DeleteUploadRequest {
    sessionId?: string
    path: string
}

interface DeleteUploadResponse {
    success: boolean
    error?: string
}

const uploadDirs = new Map<string, string>()
const uploadDirPromises = new Map<string, Promise<string>>()
const uploadDirCleanupRequested = new Set<string>()
let cleanupRegistered = false
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 2000

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff', 'image/bmp'])

/**
 * Resize image if any dimension exceeds MAX_IMAGE_DIMENSION (2000px).
 * Uses macOS `sips` (no external deps). Returns the (possibly modified) file path.
 */
function resizeImageIfNeeded(filePath: string, mimeType: string): void {
    if (!IMAGE_MIME_TYPES.has(mimeType)) return
    try {
        const info = execSync(`sips -g pixelWidth -g pixelHeight "${filePath}" 2>/dev/null`, { encoding: 'utf-8' })
        const wMatch = info.match(/pixelWidth:\s*(\d+)/)
        const hMatch = info.match(/pixelHeight:\s*(\d+)/)
        if (!wMatch || !hMatch) return
        const w = parseInt(wMatch[1], 10)
        const h = parseInt(hMatch[1], 10)
        if (w <= MAX_IMAGE_DIMENSION && h <= MAX_IMAGE_DIMENSION) return
        // Resize longest edge to MAX_IMAGE_DIMENSION, maintaining aspect ratio
        if (w >= h) {
            execSync(`sips --resampleWidth ${MAX_IMAGE_DIMENSION} "${filePath}" 2>/dev/null`)
        } else {
            execSync(`sips --resampleHeight ${MAX_IMAGE_DIMENSION} "${filePath}" 2>/dev/null`)
        }
        logger.debug(`[upload] Resized image from ${w}x${h} to fit ${MAX_IMAGE_DIMENSION}px: ${filePath}`)
    } catch (error) {
        logger.debug('[upload] Image resize failed (non-fatal):', error)
    }
}

function sanitizeFilename(filename: string): string {
    // Remove path separators and limit length
    const sanitized = filename
        .replace(/[/\\]/g, '_')
        .replace(/\.\./g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 255)

    // If filename is empty after sanitization, use a default
    return sanitized || 'upload'
}

function getSessionKey(sessionId?: string): string {
    const trimmed = sessionId?.trim()
    return trimmed ? trimmed : 'unknown'
}

function estimateBase64Bytes(base64: string): number {
    const len = base64.length
    if (len === 0) return 0
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    return Math.floor((len * 3) / 4) - padding
}

async function getOrCreateUploadDir(sessionId?: string): Promise<string> {
    const sessionKey = getSessionKey(sessionId)
    const existing = uploadDirs.get(sessionKey)
    if (existing) {
        return existing
    }

    const inflight = uploadDirPromises.get(sessionKey)
    if (inflight) {
        return await inflight
    }

    const safeKey = sanitizeFilename(sessionKey)
    const creation = (async () => {
        try {
            const blobsDir = getHapiBlobsDir()
            await mkdir(blobsDir, { recursive: true })
            const dir = await mkdtemp(join(blobsDir, `${safeKey}-`))
            if (uploadDirCleanupRequested.has(sessionKey)) {
                try {
                    await rm(dir, { recursive: true, force: true })
                } catch (error) {
                    logger.debug('Failed to cleanup upload directory after cancel:', error)
                }
                throw new Error('Upload directory cleanup requested')
            }
            uploadDirs.set(sessionKey, dir)
            return dir
        } finally {
            uploadDirPromises.delete(sessionKey)
        }
    })()
    uploadDirPromises.set(sessionKey, creation)
    return await creation
}

export async function cleanupUploadDir(sessionId?: string): Promise<void> {
    const sessionKey = getSessionKey(sessionId)
    uploadDirCleanupRequested.add(sessionKey)

    try {
        const inflight = uploadDirPromises.get(sessionKey)
        if (inflight) {
            try {
                await inflight
            } catch {
                // ignore inflight errors
            }
        }

        const dir = uploadDirs.get(sessionKey)
        uploadDirs.delete(sessionKey)
        uploadDirPromises.delete(sessionKey)

        if (!dir) {
            return
        }

        try {
            await rm(dir, { recursive: true, force: true })
        } catch (error) {
            logger.debug('Failed to cleanup upload directory:', error)
        }
    } finally {
        uploadDirCleanupRequested.delete(sessionKey)
    }
}

function cleanupUploadDirsSync(): void {
    const dirs = Array.from(uploadDirs.values())
    uploadDirs.clear()
    uploadDirPromises.clear()
    uploadDirCleanupRequested.clear()

    for (const dir of dirs) {
        try {
            rmSync(dir, { recursive: true, force: true })
        } catch (error) {
            logger.debug('Failed to cleanup upload directory on exit:', error)
        }
    }
}

function isPathWithinUploadDir(path: string, sessionId?: string): boolean {
    const sessionKey = getSessionKey(sessionId)
    const resolvedPath = resolve(path)
    const activeDir = uploadDirs.get(sessionKey)
    if (activeDir) {
        const resolvedDir = resolve(activeDir)
        const dirPrefix = resolvedDir.endsWith(sep) ? resolvedDir : `${resolvedDir}${sep}`
        return resolvedPath.startsWith(dirPrefix)
    }

    const safeKey = sanitizeFilename(sessionKey)
    const resolvedPrefix = resolve(getHapiBlobsDir(), `${safeKey}-`)
    return resolvedPath.startsWith(resolvedPrefix)
}

export function registerUploadHandlers(rpcHandlerManager: RpcHandlerManager): void {
    if (!cleanupRegistered) {
        cleanupRegistered = true
        process.once('exit', cleanupUploadDirsSync)
    }

    rpcHandlerManager.registerHandler<UploadFileRequest, UploadFileResponse>('uploadFile', async (data) => {
        logger.debug('Upload file request:', data.filename, 'mimeType:', data.mimeType)

        if (!data.filename) {
            return rpcError('Filename is required')
        }

        if (!data.content) {
            return rpcError('Content is required')
        }

        try {
            const estimatedBytes = estimateBase64Bytes(data.content)
            if (estimatedBytes > MAX_UPLOAD_BYTES) {
                return rpcError('File too large (max 50MB)')
            }

            const dir = await getOrCreateUploadDir(data.sessionId)
            const sanitizedFilename = sanitizeFilename(data.filename)

            // Add timestamp to avoid collisions
            const timestamp = Date.now()
            const uniqueFilename = `${timestamp}-${sanitizedFilename}`
            const filePath = join(dir, uniqueFilename)

            // Decode base64 content and write to file
            const buffer = Buffer.from(data.content, 'base64')
            if (buffer.length > MAX_UPLOAD_BYTES) {
                return rpcError('File too large (max 50MB)')
            }
            await writeFile(filePath, buffer)
            resizeImageIfNeeded(filePath, data.mimeType)

            logger.debug('File uploaded successfully:', filePath)
            return { success: true, path: filePath }
        } catch (error) {
            logger.debug('Failed to upload file:', error)
            return rpcError(getErrorMessage(error, 'Failed to upload file'))
        }
    })

    // Handler for large files: hub stores the file, runner downloads via HTTP
    rpcHandlerManager.registerHandler<{
        sessionId?: string
        filename: string
        downloadUrl: string
        mimeType: string
    }, UploadFileResponse>('uploadFileFromHub', async (data) => {
        logger.debug('Upload from hub request:', data.filename, 'downloadUrl:', data.downloadUrl)

        if (!data.filename || !data.downloadUrl) {
            return rpcError('Filename and downloadUrl are required')
        }

        try {
            // Download file content from hub (downloadUrl is a full URL)
            const hubUrl = data.downloadUrl
            logger.debug('Downloading file from hub:', hubUrl)
            const response = await fetch(hubUrl)
            if (!response.ok) {
                const errText = await response.text().catch(() => '')
                return rpcError(`Failed to download from hub: ${response.status} ${errText}`)
            }

            const buffer = Buffer.from(await response.arrayBuffer())
            if (buffer.length > MAX_UPLOAD_BYTES) {
                return rpcError('File too large (max 50MB)')
            }

            const dir = await getOrCreateUploadDir(data.sessionId)
            const sanitizedFilename = sanitizeFilename(data.filename)
            const timestamp = Date.now()
            const uniqueFilename = `${timestamp}-${sanitizedFilename}`
            const filePath = join(dir, uniqueFilename)
            await writeFile(filePath, buffer)
            resizeImageIfNeeded(filePath, data.mimeType)

            logger.debug('File uploaded from hub successfully:', filePath)
            return { success: true, path: filePath }
        } catch (error) {
            logger.debug('Failed to upload file from hub:', error)
            return rpcError(getErrorMessage(error, 'Failed to upload file from hub'))
        }
    })

    rpcHandlerManager.registerHandler<DeleteUploadRequest, DeleteUploadResponse>('deleteUpload', async (data) => {
        const path = data?.path?.trim()
        if (!path) {
            return rpcError('Path is required')
        }

        if (!isPathWithinUploadDir(path, data.sessionId)) {
            return rpcError('Invalid upload path')
        }

        try {
            await rm(path, { force: true })
            return { success: true }
        } catch (error) {
            logger.debug('Failed to delete upload file:', error)
            return rpcError(getErrorMessage(error, 'Failed to delete upload file'))
        }
    })
}
