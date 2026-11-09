// Appelle des outils du serveur MCP de wCLAUDE à la main, comme un agent.
// Usage : node test/call.mjs browser_navigate '{"url":"example.com"}' [outil2 '{…}' …]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

const client = new Client({ name: 'wclaude-call', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: 'node', args: [path.join(import.meta.dirname, '..', 'mcp', 'server.mjs')], env: { ...process.env }, stderr: 'ignore',
}));
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const r = await client.callTool({ name: argv[i], arguments: JSON.parse(argv[i + 1] || '{}') }, undefined, { timeout: 600000 });
  for (const c of r.content) console.log(c.type === 'text' ? c.text : `[${c.type} ${c.mimeType}, ${c.data.length} base64 chars]`);
  if (r.isError) process.exitCode = 1;
}
await client.close();
