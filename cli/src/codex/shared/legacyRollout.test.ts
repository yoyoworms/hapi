import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { installLegacyRollout, isPaginatedRollout, prepareLegacyRollout } from './legacyRollout';

let directory: string | undefined;
afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
});

async function rollout(payload: Record<string, unknown>, history = '') {
    directory = await mkdtemp(join(tmpdir(), 'hapi-legacy-rollout-'));
    const path = join(directory, 'rollout-thread.jsonl');
    const contents = `${JSON.stringify({ type: 'session_meta', payload })}\n${history}`;
    await writeFile(path, contents);
    return { path, contents };
}

describe('paginated rollout recovery', () => {
    it('preserves history, compaction, provider metadata and the original file byte for byte', async () => {
        const history = `${JSON.stringify({ type: 'response_item', payload: { role: 'user', text: 'before' } })}\r\n`
            + `${JSON.stringify({ type: 'compacted', payload: { replacement_history: [{ type: 'message', role: 'assistant', content: [] }] } })}\n`
            + `${JSON.stringify({ type: 'response_item', payload: { role: 'user', text: 'after' } })}`;
        const payload = { id: 'thread', history_mode: 'paginated', model_provider: 'custom', cwd: '/project', base_instructions: { text: 'x'.repeat(50_000) } };
        const source = await rollout(payload, history);
        const path = await prepareLegacyRollout(source.path, 'thread');
        const converted = await readFile(path, 'utf8');
        expect(path).not.toBe(source.path);
        expect(JSON.parse(converted.slice(0, converted.indexOf('\n'))).payload).toEqual({ ...payload, history_mode: 'legacy' });
        expect(converted.slice(converted.indexOf('\n') + 1)).toBe(history);
        expect(await readFile(source.path, 'utf8')).toBe(source.contents);
        if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    it.each([
        { id: 'another', history_mode: 'paginated' },
        { id: 'thread', history_mode: 'legacy' },
        { id: 'thread', history_mode: 'paginated', history_base: { thread_id: 'parent' } }
    ])('refuses incompatible or externally backed history: %j', async payload => {
        const source = await rollout(payload);
        await expect(prepareLegacyRollout(source.path, 'thread')).rejects.toThrow('Cannot recover Codex rollout');
        expect(await readFile(source.path, 'utf8')).toBe(source.contents);
        expect(await readdir(directory!)).toEqual(['rollout-thread.jsonl']);
    });

    it('detects paginated bytes even when the native index may already say legacy', async () => {
        const source = await rollout({ id: 'thread', history_mode: 'paginated' });
        expect(await isPaginatedRollout(source.path, 'thread')).toBe(true);
        expect(await isPaginatedRollout(source.path, 'other')).toBe(false);
    });

    it('installs a conversion at the indexed path while retaining the original', async () => {
        const source = await rollout({ id: 'thread', history_mode: 'paginated' }, '{"type":"response_item"}\n');
        const converted = await prepareLegacyRollout(source.path, 'thread');
        const backup = await installLegacyRollout(source.path, converted);
        expect(JSON.parse((await readFile(source.path, 'utf8')).split('\n', 1)[0]).payload.history_mode).toBe('legacy');
        expect(await readFile(backup, 'utf8')).toBe(source.contents);
    });

});
