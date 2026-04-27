import { describe, expect, it } from 'vitest';
import { CODEX_EMPTY_COMPLETION_NOTICE, EmptyCompletionNoticeTracker } from './emptyCompletionNotice';

describe('EmptyCompletionNoticeTracker', () => {
    it('creates a notice when a turn completes after tool output without an assistant reply', () => {
        const tracker = new EmptyCompletionNoticeTracker();

        tracker.onTaskStarted();
        tracker.onConvertedMessage({
            type: 'tool-call-result',
            callId: 'call-1',
            output: 'ok',
            id: 'result-1'
        });

        const notice = tracker.maybeCreateNotice({ type: 'task_complete', last_agent_message: null });

        expect(notice).toMatchObject({
            type: 'message',
            message: CODEX_EMPTY_COMPLETION_NOTICE
        });
    });

    it('does not create a notice when an assistant reply follows tool output', () => {
        const tracker = new EmptyCompletionNoticeTracker();

        tracker.onTaskStarted();
        tracker.onConvertedMessage({
            type: 'tool-call-result',
            callId: 'call-1',
            output: 'ok',
            id: 'result-1'
        });
        tracker.onConvertedMessage({
            type: 'message',
            message: 'done',
            id: 'message-1'
        });

        expect(tracker.maybeCreateNotice({ type: 'task_complete', last_agent_message: null })).toBeNull();
    });

    it('does not create duplicate notices for the same empty completion', () => {
        const tracker = new EmptyCompletionNoticeTracker();

        tracker.onConvertedMessage({
            type: 'tool-call',
            name: 'Shell',
            callId: 'call-1',
            input: {},
            id: 'call-1'
        });

        expect(tracker.maybeCreateNotice({ type: 'task_complete' })).not.toBeNull();
        expect(tracker.maybeCreateNotice({ type: 'task_complete' })).toBeNull();
    });
});
