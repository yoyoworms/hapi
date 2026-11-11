import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { logger } from '@/ui/logger';
import { record, string } from './gateway';

type Origin = { id?: string; at: number };
type Entries = { events: Origin[]; responses: Origin[] };
type TurnOrigins = Map<string, Entries>;

function key(text: unknown, phase: unknown): string {
    return JSON.stringify([text, phase ?? null]);
}

function questionsKey(questions: unknown): string {
    return JSON.stringify(Array.isArray(questions) ? questions.map(value => {
        const question = record(value);
        return [question.title, question.options];
    }) : []);
}

/** Legacy snapshots rebuild item-N ids from event_msg, although the rollout's
 * response_item retains the live id. Recover origin data without replacing the
 * native snapshot as the source of conversation content. Cache unchanged files;
 * streaming keeps large tool outputs out of the retained history index. */
export class CodexHistoryOrigins {
    private cacheKey?: string;
    private origins = new Map<string, TurnOrigins>();

    async enrich(threadId: string, thread: Record<string, unknown>): Promise<Record<string, unknown>> {
        const path = string(thread.path);
        if (!path || !Array.isArray(thread.turns)) return thread;
        try {
            const info = await stat(path);
            const cacheKey = `${threadId}:${path}:${info.ino}:${info.size}:${info.mtimeMs}`;
            if (cacheKey !== this.cacheKey) {
                const origins = await this.read(path, threadId);
                this.origins = origins;
                this.cacheKey = cacheKey;
            }
            return { ...thread, turns: thread.turns.map(value => {
                const turn = record(value);
                const origins = this.origins.get(string(turn.id) ?? '');
                if (!origins || !Array.isArray(turn.items)) return value;
                const occurrences = new Map<string, number>();
                return { ...turn, items: turn.items.map(value => {
                    const item = record(value);
                    if (item.type !== 'agentMessage' || typeof item.text !== 'string') return value;
                    const signature = key(item.text, item.phase);
                    const occurrence = occurrences.get(signature) ?? 0;
                    occurrences.set(signature, occurrence + 1);
                    const entries = origins.get(signature);
                    const origin = (entries?.events.length ? entries.events : entries?.responses)?.[occurrence];
                    if (!origin) return value;
                    return { ...item,
                        ...(/^item-\d+$/.test(string(item.id) ?? '') && origin.id ? { id: origin.id } : {}),
                        hapiOriginAt: origin.at
                    };
                }) };
            }) };
        } catch (error) {
            // The hub's replay aliases still deduplicate an older CLI snapshot
            // when the rollout is temporarily unavailable.
            logger.debug('[Codex shared] history origins unavailable', error);
            return thread;
        }
    }

    private async read(path: string, threadId: string): Promise<Map<string, TurnOrigins>> {
        const origins = new Map<string, TurnOrigins>();
        const questionCalls = new Map<string, string[]>();
        let turnId: string | undefined;
        let header = false;
        const stream = createReadStream(path, { encoding: 'utf8' });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
            for await (const line of lines) {
                let entry: Record<string, unknown>;
                try { entry = record(JSON.parse(line)); } catch { continue; }
                const payload = record(entry.payload);
                if (!header) {
                    if (entry.type !== 'session_meta' || (payload.id ?? payload.session_id) !== threadId) {
                        throw new Error('Codex history origin header does not match the thread');
                    }
                    header = true;
                    continue;
                }
                if (entry.type === 'turn_context' || (entry.type === 'event_msg' && payload.type === 'task_started')) {
                    turnId = string(payload.turn_id) ?? turnId;
                }
                if (!turnId) continue;
                const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
                if (!Number.isFinite(at)) continue;
                if (entry.type === 'response_item' && payload.type === 'function_call'
                    && /(?:^|\.)request_user_input_async$/.test(string(payload.name) ?? '') && string(payload.call_id)) {
                    try {
                        const args = typeof payload.arguments === 'string' ? record(JSON.parse(payload.arguments)) : record(payload.arguments);
                        const signature = `${turnId}:${questionsKey(args.questions)}`;
                        const calls = questionCalls.get(signature) ?? [];
                        calls.push(string(payload.call_id)!);
                        questionCalls.set(signature, calls);
                    } catch { /* A malformed call must not guess a message identity. */ }
                }
                const event = entry.type === 'event_msg' && payload.type === 'agent_message';
                const response = entry.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant';
                if (!event && !response) continue;
                const text = event ? string(payload.message) : Array.isArray(payload.content)
                    ? payload.content.map(part => string(record(part).text) ?? '').join('') : undefined;
                if (!text) continue;
                let id = string(payload.id);
                if (event && payload.delivery === 'async' && Array.isArray(payload.questions)) {
                    id ??= questionCalls.get(`${turnId}:${questionsKey(payload.questions)}`)?.shift();
                }
                const turn = origins.get(turnId) ?? new Map<string, Entries>();
                origins.set(turnId, turn);
                const signature = key(text, payload.phase);
                const entries = turn.get(signature) ?? { events: [], responses: [] };
                entries[event ? 'events' : 'responses'].push({ id, at });
                turn.set(signature, entries);
            }
            if (!header) throw new Error('Codex history origin header is missing');
        } finally {
            lines.close();
            stream.destroy();
        }
        for (const turn of origins.values()) for (const entries of turn.values()) {
            const responses = [...entries.responses];
            for (const event of entries.events) {
                const index = event.id ? responses.findIndex(response => response.id === event.id) : 0;
                if (index >= 0 && responses[index]) {
                    event.id ??= responses[index].id;
                    responses.splice(index, 1);
                }
            }
        }
        return origins;
    }
}
