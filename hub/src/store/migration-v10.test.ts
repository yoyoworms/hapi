import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

describe('Store divergent V10/V11 migration convergence', () => {
    it('fresh DB has upstream and local extension tables/columns', () => {
        const store = new Store(':memory:')
        expect(tableExists(store, 'fcm_devices')).toBe(true)
        expect(tableExists(store, 'session_scratchlist')).toBe(true)
        expect(tableExists(store, 'message_epochs')).toBe(true)
        expect(tableExists(store, 'session_shares')).toBe(true)
        expect(columnExists(store, 'messages', 'content_uuid')).toBe(true)
    })

    it('upstream V10 DB reaches the converged schema', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v11-test-'))
        const dbPath = join(dir, 'test.db')
        let store: Store | undefined
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV10Schema(db)
            db.exec('PRAGMA user_version = 10')
            db.close()

            store = new Store(dbPath)
            expect(tableExists(store, 'fcm_devices')).toBe(true)
            expect(tableExists(store, 'session_scratchlist')).toBe(true)
            expect(tableExists(store, 'message_epochs')).toBe(true)
            expect(tableExists(store, 'session_shares')).toBe(true)
            expect(columnExists(store, 'messages', 'content_uuid')).toBe(true)
        } finally {
            store?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('local V11 DB keeps content UUID dedup and gains all upstream tables', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-local-v11-test-'))
        const dbPath = join(dir, 'test.db')
        let store: Store | undefined
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV10Schema(db)
            db.exec(`
                ALTER TABLE messages ADD COLUMN content_uuid TEXT;
                CREATE INDEX idx_messages_content_uuid
                    ON messages(session_id, content_uuid)
                    WHERE content_uuid IS NOT NULL;
                CREATE TABLE session_shares (
                    token TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    namespace TEXT NOT NULL,
                    revoked INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                INSERT INTO sessions (id, namespace, created_at, updated_at, seq)
                    VALUES ('s1', 'default', 1000, 1000, 0);
                INSERT INTO session_shares (token, session_id, namespace, revoked, created_at)
                    VALUES ('valid-token', 's1', 'default', 0, 1000);
                INSERT INTO session_shares (token, session_id, namespace, revoked, created_at)
                    VALUES ('orphan-token', 'missing', 'default', 0, 1001);
                PRAGMA user_version = 11;
            `)
            db.close()

            store = new Store(dbPath)
            expect(tableExists(store, 'fcm_devices')).toBe(true)
            expect(tableExists(store, 'session_scratchlist')).toBe(true)
            expect(tableExists(store, 'message_epochs')).toBe(true)
            expect(tableExists(store, 'session_shares')).toBe(true)

            const message = (uuid: string) => ({
                role: 'agent',
                content: { type: 'output', data: { uuid, text: 'same' } }
            })
            const first = store.messages.addMessage('s1', message('stable-uuid'))
            const replay = store.messages.addMessage('s1', message('stable-uuid'))
            expect(replay.id).toBe(first.id)

            // V16 rebuilds the pre-FK local table: valid shares survive,
            // pre-existing orphans are discarded, and future deletes cascade.
            expect(store.shares.getShareByToken('valid-token')).toEqual(expect.objectContaining({
                sessionId: 's1',
                namespace: 'default'
            }))
            expect(store.shares.getShareByToken('orphan-token')).toBeNull()
            expect(hasCascadeForeignKey(store, 'session_shares', 'sessions')).toBe(true)
            expect(store.sessions.deleteSession('s1', 'default')).toBe(true)
            expect(store.shares.getShareByToken('valid-token')).toBeNull()
        } finally {
            store?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('upsert replaces token for same namespace+deviceId+platform', () => {
        const store = new Store(':memory:')
        store.fcm.upsertDevice('default', {
            token: 'tok-a',
            platform: 'phone',
            deviceId: 'pixel-1'
        })
        store.fcm.upsertDevice('default', {
            token: 'tok-b',
            platform: 'phone',
            deviceId: 'pixel-1'
        })
        const devices = store.fcm.getDevicesByNamespace('default')
        expect(devices).toHaveLength(1)
        expect(devices[0].token).toBe('tok-b')
    })
})

function tableExists(store: Store, name: string): boolean {
    const db: Database = (store as unknown as { db: Database }).db
    const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(name) as { name: string } | null
    return row !== null
}

function columnExists(store: Store, table: string, column: string): boolean {
    const db: Database = (store as unknown as { db: Database }).db
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return rows.some((row) => row.name === column)
}

function hasCascadeForeignKey(store: Store, table: string, target: string): boolean {
    const db: Database = (store as unknown as { db: Database }).db
    const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
        table: string
        from: string
        to: string
        on_delete: string
    }>
    return rows.some((row) => row.table === target
        && row.from === 'session_id'
        && row.to === 'id'
        && row.on_delete.toUpperCase() === 'CASCADE')
}

function createV10Schema(db: Database): void {
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
            service_tier TEXT,
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
