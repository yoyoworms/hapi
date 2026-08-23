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

const HAPI_CODEX_CONTEXT_CATALOG_MODELS = new Set([
    HAPI_CODEX_SOL_MODEL_ID
]);

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
    return {
        model: normalized,
        contextWindow: HAPI_CODEX_CONTEXT_DEFAULTS.contextWindow,
        autoCompactTokenLimit: HAPI_CODEX_CONTEXT_DEFAULTS.autoCompactTokenLimit,
        autoCompactTokenLimitScope: HAPI_CODEX_CONTEXT_DEFAULTS.autoCompactTokenLimitScope
    };
}

/** Add the selectable 1M Sol row without inventing an upstream model id. */
export function addHapiCodexModelVariants(models: readonly CodexModelSummary[]): CodexModelSummary[] {
    if (!models.some((model) => model.id === HAPI_CODEX_SOL_MODEL_ID)
        || models.some((model) => model.id === HAPI_CODEX_SOL_ONE_MILLION_MODEL_ID)) {
        return [...models];
    }

    const sol = models.find((model) => model.id === HAPI_CODEX_SOL_MODEL_ID)!;
    const variant: CodexModelSummary = {
        ...sol,
        id: HAPI_CODEX_SOL_ONE_MILLION_MODEL_ID,
        displayName: `${sol.displayName} (1M)`,
        isDefault: false
    };
    const solIndex = models.indexOf(sol);
    return [
        ...models.slice(0, solIndex + 1),
        variant,
        ...models.slice(solIndex + 1)
    ];
}

export function buildHapiCodexModelContextConfig(model: string | null | undefined): Record<string, unknown> {
    const spec = resolveHapiCodexModel(model);
    if (!spec?.contextWindow) {
        return {};
    }
    return {
        model_context_window: spec.contextWindow,
        model_auto_compact_token_limit: spec.autoCompactTokenLimit,
        model_auto_compact_token_limit_scope: spec.autoCompactTokenLimitScope
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
 * Codex clamps `model_context_window` to the selected model catalog entry's
 * `max_context_window`. Keep the regular catalog rows at HAPI's historical
 * 372K default, while giving Sol enough max-capacity for the explicit 1M
 * picker variant. The `context_window` field remains the default for the base
 * model; the variant supplies its 1M override in thread/turn config.
 *
 * Keep the complete account catalog. Larger user-provided values are preserved,
 * while smaller rows are raised to HAPI's historical default floor.
 */
export function applyHapiCodexContextCatalogPolicy(value: unknown): CodexModelCatalog | null {
    const catalog = parseCodexModelCatalog(value);
    if (!catalog) {
        return null;
    }
    return {
        ...catalog,
        models: catalog.models.map((model) => {
            return {
                ...model,
                context_window: atLeast(
                    model.context_window,
                    HAPI_CODEX_CONTEXT_DEFAULTS.contextWindow
                ),
                max_context_window: atLeast(
                    model.max_context_window,
                    HAPI_CODEX_CONTEXT_CATALOG_MODELS.has(model.slug as string)
                        ? HAPI_CODEX_SOL_ONE_MILLION_CONTEXT.contextWindow
                        : HAPI_CODEX_CONTEXT_DEFAULTS.contextWindow
                )
            };
        })
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
    const catalog = applyHapiCodexContextCatalogPolicy(source);
    if (!catalog) {
        return null;
    }

    const contents = `${JSON.stringify(catalog)}\n`;
    const digest = createHash('sha256').update(contents).digest('hex').slice(0, 16);
    const directory = join(codexHome, '.hapi', 'model-catalogs');
    const path = join(directory, `context-${HAPI_CODEX_CONTEXT_DEFAULTS.contextWindow}-${digest}.json`);
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
    return [
        ...(modelCatalogPath
            ? [
                '-c',
                `model_catalog_json=${JSON.stringify(modelCatalogPath)}`
            ]
            : []),
        '-c',
        `model_context_window=${HAPI_CODEX_CONTEXT_DEFAULTS.contextWindow}`,
        '-c',
        `model_auto_compact_token_limit=${HAPI_CODEX_CONTEXT_DEFAULTS.autoCompactTokenLimit}`,
        '-c',
        `model_auto_compact_token_limit_scope=${JSON.stringify(HAPI_CODEX_CONTEXT_DEFAULTS.autoCompactTokenLimitScope)}`
    ];
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
