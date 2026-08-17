import { describe, expect, it } from 'vitest';
import { ReasoningProcessor, type ReasoningOutput } from './reasoningProcessor';

describe('ReasoningProcessor', () => {
    it('does not turn a streamed summary title into a tool card', () => {
        const messages: ReasoningOutput[] = [];
        const processor = new ReasoningProcessor((message) => messages.push(message));

        processor.processDelta('**Checking');
        processor.processDelta(' files**');
        processor.processDelta('\nReviewing the implementation.');

        expect(messages).toEqual([]);
        expect(processor.getCurrentCallId()).toBeNull();
        expect(processor.hasStartedToolCall()).toBe(false);
    });

    it('emits one collapsible reasoning summary and preserves its title', () => {
        const messages: ReasoningOutput[] = [];
        const processor = new ReasoningProcessor((message) => messages.push(message));
        const summary = '**Checking files**\nReviewed the converter.\n**Running tests**\nAll focused tests pass.';

        processor.processDelta('**Checking files**\nReviewed the converter.');
        processor.handleSectionBreak();
        processor.processDelta('**Running tests**\nAll focused tests pass.');
        processor.complete(summary);

        expect(messages).toEqual([{
            type: 'reasoning',
            message: summary,
            id: expect.any(String)
        }]);
        expect(messages.some((message) => message.type === 'tool-call' || message.type === 'tool-call-result')).toBe(false);
    });

    it('treats a section break as a summary boundary rather than cancellation', () => {
        const messages: ReasoningOutput[] = [];
        const processor = new ReasoningProcessor((message) => messages.push(message));

        processor.processDelta('First summary part');
        processor.handleSectionBreak();
        processor.processDelta('Second summary part');
        processor.complete('');

        expect(messages).toEqual([{
            type: 'reasoning',
            message: 'First summary part\nSecond summary part',
            id: expect.any(String)
        }]);
    });

    it('does not emit partial summaries when aborted or reset', () => {
        const messages: ReasoningOutput[] = [];
        const processor = new ReasoningProcessor((message) => messages.push(message));

        processor.processDelta('Partial summary before abort');
        processor.abort();
        processor.processDelta('Partial summary before reset');
        processor.reset();

        expect(messages).toEqual([]);
        expect(processor.getCurrentCallId()).toBeNull();
        expect(processor.hasStartedToolCall()).toBe(false);
    });

    it('does not emit an empty completion', () => {
        const messages: ReasoningOutput[] = [];
        const processor = new ReasoningProcessor((message) => messages.push(message));

        processor.complete('   ');

        expect(messages).toEqual([]);
    });
});
