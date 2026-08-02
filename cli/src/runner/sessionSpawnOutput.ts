import {
    closeSync,
    fstatSync,
    openSync,
    readSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const DEFAULT_TAIL_BYTES = 16_000;

export type SessionSpawnOutput = {
    path: string;
    stdio: ['ignore', number, number];
    closeParentHandle: () => void;
    readTail: (maxBytes?: number) => string;
};

/**
 * Give a detached session file-backed stdout/stderr.
 *
 * Pipes are owned by the runner process. If the runner hands off to a newer
 * version, an otherwise-live detached session inherits broken pipe endpoints
 * and can later crash with EPIPE on any console write. A regular file remains
 * valid independently of the runner while still preserving startup failures.
 */
export function createSessionSpawnOutput(logsDir: string): SessionSpawnOutput {
    const path = join(
        logsDir,
        `runner-session-${Date.now()}-${randomUUID()}.log`
    );
    const fd = openSync(path, 'a', 0o600);
    let parentHandleClosed = false;

    return {
        path,
        stdio: ['ignore', fd, fd],
        closeParentHandle: () => {
            if (parentHandleClosed) return;
            parentHandleClosed = true;
            closeSync(fd);
        },
        readTail: (maxBytes = DEFAULT_TAIL_BYTES) => {
            let readFd: number | null = null;
            try {
                readFd = openSync(path, 'r');
                const size = fstatSync(readFd).size;
                const length = Math.min(size, Math.max(0, maxBytes));
                if (length === 0) return '';
                const buffer = Buffer.alloc(length);
                const bytesRead = readSync(readFd, buffer, 0, length, size - length);
                return buffer.subarray(0, bytesRead).toString('utf8');
            } catch {
                return '';
            } finally {
                if (readFd !== null) closeSync(readFd);
            }
        }
    };
}
