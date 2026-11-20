'use strict';
// Ready-to-paste MCP connection configs for popular AI tools.
const path = require('path');

const AGENT_PROMPT = `Cortex is my project manager and long-term memory. You reach it through the Cortex MCP tools (cortex_start, project_brief, memory_search, memory_write, memory_update, task_create, task_update, live_update, messages_check, command_complete, agent_list, agent_send, activity_log, skill_list, skill_get). Your app may show them with a prefix such as "cortex:" or "mcp__cortex__". What is recorded in Cortex is the source of truth for my projects, tasks, decisions and preferences. Work through it on every task, small ones included.

At the start
1. Call cortex_start, unless a "[Cortex]" brief is already in your context (Claude Code adds one at session start): that brief replaces cortex_start and project_brief. Work out which project this is (from the folder or repo name, or what I said). If none fits, ask me or create one with project_create. Never file work under the wrong project.
2. Call project_brief for that project (and the task, if there is one) and follow its user_instructions and project_instructions. What I say directly in this chat overrides them.
3. Before you ask me for context or assume anything, run memory_search: I have probably told an earlier session already.
4. If cortex_start or messages_check returns commands_from_user, do them and report each one with command_complete. Other AIs (Claude, Codex, ChatGPT) share Cortex with you: answer any messages_from_agents with command_complete, read replies_from_agents, and check agent_list and open tasks so you never duplicate someone else's work. Use agent_send to ask another agent something or hand work over (with the task).
5. Call skill_list. If a skill fits the task, load it with skill_get and follow it.

While you work
6. Keep the board true: task_create for each real piece of new work, task_update to "doing" when you start it, "done" when it is finished and checked, "blocked" with the reason when stuck.
7. Send live_update at each real step (not every tool call): one line on what you are doing now. I may be watching from my phone. Act on any messages_from_user it returns.
8. Save knowledge the moment you learn it with memory_write, filed under the project: decisions and why, how to run, build and test, gotchas and their fixes, and my preferences. Search first and use memory_update rather than creating a duplicate. Link related notes with [[Note Title]]. Save a memory with no project only when it applies to every project (for example my general preferences).

Before you finish (every time)
9. Check that everything worth keeping is saved and the tasks match reality, then call activity_log with one or two sentences: what changed, what you verified, and what is left.

Rules
- Never store passwords, API keys, tokens or connector links in Cortex.
- Say what you verified and what you did not. Never record a guess as a fact.
- For my Mind queue (videos and articles), use mind_list, mind_fetch and mind_complete. Save good links with mind_add.
- If the Cortex tools are missing or fail, tell me once (its connector link may have changed: Cortex → Settings → Connect AI apps), keep working, and save what you would have recorded as soon as the tools are back.`;

function snippets({ vault, port, host, token }) {
  const node = process.execPath;
  const cli = path.resolve(__dirname, '..', 'bin', 'cortex.js');
  const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${h}:${port}/mcp`;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const q = (s) => (/[\s"'$&()]/.test(s) ? `"${s}"` : s);
  const env = { CORTEX_VAULT: vault };

  return {
    agentPrompt: AGENT_PROMPT,
    url,
    node,
    cli,
    items: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        verified: true,
        where: process.platform === 'win32' ? 'Run in Command Prompt (cmd), or in PowerShell prefix it with: cmd /c' : 'Run in your terminal',
        lang: 'bash',
        code: `claude mcp add --scope user cortex --env CORTEX_VAULT=${q(vault)} -- ${q(node)} ${q(cli)} mcp`,
        alt: `claude mcp add --scope user --transport http cortex ${url}${token ? ` --header "Authorization: Bearer ${token}"` : ''}`,
        altLabel: 'Or connect to the running dashboard over HTTP:',
      },
      {
        id: 'claude-desktop',
        name: 'Claude Desktop',
        verified: true,
        where: 'Paste into a FILE, not the terminal: Settings → Developer → Edit Config opens claude_desktop_config.json. Merge this in, save, restart Claude Desktop.',
        lang: 'json',
        code: JSON.stringify({ mcpServers: { cortex: { command: node, args: [cli, 'mcp'], env } } }, null, 2),
      },
      {
        id: 'cursor',
        name: 'Cursor',
        where: '~/.cursor/mcp.json (Cursor Settings → MCP → Add new MCP server). Dashboard must be running for the URL form.',
        verified: false,
        lang: 'json',
        code: JSON.stringify({ mcpServers: { cortex: { url, ...(headers ? { headers } : {}) } } }, null, 2),
        alt: JSON.stringify({ mcpServers: { cortex: { command: node, args: [cli, 'mcp'], env } } }, null, 2),
        altLabel: 'Or launch it directly (no dashboard needed):',
      },
      {
        id: 'windsurf',
        name: 'Windsurf',
        where: '~/.codeium/windsurf/mcp_config.json (Windsurf uses "serverUrl" for remote servers; the command form below avoids that)',
        verified: false,
        lang: 'json',
        code: JSON.stringify({ mcpServers: { cortex: { command: node, args: [cli, 'mcp'], env } } }, null, 2),
      },
      {
        id: 'vscode',
        name: 'VS Code (Copilot)',
        verified: false,
        where: '.vscode/mcp.json in a workspace, or "MCP: Add Server" from the command palette',
        lang: 'json',
        code: JSON.stringify({ servers: { cortex: { type: 'http', url, ...(headers ? { headers } : {}) } } }, null, 2),
      },
      {
        id: 'codex',
        name: 'OpenAI Codex CLI',
        verified: false,
        where: '~/.codex/config.toml',
        lang: 'toml',
        code: `[mcp_servers.cortex]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(cli)}, "mcp"]\nenv = { CORTEX_VAULT = ${JSON.stringify(vault)} }`,
      },
      {
        id: 'http',
        name: 'Any MCP client (HTTP)',
        where: 'Streamable HTTP endpoint served by the dashboard',
        lang: 'text',
        code: `URL: ${url}\nTransport: Streamable HTTP (JSON-RPC over POST)${token ? `\nHeader: Authorization: Bearer ${token}` : ''}`,
      },
    ],
  };
}

module.exports = { snippets, AGENT_PROMPT };
