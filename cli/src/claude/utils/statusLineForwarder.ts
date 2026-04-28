import { request } from 'node:http'
import { spawnSync } from 'node:child_process'

function logError(message: string, error?: unknown): void {
    const detail = error instanceof Error ? error.message : (error ? String(error) : '')
    const suffix = detail ? `: ${detail}` : ''
    process.stderr.write(`[statusline-forwarder] ${message}${suffix}\n`)
}

function parsePort(value: string | undefined): number | null {
    if (!value) return null
    const port = Number(value)
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

function parseArgs(args: string[]): { port: number | null; token: string | null; fallbackCommand: string | null } {
    let port: number | null = null
    let token: string | null = null
    let fallbackCommand: string | null = null

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i]
        if (!arg) continue

        if (arg === '--port' || arg === '-p') {
            port = parsePort(args[i + 1])
            i += 1
            continue
        }
        if (arg.startsWith('--port=')) {
            port = parsePort(arg.slice('--port='.length))
            continue
        }
        if (arg === '--token' || arg === '-t') {
            token = args[i + 1] ?? null
            i += 1
            continue
        }
        if (arg.startsWith('--token=')) {
            token = arg.slice('--token='.length)
            continue
        }
        if (arg === '--fallback-command') {
            fallbackCommand = args[i + 1] ?? null
            i += 1
            continue
        }
        if (arg.startsWith('--fallback-command=')) {
            fallbackCommand = arg.slice('--fallback-command='.length)
        }
    }

    return { port, token, fallbackCommand }
}

async function readStdin(): Promise<Buffer> {
    const chunks: Buffer[] = []
    process.stdin.resume()
    for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer)
    }
    return Buffer.concat(chunks)
}

async function forwardStatusLine(port: number, token: string, body: Buffer): Promise<void> {
    await new Promise<void>((resolve) => {
        const req = request({
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/hook/statusline',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': body.length,
                'x-hapi-hook-token': token
            },
            timeout: 1000
        }, (res) => {
            res.on('end', () => resolve())
            res.on('error', () => resolve())
            res.resume()
        })
        req.on('error', () => resolve())
        req.on('timeout', () => {
            req.destroy()
            resolve()
        })
        req.end(body)
    })
}

function runFallback(command: string | null, input: Buffer): void {
    if (!command) return
    try {
        const result = spawnSync(command, {
            input,
            shell: true,
            encoding: 'utf-8',
            timeout: 3000,
            maxBuffer: 1024 * 1024,
            env: process.env
        })
        if (result.stdout) process.stdout.write(result.stdout)
        if (result.stderr) process.stderr.write(result.stderr)
    } catch (error) {
        logError('Fallback statusline command failed', error)
    }
}

export async function runStatusLineForwarder(args: string[]): Promise<void> {
    const { port, token, fallbackCommand } = parseArgs(args)
    if (!port || !token) {
        logError('Missing port or token')
        runFallback(fallbackCommand, Buffer.alloc(0))
        return
    }

    const body = await readStdin()
    const forwardPromise = forwardStatusLine(port, token, body)
    runFallback(fallbackCommand, body)
    await forwardPromise
}
