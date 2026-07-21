import { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import { logger } from "@/lib";
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

interface KillSessionRequest {
    reason?: string
}

interface KillSessionResponse {
    success: boolean;
    message: string;
}

/**
 * tiann/hapi#914: callers can pass either a bare `cleanupAndExit` closure
 * (legacy) or an options object that lets the kill-RPC stamp an explicit
 * `archiveReason` before the lifecycle teardown runs. The hub sends this
 * RPC for explicit user archives and safe idle auto-archives; an optional
 * reason keeps those paths distinguishable from out-of-band SIGTERM.
 */
export interface KillSessionLifecycle {
    cleanupAndExit: () => Promise<void>;
    setArchiveReason?: (reason: string) => void;
}

export function registerKillSessionHandler(
    rpcHandlerManager: RpcHandlerManager,
    lifecycleOrCleanup: KillSessionLifecycle | (() => Promise<void>)
) {
    const lifecycle: KillSessionLifecycle = typeof lifecycleOrCleanup === 'function'
        ? { cleanupAndExit: lifecycleOrCleanup }
        : lifecycleOrCleanup;

    rpcHandlerManager.registerHandler<KillSessionRequest, KillSessionResponse>(RPC_METHODS.KillSession, async (request) => {
        logger.debug('Kill session request received');

        // Stamp the archive reason before cleanup. A hub-restart-cascade
        // SIGTERM does not go through this handler, so those archives keep
        // the runner lifecycle's separate `Hub restart` reason.
        const requestedReason = typeof request?.reason === 'string'
            ? request.reason.trim().slice(0, 200)
            : '';
        lifecycle.setArchiveReason?.(requestedReason || 'User terminated');

        // This will start the cleanup process
        void lifecycle.cleanupAndExit();

        // We should still be able to respond to the client, though they
        // should optimistically assume the session is dead.
        return {
            success: true,
            message: 'Killing hapi CLI process'
        };
    });
}
