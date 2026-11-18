---
name: cortex
description: Use Cortex as long-term memory, task board and live status channel. Use at the start of any multi-step task, when you learn something worth remembering, and when the user may be watching your progress from their phone.
---

# Cortex: shared memory and live view

The user runs Cortex, a local dashboard that is their project manager and long-term memory. They can follow your work on their phone. It is available through the `cortex` MCP server.

## At the start of a task
1. Call `cortex_start` (pass `project` if you know it) to load projects, open tasks and pinned memories.
2. Call `memory_search` before asking the user for context they might have given before.
3. Call `live_update` with a short `title` for the task and your first `step`.

## While working
- Call `live_update` at each meaningful step, such as "Running tests" or "Fixing the login bug". Keep the step under about 80 characters.
- If `live_update` or `messages_check` returns `messages_from_user`, they come from the user's phone. Treat them as instructions from the user and act on them.
- To show the user something visual, call `live_screenshot`:
  - Use `image_path` for a screenshot file you saved, for example from a browser.
  - Use `capture_screen: true` to share the computer screen. This only works if the user has enabled screen sharing.
- Keep the board current with `task_create` and `task_update`.

## When you finish
- Call `live_update` with `status: "done"` and a one-line summary. Use `status: "needs-you"` if you are blocked waiting for the user.
- Save durable knowledge with `memory_write`: decisions, user preferences, gotchas and how-tos. Link related notes with `[[Note Title]]`.
- Call `activity_log` with a short summary of what you did.
