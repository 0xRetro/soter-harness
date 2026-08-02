import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyConfigurationCandidate, verifySoter } from '../kernel/verify.mjs';
import {
  fingerprintJson,
  fingerprintPath,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from './lib/canonical-json.mjs';
import {
  renderHostProjectionCandidates,
  renderHostProjectionCandidatesForEvidenceFinalization
} from './host-projections.mjs';
import { assertLegacyFinalizationCandidateBasis } from './legacy-finalization.mjs';
import {
  isPrivateConfigurationPath,
  readPrivateConfigurationState
} from './private-configurations.mjs';

export const RESOLVER_ID = 'core.resolver';
export const RESOLVER_VERSION = '0.5.0';

const layerOrder = new Map([
  ['kernel', 0],
  ['core', 1],
  ['context', 2],
  ['automation', 3],
  ['integration', 4]
]);

function compareText(left, right) {
  return left.localeCompare(right, 'en');
}

function findDefaultConfiguration(root) {
  const directory = path.join(root, 'soter', 'configurations');
  const candidates = fs.readdirSync(directory)
    .filter((name) => name.endsWith('.config.json'))
    .sort()
    .map((name) => path.join(directory, name));
  if (candidates.length !== 1) {
    throw new Error('Expected exactly one default configuration; pass --config explicitly.');
  }
  return candidates[0];
}

export function configurationFile(root, requestedPath) {
  if (!requestedPath) {
    return findDefaultConfiguration(root);
  }
  return resolveRepoPath(root, requestedPath);
}

export function findConfigurationTemplate(root, name) {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error('Configuration name is invalid.');
  }
  const directory = path.join(root, 'soter', 'configurations');
  const matches = fs.readdirSync(directory)
    .filter((entry) => entry.endsWith('.config.json'))
    .sort()
    .map((entry) => path.join(directory, entry))
    .filter((file) => {
      try {
        const value = readJson(file);
        return value.$contract === 'soter://contracts/configuration/v1' && value.name === name;
      } catch {
        return false;
      }
    });
  if (matches.length !== 1) {
    throw new Error('Expected one portable configuration template named ' + name + '; found ' + matches.length + '.');
  }
  return matches[0];
}

function candidateVerification(resolvedRoot, file, configuration) {
  const template = isPrivateConfigurationPath(resolvedRoot, file)
    ? findConfigurationTemplate(resolvedRoot, configuration.name)
    : file;
  if (isPrivateConfigurationPath(resolvedRoot, file)
    && path.basename(file) !== configuration.name + '.json') {
    throw new Error('Private desired configuration path does not match its configuration name.');
  }
  return verifyConfigurationCandidate(resolvedRoot, {
    configPath: template,
    configuration
  });
}

function requireCleanGraph(verification) {
  if (verification.health.valid !== 'passed') {
    const codes = verification.violations
      .filter((item) => item.level !== 'warn')
      .map((item) => item.code)
      .join(', ');
    throw new Error('Cannot resolve an invalid Soter graph' + (codes ? ': ' + codes : '.'));
  }
}

function selectedResolution(verification, name) {
  const matches = verification.resolvedConfigurations.filter((item) => item.name === name);
  if (matches.length !== 1) {
    throw new Error('Expected one resolved configuration named ' + name + '; found ' + matches.length + '.');
  }
  return matches[0];
}

function packManifestPath(root, id) {
  return path.join(root, 'soter', 'packs', id, 'pack.json');
}

function capabilityContractPath(root, id) {
  return path.join(root, 'soter', 'capabilities', id + '.json');
}

function hostManifestPath(root, host) {
  return path.join(root, 'soter', 'hosts', host, 'adapter.json');
}

function graphFingerprint(lock) {
  const unsigned = { ...lock };
  delete unsigned.graphFingerprint;
  return fingerprintJson(unsigned);
}

export function fingerprintLock(lock) {
  return fingerprintJson(lock);
}

export function resolveConfigurationValue({
  resolvedRoot,
  file,
  configuration,
  verification,
  host,
  evidenceFinalizationWorkflowIds = null
}) {
  const resolution = selectedResolution(verification, configuration.name);

  const selectedHost = host || configuration.host.id;
  if (typeof selectedHost !== 'string'
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(selectedHost)) {
    throw new Error('Selected Soter host has an invalid identifier.');
  }
  const selectedHostPath = hostManifestPath(resolvedRoot, selectedHost);
  if (!fs.existsSync(selectedHostPath)) {
    throw new Error('Unknown Soter host ' + selectedHost + '.');
  }
  const hostAdapter = readJson(selectedHostPath);
  if (hostAdapter.$contract !== 'soter://contracts/host-adapter/v2'
    || hostAdapter.host !== selectedHost) {
    throw new Error('Host adapter does not match selected host ' + selectedHost + '.');
  }

  const manifests = new Map(resolution.selections.map((selection) => {
    const manifestPath = packManifestPath(resolvedRoot, selection.id);
    return [selection.id, { path: manifestPath, doc: readJson(manifestPath) }];
  }));

  const packs = resolution.selections.map((selection) => {
    const manifest = manifests.get(selection.id);
    return {
      id: selection.id,
      version: manifest.doc.version,
      layer: manifest.doc.layer,
      releaseStage: manifest.doc.releaseStage,
      evidenceMaturity: manifest.doc.evidenceMaturity,
      source: selection.source,
      reason: selection.reason,
      manifestFingerprint: fingerprintJson(manifest.doc),
      artifacts: manifest.doc.artifacts.map((artifact) => ({
        path: artifact.path,
        role: artifact.role,
        fingerprint: fingerprintPath(resolveRepoPath(resolvedRoot, artifact.path))
      })).sort((left, right) => compareText(left.path, right.path))
    };
  }).sort((left, right) => {
    return layerOrder.get(left.layer) - layerOrder.get(right.layer) || compareText(left.id, right.id);
  });

  const dependencies = resolution.dependencies.map((dependency) => ({ ...dependency }))
    .sort((left, right) => compareText(left.from, right.from) || compareText(left.to, right.to));

  const capabilities = [...new Set(resolution.bindings.map((binding) => binding.capability))]
    .sort(compareText)
    .map((id) => {
      const contract = readJson(capabilityContractPath(resolvedRoot, id));
      return {
        id,
        version: contract.version,
        contractFingerprint: fingerprintJson(contract)
      };
    });

  const bindings = resolution.bindings.map((binding) => ({
    capability: binding.capability,
    capabilityVersion: binding.capabilityVersion,
    providerPack: binding.providerPack,
    providerVersion: binding.providerVersion,
    authorities: [...binding.authorities].sort(compareText),
    effects: [...binding.effects].sort(compareText),
    reason: binding.reason
  })).sort((left, right) => compareText(left.capability, right.capability));

  const sources = configuration.sources.map((source) => {
    const capability = readJson(capabilityContractPath(resolvedRoot, source.capability));
    return {
      id: source.id,
      capability: source.capability,
      capabilityVersion: capability.version,
      authority: source.authority,
      input: structuredClone(source.input),
      inputFingerprint: fingerprintJson(source.input),
      readiness: structuredClone(source.readiness),
      consumers: source.consumers.map((consumer) => ({
        ...structuredClone(consumer),
        subjects: [...consumer.subjects].sort(compareText)
      })).sort((left, right) => {
        return compareText(left.pack, right.pack) || compareText(left.purpose, right.purpose);
      }),
      reason: source.reason
    };
  }).sort((left, right) => compareText(left.id, right.id));

  const authorities = resolution.authorities.map((authority) => ({
    ...authority,
    declarationFingerprint: fingerprintJson(authority)
  })).sort((left, right) => compareText(left.id, right.id));

  const incompatiblePacks = [...manifests.values()]
    .filter((manifest) => !manifest.doc.compatibility.hosts.includes(selectedHost))
    .map((manifest) => manifest.doc.id)
    .sort(compareText);
  if (incompatiblePacks.length) {
    throw new Error(
      'Selected host ' + selectedHost + ' is incompatible with pack(s): '
        + incompatiblePacks.join(', ') + '.'
    );
  }
  const renderProjection = evidenceFinalizationWorkflowIds === null
    ? renderHostProjectionCandidates
    : renderHostProjectionCandidatesForEvidenceFinalization;
  const renderedProjections = renderProjection({
    root: resolvedRoot,
    adapter: hostAdapter,
    configurationId: configuration.name,
    packIds: packs.map((pack) => pack.id),
    capabilityIds: capabilities.map((capability) => capability.id),
    effectPolicies: configuration.effectPolicies,
    ...(evidenceFinalizationWorkflowIds === null
      ? {}
      : { workflowIds: evidenceFinalizationWorkflowIds })
  });
  const projections = renderedProjections.outputs.map((projection) => ({
    id: projection.id,
    path: projection.path,
    role: projection.role,
    mode: projection.mode,
    templatePath: projection.templatePath,
    templateFingerprint: projection.templateFingerprint,
    contentFingerprint: projection.contentFingerprint,
    fingerprint: projection.fingerprint
  }));

  const lock = {
    $contract: 'soter://contracts/lock/v1',
    contractVersion: '1.0.0',
    configuration: {
      name: configuration.name,
      path: repoRelativePath(resolvedRoot, file),
      fingerprint: fingerprintJson(configuration),
      hostSelection: {
        id: selectedHost,
        source: selectedHost === configuration.host.id ? 'configuration' : 'override'
      }
    },
    resolver: {
      id: RESOLVER_ID,
      version: RESOLVER_VERSION
    },
    host: {
      id: hostAdapter.host,
      adapter: hostAdapter.id,
      version: hostAdapter.version,
      manifestFingerprint: fingerprintJson(hostAdapter),
      projectionDefinition: renderedProjections.definition,
      projectionGenerator: renderedProjections.generator
    },
    packs,
    dependencies,
    capabilities,
    bindings,
    sources,
    authorities,
    effectPolicies: configuration.effectPolicies,
    settings: configuration.settings,
    projections
  };
  lock.graphFingerprint = graphFingerprint(lock);
  return lock;
}

export function resolveConfiguration({ root, configPath, host } = {}) {
  const resolvedRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const file = configurationFile(resolvedRoot, configPath);
  const configuration = isPrivateConfigurationPath(resolvedRoot, file)
    ? readPrivateConfigurationState(resolvedRoot, path.basename(file, '.json')).configuration
    : readJson(file);
  if (configuration.$contract !== 'soter://contracts/configuration/v1') {
    throw new Error('Not a Soter configuration: ' + repoRelativePath(resolvedRoot, file));
  }
  const verification = isPrivateConfigurationPath(resolvedRoot, file)
    ? candidateVerification(resolvedRoot, file, configuration)
    : verifySoter(resolvedRoot, { includeRuntimeArtifacts: false });
  requireCleanGraph(verification);
  return resolveConfigurationValue({ resolvedRoot, file, configuration, verification, host });
}

/**
 * Compute, without writing, the two final host locks needed by one closed
 * all-workflow evidence publication batch. Ordinary resolution remains strict:
 * callers cannot use this path to realize a host or bless a partial workflow
 * set, and every non-evidence static invariant must already pass.
 */
export function resolveDevelopmentEvidenceFinalizationConfiguration(options = {}) {
  const keys = Object.keys(options).sort(compareText);
  if (fingerprintJson(keys) !== fingerprintJson([
    'configPath',
    'host',
    'root',
    'workflowIds'
  ])) {
    throw new Error('Development evidence finalization resolver accepts only its exact declared arguments.');
  }
  const { root, configPath, host, workflowIds } = options;
  if (!Array.isArray(workflowIds)
    || workflowIds.length === 0
    || new Set(workflowIds).size !== workflowIds.length) {
    throw new Error('Development evidence finalization resolver requires one exact workflow set.');
  }
  const resolvedRoot = path.resolve(root);
  const file = configurationFile(resolvedRoot, configPath);
  if (isPrivateConfigurationPath(resolvedRoot, file)) {
    throw new Error('Development evidence finalization resolves tracked portable configuration templates only.');
  }
  const configuration = readJson(file);
  if (configuration.$contract !== 'soter://contracts/configuration/v1') {
    throw new Error('Not a Soter configuration: ' + repoRelativePath(resolvedRoot, file));
  }
  const verification = verifySoter(resolvedRoot, { includeRuntimeArtifacts: false });
  requireCleanGraph(verification);
  return resolveConfigurationValue({
    resolvedRoot,
    file,
    configuration,
    verification,
    host,
    evidenceFinalizationWorkflowIds: [...workflowIds]
  });
}

/**
 * Resolves a lock only for a fully tombstoned migration candidate whose complete
 * declared evidence set is the graph's sole remaining blocker. This is not a
 * fallback for ordinary invalid graphs and it grants no runtime authority.
 */
export function resolveLegacyFinalizationConfiguration({
  root,
  configPath,
  host,
  expectedInventoryFingerprint,
  checkerReceipt,
  evidencePaths,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length > 0) {
    throw new Error('Legacy finalization configuration request contains an unknown field.');
  }
  const resolvedRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const file = configurationFile(resolvedRoot, configPath);
  if (isPrivateConfigurationPath(resolvedRoot, file)) {
    throw new Error('Legacy finalization resolves tracked portable configuration templates only.');
  }
  const configuration = readJson(file);
  if (configuration.$contract !== 'soter://contracts/configuration/v1') {
    throw new Error('Not a Soter configuration: ' + repoRelativePath(resolvedRoot, file));
  }
  const verification = verifySoter(resolvedRoot, { includeRuntimeArtifacts: false });
  assertLegacyFinalizationCandidateBasis({
    root: resolvedRoot,
    expectedInventoryFingerprint,
    checkerReceipt,
    evidencePaths,
    verification
  });
  return resolveConfigurationValue({ resolvedRoot, file, configuration, verification, host });
}

export function resolveConfigurationDocument({ root, configPath, configuration, host } = {}) {
  const evaluated = evaluateConfigurationDocument({ root, configPath, configuration, host });
  requireCleanGraph(evaluated.verification);
  return evaluated.lock;
}

export function evaluateConfigurationDocument({ root, configPath, configuration, host } = {}) {
  const resolvedRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const file = configurationFile(resolvedRoot, configPath);
  const currentVerification = verifySoter(resolvedRoot, { includeRuntimeArtifacts: false });
  requireCleanGraph(currentVerification);
  const verification = candidateVerification(resolvedRoot, file, configuration);
  const valid = verification.health.valid === 'passed';
  return {
    verification,
    lock: valid
      ? resolveConfigurationValue({ resolvedRoot, file, configuration, verification, host })
      : null
  };
}

export function lockMatchesResolution({ lock, ...options }) {
  const expected = resolveConfiguration({
    ...options,
    configPath: options.configPath || lock.configuration.path,
    host: options.host || lock.configuration.hostSelection?.id || lock.host.id
  });
  return {
    matches: fingerprintLock(lock) === fingerprintLock(expected),
    expected,
    expectedFingerprint: fingerprintLock(expected),
    observedFingerprint: fingerprintLock(lock)
  };
}
