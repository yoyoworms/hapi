import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionSpawnOutput } from './sessionSpawnOutput';

describe('createSessionSpawnOutput', () => {
    const cleanupPaths: string[] = [];

    afterEach(async () => {
        await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
            recursive: true,
            force: true
        })));
    });

    it('captures diagnostics without runner-owned child pipes', async () => {
        const logsDir = await mkdtemp(join(tmpdir(), 'hapi-session-output-'));
        cleanupPaths.push(logsDir);
        const output = createSessionSpawnOutput(logsDir);
        const child = spawn(
            process.execPath,
            ['-e', 'console.log("stdout-ok"); console.error("stderr-ok")'],
            { stdio: output.stdio }
        );
        output.closeParentHandle();

        await once(child, 'exit');

        expect(child.stdout).toBeNull();
        expect(child.stderr).toBeNull();
        expect(output.readTail()).toContain('stdout-ok');
        expect(output.readTail()).toContain('stderr-ok');
        expect(await readFile(output.path, 'utf8')).toContain('stderr-ok');
    });
});
