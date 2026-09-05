import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { logger } from '@/ui/logger';
import type { CodexModelSummary } from '@hapi/protocol/apiTypes';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

export const HAPI_CODEX_CONTEXT_DEFAULTS = {
    // Keep the existing HAPI default. The 1M Sol variant is an explicit
    // picker option and is applied per thread/turn rather than globally.
    contextWindow: 372_000,
    autoCompactTokenLimit: 330_000,
    autoCompactTokenLimitScope: 'total'
} as const;

export const HAPI_CODEX_SOL_MODEL_ID = 'gpt-5.6-sol';
export const HAPI_CODEX_SOL_ONE_MILLION_MODEL_ID = 'gpt-5.6-sol[1m]';
export const HAPI_CODEX_SOL_ONE_MILLION_CONTEXT = {
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 900_000,
    autoCompactTokenLimitScope: 'total'
} as const;
export const HAPI_CODEX_ASTRA_MODEL_ID = 'gpt-6-astra';
export const HAPI_CODEX_ASTRA_CONTEXT = {
    // OpenAI advertises a 1,050,000-token raw window. Codex exposes 95% of
    // that value (997,500) as the effective model context window.
    contextWindow: 1_050_000,
    autoCompactTokenLimit: 950_000,
    autoCompactTokenLimitScope: 'total'
} as const;

const HAPI_CODEX_ASTRA_REASONING_EFFORTS = [
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
] as const;

const HAPI_CODEX_ASTRA_REASONING_LEVELS = [
    { effort: 'low', description: 'Fast responses with lighter reasoning' },
    { effort: 'medium', description: 'Balances speed and reasoning depth' },
    { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
    { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' }
] as const;

type CodexModelCatalog = {
    models: Array<Record<string, unknown>>;
    [key: string]: unknown;
};

function parseCodexModelCatalog(value: unknown): CodexModelCatalog | null {
    const catalog = asRecord(value);
    if (!catalog || !Array.isArray(catalog.models)) {
        return null;
    }
    const models = catalog.models.filter((model): model is Record<string, unknown> => (
        Boolean(model) && typeof model === 'object' && !Array.isArray(model)
    ));
    if (models.length !== catalog.models.length) {
        return null;
    }
    return {
        ...catalog,
        models
    };
}

function atLeast(value: unknown, minimum: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(value, minimum)
        : minimum;
}

export type HapiCodexModelSpec = {
    model: string;
    contextWindow?: number;
    autoCompactTokenLimit?: number;
    autoCompactTokenLimitScope?: 'total';
};

function resolveHapiCodexContextProfile(model: string | null | undefined): {
    contextWindow: number;
    autoCompactTokenLimit: number;
    autoCompactTokenLimitScope: 'total';
} | null {
    const normalized = model?.trim();
    if (normalized === HAPI_CODEX_ASTRA_MODEL_ID) {
        return HAPI_CODEX_ASTRA_CONTEXT;
    }
    if (normalized === HAPI_CODEX_SOL_ONE_MILLION_MODEL_ID) {
        return HAPI_CODEX_SOL_ONE_MILLION_CONTEXT;
    }
    // HAPI's Default selection resolves to the configured default Sol model.
    // Keep its historical 372K profile, but let every other upstream model use
    // the context settings advertised by Codex's own catalog.
    if (!normalized || normalized === 'auto' || normalized === HAPI_CODEX_SOL_MODEL_ID) {
        return HAPI_CODEX_CONTEXT_DEFAULTS;
    }
    return null;
}

/**
 * Resolve HAPI-only model variants to the upstream Codex model id and the
 * per-thread context settings that should accompany the request.
 */
export function resolveHapiCodexModel(model: string | null | undefined): HapiCodexModelSpec | null {
    const normalized = model?.trim();
    if (!normalized) {
        return null;
    }
    if (normalized === HAPI_CODEX_SOL_ONE_MILLION_MODEL_ID) {
        return {
            model: HAPI_CODEX_SOL_MODEL_ID,
            contextWindow: HAPI_CODEX_SOL_ONE_MILLION_CONTEXT.contextWindow,
            autoCompactTokenLimit: HAPI_CODEX_SOL_ONE_MILLION_CONTEXT.autoCompactTokenLimit,
            autoCompactTokenLimitScope: HAPI_CODEX_SOL_ONE_MILLION_CONTEXT.autoCompactTokenLimitScope
        };
    }
    const contextProfile = resolveHapiCodexContextProfile(normalized);
    return {
        model: normalized,
        ...(contextProfile
            ? {
                contextWindow: contextProfile.contextWindow,
                autoCompactTokenLimit: contextProfile.autoCompactTokenLimit,
                autoCompactTokenLimitScope: contextProfile.autoCompactTokenLimitScope
            }
            : {})
    };
}

/** Add HAPI context variants and phased-rollout models to Codex's picker. */
export function addHapiCodexModelVariants(models: readonly CodexModelSummary[]): CodexModelSummary[] {
    let next = [...models];
    const astraIndex = next.findIndex((model) => model.id === HAPI_CODEX_ASTRA_MODEL_ID);
    if (astraIndex >= 0) {
        const astra = next[astraIndex]!;
        next[astraIndex] = {
            ...astra,
            displayName: 'GPT-6 Astra (1M)',
            // The user's HAPI default remains Sol; Astra is explicit opt-in.
            isDefault: false
        };
    } else {
        const solIndex = next.findIndex((model) => model.id === HAPI_CODEX_SOL_MODEL_ID);
        if (solIndex >= 0) {
            const astra: CodexModelSummary = {
                id: HAPI_CODEX_ASTRA_MODEL_ID,
                displayName: 'GPT-6 Astra (1M)',
                isDefault: false,
                defaultReasoningEffort: 'medium',
                supportedReasoningEfforts: [...HAPI_CODEX_ASTRA_REASONING_EFFORTS],
                serviceTiers: ['priority', 'fast']
            };
            next = [...next.slice(0, solIndex), astra, ...next.slice(solIndex)];
        }
    }

    const sol = next.find((model) => model.id === HAPI_CODEX_SOL_MODEL_ID);
    if (!sol || next.some((model) => model.id === HAPI_CODEX_SOL_ONE_MILLION_MODEL_ID)) {
        return next;
    }
    const variant: CodexModelSummary = {
        ...sol,
        id: HAPI_CODEX_SOL_ONE_MILLION_MODEL_ID,
        displayName: `${sol.displayName} (1M)`,
        isDefault: false
    };
    const solIndex = next.indexOf(sol);
    return [
        ...next.slice(0, solIndex + 1),
        variant,
        ...next.slice(solIndex + 1)
    ];
}

export function buildHapiCodexModelContextConfig(model: string | null | undefined): Record<string, unknown> {
    const profile = resolveHapiCodexContextProfile(model);
    if (!profile) {
        return {};
    }
    return {
        model_context_window: profile.contextWindow,
        model_auto_compact_token_limit: profile.autoCompactTokenLimit,
        model_auto_compact_token_limit_scope: profile.autoCompactTokenLimitScope
    };
}

export function buildHapiCodexModelContextArgs(model: string | null | undefined): string[] {
    const config = buildHapiCodexModelContextConfig(model);
    return Object.entries(config).flatMap(([key, value]) => [
        '-c',
        `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`
    ]);
}

/**
 * Endpoints that serve Codex's own server-side prompt and tool definitions.
 * Anything else is a relay/self-hosted gateway that only forwards the request
 * body verbatim.
 */
const OFFICIAL_CODEX_API_HOSTS = new Set([
    'api.openai.com',
    'chatgpt.com',
    'api.chatgpt.com'
]);

function stripTomlComment(line: string): string {
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"') {
            quoted = !quoted;
            continue;
        }
        if (character === '#' && !quoted) {
            return line.slice(0, index);
        }
    }
    return line;
}

/**
 * Minimal reader for the two `config.toml` keys we need. Codex homes are either
 * generated by HAPI or hand-written by the user, so a full TOML parser would be
 * more machinery than the lookup deserves.
 */
function readCodexProviderBaseUrl(codexHome: string): string | null {
    let contents: string;
    try {
        contents = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    } catch {
        return null;
    }

    let provider: string | null = null;
    let section: string | null = null;
    const baseUrls = new Map<string, string>();

    for (const rawLine of contents.split(/\r?\n/)) {
        const line = stripTomlComment(rawLine).trim();
        const sectionMatch = /^\[\s*model_providers\s*\.\s*(?:"([^"]+)"|([^\].\s]+))\s*\]$/.exec(line);
        if (sectionMatch) {
            section = sectionMatch[1] ?? sectionMatch[2] ?? null;
            continue;
        }
        if (line.startsWith('[')) {
            section = null;
            continue;
        }
        const providerMatch = /^model_provider\s*=\s*"([^"]*)"$/.exec(line);
        if (providerMatch && section === null) {
            provider = providerMatch[1];
            continue;
        }
        const baseUrlMatch = /^base_url\s*=\s*"([^"]*)"$/.exec(line);
        if (baseUrlMatch && section !== null) {
            baseUrls.set(section, baseUrlMatch[1]);
        }
    }

    if (!provider) {
        return null;
    }
    return baseUrls.get(provider) ?? null;
}

/**
 * Codex 0.150 marks the whole GPT-5.6 family `use_responses_lite`, which drops
 * `instructions` and `tools` from the `/responses` request because the official
 * backend injects both server-side. A third-party gateway forwards the body as
 * it stands, so the model arrives with no shell tool and reports that it cannot
 * run commands. Detect that case so the catalog policy can keep the classic
 * inline-tools request shape.
 */
export function codexEndpointNeedsInlineTools(codexHome: string): boolean {
    const baseUrl = readCodexProviderBaseUrl(codexHome);
    if (!baseUrl) {
        return false;
    }
    try {
        return !OFFICIAL_CODEX_API_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
    } catch {
        return false;
    }
}

export type HapiCodexCatalogPolicyOptions = {
    /**
     * Force `use_responses_lite: false` and clear `tool_mode: "code_mode_only"`
     * so Codex sends its instructions and tool definitions inline.
     */
    inlineTools?: boolean;
};

/**
 * Codex clamps `model_context_window` to the selected model catalog entry's
 * `max_context_window`. Sol keeps HAPI's historical 372K base plus its explicit
 * 1M variant; Astra receives its official 1.05M raw window. Every other row
 * keeps Codex's context fields unchanged.
 */
export function applyHapiCodexContextCatalogPolicy(
    value: unknown,
    options: HapiCodexCatalogPolicyOptions = {}
): CodexModelCatalog | null {
    const catalog = parseCodexModelCatalog(value);
    if (!catalog) {
        return null;
    }
    const models: Array<Record<string, unknown>> = catalog.models.map((model) => {
        const isSol = model.slug === HAPI_CODEX_SOL_MODEL_ID;
        const isAstra = model.slug === HAPI_CODEX_ASTRA_MODEL_ID;
        return {
            ...model,
            ...(options.inlineTools
                ? {
                    use_responses_lite: false,
                    tool_mode: model.tool_mode === 'code_mode_only' ? null : model.tool_mode
                }
                : {}),
            ...(isAstra
                ? {
                    context_window: atLeast(
                        model.context_window,
                        HAPI_CODEX_ASTRA_CONTEXT.contextWindow
                    ),
                    max_context_window: atLeast(
                        model.max_context_window,
                        HAPI_CODEX_ASTRA_CONTEXT.contextWindow
                    )
                }
                : isSol
                    ? {
                        context_window: atLeast(
                            model.context_window,
                            HAPI_CODEX_CONTEXT_DEFAULTS.contextWindow
                        ),
                        max_context_window: atLeast(
                            model.max_context_window,
                            HAPI_CODEX_SOL_ONE_MILLION_CONTEXT.contextWindow
                        )
                    }
                    : {})
        };
    });

    if (!models.some((model) => model.slug === HAPI_CODEX_ASTRA_MODEL_ID)) {
        const solIndex = models.findIndex((model) => model.slug === HAPI_CODEX_SOL_MODEL_ID);
        if (solIndex >= 0) {
            // GPT-6 access can arrive before account-scoped model/list catches
            // up. Clone the compatible Sol transport shape, then replace the
            // Astra-specific public capabilities and context limits. The
            // official responses-lite backend still supplies model prompts and
            // tools server-side by the requested Astra model id.
            const astra = {
                ...models[solIndex]!,
                slug: HAPI_CODEX_ASTRA_MODEL_ID,
                display_name: 'GPT-6-Astra',
                description: 'Our most capable model for complex, demanding work.',
                default_reasoning_level: 'medium',
                supported_reasoning_levels: HAPI_CODEX_ASTRA_REASONING_LEVELS,
                // Keep configured Sol as HAPI's default while surfacing Astra
                // immediately after it in Codex's priority ordering.
                priority: 2,
                context_window: HAPI_CODEX_ASTRA_CONTEXT.contextWindow,
                max_context_window: HAPI_CODEX_ASTRA_CONTEXT.contextWindow,
                effective_context_window_percent: 95,
                additional_speed_tiers: ['fast'],
                service_tiers: [{
                    id: 'priority',
                    name: 'Fast',
                    description: '2x speed, increased usage'
                }]
            };
            models.splice(solIndex, 0, astra);
        }
    }

    return {
        ...catalog,
        models
    };
}

function loadCodexModelCatalog(
    codexCommand: { command: string; args?: readonly string[] },
    environment: NodeJS.ProcessEnv,
    codexHome: string
): unknown {
    try {
        const output = execFileSync(codexCommand.command, [
            ...(codexCommand.args ?? []),
            'debug',
            'models'
        ], {
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: 16 * 1024 * 1024,
            env: environment,
            stdio: ['ignore', 'pipe', 'ignore']
        });
        return JSON.parse(output);
    } catch (error) {
        logger.debug('[CodexAppServer] Failed to read effective catalog from `codex debug models`', error);
    }

    try {
        return JSON.parse(readFileSync(join(codexHome, 'models_cache.json'), 'utf8'));
    } catch (error) {
        logger.debug('[CodexAppServer] Failed to read cached Codex model catalog', error);
        return null;
    }
}

function prepareHapiCodexModelCatalog(
    codexCommand: { command: string; args?: readonly string[] },
    environment: NodeJS.ProcessEnv
): string | null {
    const codexHome = resolve(environment.CODEX_HOME?.trim() || join(homedir(), '.codex'));
    const source = loadCodexModelCatalog(codexCommand, environment, codexHome);
    const inlineTools = codexEndpointNeedsInlineTools(codexHome);
    const catalog = applyHapiCodexContextCatalogPolicy(source, { inlineTools });
    if (!catalog) {
        return null;
    }

    const contents = `${JSON.stringify(catalog)}\n`;
    const digest = createHash('sha256').update(contents).digest('hex').slice(0, 16);
    const directory = join(codexHome, '.hapi', 'model-catalogs');
    const prefix = inlineTools ? 'inline-context' : 'context';
    const path = join(directory, `${prefix}-${HAPI_CODEX_CONTEXT_DEFAULTS.contextWindow}-${digest}.json`);
    try {
        mkdirSync(directory, { recursive: true });
        if (!existsSync(path)) {
            writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx' });
        }
        return path;
    } catch (error) {
        // Another concurrent app-server may have created the same content path.
        if (existsSync(path)) {
            return path;
        }
        logger.debug('[CodexAppServer] Failed to prepare HAPI model catalog', error);
        return null;
    }
}

function buildHapiCodexContextArgs(modelCatalogPath?: string | null): string[] {
    return modelCatalogPath
        ? [
            '-c',
            `model_catalog_json=${JSON.stringify(modelCatalogPath)}`
        ]
        : [];
}

export function prepareHapiCodexContextArgs(
    codexCommand: { command: string; args?: readonly string[] },
    environment: NodeJS.ProcessEnv
): string[] {
    const modelCatalogPath = prepareHapiCodexModelCatalog(codexCommand, environment);
    return buildHapiCodexContextArgs(modelCatalogPath);
}

export function buildCodexAppServerArgs(modelCatalogPath?: string | null): string[] {
    return [
        ...buildHapiCodexContextArgs(modelCatalogPath),
        'app-server'
    ];
}
