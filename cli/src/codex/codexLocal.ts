import { logger } from '@/ui/logger';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';
import { buildMcpServerConfigArgs, buildDeveloperInstructionsArg } from './utils/codexMcpConfig';
import { codexSystemPrompt } from './utils/systemPrompt';

export function appendSessionMatchToken(instructions: string, sessionMatchToken?: string): string {
    if (!sessionMatchToken) {
        return instructions;
    }
    // Codex strips HTML comments from recorded session metadata, so keep this as
    // plain text for the session scanner. It is only used to disambiguate
    // concurrent local Codex launches in the same cwd.
    return `${instructions}\n\nHAPI session match token: ${sessionMatchToken}`;
}

/**
 * Filter out 'resume' subcommand which is managed internally by hapi.
 * Codex CLI format is `codex resume <session-id>`, so subcommand is always first.
 */
export function filterResumeSubcommand(args: string[]): string[] {
    if (args.length === 0 || args[0] !== 'resume') {
        return args;
    }

    // First arg is 'resume', filter it and optional session ID
    if (args.length > 1 && !args[1].startsWith('-')) {
        logger.debug(`[CodexLocal] Filtered 'resume ${args[1]}' - session managed by hapi`);
        return args.slice(2);
    }

    logger.debug(`[CodexLocal] Filtered 'resume' - session managed by hapi`);
    return args.slice(1);
}

export async function codexLocal(opts: {
    abort: AbortSignal;
    sessionId: string | null;
    path: string;
    model?: string;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    onSessionFound: (id: string) => void;
    codexArgs?: string[];
    sessionMatchToken?: string;
    mcpServers?: Record<string, { command: string; args: string[] }>;
}): Promise<void> {
    const args: string[] = [];

    if (opts.sessionId) {
        args.push('resume', opts.sessionId);
        opts.onSessionFound(opts.sessionId);
    }

    if (opts.model) {
        args.push('--model', opts.model);
    }

    if (opts.sandbox) {
        args.push('--sandbox', opts.sandbox);
    }

    // Add MCP server configuration
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        args.push(...buildMcpServerConfigArgs(opts.mcpServers));
    }

    args.push(...buildDeveloperInstructionsArg(appendSessionMatchToken(codexSystemPrompt, opts.sessionMatchToken)));

    if (opts.codexArgs) {
        const safeArgs = filterResumeSubcommand(opts.codexArgs);
        args.push(...safeArgs);
    }

    logger.debug(`[CodexLocal] Spawning codex with args: ${JSON.stringify(args)}`);

    if (opts.abort.aborted) {
        logger.debug('[CodexLocal] Abort already signaled before spawn; skipping launch');
        return;
    }

    await spawnWithTerminalGuard({
        command: 'codex',
        args,
        cwd: opts.path,
        env: process.env,
        signal: opts.abort,
        logLabel: 'CodexLocal',
        spawnName: 'codex',
        installHint: 'Codex CLI',
        includeCause: true,
        logExit: true,
        shell: process.platform === 'win32'
    });
}
