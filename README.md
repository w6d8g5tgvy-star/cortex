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

## Quick setup (recommended)

1. Install **Node.js 18+** from <https://nodejs.org>.
2. Unzip this folder somewhere permanent, then double-click **`Setup Cortex.bat`** (Windows) or **`Setup Cortex.command`** (Mac). On Linux, run `./setup-cortex.sh`.
3. Setup then:
   - connects Cortex to Claude Code, Claude Desktop, Cursor, Windsurf and Codex (whichever you have installed);
   - installs the Claude Code live-view hooks;
   - turns on phone access, screen sharing and automatic updates;
   - makes Cortex start when you log in.

   Every file it changes is backed up as `<file>.cortex-backup`.
4. The dashboard opens on Settings. Scan the QR code with your phone, then tap Share → **Add to Home Screen**.
5. Restart your AI apps so they pick up Cortex.

To skip a part, run setup from a terminal with `--no-screen`, `--no-phone` or `--no-autostart`, for example `node bin/cortex.js setup --no-screen`.

## 1. Install (manual)

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

**Claude Code** (verified against the Claude Code docs)

```bash
claude mcp add --scope user cortex -- node /ABSOLUTE/PATH/TO/cortex/bin/cortex.js mcp
```

> **Windows:** run that line in **Command Prompt** (`cmd`). In PowerShell, put `cmd /c ` in front of it. The JSON blocks below are **file contents**: paste them into the named config file, never into a terminal. Simplest of all, run `node bin\cortex.js setup` from the Cortex folder, which connects every AI app it finds.

**Claude Desktop** (verified): Settings → Developer → Edit Config opens `claude_desktop_config.json`. Merge this in, save, and restart Claude:

```json
{
  "mcpServers": {
    "cortex": { "command": "node", "args": ["/ABSOLUTE/PATH/TO/cortex/bin/cortex.js", "mcp"] }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`), **Windsurf** (`~/.codeium/windsurf/mcp_config.json`), **VS Code** (`.vscode/mcp.json`) and **Codex** (`~/.codex/config.toml`): the Agents tab shows the exact block for each. I couldn't reach those apps' docs from where Cortex was built, so those are marked "not verified yet" in the app.

**Prompt for your agents.** Paste this into `CLAUDE.md`, ChatGPT custom instructions, or a project's instructions. It's also in Settings → Connect AI apps and in `cortex config`:

```
You have access to Cortex, my personal project manager and long-term memory, through the "cortex" MCP server.
Start every task with cortex_start / project_brief, search memory before asking me, keep tasks current,
save what you learn with memory_write, report progress with live_update, use my skills (skill_list / skill_get),
and finish with activity_log.
```

### Tools agents get (30)

| Tool | What it does |
|------|--------------|
| `cortex_start` / `project_brief` | Load the user's instructions, the project's instructions, project + system memories, open tasks, recent agent work |
| `project_*` / `task_*` | Manage projects (incl. agent instructions and code folder) and the board |
| `memory_write` / `memory_update` / `memory_get` / `memory_delete` | Notes: with a project → `notes/<project>/`, without → system memory |
| `memory_search` / `memory_list` / `memory_links` | Ranked search (project + system scope), lists, graph neighbours |
| `live_update` / `live_screenshot` / `messages_check` | Report progress live, share screenshots, receive your messages |
| `command_complete` | Report back on a command you sent from Cortex |
| `mind_list` / `mind_add` / `mind_fetch` / `mind_complete` | Work through videos to watch, articles to read and articles to write |
| `skill_list` / `skill_get` / `skill_save` | Your skills library |
| `activity_log` / `activity_list` / `daily_briefing` | Record and review what happened |

## Memory: project vs system

| | Lives in | Given to agents |
|---|---|---|
| **Project memories** | `notes/<project>/` (every project gets its own folder) | Only when working on that project |
| **System memories** | `notes/` (no project) | On every project |

Changing a memory's project moves its file. A file you drop into a project folder (for example from Obsidian) belongs to that project. The Memory vault and the Neural map both have **Project memories / System memories** tabs.

## How Cortex makes agents record their work

- **The agent journal is guaranteed.** Cortex writes `notes/<project>/agent-journal.md` itself, so it doesn't rely on the agent. It records:
  - every Claude Code turn (what was asked, files changed, commands run, whether memory was saved, and the outcome);
  - every run started from Cortex;
  - every action any connected agent takes on the project.
- **Claude Code reads Cortex automatically.** At session start a hook injects the project brief, worked out from the folder Claude is in (set a project's *code folder*). Related memories are added to each prompt.
- **The save gate.** If Claude changed things but saved nothing, its first attempt to finish is blocked with a request to save what it learned.
- **Knowledge health** on the Home page shows, per project, whether agents are recording and saving.
- **Limits:** other apps (ChatGPT, Cursor…) still get journaled and receive the setup prompt, but Cortex can only enforce reading and saving through Claude Code's hooks. No tool can force a model to actually think with what it's given.

## Command agents (from the computer or your phone)

- **Start an agent** (Agents tab, or *Send to an agent* on any task or project). This runs Claude Code (`claude -p`) or Codex in an allowed folder.
  - The agent receives the full Cortex brief; you can preview it first.
  - Its progress streams to Live and its result lands in the journal and the task.
  - You can stop it, or **continue** a finished Claude Code chat.
  - Turn it on in Settings → Agent control, and list the folders agents may work in.
- **Send a command** to any connected agent. It's delivered the next time the agent checks in, and the result comes back.
- **Phone approvals:** turn on *Approve permission requests from Cortex*, and Claude Code's permission prompts appear on Live and your phone with Allow and Deny buttons.
- **Chats & sessions:** every agent conversation is listed with search, project, agent and status filters, plus rename, tag, pin and archive.

## Mind

Paste a video link, an article link, or a topic you want written.

- **Videos:** Cortex fetches the title, channel, description and transcript. Install [yt-dlp](https://github.com/yt-dlp/yt-dlp) for reliable transcripts from most sites. AI can't literally watch video, so the transcript is what it reads.
- **Articles:** Cortex fetches the readable text.
- **Summaries:** an agent summarises the item, and the summary becomes a linked memory.
- **Safety:** links to your own computer or home network are refused.

## Skills

- **Write once, use everywhere.** Write a skill once, then:
  - **Add** it to Claude Code or Codex (written to `~/.claude/skills/<name>/SKILL.md`);
  - download a **.zip for Claude.ai** (Customize → Skills → + → Create skill → Upload a skill);
  - **copy instructions for ChatGPT**.
- **Add-only.** Cortex marks the skills it adds and never overwrites or removes skills you made yourself. Your existing Claude Code skills can be imported as read-only reference copies.
- **Shared with agents.** Every connected agent can browse skills with `skill_list` / `skill_get`.

## Connect cloud apps (claude.ai, ChatGPT)

- **Getting a public address.** Cloud apps need a public https address. In Settings → Connect AI apps, *Create public link* starts a free Cloudflare quick tunnel (needs [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
- **claude.ai** (verified against Claude's help pages): Customize → Connectors → + Add → Add custom connector → paste the secret connector URL → *No sign in*.
- **ChatGPT:** add the same URL as a developer-mode connector. Its exact menus weren't verifiable from here.
- **Keep the link secret.** It gives full access to your vault. *New secret link* invalidates the old one.

## More

- **Daily briefing** on Home: what agents did, what was completed, what needs you. Save it as a memory with one click.
- **Memory gardener** (`/api/garden`, or ask an agent): finds duplicates, orphans and stale notes. The agent writes proposals; nothing is changed without you.
- **Better search:** ranked search that understands word variants (*deploying* finds *deployment*). Optional meaning-based search through a local [Ollama](https://ollama.com) model (`ollama pull nomic-embed-text`).
- **Templates:** Software, Research, Content, Minecraft mod, Personal. Each comes with instructions, starter tasks and project memories.
- **History and backups:** every note keeps its last 30 versions (History button in the editor), and a daily vault zip goes to `.cortex/backups` (last 14 kept).

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
npm test      # 41 end-to-end checks: MCP (stdio + HTTP), REST API, file sync, phone pairing, live sessions,
              # hooks (brief, recall, save gate, approvals), agent launcher, commands, memory scopes,
              # journal, Mind, add-only skills, connector, templates, history, backups, search, updates
```
