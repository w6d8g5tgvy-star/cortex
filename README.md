# ◆ Cortex

**A local project manager and long-term memory that you and your AI agents share.**

Cortex runs on your own computer. It gives you a dashboard in your browser with projects, a task board, notes and a knowledge graph. It also includes an **MCP server**, so Claude, Cursor, Codex, VS Code and other AI agents can read and write the same projects, tasks and memories.

- **Dashboard:** home overview, projects, drag-and-drop board, Markdown memory editor with live preview, knowledge graph, agent activity feed, and a command palette (`Ctrl K`).
- **Obsidian-compatible vault:** every project, task and note is a plain `.md` file with front-matter. `[[wikilinks]]`, backlinks and `#tags` work. You can open the vault in Obsidian, and edits from either side sync within about 2 seconds.
- **MCP server:** 17 tools for agents. It runs over **stdio** for desktop apps and over **Streamable HTTP** at `http://127.0.0.1:7777/mcp`.
- **Agent activity log:** every change an agent makes is recorded and shown live, so you can see what each agent did.
- **Phone access and live view:** pair your phone by scanning a QR code. You can then watch your **computer's screen** and every agent's current step live, send agents messages, and manage tasks from anywhere.
- **Automatic updates:** Cortex checks for new versions, installs them, restarts itself, and rolls back automatically if a new version fails to start.
- **No dependencies:** you only need Node.js 18 or newer. Nothing to `npm install`, no database and no cloud. Your data stays on your machine.

---

## 1. Install

1. Install **Node.js 18+** from <https://nodejs.org> (the LTS version is fine).
2. Unzip the `cortex` folder somewhere permanent, for example `Documents/cortex`.
3. Start it with one of these options:

| OS | Easiest | Terminal |
|----|---------|----------|
| **Windows** | Double-click `Start Cortex.bat` | `node bin\cortex.js` |
| **macOS** | Double-click `Start Cortex.command` (the first time, right-click → Open) | `node bin/cortex.js` |
| **Linux** | `./start-cortex.sh` | `node bin/cortex.js` |

The dashboard opens at **<http://127.0.0.1:7777>**. Your vault is created at `~/Cortex`.

**Optional:** install the `cortex` command globally so you can run it from anywhere:

```bash
cd path/to/cortex
npm install -g .
cortex            # start dashboard
cortex config     # print MCP setup snippets for every tool
```

**Make it feel like a desktop app:** in Chrome or Edge, click the install icon in the address bar (or menu → *Install Cortex*). Cortex then gets its own window and an icon in your dock or taskbar.

---

## 2. Connect your AI agents (MCP)

Open the **Agents** tab in the dashboard. It shows copy-paste configs with the correct paths for your computer already filled in. You can also run `cortex config` (or `node bin/cortex.js config`) in a terminal.

There are two ways for an agent to connect:

| Mode | How | Use when |
|------|-----|----------|
| **stdio** | The AI app launches `node /path/to/cortex/bin/cortex.js mcp` | Claude Desktop, Claude Code, Codex CLI. The dashboard doesn't need to be running. |
| **HTTP** | `http://127.0.0.1:7777/mcp` | Cursor, VS Code, Windsurf, or any client that supports Streamable HTTP. The dashboard must be running. |

Both modes read and write the same vault, so the dashboard updates live whichever one an agent uses.

**Claude Code**

```bash
claude mcp add --scope user cortex -- node /ABSOLUTE/PATH/TO/cortex/bin/cortex.js mcp
```

**Claude Desktop:** Settings → Developer → Edit Config. Add the following, then restart Claude:

```json
{
  "mcpServers": {
    "cortex": { "command": "node", "args": ["/ABSOLUTE/PATH/TO/cortex/bin/cortex.js", "mcp"] }
  }
}
```

**Cursor:** `~/.cursor/mcp.json`

```json
{ "mcpServers": { "cortex": { "url": "http://127.0.0.1:7777/mcp" } } }
```

**VS Code:** `.vscode/mcp.json`

```json
{ "servers": { "cortex": { "type": "http", "url": "http://127.0.0.1:7777/mcp" } } }
```

> On Windows, use double backslashes in JSON paths (`C:\\Users\\you\\cortex\\bin\\cortex.js`) or forward slashes. If `node` is not found, use the full path to `node.exe`. The Agents tab fills these in for you.

**Tip:** add this line to your agent's instructions (for example `CLAUDE.md`):

> Use the Cortex MCP server as your long-term memory and task board. Call `cortex_start` at the beginning of each task, save decisions and learnings with `memory_write`, and keep tasks updated.

### Tools agents get

| Tool | What it does |
|------|--------------|
| `cortex_start` | Loads context: projects, open tasks, pinned and recent memories, recent activity |
| `project_list` / `project_create` / `project_update` | Manage projects |
| `task_list` / `task_get` / `task_create` / `task_update` | Manage the board (status, priority, assignee, due date, progress notes) |
| `memory_write` / `memory_update` / `memory_get` / `memory_delete` | Create, append to, read and delete Markdown notes |
| `memory_search` / `memory_list` / `memory_links` | Full-text search, filtered lists, and graph neighbours (links and backlinks) |
| `activity_log` / `activity_list` | Record and read what agents did |

---

## 3. Use it from your phone

1. On your computer, open **Settings → Phone access** and turn it on. Cortex restarts.
2. Scan the QR code with your phone's camera and open the link. Your phone is now paired.
3. Optional: tap **Share → Add to Home Screen** to get an app icon.
4. To see your computer's screen, also turn on **Settings → Screen sharing**. Open the **Live** tab on your phone. Tap the screen to make it full screen, and tap again to zoom in.

**Connecting from outside your home Wi-Fi:** install the free [Tailscale](https://tailscale.com) app on your computer and your phone and sign in on both. Then pick the *Tailscale* address in the pairing screen. Tailscale encrypts the connection and works on mobile data. Plain Wi-Fi is not encrypted, so only pair on networks you trust.

**Security:**
- A device that hasn't been paired can't open anything.
- Settings, updates and screen sharing can only be changed on the computer itself.
- **Unpair all devices** creates a new pairing code, which disconnects every paired device.
- Whenever a phone is watching your screen, the computer shows a notice.
- On macOS, the first time you use screen sharing, allow *Screen Recording* for Terminal (or Node) in System Settings → Privacy & Security.

### Watch agents live and message them

The **Live** tab shows one card per agent: what it's doing right now, a progress bar, snapshots it shared, an activity log, and a message box.

- **Claude Code (automatic):** run the following, or click *Install* in Settings → Claude Code live view.

  ```bash
  cortex hooks install
  ```

  This adds hooks to `~/.claude/settings.json` (a backup is saved) and installs a `cortex` skill. After that, every step Claude takes streams to your phone. A message you send from the phone is delivered to Claude at its next step. If Claude has already finished its turn, the message makes it keep going. Restart Claude Code after installing.
  - Limit: if Claude is sitting idle and not working, a message waits until the next time you prompt it. Hooks can't wake an idle session.
- **Other MCP agents** (Claude Desktop, Cursor, Codex…) report progress with the `live_update` tool and share images with `live_screenshot`. Cortex's MCP instructions tell them to do this. Any messages you send come back in the `live_update` result.

New agent tools: `live_update`, `live_screenshot` (computer screen, an image file, or base64 image data), and `messages_check`.

## 4. Automatic updates

Cortex updates itself from a GitHub repository where you publish releases:

1. Put this folder in a GitHub repository.
2. In **Settings → Updates**, set the update source to `your-name/your-repo`.
3. To publish a new version, run `scripts/release.sh 1.2.0 "What changed"` (needs the GitHub CLI). It bumps the version, runs the tests, pushes, and creates a release with a checksum.

How running copies handle a new release:
- Every running copy checks every 6 hours (and about 20 seconds after starting).
- It downloads the new version, verifies the checksum, backs up the current version, installs, and restarts.
- If the new version crashes on startup, Cortex restores the backup automatically.
- You can turn off auto-install and update manually with **Check now / Install** or with `cortex update`.
- If you installed with `git clone`, updates use `git pull` instead.
- MCP processes started by AI apps (stdio mode) pick up the new version the next time the AI app restarts them.

## 5. The vault

```
~/Cortex/
  projects/website-redesign.md
  tasks/design-hero-section.md
  notes/brand-colors.md          ← any .md file anywhere in the vault counts as a note
  .cortex/activity.jsonl         ← agent activity log
  .cortex/trash/                 ← deleted items (recoverable)
```

Example task file:

```markdown
---
title: Design hero section
status: doing
priority: high
project: website-redesign
assignee: claude-code
tags: [design]
created: "2026-11-18T19:20:00.000Z"
updated: "2026-11-18T19:31:00.000Z"
---

Wireframes in [[Brand colors]].
```

You can open the vault folder in **Obsidian** (*Open folder as vault*) and use both apps side by side.

---

## Options

```
cortex [start]  --vault <dir>  --port 7777  --host 127.0.0.1  --token <secret>  --open
cortex mcp      --vault <dir>
cortex config
cortex hooks install | uninstall
cortex update
```

You can also set these with environment variables: `CORTEX_VAULT`, `CORTEX_PORT`, `CORTEX_HOST`, `CORTEX_TOKEN`.

**Security:** by default Cortex only listens on `127.0.0.1` (your computer only) and rejects requests from other websites. If you expose it on your network (`--host 0.0.0.0`), also set `--token`. Then open the dashboard once with `?token=...` and give agents the `Authorization: Bearer ...` header.

**Auto-start on login (optional):**
- **macOS:** System Settings → General → Login Items → add `Start Cortex.command`.
- **Windows:** press `Win+R`, type `shell:startup`, and put a shortcut to `Start Cortex.bat` there.
- **Linux:** add `start-cortex.sh` to your desktop's startup applications.

## Test

```bash
npm test      # end-to-end: MCP over stdio + HTTP, REST API, file sync, phone pairing,
              # live sessions, Claude Code hooks, screen capture, update + rollback
```
