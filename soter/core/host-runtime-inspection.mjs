import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  fingerprintJson,
  fingerprintPath,
  readJson,
  resolveRepoPath
} from './lib/canonical-json.mjs';

export const HOST_RUNTIME_REASON_CODES = Object.freeze({
  CURRENT: 'SOTER_HOST_RUNTIME_CURRENT',
  STALE: 'SOTER_HOST_RUNTIME_STALE'
});

const ACTIVE_ARTIFACT_ROLES = new Set(['definition', 'implementation', 'projection']);
const SERVER_NAME = 'soter-core';
const SERVER_VERSION = '0.1.0';

function compareText(left, right) {
  return left.localeCompare(right, 'en');
}

function packManifestFiles(root) {
  const packsRoot = path.join(root, 'soter', 'packs');
  return fs.readdirSync(packsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packsRoot, entry.name, 'pack.json'))
    .filter((file) => fs.existsSync(file))
    .sort(compareText);
}

function runtimeInventory(root, host) {
  const entries = [];
  for (const manifestFile of packManifestFiles(root)) {
    const manifest = readJson(manifestFile);
    const manifestPath = path.relative(root, manifestFile).split(path.sep).join('/');
    entries.push({ path: manifestPath, fingerprint: fingerprintPath(manifestFile) });
    for (const artifact of manifest.artifacts || []) {
      if (!ACTIVE_ARTIFACT_ROLES.has(artifact.role)) continue;
      const artifactPath = resolveRepoPath(root, artifact.path);
      entries.push({ path: artifact.path, fingerprint: fingerprintPath(artifactPath) });
    }
  }

  const adapterRelativePath = 'soter/hosts/' + host + '/adapter.json';
  const adapterPath = resolveRepoPath(root, adapterRelativePath);
  const adapter = readJson(adapterPath);
  if (adapter.host !== host || adapter.$contract !== 'soter://contracts/host-adapter/v1') {
    throw new Error('Host runtime adapter does not match active host ' + host + '.');
  }
  entries.push({ path: adapterRelativePath, fingerprint: fingerprintPath(adapterPath) });
  for (const projection of adapter.projections) {
    const projectionPath = resolveRepoPath(root, projection.path);
    entries.push({ path: projection.path, fingerprint: fingerprintPath(projectionPath) });
  }

  const unique = new Map();
  for (const entry of entries) unique.set(entry.path, entry);
  return [...unique.values()].sort((left, right) => compareText(left.path, right.path));
}

function runtimeFingerprint(root, host) {
  return fingerprintJson({
    contract: 'soter-host-runtime-basis/v1',
    host,
    artifacts: runtimeInventory(root, host)
  });
}

function inspectionFingerprint(inspection) {
  const unsigned = structuredClone(inspection);
  delete unsigned.inspectionFingerprint;
  return fingerprintJson(unsigned);
}

function assertInspection(inspection, schema) {
  const failures = validateJsonSchema(inspection, schema);
  if (failures.length) {
    throw new Error('Host runtime inspection does not satisfy its contract: '
      + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; '));
  }
  if (inspection.inspectionFingerprint !== inspectionFingerprint(inspection)) {
    throw new Error('Host runtime inspection fingerprint is stale.');
  }
  return inspection;
}

export function createHostRuntimeBasis({ root, host, startedAt = new Date().toISOString() }) {
  const resolvedRoot = path.resolve(root);
  return Object.freeze({
    host,
    server: Object.freeze({ name: SERVER_NAME, version: SERVER_VERSION, startedAt }),
    startupFingerprint: runtimeFingerprint(resolvedRoot, host),
    inspectionSchema: readJson(path.join(
      resolvedRoot,
      'soter',
      'contracts',
      'host-runtime-inspection.schema.json'
    ))
  });
}

export function inspectHostRuntime({ root, basis, inspectedAt = new Date().toISOString() }) {
  const resolvedRoot = path.resolve(root);
  let currentFingerprint = null;
  try {
    currentFingerprint = runtimeFingerprint(resolvedRoot, basis.host);
  } catch {
    currentFingerprint = null;
  }
  const current = currentFingerprint === basis.startupFingerprint;
  const inspection = {
    $contract: 'soter://contracts/host-runtime-inspection/v1',
    contractVersion: '1.0.0',
    inspectedAt,
    host: basis.host,
    server: { ...basis.server },
    runtime: {
      state: current ? 'current' : 'stale',
      startupFingerprint: basis.startupFingerprint,
      currentFingerprint,
      reasonCode: current
        ? HOST_RUNTIME_REASON_CODES.CURRENT
        : HOST_RUNTIME_REASON_CODES.STALE,
      restartRequired: !current,
      permittedNextAction: current ? 'continue' : 'restart-host-runtime'
    },
    authority: {
      grants: 'none',
      providerCallsPermitted: false,
      writesPermitted: false
    },
    privacy: {
      credentialValuesIncluded: false,
      providerResponsesIncluded: false,
      privateStateIncluded: false
    },
    inspectionFingerprint: fingerprintJson(null)
  };
  inspection.inspectionFingerprint = inspectionFingerprint(inspection);
  return assertInspection(inspection, basis.inspectionSchema);
}
