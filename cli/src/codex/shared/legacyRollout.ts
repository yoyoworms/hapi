import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, open, readdir, rename, rm, stat } from 'node:fs/promises';
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

type LegacyRolloutOptions = {
    /** CODEX_HOME used to resolve an external `history_base.thread_id`. */
    historyRoot?: string;
};

type RolloutHeader = {
    metadata: Record<string, unknown>;
    payload: Record<string, unknown>;
    historyOffset: number;
};

async function readRolloutHeader(sourcePath: string): Promise<RolloutHeader> {
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
    return { metadata, payload: record(metadata.payload), historyOffset };
}

async function findRolloutByThread(root: string, threadId: string): Promise<string | null> {
    const roots = [join(root, 'sessions'), join(root, 'archived_sessions')];
    const visit = async (directory: string): Promise<string | null> => {
        let entries: import('node:fs').Dirent[];
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch {
            return null;
        }
        for (const entry of entries) {
            const fullPath = join(directory, entry.name);
            if (entry.isDirectory()) {
                const found = await visit(fullPath);
                if (found) return found;
                continue;
            }
            if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
                return fullPath;
            }
        }
        return null;
    };
    for (const directory of roots) {
        const found = await visit(directory);
        if (found) return found;
    }
    return null;
}

async function validateExternalHistory(
    parentPath: string,
    parentThreadId: string,
    endByteOffset: number
): Promise<number> {
    const parent = await readRolloutHeader(parentPath);
    if (parent.metadata.type !== 'session_meta'
        || (string(parent.payload.id) ?? string(parent.payload.session_id)) !== parentThreadId) {
        throw new Error('Cannot recover Codex rollout: external base history metadata does not match the parent thread');
    }
    const size = (await stat(parentPath)).size;
    if (!Number.isSafeInteger(endByteOffset) || endByteOffset < parent.historyOffset || endByteOffset > size) {
        throw new Error('Cannot recover Codex rollout: external base history offset is invalid');
    }
    if (endByteOffset > parent.historyOffset) {
        const file = await open(parentPath, 'r');
        try {
            const marker = Buffer.alloc(1);
            await file.read(marker, 0, 1, endByteOffset - 1);
            if (marker[0] !== 10) {
                throw new Error('Cannot recover Codex rollout: external base history offset is not at a record boundary');
            }
        } finally {
            await file.close();
        }
    }
    return parent.historyOffset;
}

/** Keep the original rollout and every history byte; only change the format declaration. */
export async function prepareLegacyRollout(
    sourcePath: string,
    threadId: string,
    options: LegacyRolloutOptions = {}
): Promise<string> {
    const { metadata, payload, historyOffset } = await readRolloutHeader(sourcePath);
    if (metadata.type !== 'session_meta' || (string(payload.id) ?? string(payload.session_id)) !== threadId) {
        throw new Error('Cannot recover Codex rollout: session metadata does not match the thread');
    }
    if (payload.history_mode !== 'paginated') {
        throw new Error('Cannot recover Codex rollout: history is not paginated');
    }
    let externalBase: { path: string; start: number; end: number } | undefined;
    if (payload.history_base !== undefined && payload.history_base !== null) {
        const historyBase = record(payload.history_base);
        const parentThreadId = string(historyBase.thread_id);
        const endByteOffset = historyBase.end_byte_offset;
        if (!parentThreadId || typeof endByteOffset !== 'number') {
            throw new Error('Cannot recover Codex rollout: external base history metadata is incomplete');
        }
        if (!options.historyRoot) {
            throw new Error('Cannot recover Codex rollout: external base history root is unavailable');
        }
        const parentPath = await findRolloutByThread(options.historyRoot, parentThreadId);
        if (!parentPath) {
            throw new Error(`Cannot recover Codex rollout: external base history ${parentThreadId} was not found`);
        }
        const parentHistoryOffset = await validateExternalHistory(parentPath, parentThreadId, endByteOffset);
        externalBase = { path: parentPath, start: parentHistoryOffset, end: endByteOffset };
        delete payload.history_base;
    }
    payload.history_mode = 'legacy';
    const destination = join(dirname(sourcePath), `${basename(sourcePath, '.jsonl')}-hapi-legacy-${randomUUID()}.jsonl`);
    const temporary = `${destination}.tmp`;
    try {
        async function* contents() {
            yield Buffer.from(`${JSON.stringify(metadata)}\n`);
            if (externalBase && externalBase.end > externalBase.start) {
                yield* createReadStream(externalBase.path, {
                    start: externalBase.start,
                    end: externalBase.end - 1
                });
            }
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
