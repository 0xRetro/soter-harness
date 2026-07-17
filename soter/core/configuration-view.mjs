import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  fingerprintJson,
  readJson,
  resolveRepoPath
} from './lib/canonical-json.mjs';
import { fingerprintLock } from './resolve.mjs';

const VIEW_CONTRACT = 'soter://contracts/configuration-view/v1';
const VIEW_SCHEMA = 'soter/contracts/configuration-view.schema.json';

function compareText(left, right) {
  return left.localeCompare(right, 'en');
}

function assertConfigurationView(root, view) {
  const schema = readJson(resolveRepoPath(root, VIEW_SCHEMA));
  const failures = validateJsonSchema(view, schema);
  if (failures.length) {
    throw new Error(
      'Configuration view failed its contract: '
        + failures.slice(0, 10).map((failure) => {
          return failure.path + ' ' + failure.message;
        }).join('; ')
    );
  }
}

function exactPackManifest(root, pack) {
  const file = resolveRepoPath(root, path.join('soter', 'packs', pack.id, 'pack.json'));
  const manifest = readJson(file);
  if (manifest.id !== pack.id
    || manifest.version !== pack.version
    || fingerprintJson(manifest) !== pack.manifestFingerprint) {
    throw new Error('Configuration view cannot explain stale pack ' + pack.id + '.');
  }
  return manifest;
}

function exactHostManifest(root, lock) {
  const file = resolveRepoPath(
    root,
    path.join('soter', 'hosts', lock.host.id, 'adapter.json')
  );
  const manifest = readJson(file);
  if (manifest.id !== lock.host.adapter
    || manifest.host !== lock.host.id
    || manifest.version !== lock.host.version
    || fingerprintJson(manifest) !== lock.host.manifestFingerprint) {
    throw new Error('Configuration view cannot explain a stale host adapter.');
  }
  return manifest;
}

export function buildConfigurationView({ root, lock, basis = 'configuration' }) {
  const resolvedRoot = path.resolve(root);
  if (!['configuration', 'lock'].includes(basis)) {
    throw new Error('Configuration view basis must be configuration or lock.');
  }
  const desired = readJson(resolveRepoPath(resolvedRoot, lock.configuration.path));
  if (desired.name !== lock.configuration.name
    || fingerprintJson(desired) !== lock.configuration.fingerprint) {
    throw new Error('Configuration view cannot explain a stale desired configuration.');
  }
  const hostManifest = exactHostManifest(resolvedRoot, lock);
  const requiredBy = new Map(lock.packs.map((pack) => [pack.id, []]));
  for (const dependency of lock.dependencies) {
    requiredBy.get(dependency.to)?.push(dependency.from);
  }

  const systems = lock.packs.map((pack) => {
    const manifest = exactPackManifest(resolvedRoot, pack);
    return {
      id: pack.id,
      version: pack.version,
      layer: pack.layer,
      summary: manifest.summary,
      releaseStage: pack.releaseStage,
      evidenceMaturity: pack.evidenceMaturity,
      selection: {
        source: pack.source,
        reason: pack.reason
      },
      capabilities: structuredClone(manifest.capabilities),
      effects: [...manifest.effects].sort(compareText),
      requiredBy: [...(requiredBy.get(pack.id) || [])].sort(compareText),
      artifactCount: pack.artifacts.length
    };
  });
  const selectionReason = lock.configuration.hostSelection.source === 'configuration'
    ? desired.host.reason
    : 'Host ' + lock.host.id + ' was explicitly selected instead of configured default '
      + desired.host.id + ' for this resolution.';
  const unsigned = {
    $contract: VIEW_CONTRACT,
    contractVersion: '1.0.0',
    basis: {
      kind: basis,
      lockFingerprint: fingerprintLock(lock),
      graphFingerprint: lock.graphFingerprint,
      resolver: structuredClone(lock.resolver)
    },
    configuration: {
      name: lock.configuration.name,
      path: lock.configuration.path,
      fingerprint: lock.configuration.fingerprint,
      configuredDefaultHost: desired.host.id
    },
    host: {
      id: lock.host.id,
      adapter: lock.host.adapter,
      version: lock.host.version,
      selectionSource: lock.configuration.hostSelection.source,
      selectionReason,
      summary: hostManifest.summary,
      conformance: structuredClone(hostManifest.conformance),
      limitations: [...hostManifest.limitations],
      projections: lock.projections.map((projection) => ({
        path: projection.path,
        role: projection.role
      }))
    },
    systems,
    dependencies: structuredClone(lock.dependencies),
    bindings: structuredClone(lock.bindings),
    sources: structuredClone(lock.sources),
    authorities: lock.authorities.map((authority) => ({
      id: authority.id,
      role: authority.role,
      subject: authority.subject,
      uri: authority.uri,
      reason: authority.reason
    })),
    effectPolicies: structuredClone(lock.effectPolicies),
    states: {
      valid: 'passed',
      ready: 'unknown',
      verified: 'unknown',
      healthy: 'unknown',
      basis: 'Fresh resolution proves local graph and lock validity only; runtime states were not evaluated.'
    }
  };
  const view = {
    ...unsigned,
    viewFingerprint: fingerprintJson(unsigned)
  };
  assertConfigurationView(resolvedRoot, view);
  return view;
}

export function formatConfigurationView(view) {
  const lines = [
    'Soter configuration: ' + view.configuration.name,
    'Host: ' + view.host.id + ' (' + view.host.selectionSource + ')',
    'States: valid=' + view.states.valid
      + ' ready=' + view.states.ready
      + ' verified=' + view.states.verified
      + ' healthy=' + view.states.healthy,
    '',
    'Systems:'
  ];
  for (const system of view.systems) {
    lines.push(
      '  [' + system.layer + '] ' + system.id + '@' + system.version
        + ' — ' + system.summary,
      '    Included by ' + system.selection.source + ': ' + system.selection.reason
    );
  }
  lines.push('', 'Bindings:');
  for (const binding of view.bindings) {
    lines.push(
      '  ' + binding.capability + ' -> ' + binding.providerPack
        + ' [' + binding.effects.join(', ') + ']'
    );
  }
  lines.push('', 'Sources:');
  for (const source of view.sources) {
    lines.push(
      '  ' + source.id + ' -> ' + source.capability
        + ' via ' + source.authority + ' (' + source.readiness.mode + ')'
    );
  }
  lines.push('', 'Effects:');
  for (const [effect, policy] of Object.entries(view.effectPolicies)) {
    lines.push('  ' + effect + '=' + policy.mode + ' — ' + policy.reason);
  }
  lines.push(
    '',
    'Host limitation: ' + view.host.limitations.join(' '),
    'Lock: ' + view.basis.lockFingerprint,
    'View: ' + view.viewFingerprint
  );
  return lines.join('\n') + '\n';
}
