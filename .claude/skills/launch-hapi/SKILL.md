---
name: launch-hapi
description: Launch HAPI (hapi) in a tmux session for a project directory. Use when the user asks to "启动hapi", "打开hapi", "launch hapi", "start hapi in tmux", "打开hapi", or wants to open a HAPI/hapi yolo session in a project folder.
argument-hint: [project-name-or-path]
---

# Launch HAPI in tmux

Start a HAPI (`hapi`) CLI session inside a new tmux window for a given project.

## Workflow

1. **Resolve project directory**
   - If `$ARGUMENTS` is provided, treat it as a project name or path
   - Search common workspace locations: `~/workspace/`, `~/workspace/youkeda/`, `~/workspace/claude/`
   - If multiple matches found, ask the user to pick one
   - If no match, ask the user for the correct path

2. **Check for existing tmux session**
   ```bash
   tmux has-session -t <session-name> 2>/dev/null
   ```
   - If a session already exists with the same name, capture its output to check status
   - If HAPI is already running inside, inform the user and skip — do not create a duplicate
   - If the session exists but HAPI is not running, reuse the session

3. **Create tmux session and launch HAPI**
   ```bash
   tmux new-session -d -s <session-name> -c <project-directory>
   tmux send-keys -t <session-name> 'hapi --yolo' Enter
   ```
   - Session name defaults to the project folder name (e.g., `game-trade`, `zhengshu`)
   - If the session name conflicts with an existing one, append a number (e.g., `Claude2`)

4. **Handle trust prompt**
   - Wait ~5 seconds for Claude Code to start
   - Capture the tmux pane output to check for the "trust this folder" prompt
   - If the trust prompt appears, send `Enter` to confirm
   - Wait another ~5 seconds for HAPI to fully initialize

5. **Verify startup**
   - Capture tmux output and confirm HAPI is running (look for model info, context percentage, or the input prompt `>`)
   - Report the result to the user: session name, directory, model, and how to attach

## Special cases

- **Separate namespace**: If the user specifies a namespace token (e.g., `fish2026abc:zhengshu`), launch with separate `HAPI_HOME` and `CLI_API_TOKEN`:
  ```bash
  HAPI_HOME=~/.hapi-<project-name> CLI_API_TOKEN=<token> hapi --yolo
  ```

- **Custom flags**: Pass through any additional flags the user mentions (e.g., `--model`, no `--yolo`)

## Notes

- The CLI command is `hapi`, not `hapi`
- Always use `hapi --yolo` unless the user specifies otherwise
- Report the tmux attach command at the end: `tmux attach -t <session-name>`
