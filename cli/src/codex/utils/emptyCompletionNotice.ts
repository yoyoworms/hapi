import type { CodexMessage } from './codexEventConverter';
import { randomUUID } from 'node:crypto';

export const CODEX_EMPTY_COMPLETION_NOTICE = 'Codex 本轮已结束，但没有生成最终回复。上一步停在工具结果之后，可能是 Codex 提前结束；可以发送“继续”让它从这里接着完成。';

type TerminalEvent = {
    type?: unknown;
    last_agent_message?: unknown;
    lastAgentMessage?: unknown;
};

export class EmptyCompletionNoticeTracker {
    private toolActivitySinceAssistantMessage = false;

    onTaskStarted(): void {
        this.toolActivitySinceAssistantMessage = false;
    }

    onConvertedMessage(message: CodexMessage): void {
        if (message.type === 'message') {
            this.toolActivitySinceAssistantMessage = false;
            return;
        }

        if (message.type === 'tool-call' || message.type === 'tool-call-result') {
            this.toolActivitySinceAssistantMessage = true;
        }
    }

    maybeCreateNotice(event: TerminalEvent): CodexMessage | null {
        if (event.type !== 'task_complete') {
            return null;
        }

        const lastAgentMessage = event.last_agent_message ?? event.lastAgentMessage;
        if (typeof lastAgentMessage === 'string' && lastAgentMessage.trim().length > 0) {
            this.toolActivitySinceAssistantMessage = false;
            return null;
        }

        if (!this.toolActivitySinceAssistantMessage) {
            return null;
        }

        this.toolActivitySinceAssistantMessage = false;
        return {
            type: 'message',
            message: CODEX_EMPTY_COMPLETION_NOTICE,
            id: randomUUID()
        };
    }
}
