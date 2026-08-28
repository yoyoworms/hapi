import { claudeLocal } from "./claudeLocal";
import { Session } from "./session";
import { createSessionScanner } from "./utils/sessionScanner";
import { isClaudeChatVisibleMessage } from "./utils/chatVisibility";
import { BaseLocalLauncher } from "@/modules/common/launcher/BaseLocalLauncher";
import { applySessionTitleFallback } from './utils/sessionTitleFallback';
import type { AgentAccountStatus } from '@hapi/protocol/types';
import type { SDKMessage } from './sdk/types';
import { ClaudeAccountStatusTracker } from './utils/claudeAccountStatus';
import { CLAUDE_USAGE_REFRESH_INTERVAL_MS, fetchClaudeUsage } from './utils/claudeUsage';

export async function claudeLocalLauncher(session: Session): Promise<'switch' | 'exit'> {

    const accountStatusTracker = new ClaudeAccountStatusTracker();
    let publishedAccountStatus: AgentAccountStatus | null = null;
    const mergeAccountLimit = (
        previous: AgentAccountStatus['window'] | undefined,
        next: AgentAccountStatus['window'] | undefined
    ): AgentAccountStatus['window'] => next ? { ...previous, ...next } : previous ?? null;
    const publishAccountStatus = (accountStatus: AgentAccountStatus): void => {
        const merged: AgentAccountStatus = {
            ...publishedAccountStatus,
            ...accountStatus,
            accountLabel: accountStatus.accountLabel ?? publishedAccountStatus?.accountLabel,
            window: mergeAccountLimit(publishedAccountStatus?.window, accountStatus.window),
            weekly: mergeAccountLimit(publishedAccountStatus?.weekly, accountStatus.weekly),
            updatedAt: accountStatus.updatedAt
        };
        publishedAccountStatus = merged;
        session.client.sendSessionEvent({ type: 'account-status', accountStatus: merged });
    };
    const refreshClaudeUsage = async (): Promise<void> => {
        const accountStatus = await fetchClaudeUsage(session.claudeEnvVars?.CLAUDE_CONFIG_DIR);
        if (accountStatus) publishAccountStatus(accountStatus);
    };
    let usageRefreshTimer: ReturnType<typeof setInterval> | null = null;

    // Create scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
        onMessage: (message) => {
            const accountStatus = accountStatusTracker.update(message as SDKMessage);
            if (accountStatus) publishAccountStatus(accountStatus);
            // Preserve the AI-generated title emitted by Claude Code's native
            // interactive CLI. It is metadata, not a visible chat message.
            if (message.type === 'ai-title') {
                applySessionTitleFallback(session.client, message.aiTitle)
                return
            }
            // Claude Code writes its native session title as a summary. Use it as
            // a fallback for older transcript formats.
            if (message.type === 'summary') {
                applySessionTitleFallback(session.client, message.summary)
                return
            }
            // Filter out internal meta messages (e.g. skill injections) and
            // compact summaries to avoid them appearing in the web UI
            if (message.isMeta || message.isCompactSummary) {
                return
            }
            // Filter out invisible system messages (e.g. init, stop_hook_summary)
            // to avoid them showing as raw JSON in the web UI
            if (!isClaudeChatVisibleMessage(message)) {
                return
            }
            session.client.sendClaudeSessionMessage(message)
        }
    });

    const handleSessionFound = (sessionId: string, sessionFilePath?: string) => {
        scanner.onNewSession(sessionId, sessionFilePath);
    };
    session.addSessionFoundCallback(handleSessionFound);
    void refreshClaudeUsage();
    usageRefreshTimer = setInterval(() => { void refreshClaudeUsage(); }, CLAUDE_USAGE_REFRESH_INTERVAL_MS);


    const launcher = new BaseLocalLauncher({
        label: 'local',
        failureLabel: 'Local Claude process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            await claudeLocal({
                path: session.path,
                sessionId: session.sessionId,
                abort: abortSignal,
                claudeEnvVars: session.claudeEnvVars,
                claudeArgs: session.claudeArgs,
                model: session.getModel(),
                mcpServers: session.mcpServers,
                allowedTools: session.allowedTools,
                hookSettingsPath: session.localHookSettingsPath,
            });
        },
        onLaunchSuccess: () => {
            session.consumeOneTimeFlags();
        },
        sendFailureMessage: (message) => {
            session.client.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        },
        abortLogMessage: 'doAbort',
        switchLogMessage: 'doSwitch'
    });
    try {
        return await launcher.run();
    } finally {
        if (usageRefreshTimer) clearInterval(usageRefreshTimer);
        // Cleanup
        session.removeSessionFoundCallback(handleSessionFound);
        await scanner.cleanup();
    }
}
