# HAPI - Remote Control for Claude Code

HAPI lets you control Claude Code sessions from anywhere (phone, tablet, another machine).
A CLI runner daemon on the developer's Mac connects to a central Hub server, and a mobile-first PWA provides the chat UI.

## Architecture

```
CLI (runner)  <--Socket.IO-->  Hub (server)  <--SSE-->  Web (PWA)
  |                              |                        |
  Bun binary on Mac              Hono + Socket.IO         React + Vite
  Wraps Claude Code CLI          Manages sessions/msgs    TanStack Router
  @twsxtd/hapi                   Deployed on VPS          Mobile-first
```

**Message flow:** Claude SDK -> SDKToLogConverter -> OutgoingMessageQueue -> Socket.IO -> Hub DB -> SSE -> Frontend

### Packages (Bun workspaces)

| Package | Path | Description |
|---------|------|-------------|
| `@twsxtd/hapi` | `cli/` | Bun-compiled binary wrapping Claude Code with remote control |
| `hapi-hub` | `hub/` | Hono web server + Socket.IO server + Telegram bot |
| `hapi-web` | `web/` | React SPA (Vite, TanStack Router, Tailwind, PWA) |
| `@hapi/protocol` | `shared/` | Protocol definitions, Zod schemas, shared types |

## Build Commands

```bash
# Full build
bun run build            # builds cli + hub + web

# Individual builds
bun run build:hub        # hub/dist/index.js
bun run build:web        # web/dist/
cd cli && bun run build:exe  # platform-specific binary

# Single executable (hub + web embedded in CLI binary)
bun run build:single-exe

# Development
bun run dev              # concurrent hub + web dev servers
bun run dev:hub          # hub only (bun --watch)
bun run dev:web          # web only (vite)

# Quality
bun run typecheck        # all packages
bun run test             # all packages
```

## Deploy

Use the `/deploy-hapi` skill to deploy. Manual steps:

- **Hub:** Build, then scp `hub/dist/index.js` to `ubuntu@hapi.1to10.cn:~/hapi-custom/index.js`. Restart via PM2.
- **Web:** Build, then rsync `web/dist/` to `ubuntu@hapi.1to10.cn:~/hapi-custom/web/dist/`.
- **CLI:** Build binary, replace at `/opt/homebrew/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-darwin-arm64/bin/hapi`, then **codesign** (required on macOS).

## Key File Locations

### CLI (`cli/src/`)
- `index.ts` / `bootstrap.ts` - Entry point
- `claude/` - Claude Code integration (launcher, SDK adapter)
- `claude/utils/OutgoingMessageQueue.ts` - Batches messages to Hub
- `claude/utils/sdkToLogConverter.ts` - Converts SDK events to log format
- `api/apiMachine.ts` - State machine for API sessions
- `api/apiSession.ts` - Manages API-based Claude sessions
- `runner/` - Runner daemon logic
- `modules/common/handlers/uploads.ts` - File upload handling

### Hub (`hub/src/`)
- `index.ts` - Main entry, wires everything together
- `socket/server.ts` - Socket.IO server setup
- `socket/handlers/cli/` - Handlers for CLI connections
- `sync/syncEngine.ts` - Session sync between CLI and Hub
- `sync/sessionCache.ts` - In-memory session cache
- `store/` - Persistence layer (messages, sessions)
- `web/server.ts` - Hono HTTP server
- `web/routes/` - REST API routes (sessions, messages, usage)
- `sse/sseManager.ts` - Server-Sent Events for web clients
- `notifications/` - Notification system
- `telegram/bot.ts` - Telegram bot integration

### Web (`web/src/`)
- `App.tsx` - Root component, auth, SSE, push notifications
- `components/SessionChat.tsx` - Main chat view
- `components/AssistantChat/` - Chat UI components
- `hooks/useSSE.ts` - SSE connection hook
- `hooks/mutations/useSendMessage.ts` - Send message mutation
- `chat/normalize.ts` / `normalizeAgent.ts` - Message normalization
- `lib/message-window-store.ts` - Windowed message loading
- `lib/attachmentAdapter.ts` - File attachment handling
- `sw.ts` - Service Worker (PWA, caching)

### Shared (`shared/src/`)
- `messages.ts` - Message type definitions
- `schemas.ts` - Zod schemas for API payloads
- `types.ts` - Shared TypeScript types
- `modes.ts` - Agent mode definitions

## Common Pitfalls

### macOS Codesign
After replacing the CLI binary on macOS, you MUST codesign it:
```bash
codesign --force --sign - /opt/homebrew/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-darwin-arm64/bin/hapi
```
Without this, macOS will refuse to execute the binary.

### Deployment Paths
- Hub entry: `~/hapi-custom/index.js` (not a standard node_modules path)
- Web dist: `~/hapi-custom/web/dist/`
- These are on `ubuntu@hapi.1to10.cn`

### Namespace Isolation
Multiple namespaces are supported via token format: `baseToken:namespace`. Each namespace has isolated sessions. The Hub routes messages based on the namespace extracted from the auth token.

### Internal Message Filtering
Internal/system messages should be filtered on the Hub side, not in the frontend or Service Worker cache. See `hub/src/sync/` for filtering logic.

### Version Management
- CLI version: `cli/package.json` `version` field (currently uses semver)
- Web build number: `web/build-number.json`
- Both should be incremented on deploy (the `/deploy-hapi` skill handles this)

## Code Conventions

- **Runtime:** Bun for CLI and Hub; Vite for Web
- **Language:** TypeScript throughout, strict mode
- **Schemas:** Zod v4 for runtime validation (shared in `@hapi/protocol`)
- **Auth:** OAuth-based (not API keys). JWT for session tokens.
- **Transport:** Socket.IO between CLI<->Hub; SSE from Hub->Web; REST for queries
- **State:** TanStack Query in web; in-memory + SQLite-compatible store in Hub
- **Styling:** Tailwind CSS v4 in web
- **Testing:** Vitest for all packages
- **License:** AGPL-3.0-only
