'use strict';
// Ready-to-paste MCP connection configs for popular AI tools.
const path = require('path');

const AGENT_PROMPT = `You have access to Cortex, my personal project manager and long-term memory, through the "cortex" MCP server. Cortex is the source of truth for my projects, tasks, notes and preferences. Work through it on every task:

1. Start by calling cortex_start (pass the project if you know it). Before working on a project or task, call project_brief and follow the user_instructions and project_instructions it returns.
2. Search Cortex with memory_search before assuming anything or asking me for context I may have given before.
3. Keep my board current: create tasks with task_create and move them with task_update (todo → doing → done, or blocked with a reason).
4. Save anything worth remembering with memory_write: decisions, preferences, findings, how-tos and gotchas. Link related notes with [[Note Title]], and update existing notes instead of duplicating them.
5. While you work, report your current step with live_update (I may be watching from my phone). Act on any messages_from_user or commands_from_user it returns, and report commands back with command_complete.
6. Use my skills: call skill_list, then skill_get for any skill that matches the task, and follow it.
7. Work through my Mind queue when asked: mind_list, mind_fetch (gets a video transcript or article text), then mind_complete with your summary or draft. Save good links with mind_add.
8. Finish with activity_log and a short summary of what you did.
Never store passwords, API keys or other secrets in Cortex.`;

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
