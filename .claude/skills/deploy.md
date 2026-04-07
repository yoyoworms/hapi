---
name: deploy
description: Build and deploy HAPI (hub, web, CLI) to production server
user_invocable: true
---

# HAPI Deploy Skill

Deploy HAPI components to the production server at hapi.1to10.cn.

## What to deploy

Accept optional arguments to specify what to deploy:
- `/deploy` or `/deploy all` — deploy hub + web + CLI (default)
- `/deploy hub` — deploy hub only
- `/deploy web` — deploy web only
- `/deploy cli` — deploy CLI binary only
- `/deploy hub web` — deploy hub and web

## Deploy Steps

### 1. Build Number (web only)

Before building web, increment the build number:
```bash
# Read current build number
cat web/build-number.json
# Increment and write back
# e.g. { "build": 2 } → { "build": 3 }
```

### 2. Build

```bash
# Hub
bun run build:hub

# Web
bun run build:web

# CLI (macOS arm64 binary)
cd cli && bun run build:exe
```

### 3. Deploy

```bash
# Hub — copy bundle to server and restart
scp hub/dist/index.js ubuntu@hapi.1to10.cn:~/hapi-custom/index.js
ssh ubuntu@hapi.1to10.cn "pm2 restart hapi-hub"

# Web — rsync to server
rsync -az --delete web/dist/ ubuntu@hapi.1to10.cn:~/hapi-custom/web/dist/

# CLI — replace local binary and codesign
cp cli/dist-exe/bun-darwin-arm64/hapi /opt/homebrew/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-darwin-arm64/bin/hapi
codesign -s - -f /opt/homebrew/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-darwin-arm64/bin/hapi
```

### 4. Restart sessions (CLI only)

After replacing CLI binary, kill all existing session processes so runner restarts them with the new binary:
```bash
ps aux | grep 'hapi.*claude' | grep -v grep | awk '{print $2}' | xargs kill 2>/dev/null
```

### 5. Report

After deployment, report:
- What was deployed (hub/web/cli)
- New version number (from `web/build-number.json` or `cli/package.json`)
- Any errors encountered

## Important Notes

- Hub deploy path is `~/hapi-custom/index.js` (NOT `hub/dist/index.js` on server)
- Web deploy path is `~/hapi-custom/web/dist/`（hub 的 `findWebappDistDir` 查找 `{cwd}/web/dist`）
- CLI binary path is `/opt/homebrew/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-darwin-arm64/bin/hapi`
- Always codesign the CLI binary after copying (macOS requirement)
- The zhengshu namespace uses `/Users/luxiang/.local/bin/claude` (native Claude CLI), not the HAPI binary
