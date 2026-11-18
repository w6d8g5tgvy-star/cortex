'use strict';
// Ready-to-paste MCP connection configs for popular AI tools.
const path = require('path');

function snippets({ vault, port, host, token }) {
  const node = process.execPath;
  const cli = path.resolve(__dirname, '..', 'bin', 'cortex.js');
  const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${h}:${port}/mcp`;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const q = (s) => (/[\s"'$&()]/.test(s) ? JSON.stringify(s) : s);
  const env = { CORTEX_VAULT: vault };

  return {
    url,
    node,
    cli,
    items: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        where: 'Run in your terminal',
        lang: 'bash',
        code: `claude mcp add --scope user cortex --env CORTEX_VAULT=${q(vault)} -- ${q(node)} ${q(cli)} mcp`,
        alt: `claude mcp add --scope user --transport http cortex ${url}${token ? ` --header "Authorization: Bearer ${token}"` : ''}`,
        altLabel: 'Or connect to the running dashboard over HTTP:',
      },
      {
        id: 'claude-desktop',
        name: 'Claude Desktop',
        where: 'Settings → Developer → Edit Config (claude_desktop_config.json), then restart Claude',
        lang: 'json',
        code: JSON.stringify({ mcpServers: { cortex: { command: node, args: [cli, 'mcp'], env } } }, null, 2),
      },
      {
        id: 'cursor',
        name: 'Cursor / Windsurf',
        where: '~/.cursor/mcp.json (Windsurf: ~/.codeium/windsurf/mcp_config.json). Dashboard must be running.',
        lang: 'json',
        code: JSON.stringify({ mcpServers: { cortex: { url, ...(headers ? { headers } : {}) } } }, null, 2),
        alt: JSON.stringify({ mcpServers: { cortex: { command: node, args: [cli, 'mcp'], env } } }, null, 2),
        altLabel: 'Or launch it directly (no dashboard needed):',
      },
      {
        id: 'vscode',
        name: 'VS Code (Copilot)',
        where: '.vscode/mcp.json in a workspace, or "MCP: Add Server" from the command palette',
        lang: 'json',
        code: JSON.stringify({ servers: { cortex: { type: 'http', url, ...(headers ? { headers } : {}) } } }, null, 2),
      },
      {
        id: 'codex',
        name: 'OpenAI Codex CLI',
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

module.exports = { snippets };
