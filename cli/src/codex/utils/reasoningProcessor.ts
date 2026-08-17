/**
 * Accumulates the user-readable Codex reasoning summary.
 *
 * Reasoning is not a tool lifecycle. In particular, markdown summary headings
 * must not become synthetic CodexReasoning calls, and summary part boundaries
 * must not create canceled tool results. The completed summary is emitted once
 * as a regular, collapsible reasoning message.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

export interface ReasoningToolCall {
    type: 'tool-call';
    name: 'CodexReasoning';
    callId: string;
    input: {
        title: string;
    };
    id: string;
}

export interface ReasoningToolResult {
    type: 'tool-call-result';
    callId: string;
    output: {
        content?: string;
        status?: 'completed' | 'canceled';
    };
    id: string;
}

export interface ReasoningMessage {
    type: 'reasoning';
    message: string;
    id: string;
}

export type ReasoningOutput = ReasoningToolCall | ReasoningToolResult | ReasoningMessage;

export class ReasoningProcessor {
    private accumulator = '';
    private onMessage: ((message: any) => void) | null = null;

    constructor(onMessage?: (message: any) => void) {
        this.onMessage = onMessage || null;
        this.reset();
    }

    /**
     * Set the message callback for sending messages directly
     */
    setMessageCallback(callback: (message: any) => void): void {
        this.onMessage = callback;
    }

    /**
     * Process a reasoning section break - indicates a new reasoning section is starting
     */
    handleSectionBreak(): void {
        // A summary part boundary is normal streaming progress, not a canceled
        // operation. Retain a readable boundary only for the delta fallback.
        if (this.accumulator.length > 0 && !this.accumulator.endsWith('\n')) {
            this.accumulator += '\n';
        }
        logger.debug('[ReasoningProcessor] Summary section break');
    }

    /**
     * Process a reasoning delta and accumulate content
     */
    processDelta(delta: string): void {
        this.accumulator += delta;
    }

    /**
     * Complete the reasoning section with final text
     */
    complete(fullText: string): void {
        const summary = fullText.trim().length > 0 ? fullText : this.accumulator;
        if (summary.trim().length > 0) {
            const reasoningMessage: ReasoningMessage = {
                type: 'reasoning',
                message: summary,
                id: randomUUID()
            };
            logger.debug('[ReasoningProcessor] Sending reasoning message');
            this.onMessage?.(reasoningMessage);
        }

        this.resetState();
    }

    /**
     * Abort the current reasoning section
     */
    abort(): void {
        logger.debug('[ReasoningProcessor] Abort called');
        this.resetState();
    }

    /**
     * Reset the processor state
     */
    reset(): void {
        this.resetState();
    }

    /**
     * Reset internal state
     */
    private resetState(): void {
        this.accumulator = '';
    }

    /**
     * Get the current call ID for tool result matching
     */
    getCurrentCallId(): string | null {
        return null;
    }

    /**
     * Check if a tool call has been started
     */
    hasStartedToolCall(): boolean {
        return false;
    }
}
