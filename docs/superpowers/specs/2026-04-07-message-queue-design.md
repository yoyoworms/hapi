# Message Queue: Send Multiple Messages to Claude

**Date:** 2026-04-07
**Status:** Approved

## Problem

Users can only send one message at a time. The input is blocked while Claude is responding. Users want to queue up multiple messages that get sent to Claude one by one after each response.

## Design: Web Queue on Top of Existing Ordering Guarantees

Queue state and dispatch policy live in the web UI, but they depend on existing Hub/CLI ordering safeguards. Today `syncEngine.sendMessage()` flushes the CLI outgoing message queue before storing a new user message, and Claude remote launcher exposes `flushQueue` that waits for queued assistant output to ack. This feature should reuse that path. No new protocol or RPC changes are required.

### Message Queue Store

New file: `web/src/lib/message-queue-store.ts`

Simple in-memory store keyed by sessionId:

```typescript
interface QueuedMessage {
  localId: string
  text: string
  attachments?: AttachmentMetadata[]
  createdAt: number
  phase: 'queued' | 'paused'
}

interface SessionQueueState {
  items: QueuedMessage[]
  inFlightLocalId: string | null
  resolvingSession: boolean
}

// Map<sessionId, SessionQueueState>
```

Methods:
- `enqueue(sessionId, message)` — add message to end of queue
- `peek(sessionId)` — return first queued message without removing it
- `dequeue(sessionId)` — remove and return first queued message
- `cancel(sessionId, localId)` — remove specific queued/paused message
- `clearAll(sessionId)` — remove queued/paused messages only
- `pauseQueue(sessionId)` — set queued messages to `paused`
- `resumeQueue(sessionId)` — set paused messages back to `queued`
- `moveSession(fromSessionId, toSessionId)` — move queue state after `resolveSessionId()` returns a new session id
- `getState(sessionId)` — return queue + dispatcher state
- `subscribe(sessionId, callback)` — notify on queue changes

### Send Flow (useSendMessage hook)

Current: blocks send when `mutation.isPending`.

New:
1. User sends message
2. If a local dispatch is already in flight, session resolution is in progress, or Claude still owns the turn (`session.thinking === true` / thread running), enqueue the message and show an optimistic bubble immediately
3. If the dispatcher is idle, run the same pipeline as today:
   - resolve inactive session via the existing `resolveSessionId` flow
   - if resolution returns a new session id, migrate queue/message-window state to that id
   - fetch latest messages
   - call `api.sendMessage()`
4. When a queued item is dequeued, remove it from the queue, clear its queue phase, and mark its optimistic message `status: 'sending'`
5. Only one item per session may be in local dispatch at a time

### Auto-Dequeue Trigger

Do not rely only on `session.thinking` transitions. Drain attempts should run when:
- `thinking` transitions `true → false`
- local dispatch / session-resolution work finishes and the dispatcher becomes idle
- the session mounts, reconnects, or switches while queued items already exist and the session is idle

Dequeue only when there is no in-flight local send and Claude is not currently thinking. This prevents rapid double-submit gaps and avoids stranded queues after reconnects or resume flows.

### UI: Queued Message Style

Queued state must be exposed through the same message metadata path that `UserMessage.tsx` already reads. Current `MessageStatus` only supports `sending | sent | failed`, so this design must either extend that type or add a separate `queuePhase` field in assistant-runtime / message-window metadata.

UI states:
- `queued`: semi-transparent opacity (0.6) + dashed left border + "排队中" / "Queued" label
- `paused`: queued styling + paused/error label
- `sending`: normal style with existing sending indicator after the item leaves the queue

### UI: Cancel Controls

Single message cancel:
- X button only on queued/paused message bubbles
- Calls `queue.cancel(sessionId, localId)` and removes optimistic message from chat

Clear all:
- When queue has queued/paused items, show bar above input: "{N} messages queued · Clear all"
- Calls `queue.clearAll(sessionId)` and removes queued/paused optimistic messages only
- Already-dispatched `sending` messages are not canceled; current stack does not support aborting a user send request after it reaches the API

### Error Handling

When a queued item reaches the head of the queue:
- If the session is inactive, first run the existing `resolveSessionId` / `resumeSession()` path
- If session resolution fails, leave the current item and remaining queued items as `paused`
- If `sendMessage` fails after dispatch, mark the in-flight optimistic message `failed` via the existing send flow, then pause the remaining queued items
- Show bar above input: "Send failed. Queue paused. [Resume] [Clear]"
- Resume: retry the paused head item through the same resolve → fetch latest → send pipeline
- Clear: remove queued/paused messages

### Files Changed

| File | Change |
|------|--------|
| `web/src/lib/message-queue-store.ts` | **New** — queue + per-session dispatcher state |
| `web/src/hooks/mutations/useSendMessage.ts` | Replace hard pending block with enqueue/dequeue dispatcher; preserve `resolveSessionId` flow |
| `web/src/components/SessionChat.tsx` | Trigger drain when Claude turn completes or the session becomes idle |
| `web/src/lib/message-window-store.ts` | Helpers to mark/remove queued optimistic messages |
| `web/src/lib/assistant-runtime.ts` | Expose queue phase/status to `UserMessage.tsx` |
| `web/src/components/AssistantChat/messages/UserMessage.tsx` | Queued/paused styling + cancel affordance |
| `web/src/components/AssistantChat/HappyComposer.tsx` | Queue indicator bar + resume/clear controls |
| `web/src/types/api.ts` | Extend message status or add queue metadata type |

### Out of Scope

- Queue persistence across page refresh
- Multi-device queue sync
- New Hub/CLI protocol changes
