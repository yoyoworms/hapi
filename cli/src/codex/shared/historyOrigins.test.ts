import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiSessionClient } from '@/api/apiSession';
import { SharedCodexProjection } from './projection';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const at = '2026-10-19T12:47:40.090Z';
const event = (type: string, payload: unknown) => JSON.stringify({ timestamp: at, type, payload });
async function rollout(entries: string[]) {
    const directory = await mkdtemp('/tmp/hapi-history-origins-'); directories.push(directory);
    const path = join(directory, 'rollout.jsonl');
    await writeFile(path, [event('session_meta', { id: 'thread' }), event('event_msg', { type: 'task_started', turn_id: 'turn' }), ...entries, ''].join('\n'));
    return path;
}
function fixture() {
    const send = vi.fn();
    const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
    return { send, session, projection: new SharedCodexProjection(session, 'thread', async () => {}) };
}
const saved = (text: string, id: string) => [
    event('event_msg', { type: 'agent_message', message: text, phase: 'commentary' }),
    event('response_item', { type: 'message', role: 'assistant', id, phase: 'commentary', content: [{ type: 'output_text', text }] })
];
const snapshot = (path: string, items: unknown[]) => ({ path, turns: [{ id: 'turn', status: 'completed', items }] });
const item = (id: string, text: string) => ({ type: 'agentMessage', id, text, phase: 'commentary' });

describe('Codex history origin projection', () => {
    it('replays legacy item-N with the live id and original time after a cold restart', async () => {
        const path = await rollout(saved('Saved answer', 'msg_live'));
        const f = fixture();
        await f.projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item: item('msg_live', 'Saved answer') });
        const liveId = f.send.mock.calls[0][1];
        const restarted = new SharedCodexProjection(f.session, 'thread', async () => {});
        await restarted.history(snapshot(path, [item('item-393', 'Saved answer')]));
        expect(f.send.mock.calls[1][1]).toBe(liveId);
        expect(f.send.mock.calls[1][2]).toBe(Date.parse(at));
        restarted.reset();
        await restarted.history(snapshot(path, [item('item-400', 'Saved answer')]));
        expect(f.send.mock.calls[2]).toEqual(f.send.mock.calls[1]);
    });

    it('preserves identical text occurrences with their distinct native ids', async () => {
        const path = await rollout([...saved('Same text', 'msg_one'), ...saved('Same text', 'msg_two')]);
        const f = fixture();
        await f.projection.history(snapshot(path, [item('item-1', 'Same text'), item('item-2', 'Same text')]));
        expect(f.send.mock.calls.map(call => call[1])).toEqual([
            'codex:thread:turn:msg_one:agent_message', 'codex:thread:turn:msg_two:agent_message'
        ]);
    });

    it('restores async question identity from its native call id', async () => {
        const questions = [{ title: 'Continue?', options: ['Yes', 'No'] }];
        const path = await rollout([
            event('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'call_question', arguments: JSON.stringify({ questions }) }),
            event('event_msg', { type: 'agent_message', message: 'Continue?\n- Yes\n- No', delivery: 'async', questions })
        ]);
        const f = fixture();
        await f.projection.history(snapshot(path, [{ id: 'item-7', type: 'agentMessage', text: 'Continue?\n- Yes\n- No' }]));
        expect(f.send.mock.calls[0][1]).toBe('codex:thread:turn:call_question:agent_message');
        expect(f.send.mock.calls[0][2]).toBe(Date.parse(at));
    });

    it('does not shift response identities when an earlier event already has its native id', async () => {
        const path = await rollout([
            event('event_msg', { type: 'agent_message', id: 'msg_one', message: 'Same text', phase: 'commentary' }),
            event('response_item', { type: 'message', role: 'assistant', id: 'msg_one', phase: 'commentary', content: [{ text: 'Same text' }] }),
            ...saved('Same text', 'msg_two')
        ]);
        const f = fixture();
        await f.projection.history(snapshot(path, [item('item-1', 'Same text'), item('item-2', 'Same text')]));
        expect(f.send.mock.calls.map(call => call[1])).toEqual([
            'codex:thread:turn:msg_one:agent_message', 'codex:thread:turn:msg_two:agent_message'
        ]);
    });

    it('refreshes origin data after the rollout grows and ignores an incomplete trailing line', async () => {
        const path = await rollout([...saved('First', 'msg_first'), '{"partial":']);
        const f = fixture();
        await f.projection.history(snapshot(path, [item('item-1', 'First')]));
        await appendFile(path, [...saved('Second', 'msg_second'), ''].join('\n'));
        f.projection.reset(); f.send.mockClear();
        await f.projection.history(snapshot(path, [item('item-1', 'First'), item('item-2', 'Second')]));
        expect(f.send.mock.calls.map(call => call[1])).toEqual([
            'codex:thread:turn:msg_first:agent_message', 'codex:thread:turn:msg_second:agent_message'
        ]);
    });

    it('does not use another thread rollout to rewrite identity or settle active partial text', async () => {
        const path = await rollout(saved('Partial', 'msg_other'));
        await writeFile(path, (await readFile(path, 'utf8')).replace('"id":"thread"', '"id":"other"'));
        const f = fixture();
        await f.projection.history(snapshot(path, [item('item-1', 'Partial')]));
        expect(f.send.mock.calls[0][1]).toBe('codex:thread:turn:item-1:agent_message');
        expect(f.send.mock.calls[0]).toHaveLength(2);
        f.send.mockClear(); f.projection.reset();
        await f.projection.history({ path, turns: [{ id: 'turn', status: 'inProgress', items: [item('item-1', 'Partial')] }] });
        expect(f.send).not.toHaveBeenCalled();
    });
});
