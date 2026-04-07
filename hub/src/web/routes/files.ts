/**
 * File upload routes - upload files to COS and return URLs
 */

import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { uploadToCos, isCosConfigured } from '../../services/cosUpload'

export function createFilesRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // POST /files/upload - upload file to COS
    // Accepts multipart/form-data or raw binary with headers
    app.post('/files/upload', async (c) => {
        if (!isCosConfigured()) {
            return c.json({ error: 'COS not configured' }, 503)
        }

        const contentType = c.req.header('content-type') || ''

        let buffer: Buffer
        let filename: string | undefined
        let mimeType: string | undefined

        if (contentType.includes('multipart/form-data')) {
            const formData = await c.req.formData()
            const file = formData.get('file')
            if (!file || !(file instanceof File)) {
                return c.json({ error: 'No file provided' }, 400)
            }
            buffer = Buffer.from(await file.arrayBuffer())
            filename = file.name
            mimeType = file.type
        } else {
            // Raw binary upload with headers
            buffer = Buffer.from(await c.req.arrayBuffer())
            filename = c.req.header('x-filename') || undefined
            mimeType = c.req.header('x-mime-type') || contentType.split(';')[0] || undefined
        }

        if (buffer.length === 0) {
            return c.json({ error: 'Empty file' }, 400)
        }

        if (buffer.length > 50 * 1024 * 1024) {
            return c.json({ error: 'File too large (max 50MB)' }, 413)
        }

        const namespace = c.get('namespace') || 'default'
        const result = await uploadToCos(buffer, { filename, mimeType, namespace })

        if (!result.success) {
            return c.json({ error: result.error }, 500)
        }

        return c.json({
            url: result.url,
            key: result.key,
        })
    })

    return app
}
