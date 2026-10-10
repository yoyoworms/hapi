import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { record, string } from './gateway';

export async function isPaginatedRollout(sourcePath: string, threadId: string): Promise<boolean> {
    const file = await open(sourcePath, 'r');
    try {
        const buffer = Buffer.alloc(1024 * 1024);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const newline = buffer.subarray(0, bytesRead).indexOf(10);
        if (newline < 0) return false;
        const metadata = record(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
        const payload = record(metadata.payload);
        return metadata.type === 'session_meta'
            && (string(payload.id) ?? string(payload.session_id)) === threadId
            && payload.history_mode === 'paginated';
    } catch {
        return false;
    } finally {
        await file.close();
    }
}

/** Keep the original rollout and every history byte; only change the format declaration. */
export async function prepareLegacyRollout(sourcePath: string, threadId: string): Promise<string> {
    const source = await open(sourcePath, 'r');
    let header = Buffer.alloc(0);
    let historyOffset = -1;
    try {
        while (header.length < 1024 * 1024) {
            const chunk = Buffer.alloc(16 * 1024);
            const { bytesRead } = await source.read(chunk, 0, chunk.length, header.length);
            if (!bytesRead) break;
            header = Buffer.concat([header, chunk.subarray(0, bytesRead)]);
            const newline = header.indexOf(10);
            if (newline >= 0) {
                historyOffset = newline + 1;
                header = header.subarray(0, newline);
                break;
            }
        }
    } finally {
        await source.close();
    }
    if (historyOffset < 0) throw new Error('Cannot recover Codex rollout: missing session metadata');
    const metadata = record(JSON.parse(header.toString('utf8')));
    const payload = record(metadata.payload);
    if (metadata.type !== 'session_meta' || (string(payload.id) ?? string(payload.session_id)) !== threadId) {
        throw new Error('Cannot recover Codex rollout: session metadata does not match the thread');
    }
    if (payload.history_mode !== 'paginated') {
        throw new Error('Cannot recover Codex rollout: history is not paginated');
    }
    if (payload.history_base !== undefined && payload.history_base !== null) {
        throw new Error('Cannot recover Codex rollout: external base history must be materialized first');
    }
    payload.history_mode = 'legacy';
    const destination = join(dirname(sourcePath), `${basename(sourcePath, '.jsonl')}-hapi-legacy-${randomUUID()}.jsonl`);
    const temporary = `${destination}.tmp`;
    try {
        async function* contents() {
            yield Buffer.from(`${JSON.stringify(metadata)}\n`);
            yield* createReadStream(sourcePath, { start: historyOffset });
        }
        await pipeline(Readable.from(contents()), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        await rename(temporary, destination);
        return destination;
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
}

/**
 * Codex indexes the rollout path by thread id. A sibling path passed to
 * thread/resume is rejected as stale, so install the converted copy at the
 * indexed path and retain the original under a recoverable backup name.
 */
export async function installLegacyRollout(sourcePath: string, convertedPath: string): Promise<string> {
    const backupPath = `${sourcePath}.bak-hapi-paginated-${Date.now()}-${randomUUID()}`;
    try {
        await copyFile(sourcePath, backupPath, constants.COPYFILE_EXCL);
        await rename(convertedPath, sourcePath);
        return backupPath;
    } catch (error) {
        await rm(convertedPath, { force: true }).catch(() => {});
        throw error;
    }
}
