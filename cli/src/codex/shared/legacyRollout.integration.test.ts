import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { CodexAppServerClient } from '../codexAppServerClient';
import { initializeSharedClient } from './launch';
import { record } from './gateway';
import { installLegacyRollout, prepareLegacyRollout } from './legacyRollout';

it.skipIf(process.env.HAPI_RUN_SHARED_CODEX_TESTS !== '1')('restores a paginated native thread in place with its original id and history', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hapi-native-legacy-'));
    const threadId = randomUUID(); const turnId = randomUUID();
    await mkdir(join(home, 'sessions'));
    const path = join(home, 'sessions', `rollout-${threadId}.jsonl`);
    const timestamp = new Date().toISOString();
    const original = [
        { type: 'session_meta', payload: { id: threadId, timestamp, cwd: home, source: 'cli', originator: 'hapi', cli_version: '0.144.6', history_mode: 'paginated', model_provider: 'mock' } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Saved question' }] } },
        { type: 'event_msg', payload: { type: 'item_completed', thread_id: threadId, turn_id: turnId,
            item: { type: 'UserMessage', id: 'user-item', content: [{ type: 'text', text: 'Saved question', text_elements: [] }] } } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Saved answer' }] } },
        { type: 'event_msg', payload: { type: 'item_completed', thread_id: threadId, turn_id: turnId,
            item: { type: 'AgentMessage', id: 'agent-item', content: [{ type: 'Text', text: 'Saved answer' }], phase: 'final_answer' } } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'Saved answer' } }
    ].map(row => JSON.stringify({ timestamp, ...row })).join('\n') + '\n';
    await writeFile(path, original);
    await writeFile(join(home, 'config.toml'), 'model = "mock-model"\nmodel_provider = "mock"\ncheck_for_update_on_startup = false\n[model_providers.mock]\nname = "No model calls"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n');
    const client = new CodexAppServerClient({ cwd: home, env: { CODEX_HOME: home, HOME: home } });
    try {
        await initializeSharedClient(client);
        const before = record(await client.request('thread/read', { threadId, includeTurns: false }));
        expect(record(before.thread).historyMode).toBe('paginated');
        const backup = await installLegacyRollout(path, await prepareLegacyRollout(path, threadId));
        const resumed = record(await client.request('thread/resume', { threadId }));
        expect(record(resumed.thread)).toMatchObject({ id: threadId, historyMode: 'legacy' });
        const after = record(await client.request('thread/read', { threadId, includeTurns: true }));
        const history = record(after.thread).turns;
        const turns = Array.isArray(history) ? history : [];
        expect(turns).toHaveLength(1);
        expect(record(turns[0]).status).toBe('completed');
        expect(await readFile(backup, 'utf8')).toBe(original);
        const restored = await readFile(path, 'utf8');
        expect(restored.slice(restored.indexOf('\n') + 1)).toContain(original.slice(original.indexOf('\n') + 1));
    } finally {
        await client.disconnect();
        await rm(home, { recursive: true, force: true });
    }
}, 30_000);
