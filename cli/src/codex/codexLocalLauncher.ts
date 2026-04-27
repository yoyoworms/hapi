import { logger } from '@/ui/logger';
import { codexLocal } from './codexLocal';
import { CodexSession } from './session';
import { createCodexSessionScanner } from './utils/codexSessionScanner';
import { convertCodexEvent } from './utils/codexEventConverter';
import { buildHapiMcpBridge } from './utils/buildHapiMcpBridge';
import { stripCodexCliOverrides } from './utils/codexCliOverrides';
import { buildCodexPermissionModeCliArgs } from './utils/permissionModeConfig';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';
import { randomUUID } from 'node:crypto';
import { EmptyCompletionNoticeTracker } from './utils/emptyCompletionNotice';

export async function codexLocalLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    const resumeSessionId = session.sessionId;
    const sessionMatchToken = resumeSessionId ? undefined : randomUUID();
    let scanner: Awaited<ReturnType<typeof createCodexSessionScanner>> | null = null;
    const permissionMode = session.getPermissionMode();
    const managedPermissionMode = permissionMode === 'read-only' || permissionMode === 'safe-yolo' || permissionMode === 'yolo'
        ? permissionMode
        : null;
    const codexArgs = managedPermissionMode
        ? [
            ...buildCodexPermissionModeCliArgs(managedPermissionMode),
            ...stripCodexCliOverrides(session.codexArgs)
        ]
        : session.codexArgs;
    const emptyCompletionNoticeTracker = new EmptyCompletionNoticeTracker();

    // Start hapi hub for MCP bridge (same as remote mode)
    const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client);
    logger.debug(`[codex-local]: Started hapi MCP bridge server at ${happyServer.url}`);

    const handleSessionFound = (sessionId: string) => {
        session.onSessionFound(sessionId);
        scanner?.onNewSession(sessionId);
    };

    const launcher = new BaseLocalLauncher({
        label: 'codex-local',
        failureLabel: 'Local Codex process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            await codexLocal({
                path: session.path,
                sessionId: resumeSessionId,
                onSessionFound: handleSessionFound,
                abort: abortSignal,
                codexArgs,
                sessionMatchToken,
                mcpServers
            });
        },
        sendFailureMessage: (message) => {
            session.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        },
        abortLogMessage: 'doAbort',
        switchLogMessage: 'doSwitch'
    });

    const handleSessionMatchFailed = (message: string) => {
        logger.warn(`[codex-local]: ${message}`);
        session.sendSessionEvent({
            type: 'message',
            message: `${message} Keeping local Codex running; remote transcript sync may be unavailable for this launch.`
        });
    };

    scanner = await createCodexSessionScanner({
        sessionId: resumeSessionId,
        cwd: session.path,
        sessionMatchToken,
        startupTimestampMs: Date.now(),
        shouldImportHistory: session.shouldImportHistory,
        onHistoryImported: session.markHistoryImported,
        onSessionMatchFailed: handleSessionMatchFailed,
        onSessionFound: (sessionId) => {
            session.onSessionFound(sessionId);
        },
        onEvent: (event) => {
            const converted = convertCodexEvent(event);
            if (converted?.sessionId) {
                session.onSessionFound(converted.sessionId);
                scanner?.onNewSession(converted.sessionId);
            }
            if (converted?.userMessage) {
                session.sendUserMessage(converted.userMessage);
            }
            if (converted?.message) {
                emptyCompletionNoticeTracker.onConvertedMessage(converted.message);
                session.sendAgentMessage(converted.message);
            }
            const eventPayload = event.payload && typeof event.payload === 'object'
                ? event.payload as Record<string, unknown>
                : null;
            if (event.type === 'event_msg' && eventPayload?.type === 'task_started') {
                emptyCompletionNoticeTracker.onTaskStarted();
            }
            if (event.type === 'event_msg' && eventPayload?.type === 'task_complete') {
                const notice = emptyCompletionNoticeTracker.maybeCreateNotice(eventPayload);
                if (notice) {
                    session.sendAgentMessage(notice);
                }
            }
        }
    });

    try {
        const exitReason = await launcher.run();
        if (exitReason === 'switch' && !session.sessionId) {
            await scanner?.resolveActiveSession();
        }
        return exitReason;
    } finally {
        await scanner?.cleanup();
        happyServer.stop();
        logger.debug('[codex-local]: Stopped hapi MCP bridge server');
    }
}
