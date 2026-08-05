#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; log to stderr only.
  console.error('twitter-guest-mcp running on stdio');
}

main().catch(error => {
  console.error('Fatal:', error);
  process.exit(1);
});
