import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fingerprintJson, readJson, resolveRepoPath } from './lib/canonical-json.mjs';

const ERROR_KINDS = new Set([
  'authentication',
  'authorization',
  'validation',
  'conflict',
  'rate-limit',
  'unavailable',
  'retryable',
  'not-found',
  'unknown'
]);

const ERROR_PROFILES = Object.freeze({
  authentication: Object.freeze({
    code: 'HOST_CALL_AUTHENTICATION_FAILED',
    message: 'The exact host operation could not authenticate.'
  }),
  authorization: Object.freeze({
    code: 'HOST_CALL_AUTHORIZATION_FAILED',
    message: 'The exact host operation was not authorized.'
  }),
  validation: Object.freeze({
    code: 'HOST_CALL_VALIDATION_FAILED',
    message: 'The exact host operation failed governed validation.'
  }),
  conflict: Object.freeze({
    code: 'HOST_CALL_CONFLICT',
    message: 'The exact host operation encountered a conflict.'
  }),
  'rate-limit': Object.freeze({
    code: 'HOST_CALL_RATE_LIMITED',
    message: 'The exact host operation was rate limited.'
  }),
  unavailable: Object.freeze({
    code: 'HOST_CALL_UNAVAILABLE',
    message: 'The exact host operation was unavailable.'
  }),
  retryable: Object.freeze({
    code: 'HOST_CALL_RETRYABLE_FAILURE',
    message: 'The exact host operation reported a retryable failure.'
  }),
  'not-found': Object.freeze({
    code: 'HOST_CALL_NOT_FOUND',
    message: 'The exact host operation did not find its governed subject.'
  }),
  unknown: Object.freeze({
    code: 'HOST_CALL_FAILED',
    message: 'The exact host operation failed.'
  })
});

const CREDENTIAL_KEY_RE = /^(?:authorization|password|passphrase|token|access[_-]?token|refresh[_-]?token|bearer[_-]?token|api[_-]?key|client[_-]?secret|secret(?:[_-]?ref(?:[_-]?id)?)?)$/i;
const CREDENTIAL_VALUE_RE = /\b(?:secret_[A-Za-z0-9]{32,}|ntn_[A-Za-z0-9]{32,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36})\b/;

export function containsCredentialMaterial(value) {
  if (typeof value === 'string') return CREDENTIAL_VALUE_RE.test(value);
  if (Array.isArray(value)) return value.some(containsCredentialMaterial);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    return CREDENTIAL_KEY_RE.test(key) || containsCredentialMaterial(child);
  });
}

export function isHostFailureKind(value) {
  return ERROR_KINDS.has(value);
}

export function normalizedError(error, fallbackKind = 'unknown') {
  const kind = ERROR_KINDS.has(error?.kind)
    ? error.kind
    : ERROR_KINDS.has(fallbackKind)
      ? fallbackKind
      : 'unknown';
  return { kind, ...ERROR_PROFILES[kind] };
}

export function assertMcpRuntime(provider) {
  if (provider.runtime.engine !== 'mcp') {
    throw new Error(provider.id + ' is not a host-dispatched MCP implementation.');
  }
  if (!Array.isArray(provider.runtime.responseProfiles)
    || provider.runtime.responseProfiles.length < 1
    || provider.runtime.responseProfiles.some((profile) => typeof profile !== 'string')) {
    throw new Error(provider.id + ' does not declare a closed MCP response profile set.');
  }
}

export function hostRoute(root, lock, provider) {
  const adapter = readJson(path.join(root, 'soter', 'hosts', lock.host.id, 'adapter.json'));
  if (adapter.id !== lock.host.adapter
    || adapter.version !== lock.host.version
    || fingerprintJson(adapter) !== lock.host.manifestFingerprint) {
    throw new Error('The resolved host adapter is stale or does not match the lock.');
  }
  if (adapter.mechanisms.tools === 'unsupported') {
    throw new Error(adapter.id + ' does not support tool delivery.');
  }
  const route = adapter.mcpServers.find((server) => server.id === provider.runtime.server);
  if (!route) {
    throw new Error(
      adapter.id + ' does not declare MCP server ' + provider.runtime.server
        + ' required by ' + provider.id + '.'
    );
  }
  return route;
}

export function resolveHostTool(root, lock, provider, logicalTool) {
  const route = hostRoute(root, lock, provider);
  const matches = route.toolMappings.filter((mapping) => mapping.logical === logicalTool);
  if (matches.length !== 1) {
    throw new Error(
      lock.host.adapter + ' must map provider operation ' + provider.runtime.server + '/'
        + logicalTool + ' exactly once; found ' + matches.length + '.'
    );
  }
  if (!provider.runtime.responseProfiles.includes(matches[0].responseProfile)) {
    throw new Error(
      lock.host.adapter + ' maps provider operation ' + provider.runtime.server + '/'
        + logicalTool + ' to undeclared response profile ' + matches[0].responseProfile + '.'
    );
  }
  return {
    route,
    logicalTool,
    nativeTool: matches[0].native,
    responseProfile: matches[0].responseProfile
  };
}

export function loadProviderMappings(root, provider) {
  return provider.mappings.map((mappingPath) => {
    return readJson(resolveRepoPath(root, mappingPath));
  });
}

export async function loadProviderModule(root, provider, injected) {
  if (injected) return injected;
  const modulePath = resolveRepoPath(root, provider.runtime.module);
  return import(pathToFileURL(modulePath).href);
}
