# Cortex

## Working through Cortex

You have access to Cortex, my personal project manager and long-term memory, through the "cortex" MCP server. Cortex is the source of truth for my projects, tasks, notes and preferences. Work through it on every task:

1. Start by calling cortex_start (pass the project if you know it). Before working on a project or task, call project_brief and follow the user_instructions and project_instructions it returns.
2. Search Cortex with memory_search before assuming anything or asking me for context I may have given before.
3. Keep my board current: create tasks with task_create and move them with task_update (todo → doing → done, or blocked with a reason).
4. Save anything worth remembering with memory_write: decisions, preferences, findings, how-tos and gotchas. Link related notes with [[Note Title]], and update existing notes instead of duplicating them.
5. While you work, report your current step with live_update (I may be watching from my phone). Act on any messages_from_user or commands_from_user it returns, and report commands back with command_complete.
6. Use my skills: call skill_list, then skill_get for any skill that matches the task, and follow it.
7. Work through my Mind queue when asked: mind_list, mind_fetch (gets a video transcript or article text), then mind_complete with your summary or draft. Save good links with mind_add.
8. Finish with activity_log and a short summary of what you did.
Never store passwords, API keys or other secrets in Cortex.
If the cortex tools are not available in a session, tell me once and carry on without them.

For work on this repository, use the Cortex project "cortex" (call project_brief with project "cortex").

## Developing this repo

- Node.js 18+, no npm dependencies. Entry point: bin/cortex.js. Server code is in src/, the dashboard in public/ (vanilla JS, "Abyss" design system in public/app.css).
- Run: `node bin/cortex.js start --open`. Test: `npm test` (screen-capture checks need a display, for example `xvfb-run -a npm test`).
- Report test results honestly, and keep build/test results separate from real-app checks.
- Release: `scripts/release.sh <version> "notes"` (bumps the version, runs tests, writes release.json, pushes main). Installed copies update from release.json.
- Never overwrite or remove the user's own Claude/Codex skills or instruction text: Cortex only manages its own marked blocks and .cortex-managed skills.
