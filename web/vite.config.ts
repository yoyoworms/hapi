import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shareTargetPathnameFromBase } from './src/lib/sharePath'

const base = process.env.VITE_BASE_URL || '/'
const manifestBase = base.endsWith('/') ? base : `${base}/`
const shareAction = shareTargetPathnameFromBase(base)
const hubTarget = process.env.VITE_HUB_PROXY || 'http://127.0.0.1:3006'
const appVersion = readAppVersion()

function readAppVersion(): string {
    const buildInfoPath = resolve(__dirname, '../shared/src/buildInfo.ts')
    const buildInfo = readFileSync(buildInfoPath, 'utf8')
    const match = buildInfo.match(/export const APP_VERSION = ['"]([^'"]+)['"]/)

    if (!match) {
        throw new Error(`Could not read APP_VERSION from ${buildInfoPath}`)
    }

    return match[1]
}

function getBuildNumber(): number {
    try {
        const data = JSON.parse(readFileSync(resolve(__dirname, 'build-number.json'), 'utf-8'))
        return data.build ?? 1
    } catch {
        return 1
    }
}

function getVendorChunkName(id: string): string | undefined {
    if (!id.includes('/node_modules/')) {
        return undefined
    }

    if (id.includes('/node_modules/@xterm/')) {
        return 'vendor-terminal'
    }

    if (
        id.includes('/node_modules/@assistant-ui/')
        || id.includes('/node_modules/remark-gfm/')
        || id.includes('/node_modules/hast-util-to-jsx-runtime/')
    ) {
        return 'vendor-assistant'
    }

    if (id.includes('/node_modules/@elevenlabs/react/')) {
        return 'vendor-voice'
    }

    return undefined
}

export default defineConfig({
    define: {
        __APP_VERSION__: JSON.stringify(`${appVersion}.${getBuildNumber()}`),
        __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    server: {
        host: true,
        allowedHosts: ['hapidev.weishu.me'],
        proxy: {
            '/api': {
                target: hubTarget,
                changeOrigin: true
            },
            '/socket.io': {
                target: hubTarget,
                ws: true
            }
        }
    },
    plugins: [
        react(),
        VitePWA({
            // User-controlled reload avoids mid-session surprise reloads (autoUpdate reloads all tabs).
            registerType: 'prompt',
            includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'mask-icon.svg'],
            strategies: 'injectManifest',
            srcDir: 'src',
            filename: 'sw.ts',
            manifest: {
                id: manifestBase,
                name: 'LXAPI',
                short_name: 'LXAPI',
                description: 'AI-powered development assistant',
                theme_color: '#ffffff',
                background_color: '#ffffff',
                display: 'standalone',
                display_override: ['standalone', 'browser'],
                orientation: 'portrait',
                scope: manifestBase,
                start_url: manifestBase,
                launch_handler: {
                    client_mode: ['navigate-existing', 'auto']
                },
                icons: [
                    {
                        src: 'pwa-64x64.png',
                        sizes: '64x64',
                        type: 'image/png',
                        purpose: 'any'
                    },
                    {
                        src: 'pwa-192x192.png',
                        sizes: '192x192',
                        type: 'image/png',
                        purpose: 'any'
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'any'
                    }
                ],
                // Web Share Target — Android Chrome routes POSTs to /share
                // when the user picks HAPI in the system share sheet. The
                // service worker (`web/src/sw.ts`) intercepts POST /share,
                // stashes the multipart payload in IndexedDB, and 303-
                // redirects to /share?id=<transferId> for the SPA picker.
                // `*/*` is the broad fallback; explicit MIME prefixes stay
                // first because some Chrome versions only honor declared
                // prefixes when surfacing in the share sheet.
                share_target: {
                    action: shareAction,
                    method: 'POST',
                    enctype: 'multipart/form-data',
                    params: {
                        title: 'title',
                        text: 'text',
                        url: 'url',
                        files: [
                            {
                                name: 'files',
                                accept: [
                                    'image/*',
                                    'application/pdf',
                                    'text/*',
                                    'application/json',
                                    'application/zip',
                                    '*/*'
                                ]
                            }
                        ]
                    }
                }
            },
            injectManifest: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}']
            },
            devOptions: {
                enabled: true,
                type: 'module'
            }
        })
    ],
    base,
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src')
        }
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        rollupOptions: {
            output: {
                manualChunks(id) {
                    return getVendorChunkName(id)
                }
            }
        }
    }
})
