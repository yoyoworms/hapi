import { defineConfig, type Plugin } from 'vite'
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

function rejectDuplicateReactRuntimes(): Plugin {
    return {
        name: 'reject-duplicate-react-runtimes',
        generateBundle() {
            const packageLocations = new Map<string, Set<string>>()

            for (const moduleId of this.getModuleIds()) {
                const normalizedId = moduleId.replaceAll('\0', '').replaceAll('\\', '/').split('?')[0]
                const match = normalizedId.match(/\/node_modules\/(react(?:-dom)?)(?:\/|$)/)

                if (!match || match.index === undefined) {
                    continue
                }

                const packageName = match[1]
                const packageRoot = normalizedId.slice(
                    0,
                    match.index + `/node_modules/${packageName}`.length
                )
                const locations = packageLocations.get(packageName) ?? new Set<string>()
                locations.add(packageRoot)
                packageLocations.set(packageName, locations)
            }

            const duplicates = [...packageLocations.entries()]
                .filter(([, locations]) => locations.size > 1)
                .map(([packageName, locations]) => {
                    const paths = [...locations].map(location => `  - ${location}`).join('\n')
                    return `${packageName}:\n${paths}`
                })

            if (duplicates.length > 0) {
                throw new Error(
                    `Duplicate React runtime packages detected:\n${duplicates.join('\n')}\n` +
                    'Remove node_modules and reinstall from the lockfile before building.'
                )
            }
        }
    }
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
        rejectDuplicateReactRuntimes(),
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
