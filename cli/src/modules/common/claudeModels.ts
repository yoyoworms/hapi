import { spawn } from 'node:child_process'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'
import type { ClaudeModelsResponse, ClaudeModelSummary } from '@hapi/protocol/apiTypes'

const CACHE_TTL_MS = 60_000
const PROBE_TIMEOUT_MS = 15_000
const cache = new Map<string, { expiresAt: number; response: ClaudeModelsResponse }>()

function labelForModel(modelId: string): string {
    if (modelId === 'opus[1m]') return 'Opus 1M'
    if (modelId === 'sonnet[1m]') return 'Sonnet 1M'
    if (modelId === 'fable[1m]') return 'Fable 1M'
    return modelId === 'default' || modelId === 'best' ? 'Default' : modelId[0]?.toUpperCase() + modelId.slice(1)
}

export function parseClaudeModelsOutput(output: string): ClaudeModelsResponse {
    const payload = JSON.parse(output) as { result?: unknown }
    const result = typeof payload.result === 'string' ? payload.result : ''
    const availableMatch = /Available:\s*([^\n.]+)/i.exec(result)
    const currentMatch = /Current model:\s*`?([^`\n(]+)`?/i.exec(result)
    const availableModels: ClaudeModelSummary[] = []
    for (const raw of (availableMatch?.[1] ?? '').split(',')) {
        const modelId = raw.trim()
        if (!modelId || availableModels.some((model) => model.modelId === modelId)) continue
        availableModels.push({ modelId, name: labelForModel(modelId) })
    }
    return {
        success: availableModels.length > 0,
        availableModels,
        currentModelId: currentMatch?.[1]?.trim() || null,
        ...(availableModels.length > 0 ? {} : { error: 'Claude Code did not return a model list' })
    }
}

export async function listClaudeModelsForMachine(): Promise<ClaudeModelsResponse> {
    const cached = cache.get('default')
    if (cached && cached.expiresAt > Date.now()) return cached.response
    const response = await new Promise<ClaudeModelsResponse>((resolve, reject) => {
        const child = spawn(getAgentLaunchCommand('claude'), ['-p', '/model', '--output-format', 'json', '--max-turns', '1'], {
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
            child.kill('SIGTERM')
            reject(new Error('Claude model discovery timed out'))
        }, PROBE_TIMEOUT_MS)
        child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
        child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.on('close', (code) => {
            clearTimeout(timer)
            if (code !== 0) {
                reject(new Error(stderr.trim() || `Claude model discovery exited with code ${code}`))
                return
            }
            try { resolve(parseClaudeModelsOutput(stdout)) } catch (error) { reject(error) }
        })
    })
    cache.set('default', { expiresAt: Date.now() + CACHE_TTL_MS, response })
    return response
}

export function _resetClaudeModelsCacheForTests(): void {
    cache.clear()
}
