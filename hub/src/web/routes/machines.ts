import {
    AddCodexApiEndpointRequestSchema,
    MACHINE_DISPLAY_NAME_MAX_LENGTH,
    MachineListDirectoryRequestSchema,
    MachinePathsExistsRequestSchema,
    RenameMachineRequestSchema,
    SpawnSessionRequestSchema
} from '@hapi/protocol'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import { RpcTargetMissingError } from '../../sync/rpcGateway'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine } from './guards'

export function createMachinesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/machines', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const namespace = c.get('namespace')
        const machines = engine.getOnlineMachinesByNamespace(namespace)
        return c.json({ machines })
    })

    app.patch('/machines/:id', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = RenameMachineRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body: displayName is required' }, 400)
        }

        // Trim first: a name is stored trimmed, so the ceiling applies to what
        // actually gets stored. An empty result clears the custom name.
        const displayName = parsed.data.displayName.trim()
        if (displayName.length > MACHINE_DISPLAY_NAME_MAX_LENGTH) {
            return c.json({ error: `displayName must be at most ${MACHINE_DISPLAY_NAME_MAX_LENGTH} characters` }, 400)
        }

        try {
            await engine.renameMachine(machineId, displayName)
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to rename machine'
            // Match the session rename contract: contention maps to 409.
            if (message.includes('concurrently') || message.includes('version')) {
                return c.json({ error: message }, 409)
            }
            return c.json({ error: message }, 500)
        }
    })

    app.post('/machines/:id/spawn', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SpawnSessionRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        // Fork-only optional fields not present in upstream SpawnSessionRequestSchema.
        // Extract directly from the raw body; harmless if missing.
        const rawBody = (body && typeof body === 'object') ? body as Record<string, unknown> : {}
        const sandbox = typeof rawBody.sandbox === 'boolean' ? rawBody.sandbox : undefined
        const continueLatest = typeof rawBody.continueLatest === 'boolean' ? rawBody.continueLatest : undefined

        const result = await engine.spawnSession(
            machineId,
            parsed.data.directory,
            parsed.data.agent,
            parsed.data.model,
            parsed.data.modelReasoningEffort,
            parsed.data.yolo,
            parsed.data.sessionType,
            parsed.data.worktreeName,
            undefined, // resumeSessionId
            parsed.data.effort,
            parsed.data.permissionMode,
            parsed.data.serviceTier,
            undefined, // existingSessionId
            sandbox,
            continueLatest,
            parsed.data.codexAccountId,
            parsed.data.collaborationMode
        )
        return c.json(result)
    })

    app.post('/machines/:id/list-directory', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = MachineListDirectoryRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.listMachineDirectory(machineId, parsed.data.path)
            return c.json(result)
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to list directory' }, 500)
        }
    })

    app.post('/machines/:id/paths/exists', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = MachinePathsExistsRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const uniquePaths = Array.from(new Set(parsed.data.paths.map((path) => path.trim()).filter(Boolean)))
        if (uniquePaths.length === 0) {
            return c.json({ exists: {} })
        }

        try {
            const exists = await engine.checkPathsExist(machineId, uniquePaths)
            return c.json({ exists })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to check paths' }, 500)
        }
    })

    app.get('/machines/:id/codex-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listCodexModelsForMachine(machineId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Codex models'
            }, 500)
        }
    })

    app.get('/machines/:id/codex-accounts', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ success: false, accounts: [], defaultAccountId: 'system', error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        try {
            return c.json(await engine.listCodexAccountsForMachine(machineId))
        } catch (error) {
            if (error instanceof RpcTargetMissingError && error.code === 'handler-not-registered') {
                return c.json({
                    success: false,
                    accounts: [],
                    defaultAccountId: 'system',
                    code: 'runner_update_required',
                    error: 'This runner must be updated before HAPI can manage Codex accounts'
                }, 409)
            }
            return c.json({
                success: false,
                accounts: [],
                defaultAccountId: 'system',
                error: error instanceof Error ? error.message : 'Failed to list Codex accounts'
            }, 500)
        }
    })

    app.post('/machines/:id/codex-accounts/login', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ success: false, error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        try {
            const result = await engine.startCodexAccountLogin(machineId)
            return c.json(result, result.success ? 200 : 500)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to start Codex account login'
            }, 500)
        }
    })

    app.post('/machines/:id/codex-accounts/api-endpoints', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ success: false, accounts: [], defaultAccountId: 'system', error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const body = await c.req.json().catch(() => null)
        const parsed = AddCodexApiEndpointRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({
                success: false,
                accounts: [],
                defaultAccountId: 'system',
                error: parsed.error.issues[0]?.message ?? 'Invalid Codex API endpoint'
            }, 400)
        }
        try {
            return c.json(await engine.addCodexApiEndpoint(machineId, parsed.data))
        } catch (error) {
            return c.json({
                success: false,
                accounts: [],
                defaultAccountId: 'system',
                error: error instanceof Error ? error.message : 'Failed to add Codex API endpoint'
            }, 500)
        }
    })

    app.get('/machines/:id/codex-accounts/login/:attemptId', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ success: false, status: 'not_found', error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        try {
            return c.json(await engine.getCodexAccountLoginStatus(machineId, c.req.param('attemptId')))
        } catch (error) {
            return c.json({
                success: false,
                status: 'error',
                error: error instanceof Error ? error.message : 'Failed to inspect Codex account login'
            }, 500)
        }
    })

    app.post('/machines/:id/codex-accounts/default', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ success: false, accounts: [], defaultAccountId: 'system', error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const body = await c.req.json().catch(() => null)
        const accountId = body && typeof body === 'object' && typeof (body as Record<string, unknown>).accountId === 'string'
            ? (body as Record<string, string>).accountId.trim()
            : ''
        if (!accountId) {
            return c.json({ success: false, accounts: [], defaultAccountId: 'system', error: 'Account id is required' }, 400)
        }
        try {
            return c.json(await engine.setDefaultCodexAccount(machineId, accountId))
        } catch (error) {
            return c.json({
                success: false,
                accounts: [],
                defaultAccountId: 'system',
                error: error instanceof Error ? error.message : 'Failed to set default Codex account'
            }, 500)
        }
    })

    app.delete('/machines/:id/codex-accounts/:accountId', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ success: false, accounts: [], defaultAccountId: 'system', error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        try {
            return c.json(await engine.removeCodexAccount(machineId, c.req.param('accountId')))
        } catch (error) {
            return c.json({
                success: false,
                accounts: [],
                defaultAccountId: 'system',
                error: error instanceof Error ? error.message : 'Failed to remove Codex account'
            }, 500)
        }
    })

    app.get('/machines/:id/opencode-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const cwd = (c.req.query('cwd') ?? '').trim()
        if (!cwd) {
            return c.json({ success: false, error: 'cwd query parameter is required' }, 400)
        }

        try {
            const result = await engine.listOpencodeModelsForCwd(machineId, cwd)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list OpenCode models'
            }, 500)
        }
    })

    app.get('/machines/:id/grok-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine

        const cwd = (c.req.query('cwd') ?? '').trim()
        if (!cwd) {
            return c.json({ success: false, error: 'cwd query parameter is required' }, 400)
        }

        try {
            return c.json(await engine.listGrokModelsForCwd(machineId, cwd))
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Grok models'
            }, 500)
        }
    })

    app.get('/machines/:id/cursor-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listCursorModelsForMachine(machineId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Cursor models'
            }, 500)
        }
    })

    return app
}
