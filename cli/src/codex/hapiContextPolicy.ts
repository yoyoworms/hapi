import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { logger } from '@/ui/logger';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

export const HAPI_CODEX_CONTEXT_DEFAULTS = {
    contextWindow: 372_000,
    autoCompactTokenLimit: 330_000,
    autoCompactTokenLimitScope: 'total'
} as const;

const HAPI_CODEX_CONTEXT_CATALOG_MODELS = new Set([
    'gpt-5.6-sol'
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

/**
 * Codex clamps `model_context_window` to the selected model catalog entry's
 * `max_context_window`. The account catalog currently advertises 272K for Sol,
 * so a CLI `-c model_context_window=372000` override alone still resolves to
 * 272K (258.4K after Codex's 95% effective-window reserve).
 *
 * Keep the complete account catalog and only raise metadata for models covered
 * by HAPI's explicit context policy. Larger user-provided values are preserved.
 */
export function applyHapiCodexContextCatalogPolicy(value: unknown): CodexModelCatalog | null {
    const catalog = parseCodexModelCatalog(value);
    if (!catalog) {
        return null;
    }
    return {
        ...catalog,
        models: catalog.models.map((model) => {
            if (
                typeof model.slug !== 'string'
                || !HAPI_CODEX_CONTEXT_CATALOG_MODELS.has(model.slug)
            ) {
                return model;
            }
            return {
                ...model,
                context_window: atLeast(
                    model.context_window,
                    HAPI_CODEX_CONTEXT_DEFAULTS.contextWindow
                ),
                max_context_window: atLeast(
                    model.max_context_window,
                    HAPI_CODEX_CONTEXT_DEFAULTS.contextWindow
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
