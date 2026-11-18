import { createHash } from 'node:crypto';
import type { CodexModelSummary } from '@hapi/protocol/apiTypes';
import { resolveUsageCredentials } from '@/usageQuery/credentials';

const CACHE_TTL_MS = 5 * 60_000;
const RETRY_TTL_MS = 30_000;
const cache = new Map<string, { expiresAt: number; models: CodexModelSummary[] }>();
const inflight = new Map<string, Promise<CodexModelSummary[]>>();

function normalizeApiModel(entry: unknown): CodexModelSummary | null {
    if (!entry || typeof entry !== 'object') return null;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    // /models can also advertise media, embedding and compaction endpoints.
    // These cannot run a Codex conversation.
    if (!id || /(?:^|[-_])(?:image|audio|realtime|embedding|tts|whisper|dall-e|video|sora|moderation|compact)(?:[-_]|$)/i.test(id)) return null;
    return {
        id,
        displayName: typeof record.display_name === 'string' ? record.display_name : id,
        isDefault: false,
        defaultReasoningEffort: null,
        defaultServiceTier: null
    };
}

async function fetchApiModels(baseUrl: string, apiKey: string): Promise<CodexModelSummary[]> {
    try {
        const url = new URL(`${baseUrl.replace(/\/$/, '')}/models`);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(5_000),
            redirect: 'error'
        });
        if (!response.ok) {
            await response.body?.cancel();
            return [];
        }
        const body: unknown = await response.json();
        const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : null;
        return Array.isArray(data)
            ? data.map(normalizeApiModel).filter((model): model is CodexModelSummary => model !== null)
            : [];
    } catch {
        // /models is optional on Responses-compatible providers. Never expose
        // credential-bearing errors or lose the native catalog if it fails.
        return [];
    }
}

/** Supplement Codex's bundled catalog with models advertised by this API account. */
export async function supplementCodexApiModels(
    models: CodexModelSummary[],
    environment?: Record<string, string>
): Promise<CodexModelSummary[]> {
    const effectiveEnvironment = { ...process.env, ...environment };
    if (effectiveEnvironment.HAPI_CODEX_ACCOUNT_KIND !== 'api') return models;
    const { baseUrl, apiKey } = await resolveUsageCredentials('codex', effectiveEnvironment);
    if (!baseUrl || !apiKey) return models;
    const key = createHash('sha256')
        .update(JSON.stringify([effectiveEnvironment.CODEX_HOME, baseUrl, apiKey]))
        .digest('hex');
    let cached = cache.get(key);
    if (!cached || cached.expiresAt <= Date.now()) {
        let pending = inflight.get(key);
        if (!pending) {
            pending = fetchApiModels(baseUrl, apiKey).then(discovered => {
                cache.set(key, {
                    expiresAt: Date.now() + (discovered.length ? CACHE_TTL_MS : RETRY_TTL_MS),
                    models: discovered
                });
                return discovered;
            }).finally(() => { inflight.delete(key); });
            inflight.set(key, pending);
        }
        const discovered = await pending;
        cached = { expiresAt: 0, models: discovered };
    }
    // Preserve the native capability metadata (effort/tier/default) for exact
    // matches. A plain /models response does not establish those capabilities.
    const ids = new Set(models.map(model => model.id));
    const result = [...models];
    for (const model of cached.models) {
        if (!ids.has(model.id)) {
            ids.add(model.id);
            result.push(model);
        }
    }
    return result;
}

export function _resetCodexApiModelsCacheForTests(): void {
    cache.clear();
    inflight.clear();
}
