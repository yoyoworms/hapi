import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexAccountManager } from './codexAccountManager';

describe('CodexAccountManager account switching', () => {
    let rootDir: string | undefined;

    afterEach(async () => {
        if (rootDir) await rm(rootDir, { recursive: true, force: true });
        rootDir = undefined;
    });

    it('finds and copies an archived rollout when legacy metadata says system but another API account owns it', async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'hapi-codex-account-switch-'));
        const systemHomeDir = join(rootDir, 'system-codex-home');
        const sourceAccountId = '7048e59e-045d-438f-a1df-2d4c38458cd1';
        const targetAccountId = 'a68929e0-fce2-47a7-9722-f22288400c46';
        const sessionId = '01a0bd50-353d-79e0-a650-0561d673515f';
        const sourceHomeDir = join(rootDir, 'codex-accounts', sourceAccountId);
        const targetHomeDir = join(rootDir, 'codex-accounts', targetAccountId);
        const transcriptContents = '{"thread_id":"01a0bd50-353d-79e0-a650-0561d673515f"}\n';

        await mkdir(join(sourceHomeDir, 'archived_sessions'), { recursive: true });
        await mkdir(join(targetHomeDir, 'sessions'), { recursive: true });
        await writeFile(join(sourceHomeDir, 'api-key'), 'source-test-api-key');
        await writeFile(join(targetHomeDir, 'api-key'), 'test-api-key');
        await writeFile(
            join(rootDir, 'codex-accounts.json'),
            JSON.stringify({
                version: 1,
                defaultAccountId: 'system',
                accounts: [
                    {
                        id: sourceAccountId,
                        label: 'Local API',
                        kind: 'api',
                        baseUrl: 'https://local.example.test/v1',
                        model: 'gpt-5.6-local',
                        createdAt: 1
                    },
                    {
                        id: targetAccountId,
                        label: 'CodeCli API',
                        kind: 'api',
                        baseUrl: 'https://api.example.test/v1',
                        model: 'gpt-5.6-sol',
                        createdAt: 2
                    }
                ]
            })
        );
        await writeFile(join(sourceHomeDir, 'archived_sessions', `${sessionId}.jsonl`), transcriptContents);

        const manager = new CodexAccountManager({ rootDir, systemHomeDir });
        const result = await manager.prepareSessionSwitch('system', targetAccountId, sessionId);

        expect(result.sourceAccount).toMatchObject({
            id: sourceAccountId,
            kind: 'api',
            label: 'Local API'
        });
        expect(result.resumePath).toContain(join(targetHomeDir, 'sessions', 'hapi-migrated', sessionId));
        expect(result.resumePath).not.toBeNull();
        expect(await readFile(result.resumePath!, 'utf8')).toBe(transcriptContents);
    });
});
