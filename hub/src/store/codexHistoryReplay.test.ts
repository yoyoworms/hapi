import { describe, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Store } from './index'
import { repairCodexHistoryReplays } from './codexHistoryReplay'

function fixture() {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession('codex-history', { path: '/tmp/codex-history' }, null, 'default')
    const db = (store as unknown as { db: Database }).db
    const body = (id: string, text = 'Saved answer') => ({ role: 'agent',
        content: { type: 'codex', data: { type: 'message', message: text, id } }, meta: { sentFrom: 'cli' } })
    const add = (item: string, text?: string, turn = 'turn') => {
        const id = `codex:thread:${turn}:${item}:agent_message`
        return store.messages.addMessage(session.id, body(id, text), id, undefined, 1_700_000_000_000)
    }
    return { store, session, db, body, add }
}

describe('Codex legacy history replay', () => {
    it('returns the original id, position and seq after a synthetic-id reconnect', () => {
        const f = fixture()
        const original = f.add('msg_live')
        const replay = f.add('item-393')
        expect(replay.id).toBe(original.id)
        expect(replay.seq).toBe(original.seq)
        expect(replay.invokedAt).toBe(original.invokedAt)
        expect(f.add('item-393').id).toBe(original.id)
        expect(f.store.messages.countMessages(f.session.id)).toBe(1)
    })

    it('preserves repeated identical messages as separate occurrences', () => {
        const f = fixture()
        const one = f.add('msg_one')
        const two = f.add('msg_two')
        expect(f.add('item-1').id).toBe(one.id)
        expect(f.add('item-2').id).toBe(two.id)
        expect(f.add('item-1').id).toBe(one.id)
        expect(f.add('item-2').id).toBe(two.id)
        expect(f.store.messages.countMessages(f.session.id)).toBe(2)
    })

    it('backfills an occurrence that was never received live', () => {
        const f = fixture()
        const one = f.add('msg_one')
        expect(f.add('item-1').id).toBe(one.id)
        const missing = f.add('item-2')
        expect(missing.id).not.toBe(one.id)
        expect(f.add('item-2').id).toBe(missing.id)
        expect(f.store.messages.countMessages(f.session.id)).toBe(2)
    })

    it('adopts a snapshot-only row when its native id and original time become available', () => {
        const f = fixture()
        const alias = 'codex:thread:turn:item-1:agent_message'
        const snapshot = f.store.messages.addImportedMessage(f.session.id, f.body(alias), alias, Date.now()).message
        const origin = f.add('msg_restored')
        expect(origin.id).toBe(snapshot.id)
        expect(origin.seq).toBe(snapshot.seq)
        expect(origin.localId).toBe('codex:thread:turn:msg_restored:agent_message')
        expect(origin.createdAt).toBe(1_700_000_000_000)
        expect(origin.invokedAt).toBe(origin.createdAt)
        expect(f.add('item-1').id).toBe(origin.id)
        expect(f.store.messages.countMessages(f.session.id)).toBe(1)
        expect(f.store.messages.getMessageEpoch(f.session.id)).toBe(1)
        expect(f.store.messages.searchContent('Saved answer', 'default')).toEqual([
            expect.objectContaining({ messageId: origin.id, createdAt: origin.createdAt })
        ])
    })

    it('does not collapse identical content across turns or live native ids', () => {
        const f = fixture()
        const first = f.add('msg_one')
        expect(f.add('msg_two').id).not.toBe(first.id)
        expect(f.add('item-1', undefined, 'other-turn').id).not.toBe(first.id)
        expect(f.store.messages.countMessages(f.session.id)).toBe(3)
    })

    it('keeps the origin time through later consumed acknowledgements', () => {
        const f = fixture()
        const original = f.add('msg_one')
        expect(original.invokedAt).toBe(1_700_000_000_000)
        expect(f.store.messages.markMessagesInvoked(f.session.id, [original.localId!], Date.now())).toBe(0)
        expect(f.store.messages.getMessages(f.session.id)[0].invokedAt).toBe(original.invokedAt)
        const user = f.store.messages.addMessage(f.session.id, { role: 'user', content: { type: 'text', text: 'prompt' } }, 'user', undefined, 1_700_000_000_000)
        expect(user.invokedAt).toBeNull()
    })

    it('repairs existing copies once, preserves original rows and remembers replay aliases', () => {
        const f = fixture()
        const original = f.add('msg_one')
        const alias = 'codex:thread:turn:item-1:agent_message'
        const copy = f.store.messages.addImportedMessage(f.session.id, f.body(alias), alias, Date.now()).message
        // A newer row keeps the durable sequence high-water mark after repair.
        f.add('msg_new', 'A newer answer')
        const epoch = f.store.messages.getMessageEpoch(f.session.id)
        expect(repairCodexHistoryReplays(f.db, f.session.id)).toEqual([{ removedId: copy.id, originalId: original.id }])
        expect(f.store.messages.getMessageEpoch(f.session.id)).toBe(epoch + 1)
        expect(f.store.messages.searchContent('Saved answer', 'default').map(hit => hit.messageId)).toEqual([original.id])
        expect(f.db.query('SELECT count(*) AS count FROM message_content_search WHERE message_id = ?').get(copy.id)).toEqual({ count: 0 })
        expect(repairCodexHistoryReplays(f.db, f.session.id)).toEqual([])
        expect(f.add('item-1').id).toBe(original.id)
        expect(f.store.messages.countMessages(f.session.id)).toBe(2)
    })

    it('does not recycle a sequence already observed by CLI clients', () => {
        const f = fixture()
        f.add('msg_one')
        const alias = 'codex:thread:turn:item-1:agent_message'
        const head = f.store.messages.addImportedMessage(f.session.id, f.body(alias), alias, Date.now()).message
        expect(repairCodexHistoryReplays(f.db, f.session.id)).toEqual([])
        expect(f.add('msg_next', 'Next message').seq).toBe(head.seq + 1)
        expect(repairCodexHistoryReplays(f.db, f.session.id)).toHaveLength(1)
    })
})
