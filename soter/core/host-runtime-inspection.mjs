import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  fingerprintJson,
  fingerprintGovernedFile,
  readGovernedFile,
  readGovernedJson
} from './lib/canonical-json.mjs';
import {
  inspectManagedHostRealizationApplicability,
  inspectManagedHostRuntimeProjection
} from './host-realizations.mjs';

export const HOST_RUNTIME_REASON_CODES = Object.freeze({
  CURRENT: 'SOTER_HOST_RUNTIME_CURRENT',
  NOT_REALIZED: 'SOTER_HOST_RUNTIME_NOT_REALIZED',
  STALE: 'SOTER_HOST_RUNTIME_STALE'
});

const ACTIVE_ARTIFACT_ROLES = new Set(['definition', 'implementation', 'projection']);
const SERVER_NAME = 'soter-core';
const SERVER_VERSION = '0.1.0';
const INSTANT_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{3})?Z$/;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function packManifestFiles(root) {
  const packsRoot = path.join(root, 'soter', 'packs');
  return fs.readdirSync(packsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(packsRoot, entry.name, 'pack.json'))
    .sort(compareText);
}

function governedJsonWithFingerprint(root, relativePath) {
  const exact = readGovernedFile(root, relativePath);
  return {
    value: JSON.parse(exact.bytes.toString('utf8')),
    fingerprint: exact.fingerprint
  };
}

function runtimeInventory(root, host) {
  const entries = [];
  for (const manifestFile of packManifestFiles(root)) {
    const manifestPath = path.relative(root, manifestFile).split(path.sep).join('/');
    const exactManifest = governedJsonWithFingerprint(root, manifestPath);
    const manifest = exactManifest.value;
    entries.push({
      path: manifestPath,
      fingerprint: exactManifest.fingerprint
    });
    for (const artifact of manifest.artifacts || []) {
      if (!ACTIVE_ARTIFACT_ROLES.has(artifact.role)) continue;
      entries.push({
        path: artifact.path,
        fingerprint: fingerprintGovernedFile(root, artifact.path)
      });
    }
  }

  const adapterRelativePath = 'soter/hosts/' + host + '/adapter.json';
  const exactAdapter = governedJsonWithFingerprint(root, adapterRelativePath);
  const adapter = exactAdapter.value;
  if (adapter.host !== host || adapter.$contract !== 'soter://contracts/host-adapter/v2') {
    throw new Error('Host runtime adapter does not match active host ' + host + '.');
  }
  entries.push({
    path: adapterRelativePath,
    fingerprint: exactAdapter.fingerprint
  });
  const exactDefinition = governedJsonWithFingerprint(
    root,
    adapter.projectionDefinition.path
  );
  const definition = exactDefinition.value;
  entries.push({
    path: adapter.projectionDefinition.path,
    fingerprint: exactDefinition.fingerprint
  });
  for (const output of definition.outputs) {
    entries.push({
      path: output.template,
      fingerprint: fingerprintGovernedFile(root, output.template)
    });
  }
  for (const collection of definition.collections) {
    for (const output of collection.outputs) {
      entries.push({
        path: output.template,
        fingerprint: fingerprintGovernedFile(root, output.template)
      });
    }
  }
  const unique = new Map();
  for (const entry of entries) unique.set(entry.path, entry);
  return [...unique.values()].sort((left, right) => compareText(left.path, right.path));
}

function runtimeSnapshot(root, host, expectedProjection = null) {
  try {
    const artifacts = runtimeInventory(root, host);
    const governedSourceFingerprint = fingerprintJson({
      contract: 'soter-host-runtime-governed-source/v1',
      host,
      artifacts
    });
    const projection = inspectManagedHostRuntimeProjection({
      root,
      host,
      governedSourceFingerprint,
      expected: expectedProjection
    });
    if (projection.state === 'not-realized') {
      return Object.freeze({
        state: 'not-realized',
        fingerprint: null,
        governedSourceFingerprint,
        projectionBasis: null
      });
    }
    return Object.freeze({
      state: 'realized',
      fingerprint: fingerprintJson({
        contract: 'soter-host-runtime-basis/v2',
        host,
        governedSourceFingerprint,
        projectionFingerprint: projection.fingerprint
      }),
      governedSourceFingerprint,
      projectionBasis: projection.basis
    });
  } catch {
    return Object.freeze({
      state: 'invalid',
      fingerprint: null,
      governedSourceFingerprint: null,
      projectionBasis: null
    });
  }
}

function inspectionFingerprint(inspection) {
  const unsigned = structuredClone(inspection);
  delete unsigned.inspectionFingerprint;
  return fingerprintJson(unsigned);
}

function assertInstant(value, label) {
  const canonical = typeof value === 'string' && !value.includes('.')
    ? value.replace(/Z$/, '.000Z')
    : value;
  if (typeof value !== 'string'
    || !INSTANT_RE.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== canonical) {
    throw new Error(label + ' must be one valid UTC instant.');
  }
}

export function assertHostRuntimeInspection(inspection, schema) {
  const failures = validateJsonSchema(inspection, schema);
  if (failures.length) {
    throw new Error('Host runtime inspection does not satisfy its contract: '
      + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; '));
  }
  if (inspection.inspectionFingerprint !== inspectionFingerprint(inspection)) {
    throw new Error('Host runtime inspection fingerprint is stale.');
  }
  assertInstant(inspection.inspectedAt, 'Host runtime inspection inspectedAt');
  assertInstant(inspection.server.startedAt, 'Host runtime inspection server.startedAt');
  if (Date.parse(inspection.inspectedAt) < Date.parse(inspection.server.startedAt)) {
    throw new Error('Host runtime inspection cannot predate the loaded server runtime.');
  }
  const runtime = inspection.runtime;
  if ((runtime.state === 'current'
      && (runtime.startupFingerprint === null
        || runtime.currentFingerprint !== runtime.startupFingerprint
        || runtime.reasonCode !== HOST_RUNTIME_REASON_CODES.CURRENT
        || runtime.restartRequired
        || runtime.permittedNextAction !== 'continue'))
    || (runtime.state === 'not-realized'
      && (runtime.startupFingerprint !== null
        || runtime.currentFingerprint !== null
        || runtime.reasonCode !== HOST_RUNTIME_REASON_CODES.NOT_REALIZED
        || !runtime.restartRequired
        || runtime.permittedNextAction !== 'realize-host-runtime'))
    || (runtime.state === 'stale'
      && (runtime.reasonCode !== HOST_RUNTIME_REASON_CODES.STALE
        || runtime.restartRequired !== (runtime.currentFingerprint === null ? null : true)
        || runtime.permittedNextAction !== (runtime.currentFingerprint === null
          ? 'none'
          : 'restart-host-runtime')
        || (runtime.startupFingerprint !== null
          && runtime.currentFingerprint === runtime.startupFingerprint)))) {
    throw new Error('Host runtime inspection state facts are contradictory.');
  }
  const hostRealization = inspection.hostRealization;
  const exactHostRealizationFacts = new Set([
    'current\0HOST_REALIZATION_CURRENT\0continue',
    'not-realized\0HOST_REALIZATION_NOT_REALIZED\0realize-host-runtime',
    'stale\0HOST_REALIZATION_ACTIVE_LOCK_MISSING\0refresh-active-configuration',
    'stale\0HOST_REALIZATION_ACTIVE_LOCK_STALE\0refresh-active-configuration',
    'stale\0HOST_REALIZATION_MANIFEST_LOCK_STALE\0realize-host-runtime',
    'unavailable\0HOST_REALIZATION_APPLICABILITY_UNAVAILABLE\0none'
  ]);
  if (!exactHostRealizationFacts.has([
    hostRealization.state,
    hostRealization.reasonCode,
    hostRealization.permittedNextAction
  ].join('\0'))) {
    throw new Error('Host realization applicability facts are contradictory.');
  }
  return inspection;
}

export function createHostRuntimeBasis({ root, host, startedAt = new Date().toISOString() }) {
  assertInstant(startedAt, 'Host runtime basis startedAt');
  const resolvedRoot = path.resolve(root);
  const startup = runtimeSnapshot(resolvedRoot, host);
  return Object.freeze({
    host,
    server: Object.freeze({ name: SERVER_NAME, version: SERVER_VERSION, startedAt }),
    startupState: startup.state,
    startupFingerprint: startup.fingerprint,
    startupGovernedSourceFingerprint: startup.governedSourceFingerprint,
    startupProjectionBasis: startup.projectionBasis,
    inspectionSchema: readGovernedJson(
      resolvedRoot,
      'soter/contracts/host-runtime-inspection.schema.json'
    )
  });
}

export function inspectHostRuntime({ root, basis, inspectedAt = new Date().toISOString() }) {
  assertInstant(inspectedAt, 'Host runtime inspection inspectedAt');
  const resolvedRoot = path.resolve(root);
  const observed = runtimeSnapshot(
    resolvedRoot,
    basis.host,
    basis.startupState === 'realized' ? basis.startupProjectionBasis : null
  );
  const currentFingerprint = observed.fingerprint;
  const notRealized = basis.startupState === 'not-realized'
    && observed.state === 'not-realized'
    && observed.governedSourceFingerprint === basis.startupGovernedSourceFingerprint;
  const current = basis.startupState === 'realized'
    && observed.state === 'realized'
    && currentFingerprint === basis.startupFingerprint;
  const automaticRecoveryUnavailable = !notRealized
    && !current
    && currentFingerprint === null;
  const inspection = {
    $contract: 'soter://contracts/host-runtime-inspection/v1',
    contractVersion: '1.0.0',
    inspectedAt,
    host: basis.host,
    server: { ...basis.server },
    runtime: {
      state: notRealized ? 'not-realized' : current ? 'current' : 'stale',
      startupFingerprint: basis.startupFingerprint,
      currentFingerprint,
      reasonCode: notRealized
        ? HOST_RUNTIME_REASON_CODES.NOT_REALIZED
        : current
          ? HOST_RUNTIME_REASON_CODES.CURRENT
          : HOST_RUNTIME_REASON_CODES.STALE,
      restartRequired: notRealized
        ? true
        : current ? false : automaticRecoveryUnavailable ? null : true,
      permittedNextAction: notRealized
        ? 'realize-host-runtime'
        : current
          ? 'continue'
          : automaticRecoveryUnavailable ? 'none' : 'restart-host-runtime'
    },
    hostRealization: inspectManagedHostRealizationApplicability({
      root: resolvedRoot,
      host: basis.host
    }),
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
  return assertHostRuntimeInspection(inspection, basis.inspectionSchema);
}
