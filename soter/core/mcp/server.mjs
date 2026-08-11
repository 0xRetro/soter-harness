#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createSoterMcpServer } from './tools.mjs';
import { SOTER_SDK_STDIO_TRANSPORT_MAX_BYTES } from '../service.mjs';

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

const transport = new StdioServerTransport(
  process.stdin,
  process.stdout,
  { maxBufferSize: SOTER_SDK_STDIO_TRANSPORT_MAX_BYTES }
);

server.connect(transport).then(() => {
  const reportTransportError = transport.onerror;
  transport.onerror = (error) => {
    reportTransportError?.(error);
    process.stderr.write('Soter MCP server transport closed before request handling.\n');
    process.exitCode = 1;
    transport.close().finally(() => process.exit(1));
  };
}).catch((error) => {
  process.stderr.write('Soter MCP server: ' + error.message + '\n');
  process.exitCode = 1;
});
