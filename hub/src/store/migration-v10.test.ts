import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

/**
 * Tests for V9→V10 schema migration: adding the content_uuid column + partial
 * index that backs persistent agent-message dedup (prevents reconnect-replayed
 * duplicates from being re-inserted). Follows migration-v9.test.ts.
 */
describe('Store V9→V10 migration: content_uuid column', () => {
    it('fresh DB has content_uuid column in messages', () => {
        const store = new Store(':memory:')
        try {
            expect(getMessageColumns(store)).toContain('content_uuid')
        } finally {
            store.close()
        }
    })

    it('V9 DB migrates to V10: content_uuid added, existing rows NULL, dedup works after', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v10-test-'))
        const dbPath = join(dir, 'test.db')
        let store: Store | undefined
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV9Schema(db)
            db.exec('PRAGMA user_version = 9')
            db.exec(`INSERT INTO sessions (id, namespace, created_at, updated_at, seq)
                     VALUES ('s1', 'default', 1000, 1000, 0)`)
            db.exec(`INSERT INTO messages (id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at)
                     VALUES ('m1', 's1', '"hello"', 1000, 1, NULL, 1000, NULL)`)
            db.close()

            store = new Store(dbPath)
            expect(getMessageColumns(store)).toContain('content_uuid')

            // Pre-existing row keeps a NULL content_uuid (not backfilled).
            const rawUuid = (store as any).db
                .prepare('SELECT content_uuid FROM messages WHERE id = ?')
                .get('m1') as { content_uuid: string | null }
            expect(rawUuid.content_uuid).toBeNull()

            // New agent messages dedup by content uuid on the migrated DB.
            const agent = (uuid: string) => ({ role: 'agent', content: { type: 'output', data: { uuid, text: 't' } } })
            const first = store.messages.addMessage('s1', agent('u1'))
            const replay = store.messages.addMessage('s1', agent('u1'))
            expect(replay.id).toBe(first.id)
        } finally {
            store?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

function getMessageColumns(store: Store): string[] {
    const db: Database = (store as any).db
    const rows = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    return rows.map(r => r.name)
}

/** Minimal V9 schema: messages with scheduled_at but without content_uuid. */
function createV9Schema(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            tag TEXT,
            namespace TEXT NOT NULL DEFAULT 'default',
            machine_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            metadata TEXT,
            metadata_version INTEGER DEFAULT 1,
            agent_state TEXT,
            agent_state_version INTEGER DEFAULT 1,
            model TEXT,
            model_reasoning_effort TEXT,
            effort TEXT,
            todos TEXT,
            todos_updated_at INTEGER,
            team_state TEXT,
            team_state_updated_at INTEGER,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            seq INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS machines (
            id TEXT PRIMARY KEY,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            metadata TEXT,
            metadata_version INTEGER DEFAULT 1,
            runner_state TEXT,
            runner_state_version INTEGER DEFAULT 1,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            seq INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            local_id TEXT,
            invoked_at INTEGER,
            scheduled_at INTEGER,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_messages_session_position
            ON messages(session_id, COALESCE(invoked_at, created_at) DESC, seq DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_scheduled_pending
            ON messages(scheduled_at) WHERE scheduled_at IS NOT NULL AND invoked_at IS NULL;

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            platform_user_id TEXT NOT NULL,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            UNIQUE(platform, platform_user_id)
        );

        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(namespace, endpoint)
        );
    `)
}
