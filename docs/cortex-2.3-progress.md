# Cortex 2.3 progress (branch `cortex-2.3`)

Built on top of the released 2.2.0. Not released yet: releasing needs the user's approval.
Saved here because the Cortex connector was unreachable from the cloud session. Copy it into the Cortex checklist
note (`notes/cortex/cortex-2-2-master-implementation-checklist`) when Cortex is back.

## Checklist items finished in this batch
| # | Feature | What was built | Tests |
|---|---|---|---|
| 34 | Visual workflow builder | `src/workflows.js`, `public/workflows-ui.js`. Steps: trigger (manual, schedule, task created/done), AI agent, tool, condition, approval, task, notification, output. Drag-and-drop canvas, 4 templates, free test runs (agents and writes simulated), step-by-step run log, limits on steps, agent runs and minutes | `test/workflows.js` (9) |
| 21 | Unified AI conversations | `src/conversations.js`, `public/chat-ui.js`. Chat page for Claude Code / Codex on this computer, with the Cortex brief, automatic routing, `--resume` while the model stays the same, a fresh session with the transcript on a model or tool switch, attachments, save as memory, handoff to another agent. Only installed tools are offered; ChatGPT and Gemini are not driven from here | `test/conversations.js` (4) |
| 35 | Built-in file editor | `src/fileeditor.js`, `public/files-ui.js`. Project files only (allowed folders), text and code up to 1 MB, autosave, preview, search, newest 30 versions, compare and restore, conflict detection. Never opens .env, keys or files containing tokens. Phones are read-only unless the main computer allows editing | `test/fileeditor.js` (5) |
| 38 | Offline mode | `public/sw.js`, `public/offline-ui.js`. Network first; the saved copy (allow-listed read-only data) is used when offline. New tasks, memories and task edits are queued and replayed in order; an edit to an item changed elsewhere gets a 409 and is reported. The banner lists what needs a connection | `test/offline.js` (5, real browser offline) |
| 33 | Automatic project organization | `src/organize.js`, `public/organize-ui.js`. Suggests tags (your own vocabulary), filing, related links, duplicates, outdated memories, inbox files and task priorities. Apply or dismiss each one. Opt-in auto mode is limited to safe kinds. Nothing is deleted, and edits go through Undo | `test/organize.js` (4) |
| 20 | Effortless device setup | `src/installers.js`, `installers/`. One-file installers for Windows (.cmd), Mac (.command in a .zip) and Linux (.sh): they install Node.js if needed, download Cortex and set it to start at login. "Add a computer" gives a link with a one-time code: the installer pairs first, then sets up the runner or standby. The Linux installer is tested end to end | `test/installers.js` (4) |
| 15 | Universal AI tool manager | `src/toolmanager.js`, `public/tools-ui.js`. Lists the MCP servers across Claude Desktop, Claude Code, Cursor, Windsurf and Codex, health-checks them over a real MCP handshake, and shares a server to other apps in one click. Cortex never stores or shows keys and removes only what it added. Also shows local tools and whether API keys are set | `test/toolmanager.js` (5) |

| (new) | Cloud sync | `src/cloudsync.js`, panel in Settings. One vault shared by all computers and cloud sessions through a private Git repo (free on GitHub). Syncs every 5 minutes and 20 seconds after a change. Edits on two computers keep both versions; timestamp-only differences are ignored. `.cortex` (settings, keys) is never uploaded; tokens in the address are refused. The Windows installer adds Git | `test/cloudsync.js` (5) |

## Bug fixed
- `cortex setup` (run by "Setup Cortex.bat/.command" and the new installers) was broken from 2.1.0 to 2.2.0. The Fetcher 2 merge replaced `src/setup.js`, which caused "run is not a function". The original setup code is restored as `src/appsetup.js`, with a regression test. **It should be released soon (2.2.1 or 2.3.0).**

## Still open
- #10 AI Research Lab, #27 Mobile app experience (push notifications), #28 Voice commands (voice input exists), #17 Independent cloud control center (needs hosting the user chooses; nothing paid is set up automatically).
- Merge the PC Claude's 13-improvement batch once it's pushed.
- Before/after performance comparison and release notes.

## Test status (cloud container, `xvfb-run -a npm test`)
36 suites pass. These are build and test results. Real-app checks on the user's computers haven't been done (Windows and Mac installers were checked for structure only; the Linux installer ran end to end).
