#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createSoterMcpServer } from './tools.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function rootOption(args) {
  const index = args.indexOf('--root');
  if (index < 0) return defaultRoot;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error('--root requires a value.');
  }
  return path.resolve(args[index + 1]);
}

function hostOption(args) {
  const index = args.indexOf('--host');
  if (index < 0) throw new Error('--host is required.');
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error('--host requires a value.');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args[index + 1])) {
    throw new Error('--host must be a lowercase host identifier.');
  }
  return args[index + 1];
}

const args = process.argv.slice(2);
const server = createSoterMcpServer({ root: rootOption(args), host: hostOption(args) });

async function close() {
  await server.close();
}

process.once('SIGINT', () => {
  close().finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  close().finally(() => process.exit(0));
});

server.connect(new StdioServerTransport()).catch((error) => {
  process.stderr.write('Soter MCP server: ' + error.message + '\n');
  process.exitCode = 1;
});
