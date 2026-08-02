import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync, mkdirSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';

type HookCommandConfig = {
    matcher?: string;
    hooks: Array<{
        type: 'command';
        command: string;
    }>;
};

type HookSettings = {
    hooksConfig?: {
        enabled?: boolean;
    };
    hooks: {
        SessionStart: HookCommandConfig[];
        UserPromptSubmit?: HookCommandConfig[];
        PreToolUse?: HookCommandConfig[];
    };
    statusLine?: {
        type: 'command';
        command: string;
        padding?: number;
    };
};

export type HookSettingsOptions = {
    filenamePrefix: string;
    logLabel: string;
    hooksEnabled?: boolean;
    /**
     * Also forward UserPromptSubmit and PreToolUse hooks. Unlike SessionStart,
     * their payloads carry `permission_mode`, letting HAPI track the mode the
     * user picks inside the interactive TUI (shift+tab). Keep this off for the
     * remote SDK process: these hooks block Claude while the forwarder runs,
     * and remote permission state is owned by the hub/RPC path anyway.
     */
    trackPermissionMode?: boolean;
};

function shellQuote(value: string): string {
    if (value.length === 0) {
        return '""';
    }

    if (/^[A-Za-z0-9_\/:=-]+$/.test(value)) {
        return value;
    }

    return '"' + value.replace(/(["\\$`])/g, '\\$1') + '"';
}

function shellJoin(parts: string[]): string {
    return parts.map(shellQuote).join(' ');
}

function readUserStatusLineCommand(): string | null {
    try {
        const settingsPath = join(homedir(), '.claude', 'settings.json');
        if (!existsSync(settingsPath)) return null;
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { statusLine?: { command?: unknown } };
        const command = parsed.statusLine?.command;
        if (typeof command !== 'string' || !command.trim()) return null;
        if (command.includes('statusline-forwarder')) return null;
        return command;
    } catch {
        return null;
    }
}

export function buildHookSettings(
    command: string,
    hooksEnabled?: boolean,
    trackPermissionMode?: boolean,
    statusLineCommand?: string
): HookSettings {
    const commandHook = {
        hooks: [
            {
                type: 'command' as const,
                command
            }
        ]
    };
    const hooks: HookSettings['hooks'] = {
        SessionStart: [{ matcher: '*', ...commandHook }]
    };
    if (trackPermissionMode) {
        hooks.UserPromptSubmit = [commandHook];
        hooks.PreToolUse = [{ matcher: '*', ...commandHook }];
    }

    const settings: HookSettings = { hooks };
    if (statusLineCommand) {
        settings.statusLine = {
            type: 'command',
            command: statusLineCommand,
            padding: 0
        };
    }
    if (hooksEnabled !== undefined) {
        settings.hooksConfig = {
            enabled: hooksEnabled
        };
    }

    return settings;
}

export function generateHookSettingsFile(
    port: number,
    token: string,
    options: HookSettingsOptions
): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    const filename = `${options.filenamePrefix}-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    const { command, args } = getHappyCliCommand([
        'hook-forwarder',
        '--port',
        String(port),
        '--token',
        token
    ]);
    const hookCommand = shellJoin([command, ...args]);

    const originalStatusLineCommand = readUserStatusLineCommand();
    const statusLineArgs = [
        'statusline-forwarder',
        '--port',
        String(port),
        '--token',
        token
    ];
    if (originalStatusLineCommand) {
        statusLineArgs.push('--fallback-command', originalStatusLineCommand);
    }
    const statusLineCommand = shellJoin([command, ...statusLineArgs]);

    const settings = buildHookSettings(
        hookCommand,
        options.hooksEnabled,
        options.trackPermissionMode,
        statusLineCommand
    );

    writeFileSync(filepath, JSON.stringify(settings, null, 4));
    logger.debug(`[${options.logLabel}] Created hook settings file: ${filepath}`);

    return filepath;
}

export function cleanupHookSettingsFile(filepath: string, logLabel: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[${logLabel}] Cleaned up hook settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[${logLabel}] Failed to cleanup hook settings file: ${error}`);
    }
}
