import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
import {
  buildDevelopmentHostHistoricalEvidenceForBatch
} from './development-host-observations.mjs';
import { resolveDevelopmentCandidateLock } from './development-candidate-locks.mjs';
import {
  fingerprintFile,
  fingerprintJson,
  readJson,
  resolveRepoPath,
  sha256
} from './lib/canonical-json.mjs';

const REQUEST_CONTRACT = 'soter://private/development-historical-evidence-batch-request/v1';
const CONSUMPTION_CONTRACT = 'soter://private/development-historical-evidence-batch-consumption/v1';
const CHECKPOINT_CONTRACT = 'soter://private/development-historical-evidence-batch-checkpoint/v1';
const INSPECTION_CONTRACT = 'soter://contracts/development-historical-evidence-batch-inspection/v1';
const INSPECTION_SCHEMA = 'soter/contracts/development-historical-evidence-batch-inspection.schema.json';
const STATE_DIRECTORY = '.soter/state/development-historical-evidence-batches';
const OUTPUT_DIRECTORY = 'soter/evidence/development';
const REQUEST_ID = /^development-historical-evidence-batch[.][a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const DEVELOPMENT_REQUEST_ID = /^development-request[.][a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/;
const OUTPUT_PATH = /^soter\/evidence\/development\/development-agent-migration-evidence[.](codex|claude)[.]([a-z0-9]+(?:-[a-z0-9]+)*)[.]json$/;
const OWNED_PENDING_PATH = /^soter\/evidence\/development\/[.]development-agent-migration-evidence[.](?:codex|claude)[.][a-z0-9]+(?:-[a-z0-9]+)*[.]json[.]pending-[a-f0-9]{24}$/;
const REQUEST_MAX_TTL_MS = 15 * 60 * 1000;
const WORKFLOW_IDS = Object.freeze([
  'automation.auditing-a-schema-doc',
  'automation.authoring-a-policy-standard',
  'automation.forge',
  'automation.promoting-pieces',
  'automation.reviewing-forge-output',
  'automation.running-evals',
  'automation.validating-resources'
]);
const HOSTS = Object.freeze(['claude', 'codex']);
const CLAIM_BOUNDARY = 'Exact create-only local historical evidence bytes only; lifecycle activation, fixture materialization, final locks, provider behavior, host behavior, readiness, connected verification, and health are not evaluated.';
const ROLLED_BACK_SUMMARY = 'Historical evidence publication stopped and exact rollback completed.';
const NEEDS_ATTENTION_SUMMARY = 'Historical evidence publication requires checkpoint-bound reconciliation.';
const EXCLUDED_ROOTS = new Set(['.git', '.soter', 'node_modules']);

function fail(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  throw error;
}

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function same(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && same(Object.keys(value).sort(compareCodepoint), [...keys].sort(compareCodepoint));
}

function exactInstant(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!INSTANT.test(value || '') || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value) {
    fail(
      'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_TIME_INVALID',
      label + ' must be one canonical UTC instant with millisecond precision.'
    );
  }
  return parsed;
}

function normalizeCode(error, fallback) {
  return typeof error?.code === 'string'
      && /^DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : fallback;
}

function canonicalRoot(root) {
  const resolved = path.resolve(root || '');
  let stat;
  let real;
  try {
    stat = fs.lstatSync(resolved);
    real = fs.realpathSync(resolved);
  } catch (error) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_ROOT_INVALID', 'Historical evidence batch root is unavailable.', error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== resolved) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_ROOT_INVALID', 'Historical evidence batch requires one exact real repository root.');
  }
  return resolved;
}

function rootIdentity(root) {
  const resolved = canonicalRoot(root);
  const stat = fs.statSync(resolved);
  const basis = {
    realPath: resolved,
    device: Number(stat.dev),
    inode: Number(stat.ino)
  };
  return { ...basis, fingerprint: fingerprintJson(basis) };
}

function assertRoot(root, fingerprint) {
  const identity = rootIdentity(root);
  if (identity.fingerprint !== fingerprint) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_ROOT_DRIFT', 'Historical evidence batch repository identity changed.');
  }
  return identity;
}

function requestFingerprint(request) {
  const unsigned = structuredClone(request);
  delete unsigned.requestFingerprint;
  return fingerprintJson(unsigned);
}

function sealFingerprint(value, property) {
  value[property] = null;
  const unsigned = structuredClone(value);
  delete unsigned[property];
  value[property] = fingerprintJson(unsigned);
  return value;
}

function normalizedRelative(relative, label) {
  if (typeof relative !== 'string' || !relative.length || relative.includes('\\')
    || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative
    || relative === '.' || relative === '..' || relative.startsWith('../')
    || relative.includes('/../') || relative.includes('//')) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PATH_INVALID', label + ' is not one normalized repository-relative path.');
  }
  return relative;
}

function confinedPath(root, relative) {
  const resolvedRoot = canonicalRoot(root);
  const normalized = normalizedRelative(relative, 'Historical evidence path');
  const target = path.resolve(resolvedRoot, normalized);
  if (!target.startsWith(resolvedRoot + path.sep)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PATH_INVALID', 'Historical evidence path escapes the exact repository root.');
  }
  let current = resolvedRoot;
  for (const [index, part] of normalized.split('/').entries()) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PATH_INVALID', 'Historical evidence path crosses a symbolic link.');
    }
    if (index < normalized.split('/').length - 1 && !stat.isDirectory()) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PATH_INVALID', 'Historical evidence path crosses a non-directory parent.');
    }
  }
  return target;
}

function modeString(stat) {
  return (stat.mode & 0o7777).toString(8).padStart(4, '0');
}

function publicTreeBasis(root, ignoredOutputPaths) {
  const resolvedRoot = canonicalRoot(root);
  const ignored = new Set(ignoredOutputPaths);
  const files = [];
  const visit = (directory, relativeDirectory = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareCodepoint(left.name, right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? relativeDirectory + '/' + entry.name : entry.name;
      if (!relativeDirectory && EXCLUDED_ROOTS.has(entry.name)) continue;
      const file = path.join(directory, entry.name);
      const stat = fs.lstatSync(file);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_BASIS_INVALID', 'Public candidate basis contains a symbolic link: ' + relative);
      }
      if (entry.isDirectory()) {
        if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o7000) !== 0)) {
          fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_BASIS_INVALID', 'Public candidate basis contains an unsafe directory: ' + relative);
        }
        visit(file, relative);
        continue;
      }
      if (ignored.has(relative) || OWNED_PENDING_PATH.test(relative)) {
        if (!entry.isFile() || !stat.isFile()) {
          fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_BASIS_INVALID', 'An ignored checkpoint-owned output path is not a regular file: ' + relative);
        }
        continue;
      }
      if (!entry.isFile() || !stat.isFile() || stat.nlink !== 1
        || (process.platform !== 'win32' && (stat.mode & 0o7000) !== 0)) {
        fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_BASIS_INVALID', 'Public candidate basis contains an unsafe file: ' + relative);
      }
      files.push({
        path: relative,
        mode: modeString(stat),
        contentFingerprint: fingerprintFile(file)
      });
    }
  };
  visit(resolvedRoot);
  return { files, fingerprint: fingerprintJson(files) };
}

function assertWorkflowSet(root) {
  for (const workflowId of WORKFLOW_IDS) {
    const slug = workflowId.slice('automation.'.length);
    const definition = readJson(resolveRepoPath(root, `soter/automations/${slug}/definition.json`));
    if (definition.id !== workflowId
      || definition.$contract !== 'soter://contracts/workflow-definition/v2'
      || definition.lifecycle?.state !== 'active-host-guided'
      || definition.lifecycle?.activation?.state !== 'candidate') {
      fail(
        'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_WORKFLOW_SET_INVALID',
        'Historical evidence batch requires the exact seven candidate active-host-guided workflows.'
      );
    }
  }
}

function expectedOutputPath(workflowId, host) {
  return `${OUTPUT_DIRECTORY}/development-agent-migration-evidence.${host}.${workflowId.slice('automation.'.length)}.json`;
}

function normalizeWorkflowRequests(workflows) {
  if (!Array.isArray(workflows) || workflows.length !== WORKFLOW_IDS.length) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_WORKFLOW_SET_INVALID', 'Historical evidence batch requires seven workflow request rows.');
  }
  const rows = workflows.map((row) => {
    if (!exactKeys(row, ['id', 'requests'])
      || !WORKFLOW_IDS.includes(row.id)
      || !exactKeys(row.requests, HOSTS)
      || HOSTS.some((host) => !DEVELOPMENT_REQUEST_ID.test(row.requests[host] || ''))
      || row.requests.codex === row.requests.claude) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_WORKFLOW_SET_INVALID', 'Each workflow must bind distinct exact Codex and Claude request identities.');
    }
    return structuredClone(row);
  }).sort((left, right) => compareCodepoint(left.id, right.id));
  if (!same(rows.map((row) => row.id), WORKFLOW_IDS)
    || new Set(rows.flatMap((row) => HOSTS.map((host) => row.requests[host]))).size !== 14) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_WORKFLOW_SET_INVALID', 'Workflow or request identities are missing, duplicated, or substituted.');
  }
  return rows;
}

function assertEvidenceSafe(evidence) {
  if (containsCredentialMaterial(evidence)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PRIVATE_MATERIAL_INVALID', 'Historical evidence cannot contain credential material.');
  }
  if (evidence.privacy?.scope !== 'shareable-sanitized'
    || Object.entries(evidence.privacy || {}).some(([key, value]) => key !== 'scope' && value !== false)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PRIVATE_MATERIAL_INVALID', 'Historical evidence privacy claims are not the exact sanitized boundary.');
  }
}

function buildOutput(evidence, workflowId, host, sequence) {
  const relativePath = expectedOutputPath(workflowId, host);
  const match = relativePath.match(OUTPUT_PATH);
  const expectedId = path.posix.basename(relativePath, '.json');
  if (!match || match[1] !== host || `automation.${match[2]}` !== workflowId
    || evidence.id !== expectedId || evidence.workflow?.id !== workflowId
    || evidence.host?.id !== host) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_EVIDENCE_SET_INVALID', 'Historical evidence identity does not match its exact workflow, host, and output path.');
  }
  assertEvidenceSafe(evidence);
  const bytes = canonicalBytes(evidence);
  return {
    sequence,
    path: relativePath,
    mode: '0644',
    documentFingerprint: fingerprintJson(evidence),
    contentFingerprint: sha256(bytes),
    document: structuredClone(evidence)
  };
}

function directoryState(root, relativePath) {
  const directory = confinedPath(root, relativePath);
  if (!fs.existsSync(directory)) return { path: relativePath, mode: '0755', preState: 'absent' };
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o755)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PATH_INVALID', 'Governed evidence parent is not one exact 0755 directory.');
  }
  return { path: relativePath, mode: '0755', preState: 'existing' };
}

function candidateFingerprint(candidate) {
  return fingerprintJson({
    basis: candidate.basis,
    directories: candidate.directories,
    chains: candidate.chains,
    outputs: candidate.outputs
  });
}

function deriveCandidate({ root, workflows, requireCurrentCandidateLock }) {
  const resolvedRoot = canonicalRoot(root);
  assertWorkflowSet(resolvedRoot);
  const requested = normalizeWorkflowRequests(workflows);
  const ignoredOutputPaths = WORKFLOW_IDS.flatMap((workflowId) => HOSTS.map(
    (host) => expectedOutputPath(workflowId, host)
  ));
  const before = publicTreeBasis(resolvedRoot, ignoredOutputPaths);
  const expectedDevelopmentRoot = fingerprintJson({ root: resolvedRoot });
  const chains = [];
  const outputs = [];
  let sequence = 1;
  for (const row of requested) {
    for (const host of HOSTS) {
      const built = buildDevelopmentHostHistoricalEvidenceForBatch({
        root: resolvedRoot,
        requestId: row.requests[host],
        requireCurrentCandidateLock
      });
      const binding = built.binding;
      if (binding.requestId !== row.requests[host]
        || binding.workflow.id !== row.id
        || binding.host !== host
        || binding.workspace.rootIdentityFingerprint !== expectedDevelopmentRoot
        || binding.workspace.exactInputState !== 'clean'
        || binding.workspace.postExactInputState !== 'clean'
        || binding.workspace.treeFingerprint !== binding.workspace.postTreeFingerprint) {
        fail(
          'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHAIN_INVALID',
          'Every private host chain must bind the exact workflow, host, root, and unchanged clean development tree.'
        );
      }
      chains.push(structuredClone(binding));
      outputs.push(buildOutput(built.evidence, row.id, host, sequence));
      sequence += 1;
    }
  }
  const after = publicTreeBasis(resolvedRoot, ignoredOutputPaths);
  if (before.fingerprint !== after.fingerprint) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_BASIS_DRIFT', 'Public candidate tree changed while the fourteen private chains were validated.');
  }
  const common = (selector, label) => {
    const values = chains.map(selector);
    if (new Set(values).size !== 1 || !values[0]) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHAIN_INVALID', 'The fourteen private chains do not share one exact ' + label + '.');
    }
    return values[0];
  };
  const hostGraphFingerprints = Object.fromEntries(HOSTS.map((host) => {
    const hostChains = chains.filter((chain) => chain.host === host);
    const values = hostChains.map((chain) => chain.configuration.graphFingerprint);
    if (hostChains.length !== WORKFLOW_IDS.length
      || new Set(values).size !== 1
      || !HASH.test(values[0] || '')) {
      fail(
        'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHAIN_INVALID',
        'The seven private chains for each host must share one exact host-specific candidate graph.'
      );
    }
    return [host, values[0]];
  }));
  if (new Set(Object.values(hostGraphFingerprints)).size !== HOSTS.length) {
    fail(
      'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHAIN_INVALID',
      'Codex and Claude candidate graphs must remain distinct exact host bindings.'
    );
  }
  const basis = {
    publicTreeFingerprint: before.fingerprint,
    developmentTreeFingerprint: common((chain) => chain.workspace.treeFingerprint, 'clean development tree'),
    revisionFingerprint: common((chain) => chain.workspace.revisionFingerprint || 'none', 'development revision') === 'none'
      ? null
      : chains[0].workspace.revisionFingerprint,
    hostGraphFingerprints,
    policyFingerprint: common((chain) => chain.workspace.policyFingerprint, 'workspace policy'),
    settingsFingerprint: common((chain) => chain.workspace.settingsFingerprint, 'workspace settings')
  };
  const directories = [
    directoryState(resolvedRoot, 'soter/evidence'),
    directoryState(resolvedRoot, OUTPUT_DIRECTORY)
  ];
  const candidate = {
    basis,
    directories,
    chains,
    outputs: outputs.sort((left, right) => compareCodepoint(left.path, right.path))
      .map((output, index) => ({ ...output, sequence: index + 1 }))
  };
  candidate.candidateFingerprint = candidateFingerprint(candidate);
  return candidate;
}

function validateCandidateShape(candidate) {
  if (!exactKeys(candidate, ['basis', 'directories', 'chains', 'outputs', 'candidateFingerprint'])
    || candidate.candidateFingerprint !== candidateFingerprint(candidate)
    || !exactKeys(candidate.basis, [
      'publicTreeFingerprint',
      'developmentTreeFingerprint',
      'revisionFingerprint',
      'hostGraphFingerprints',
      'policyFingerprint',
      'settingsFingerprint'
    ])
    || !exactKeys(candidate.basis.hostGraphFingerprints, HOSTS)
    || [
      candidate.basis.publicTreeFingerprint,
      candidate.basis.developmentTreeFingerprint,
      ...HOSTS.map((host) => candidate.basis.hostGraphFingerprints?.[host]),
      candidate.basis.policyFingerprint,
      candidate.basis.settingsFingerprint
    ].some((value) => !HASH.test(value || ''))
    || new Set(HOSTS.map((host) => candidate.basis.hostGraphFingerprints[host])).size !== HOSTS.length
    || (candidate.basis.revisionFingerprint !== null && !HASH.test(candidate.basis.revisionFingerprint || ''))
    || !Array.isArray(candidate.directories) || candidate.directories.length !== 2
    || !Array.isArray(candidate.chains) || candidate.chains.length !== 14
    || !Array.isArray(candidate.outputs) || candidate.outputs.length !== 14) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_INVALID', 'Historical evidence candidate shape or fingerprint is invalid.');
  }
  const expectedDirectories = ['soter/evidence', OUTPUT_DIRECTORY];
  candidate.directories.forEach((directory, index) => {
    if (!exactKeys(directory, ['path', 'mode', 'preState'])
      || directory.path !== expectedDirectories[index]
      || directory.mode !== '0755'
      || !['absent', 'existing'].includes(directory.preState)) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_INVALID', 'Historical evidence directory plan is invalid.');
    }
  });
  const requestIds = [];
  for (const chain of candidate.chains) {
    if (!exactKeys(chain, [
      'requestId', 'requestFingerprint', 'resultFingerprint', 'observationFingerprint',
      'finalizationFingerprint', 'finalizedAt', 'workflow', 'host', 'configuration', 'workspace'
    ]) || !DEVELOPMENT_REQUEST_ID.test(chain.requestId || '')
      || !WORKFLOW_IDS.includes(chain.workflow?.id)
      || !HOSTS.includes(chain.host)
      || !exactKeys(chain.workflow, ['id', 'version'])
      || !exactKeys(chain.configuration, ['name', 'lockPath', 'lockFingerprint', 'graphFingerprint'])
      || !exactKeys(chain.workspace, [
        'rootIdentityFingerprint', 'revisionFingerprint', 'treeFingerprint', 'exactInputState',
        'postTreeFingerprint', 'postExactInputState', 'policyFingerprint', 'settingsFingerprint'
      ])
      || [
        chain.requestFingerprint, chain.resultFingerprint, chain.observationFingerprint,
        chain.finalizationFingerprint, chain.configuration.lockFingerprint,
        chain.configuration.graphFingerprint, chain.workspace.rootIdentityFingerprint,
        chain.workspace.treeFingerprint, chain.workspace.postTreeFingerprint,
        chain.workspace.policyFingerprint, chain.workspace.settingsFingerprint
      ].some((value) => !HASH.test(value || ''))
      || (chain.workspace.revisionFingerprint !== null && !HASH.test(chain.workspace.revisionFingerprint || ''))
      || chain.workspace.exactInputState !== 'clean'
      || chain.workspace.postExactInputState !== 'clean'
      || chain.configuration.graphFingerprint !== candidate.basis.hostGraphFingerprints[chain.host]) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_INVALID', 'Historical evidence private-chain binding is invalid.');
    }
    exactInstant(chain.finalizedAt, 'Private chain finalizedAt');
    requestIds.push(chain.requestId);
  }
  if (new Set(requestIds).size !== 14) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_INVALID', 'Historical evidence private-chain identities are not unique.');
  }
  candidate.outputs.forEach((output, index) => {
    const match = output.path?.match(OUTPUT_PATH);
    if (!exactKeys(output, [
      'sequence', 'path', 'mode', 'documentFingerprint', 'contentFingerprint', 'document'
    ]) || output.sequence !== index + 1 || output.mode !== '0644' || !match
      || !HASH.test(output.documentFingerprint || '') || !HASH.test(output.contentFingerprint || '')
      || output.documentFingerprint !== fingerprintJson(output.document)
      || output.contentFingerprint !== sha256(canonicalBytes(output.document))
      || output.document.id !== path.posix.basename(output.path, '.json')) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_INVALID', 'Historical evidence output plan or exact bytes are invalid.');
    }
    assertEvidenceSafe(output.document);
  });
  if (new Set(candidate.outputs.map((output) => output.path)).size !== 14) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_INVALID', 'Historical evidence output paths are not unique.');
  }
}

function validateRequest(root, request) {
  if (!exactKeys(request, [
    '$contract', 'contractVersion', 'id', 'requestFingerprint', 'createdAt', 'validUntil',
    'rootIdentityFingerprint', 'candidate', 'authority'
  ]) || request.$contract !== REQUEST_CONTRACT || request.contractVersion !== '1.0.0'
    || !REQUEST_ID.test(request.id || '') || !HASH.test(request.requestFingerprint || '')
    || request.requestFingerprint !== requestFingerprint(request)
    || request.rootIdentityFingerprint !== rootIdentity(root).fingerprint
    || !exactKeys(request.authority, [
      'kind', 'grantsExecution', 'grantsApproval', 'grantsActivation', 'grantsFixtureMutation',
      'grantsFinalLockMutation', 'grantsProviderRead', 'grantsProviderWrite', 'grantsHostCall'
    ]) || request.authority.kind !== 'historical-evidence-publication-only'
    || Object.entries(request.authority).some(([key, value]) => key !== 'kind' && value !== false)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_INVALID', 'Historical evidence request identity, root, authority, or fingerprint is invalid.');
  }
  const createdAt = exactInstant(request.createdAt, 'Historical evidence request createdAt');
  const validUntil = exactInstant(request.validUntil, 'Historical evidence request validUntil');
  if (validUntil <= createdAt || validUntil - createdAt > REQUEST_MAX_TTL_MS) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_INVALID', 'Historical evidence request validity window is invalid.');
  }
  validateCandidateShape(request.candidate);
  if (containsCredentialMaterial(request)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PRIVATE_MATERIAL_INVALID', 'Historical evidence request cannot contain credential material.');
  }
  return request;
}

function readPrivateRequest(root, requestPath) {
  if (typeof requestPath !== 'string' || !path.isAbsolute(requestPath)
    || requestPath !== path.resolve(requestPath)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_PATH_INVALID', 'Historical evidence request must be one absolute external private file.');
  }
  const resolvedRoot = canonicalRoot(root);
  let stat;
  let real;
  try {
    stat = fs.lstatSync(requestPath);
    real = fs.realpathSync(requestPath);
  } catch (error) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_PATH_INVALID', 'Historical evidence request is unavailable.', error);
  }
  if (real === resolvedRoot || real.startsWith(resolvedRoot + path.sep)
    || real !== path.resolve(requestPath) || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o600)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_PATH_INVALID', 'Historical evidence request must be one exact non-linked external 0600 file.');
  }
  let descriptor = null;
  try {
    descriptor = fs.openSync(requestPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.dev !== stat.dev || before.ino !== stat.ino
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || after.nlink !== 1) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_PATH_INVALID', 'Historical evidence request changed during its exact read.');
    }
    const request = JSON.parse(bytes.toString('utf8'));
    if (!bytes.equals(canonicalBytes(request))) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_INVALID', 'Historical evidence request must contain exact canonical JSON bytes.');
    }
    return validateRequest(resolvedRoot, request);
  } catch (error) {
    if (error?.code?.startsWith('DEVELOPMENT_HISTORICAL_')) throw error;
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_INVALID', 'Historical evidence request is malformed.', error);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function compareCandidate(request, candidate, { recovery }) {
  validateCandidateShape(candidate);
  if (!same(request.candidate.basis, candidate.basis)
    || !same(request.candidate.chains, candidate.chains)
    || !same(request.candidate.outputs, candidate.outputs)
    || (!recovery && !same(request.candidate.directories, candidate.directories))) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CANDIDATE_MISMATCH', 'Current private chains, clean-tree basis, or exact output bytes differ from the sealed request.');
  }
  if (!recovery && candidate.candidateFingerprint !== request.candidate.candidateFingerprint) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CANDIDATE_MISMATCH', 'Historical evidence candidate fingerprint changed.');
  }
}

export function buildDevelopmentHistoricalEvidenceBatchRequest({
  root,
  id,
  createdAt,
  validUntil,
  workflows,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length || !REQUEST_ID.test(id || '')) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_ARGUMENTS_INVALID', 'Historical evidence request builder received an unknown or malformed argument.');
  }
  exactInstant(createdAt, 'Historical evidence request createdAt');
  exactInstant(validUntil, 'Historical evidence request validUntil');
  const resolvedRoot = canonicalRoot(root);
  const candidate = deriveCandidate({
    root: resolvedRoot,
    workflows,
    requireCurrentCandidateLock: true
  });
  const request = {
    $contract: REQUEST_CONTRACT,
    contractVersion: '1.0.0',
    id,
    requestFingerprint: 'sha256:' + '0'.repeat(64),
    createdAt,
    validUntil,
    rootIdentityFingerprint: rootIdentity(resolvedRoot).fingerprint,
    candidate,
    authority: {
      kind: 'historical-evidence-publication-only',
      grantsExecution: false,
      grantsApproval: false,
      grantsActivation: false,
      grantsFixtureMutation: false,
      grantsFinalLockMutation: false,
      grantsProviderRead: false,
      grantsProviderWrite: false,
      grantsHostCall: false
    }
  };
  request.requestFingerprint = requestFingerprint(request);
  return validateRequest(resolvedRoot, request);
}

function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function unlinkDurably(file) {
  fs.unlinkSync(file);
  fsyncDirectory(path.dirname(file));
}

function ensurePrivateStateDirectory(root, { create = true } = {}) {
  const resolvedRoot = canonicalRoot(root);
  let current = resolvedRoot;
  for (const part of STATE_DIRECTORY.split('/')) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      if (!create) {
        fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PRIVATE_STATE_INVALID', 'Historical evidence private state parent is unavailable.');
      }
      try {
        fs.mkdirSync(current, { recursive: false, mode: 0o700 });
        if (process.platform !== 'win32') fs.chmodSync(current, 0o700);
        fsyncDirectory(current);
        fsyncDirectory(path.dirname(current));
      } catch (error) {
        fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PRIVATE_STATE_INVALID', 'Historical evidence private state parent could not be created exactly.', error);
      }
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current
      || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o700)) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PRIVATE_STATE_INVALID', 'Historical evidence private state parent must be one exact 0700 directory.');
    }
  }
  return current;
}

function stateFiles(root, requestId) {
  if (!REQUEST_ID.test(requestId || '')) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PRIVATE_STATE_INVALID', 'Historical evidence private state identity is invalid.');
  }
  const directory = confinedPath(root, STATE_DIRECTORY);
  return {
    directory,
    consumption: path.join(directory, requestId + '.consumption.json'),
    checkpoint: path.join(directory, requestId + '.checkpoint.json')
  };
}

function readCanonicalPrivateState(file, label, allowedLinks = [1]) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (!before.isFile() || !allowedLinks.includes(before.nlink)
      || (process.platform !== 'win32' && (before.mode & 0o7777) !== 0o600)
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || !allowedLinks.includes(after.nlink)) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PRIVATE_STATE_INVALID', label + ' is not one stable non-linked 0600 file.');
    }
    const value = JSON.parse(bytes.toString('utf8'));
    if (!bytes.equals(canonicalBytes(value))) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PRIVATE_STATE_INVALID', label + ' is not exact canonical JSON.');
    }
    return value;
  } catch (error) {
    if (error?.code?.startsWith('DEVELOPMENT_HISTORICAL_')) throw error;
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PRIVATE_STATE_INVALID', label + ' is unavailable or malformed.', error);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function writePrivateCreateOnly(file, value, label) {
  const bytes = canonicalBytes(value);
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fsyncDirectory(path.dirname(file));
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (error?.code === 'EEXIST') throw error;
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PRIVATE_STATE_INVALID', label + ' could not be created exactly.', error);
  }
}

function consumptionFingerprint(consumption) {
  const unsigned = structuredClone(consumption);
  delete unsigned.consumptionFingerprint;
  return fingerprintJson(unsigned);
}

function validateConsumption(root, request, consumption) {
  if (!exactKeys(consumption, [
    '$contract', 'contractVersion', 'id', 'consumptionFingerprint', 'startedAt',
    'rootIdentityFingerprint', 'request', 'candidateFingerprint', 'outputSetFingerprint', 'authority'
  ]) || consumption.$contract !== CONSUMPTION_CONTRACT || consumption.contractVersion !== '1.0.0'
    || consumption.id !== request.id + '.consumption'
    || consumption.consumptionFingerprint !== consumptionFingerprint(consumption)
    || consumption.rootIdentityFingerprint !== request.rootIdentityFingerprint
    || consumption.rootIdentityFingerprint !== rootIdentity(root).fingerprint
    || !exactKeys(consumption.request, ['id', 'fingerprint', 'validUntil'])
    || consumption.request.id !== request.id
    || consumption.request.fingerprint !== request.requestFingerprint
    || consumption.request.validUntil !== request.validUntil
    || consumption.candidateFingerprint !== request.candidate.candidateFingerprint
    || consumption.outputSetFingerprint !== fingerprintJson(request.candidate.outputs)
    || consumption.authority !== 'exact-historical-evidence-batch-recovery-only') {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CONSUMPTION_INVALID', 'Historical evidence consumption does not bind the exact request, root, candidate, and output set.');
  }
  const startedAt = exactInstant(consumption.startedAt, 'Historical evidence consumption startedAt');
  if (startedAt < Date.parse(request.createdAt) || startedAt >= Date.parse(request.validUntil)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CONSUMPTION_INVALID', 'Historical evidence consumption falls outside the exact request validity window.');
  }
  return consumption;
}

function readConsumption(root, request) {
  ensurePrivateStateDirectory(root, { create: false });
  const files = stateFiles(root, request.id);
  return validateConsumption(
    root,
    request,
    readCanonicalPrivateState(files.consumption, 'Historical evidence consumption')
  );
}

function createConsumption(root, request, at) {
  const parsed = exactInstant(at, 'Historical evidence consumption time');
  if (parsed < Date.parse(request.createdAt) || parsed >= Date.parse(request.validUntil)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_EXPIRED', 'Historical evidence request is not yet valid or has expired.');
  }
  assertRoot(root, request.rootIdentityFingerprint);
  const directory = ensurePrivateStateDirectory(root);
  const files = stateFiles(root, request.id);
  const consumption = {
    $contract: CONSUMPTION_CONTRACT,
    contractVersion: '1.0.0',
    id: request.id + '.consumption',
    consumptionFingerprint: 'sha256:' + '0'.repeat(64),
    startedAt: at,
    rootIdentityFingerprint: request.rootIdentityFingerprint,
    request: {
      id: request.id,
      fingerprint: request.requestFingerprint,
      validUntil: request.validUntil
    },
    candidateFingerprint: request.candidate.candidateFingerprint,
    outputSetFingerprint: fingerprintJson(request.candidate.outputs),
    authority: 'exact-historical-evidence-batch-recovery-only'
  };
  consumption.consumptionFingerprint = consumptionFingerprint(consumption);
  try {
    writePrivateCreateOnly(files.consumption, consumption, 'Historical evidence consumption');
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return readConsumption(root, request);
  }
  fsyncDirectory(directory);
  return readConsumption(root, request);
}

function checkpointAuthority(checkpoint) {
  return fingerprintJson({
    contract: checkpoint.$contract,
    contractVersion: checkpoint.contractVersion,
    id: checkpoint.id,
    rootIdentityFingerprint: checkpoint.rootIdentityFingerprint,
    request: checkpoint.request,
    consumptionFingerprint: checkpoint.consumptionFingerprint,
    candidateFingerprint: checkpoint.candidateFingerprint,
    directories: checkpoint.directories.map((directory) => ({
      path: directory.path,
      mode: directory.mode,
      preState: directory.preState
    })),
    outputs: checkpoint.outputs.map((output) => ({
      sequence: output.sequence,
      path: output.path,
      documentFingerprint: output.documentFingerprint,
      contentFingerprint: output.contentFingerprint
    }))
  });
}

function checkpointFingerprint(checkpoint) {
  const unsigned = structuredClone(checkpoint);
  delete unsigned.checkpointFingerprint;
  return fingerprintJson(unsigned);
}

function sealCheckpoint(checkpoint) {
  checkpoint.checkpointFingerprint = 'sha256:' + '0'.repeat(64);
  checkpoint.checkpointFingerprint = checkpointFingerprint(checkpoint);
  return checkpoint;
}

function validateCheckpoint(root, request, consumption, checkpoint) {
  if (!exactKeys(checkpoint, [
    '$contract', 'contractVersion', 'id', 'checkpointFingerprint', 'authorityFingerprint',
    'createdAt', 'updatedAt', 'rootIdentityFingerprint', 'request', 'consumptionFingerprint',
    'candidateFingerprint', 'state', 'phase', 'directories', 'outputs', 'failure'
  ]) || checkpoint.$contract !== CHECKPOINT_CONTRACT || checkpoint.contractVersion !== '1.0.0'
    || checkpoint.id !== request.id + '.checkpoint'
    || checkpoint.checkpointFingerprint !== checkpointFingerprint(checkpoint)
    || checkpoint.authorityFingerprint !== checkpointAuthority(checkpoint)
    || checkpoint.rootIdentityFingerprint !== request.rootIdentityFingerprint
    || checkpoint.rootIdentityFingerprint !== rootIdentity(root).fingerprint
    || !exactKeys(checkpoint.request, ['id', 'fingerprint', 'validUntil'])
    || checkpoint.request.id !== request.id
    || checkpoint.request.fingerprint !== request.requestFingerprint
    || checkpoint.request.validUntil !== request.validUntil
    || checkpoint.consumptionFingerprint !== consumption.consumptionFingerprint
    || checkpoint.candidateFingerprint !== request.candidate.candidateFingerprint) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_INVALID', 'Historical evidence checkpoint identity, authority, or fingerprint is invalid.');
  }
  const createdAt = exactInstant(checkpoint.createdAt, 'Historical evidence checkpoint createdAt');
  const updatedAt = exactInstant(checkpoint.updatedAt, 'Historical evidence checkpoint updatedAt');
  if (createdAt !== Date.parse(consumption.startedAt) || updatedAt < createdAt) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_INVALID', 'Historical evidence checkpoint chronology is invalid.');
  }
  if (!['running', 'completed', 'rolled-back', 'needs-attention'].includes(checkpoint.state)
    || !['publishing', 'verifying', 'rolling-back', 'completed', 'rolled-back', 'needs-attention'].includes(checkpoint.phase)
    || !Array.isArray(checkpoint.directories) || checkpoint.directories.length !== 2
    || !Array.isArray(checkpoint.outputs) || checkpoint.outputs.length !== 14) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_INVALID', 'Historical evidence checkpoint state or progress shape is invalid.');
  }
  checkpoint.directories.forEach((directory, index) => {
    const planned = request.candidate.directories[index];
    if (!exactKeys(directory, ['path', 'mode', 'preState', 'state'])
      || directory.path !== planned.path || directory.mode !== planned.mode
      || directory.preState !== planned.preState
      || !['existing', 'planned', 'creating', 'created', 'removed', 'blocked'].includes(directory.state)
      || (directory.preState === 'existing' && directory.state !== 'existing')) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_INVALID', 'Historical evidence checkpoint directory progress is invalid.');
    }
  });
  checkpoint.outputs.forEach((output, index) => {
    const planned = request.candidate.outputs[index];
    if (!exactKeys(output, [
      'sequence', 'path', 'documentFingerprint', 'contentFingerprint', 'state'
    ]) || output.sequence !== planned.sequence || output.path !== planned.path
      || output.documentFingerprint !== planned.documentFingerprint
      || output.contentFingerprint !== planned.contentFingerprint
      || !['planned', 'begun', 'applied', 'verified', 'rolled-back', 'blocked'].includes(output.state)) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_INVALID', 'Historical evidence checkpoint output progress is invalid.');
    }
  });
  const publicationProgressValid = (() => {
    let begun = false;
    let planned = false;
    for (const output of checkpoint.outputs) {
      if (output.state === 'applied') {
        if (begun || planned) return false;
        continue;
      }
      if (output.state === 'begun') {
        if (begun || planned) return false;
        begun = true;
        planned = true;
        continue;
      }
      if (output.state === 'planned') {
        planned = true;
        continue;
      }
      return false;
    }
    return true;
  })();
  const exactState = checkpoint.state === 'completed'
    ? checkpoint.phase === 'completed'
      && checkpoint.failure === null
      && checkpoint.outputs.every((output) => output.state === 'verified')
      && checkpoint.directories.every((directory) => directory.preState === 'existing' || directory.state === 'created')
    : checkpoint.state === 'rolled-back'
      ? checkpoint.phase === 'rolled-back'
        && checkpoint.failure?.summary === ROLLED_BACK_SUMMARY
        && checkpoint.outputs.every((output) => output.state === 'rolled-back')
        && checkpoint.directories.every((directory) => directory.preState === 'existing' || directory.state === 'removed')
      : checkpoint.state === 'needs-attention'
        ? checkpoint.phase === 'needs-attention'
          && checkpoint.failure?.summary === NEEDS_ATTENTION_SUMMARY
        : checkpoint.failure === null && (
          (checkpoint.phase === 'publishing' && publicationProgressValid)
          || (checkpoint.phase === 'verifying'
            && checkpoint.outputs.every((output) => output.state === 'applied'))
          || checkpoint.phase === 'rolling-back'
        );
  if (!exactState) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_INVALID', 'Historical evidence checkpoint terminal or running-state semantics are invalid.');
  }
  if (checkpoint.failure !== null
    && (!exactKeys(checkpoint.failure, ['reasonCode', 'summary'])
      || !/^DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_[A-Z0-9_]+$/.test(checkpoint.failure.reasonCode || ''))) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_INVALID', 'Historical evidence checkpoint failure projection is invalid.');
  }
  return checkpoint;
}

function checkpointFiles(root, request) {
  const files = stateFiles(root, request.id);
  return { primary: files.checkpoint, pending: files.checkpoint + '.pending' };
}

function readCheckpointDocument(file, label, allowedLinks = [1]) {
  return readCanonicalPrivateState(file, label, allowedLinks);
}

function reconcileCheckpointPending(root, request, consumption, current = null) {
  const files = checkpointFiles(root, request);
  if (!fs.existsSync(files.pending)) return;
  const pendingStat = fs.lstatSync(files.pending);
  if (!pendingStat.isFile() || pendingStat.isSymbolicLink() || ![1, 2].includes(pendingStat.nlink)
    || (process.platform !== 'win32' && (pendingStat.mode & 0o7777) !== 0o600)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_COLLISION', 'Historical evidence checkpoint temporary is unsafe.');
  }
  const pending = validateCheckpoint(
    root,
    request,
    consumption,
    readCheckpointDocument(files.pending, 'Historical evidence checkpoint temporary', [1, 2])
  );
  if (current && checkpointAuthority(pending) !== checkpointAuthority(current)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_COLLISION', 'Historical evidence checkpoint temporary has different authority.');
  }
  if (fs.existsSync(files.primary)) {
    const primaryStat = fs.lstatSync(files.primary);
    if (pendingStat.nlink === 2
      && (pendingStat.dev !== primaryStat.dev || pendingStat.ino !== primaryStat.ino)) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_COLLISION', 'Historical evidence checkpoint temporary is an external hardlink.');
    }
    unlinkDurably(files.pending);
    return;
  }
  if (pendingStat.nlink !== 1) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_COLLISION', 'Orphan historical evidence checkpoint temporary is linked externally.');
  }
  fs.linkSync(files.pending, files.primary);
  fsyncDirectory(path.dirname(files.primary));
  unlinkDurably(files.pending);
}

function readCheckpoint(root, request, consumption) {
  ensurePrivateStateDirectory(root, { create: false });
  const files = checkpointFiles(root, request);
  if (!fs.existsSync(files.primary)) {
    if (fs.existsSync(files.pending)) reconcileCheckpointPending(root, request, consumption);
  }
  const checkpoint = validateCheckpoint(
    root,
    request,
    consumption,
    readCheckpointDocument(files.primary, 'Historical evidence checkpoint', [1, 2])
  );
  if (fs.existsSync(files.pending)) reconcileCheckpointPending(root, request, consumption, checkpoint);
  const stat = fs.lstatSync(files.primary);
  if (stat.nlink !== 1) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_INVALID', 'Historical evidence checkpoint has an unresolved hardlink.');
  }
  return checkpoint;
}

function persistCheckpoint(root, request, consumption, checkpoint, { create = false } = {}) {
  assertRoot(root, request.rootIdentityFingerprint);
  checkpoint.authorityFingerprint = checkpointAuthority(checkpoint);
  const priorFingerprint = checkpoint.checkpointFingerprint;
  sealCheckpoint(checkpoint);
  validateCheckpoint(root, request, consumption, checkpoint);
  ensurePrivateStateDirectory(root);
  const files = checkpointFiles(root, request);
  const bytes = canonicalBytes(checkpoint);
  if (create) {
    if (fs.existsSync(files.primary)) {
      const existing = readCheckpoint(root, request, consumption);
      if (checkpointAuthority(existing) !== checkpointAuthority(checkpoint)) {
        fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_COLLISION', 'Existing historical evidence checkpoint has different authority.');
      }
      return existing;
    }
    if (fs.existsSync(files.pending)) reconcileCheckpointPending(root, request, consumption);
    if (fs.existsSync(files.primary)) return readCheckpoint(root, request, consumption);
    let descriptor = null;
    try {
      descriptor = fs.openSync(files.pending, 'wx', 0o600);
      if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      assertRoot(root, request.rootIdentityFingerprint);
      fs.linkSync(files.pending, files.primary);
      fsyncDirectory(path.dirname(files.primary));
      unlinkDurably(files.pending);
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      if (fs.existsSync(files.pending) && !fs.existsSync(files.primary)) unlinkDurably(files.pending);
    }
    return readCheckpoint(root, request, consumption);
  }
  const current = readCheckpoint(root, request, consumption);
  if (current.checkpointFingerprint !== priorFingerprint
    || checkpointAuthority(current) !== checkpointAuthority(checkpoint)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_DRIFT', 'Historical evidence checkpoint changed before its exact update.');
  }
  if (fs.existsSync(files.pending)) reconcileCheckpointPending(root, request, consumption, current);
  let descriptor = null;
  try {
    descriptor = fs.openSync(files.pending, 'wx', 0o600);
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    assertRoot(root, request.rootIdentityFingerprint);
    fs.renameSync(files.pending, files.primary);
    fsyncDirectory(path.dirname(files.primary));
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(files.pending)) unlinkDurably(files.pending);
  }
  return readCheckpoint(root, request, consumption);
}

function initialCheckpoint(root, request, consumption) {
  const checkpoint = {
    $contract: CHECKPOINT_CONTRACT,
    contractVersion: '1.0.0',
    id: request.id + '.checkpoint',
    checkpointFingerprint: 'sha256:' + '0'.repeat(64),
    authorityFingerprint: 'sha256:' + '0'.repeat(64),
    createdAt: consumption.startedAt,
    updatedAt: consumption.startedAt,
    rootIdentityFingerprint: request.rootIdentityFingerprint,
    request: {
      id: request.id,
      fingerprint: request.requestFingerprint,
      validUntil: request.validUntil
    },
    consumptionFingerprint: consumption.consumptionFingerprint,
    candidateFingerprint: request.candidate.candidateFingerprint,
    state: 'running',
    phase: 'publishing',
    directories: request.candidate.directories.map((directory) => ({
      ...structuredClone(directory),
      state: directory.preState === 'existing' ? 'existing' : 'planned'
    })),
    outputs: request.candidate.outputs.map((output) => ({
      sequence: output.sequence,
      path: output.path,
      documentFingerprint: output.documentFingerprint,
      contentFingerprint: output.contentFingerprint,
      state: 'planned'
    })),
    failure: null
  };
  checkpoint.authorityFingerprint = checkpointAuthority(checkpoint);
  sealCheckpoint(checkpoint);
  return persistCheckpoint(root, request, consumption, checkpoint, { create: true });
}

function assertDirectoryExact(root, relativePath) {
  const directory = confinedPath(root, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PATH_INVALID', 'Governed evidence directory is unavailable.', error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o755)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PATH_INVALID', 'Governed evidence directory must be one exact 0755 directory.');
  }
  return directory;
}

function createPlannedDirectories(
  root,
  request,
  consumption,
  checkpoint,
  at,
  selftestFault = null
) {
  for (let index = 0; index < checkpoint.directories.length; index += 1) {
    let progress = checkpoint.directories[index];
    if (progress.preState === 'existing') {
      assertDirectoryExact(root, progress.path);
      continue;
    }
    const directory = confinedPath(root, progress.path);
    if (progress.state === 'created') {
      if (!fs.existsSync(directory)) {
        fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_DIRECTORY_DRIFT', 'A checkpoint-owned evidence directory disappeared.');
      }
      assertDirectoryExact(root, progress.path);
      continue;
    }
    if (!['planned', 'creating'].includes(progress.state)) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_DIRECTORY_DRIFT', 'Historical evidence directory is not in one exact creatable state.');
    }
    if (progress.state === 'planned' && fs.existsSync(directory)) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_DIRECTORY_DRIFT', 'An unowned evidence directory appeared before its checkpoint-owned create step.');
    }
    const parentRelative = path.posix.dirname(progress.path);
    if (parentRelative !== '.') assertDirectoryExact(root, parentRelative);
    if (progress.state === 'planned') {
      progress.state = 'creating';
      checkpoint.updatedAt = at;
      checkpoint = persistCheckpoint(root, request, consumption, checkpoint);
      progress = checkpoint.directories[index];
      if (selftestFault?.kind === 'crash-after-directory-begun-before-create'
        && selftestFault.index === index) {
        const crash = new Error('Synthetic crash after durable directory-begun marker.');
        crash.simulatedCrash = true;
        throw crash;
      }
    }
    if (fs.existsSync(directory)) {
      assertDirectoryExact(root, progress.path);
      if (fs.readdirSync(directory).length !== 0) {
        fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_DIRECTORY_DRIFT', 'A begun evidence directory contains unowned entries before its create step completed.');
      }
    } else {
      assertRoot(root, request.rootIdentityFingerprint);
      try {
        fs.mkdirSync(directory, { mode: 0o755 });
        if (process.platform !== 'win32') fs.chmodSync(directory, 0o755);
        fsyncDirectory(directory);
        fsyncDirectory(path.dirname(directory));
      } catch (error) {
        fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PATH_INVALID', 'Governed evidence directory could not be created exactly.', error);
      }
      assertDirectoryExact(root, progress.path);
    }
    if (selftestFault?.kind === 'crash-after-directory-create-before-created'
      && selftestFault.index === index) {
      const crash = new Error('Synthetic crash after exact directory creation.');
      crash.simulatedCrash = true;
      throw crash;
    }
    progress.state = 'created';
    checkpoint.updatedAt = at;
    checkpoint = persistCheckpoint(root, request, consumption, checkpoint);
  }
  return checkpoint;
}

function outputRuntime(root, output) {
  const file = confinedPath(root, output.path);
  const directory = assertDirectoryExact(root, path.posix.dirname(output.path));
  const pending = path.join(
    directory,
    '.' + path.basename(file) + '.pending-' + output.contentFingerprint.slice('sha256:'.length, 'sha256:'.length + 24)
  );
  return {
    ...output,
    bytes: canonicalBytes(output.document),
    file,
    directory,
    pending
  };
}

function readExactOutputFile(file, bytes, { allowedLinks, label }) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    const observed = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (!before.isFile() || !allowedLinks.includes(before.nlink)
      || (process.platform !== 'win32' && (before.mode & 0o7777) !== 0o644)
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || !allowedLinks.includes(after.nlink)
      || !observed.equals(bytes)) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_OUTPUT_COLLISION', label + ' is not the exact sealed output bytes and mode.');
    }
    return after;
  } catch (error) {
    if (error?.code?.startsWith('DEVELOPMENT_HISTORICAL_')) throw error;
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_OUTPUT_COLLISION', label + ' is unavailable or unsafe.', error);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function inspectOutput(runtime) {
  const finalExists = fs.existsSync(runtime.file);
  const pendingExists = fs.existsSync(runtime.pending);
  if (!finalExists && !pendingExists) return { state: 'missing' };
  if (!finalExists && pendingExists) {
    const pending = readExactOutputFile(runtime.pending, runtime.bytes, {
      allowedLinks: [1],
      label: 'Historical evidence pending output'
    });
    return { state: 'pending', pending };
  }
  if (finalExists && !pendingExists) {
    const final = readExactOutputFile(runtime.file, runtime.bytes, {
      allowedLinks: [1],
      label: 'Historical evidence output'
    });
    return { state: 'exact', final };
  }
  const final = readExactOutputFile(runtime.file, runtime.bytes, {
    allowedLinks: [2],
    label: 'Linked historical evidence output'
  });
  const pending = readExactOutputFile(runtime.pending, runtime.bytes, {
    allowedLinks: [2],
    label: 'Linked historical evidence pending output'
  });
  if (final.dev !== pending.dev || final.ino !== pending.ino || final.nlink !== 2 || pending.nlink !== 2) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_OUTPUT_COLLISION', 'Historical evidence output and pending file are not one exact interrupted publication.');
  }
  return { state: 'linked', final, pending };
}

function assertNoUnrecognizedPending(runtime) {
  const prefix = '.' + path.basename(runtime.file) + '.pending-';
  const names = fs.readdirSync(runtime.directory).filter((name) => name.startsWith(prefix));
  if (names.length > (fs.existsSync(runtime.pending) ? 1 : 0)
    || names.some((name) => path.join(runtime.directory, name) !== runtime.pending)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_OUTPUT_COLLISION', 'Governed evidence directory contains an unrecognized pending output.');
  }
}

function initialOutputPreflight(root, request) {
  for (const directory of request.candidate.directories) {
    const file = confinedPath(root, directory.path);
    if (directory.preState === 'absent') {
      if (fs.existsSync(file)) {
        fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_UNOWNED_OUTPUT', 'A planned evidence directory already exists without exact batch consumption.');
      }
    } else {
      assertDirectoryExact(root, directory.path);
    }
  }
  const existingParent = request.candidate.directories.find((item) => item.path === OUTPUT_DIRECTORY)?.preState === 'existing';
  if (!existingParent) return;
  for (const output of request.candidate.outputs) {
    const runtime = outputRuntime(root, output);
    assertNoUnrecognizedPending(runtime);
    if (inspectOutput(runtime).state !== 'missing') {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_UNOWNED_OUTPUT', 'Existing historical evidence output cannot be adopted without exact batch consumption.');
    }
  }
}

function assertPublicBasis(root, request) {
  const current = publicTreeBasis(
    root,
    request.candidate.outputs.map((output) => output.path)
  );
  if (current.fingerprint !== request.candidate.basis.publicTreeFingerprint) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_BASIS_DRIFT', 'Public candidate tree changed before an exact historical evidence effect.');
  }
}

function publishOutput(root, request, runtime, progress) {
  if (progress.state !== 'begun') {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_UNOWNED_OUTPUT', 'Historical evidence publication lacks its durable per-output begun marker.');
  }
  assertRoot(root, request.rootIdentityFingerprint);
  assertPublicBasis(root, request);
  assertNoUnrecognizedPending(runtime);
  let inspected = inspectOutput(runtime);
  if (inspected.state === 'exact') return { recovered: true, stat: inspected.final };
  if (inspected.state === 'linked') {
    assertRoot(root, request.rootIdentityFingerprint);
    assertPublicBasis(root, request);
    unlinkDurably(runtime.pending);
    inspected = inspectOutput(runtime);
    if (inspected.state !== 'exact') {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_OUTPUT_INVALID', 'Interrupted linked evidence publication did not reconcile exactly.');
    }
    return { recovered: true, stat: inspected.final };
  }
  if (inspected.state === 'pending') {
    assertRoot(root, request.rootIdentityFingerprint);
    assertPublicBasis(root, request);
    fs.linkSync(runtime.pending, runtime.file);
    fsyncDirectory(runtime.directory);
    const linked = inspectOutput(runtime);
    if (linked.state !== 'linked') {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_OUTPUT_INVALID', 'Pending historical evidence did not link to its exact final path.');
    }
    unlinkDurably(runtime.pending);
    const exact = inspectOutput(runtime);
    if (exact.state !== 'exact') {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_OUTPUT_INVALID', 'Recovered historical evidence output is not exact.');
    }
    return { recovered: true, stat: exact.final };
  }
  let descriptor = null;
  let pendingIdentity = null;
  try {
    descriptor = fs.openSync(
      runtime.pending,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o644
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_OUTPUT_INVALID', 'New historical evidence pending output is unsafe.');
    }
    pendingIdentity = { dev: before.dev, ino: before.ino };
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o644);
    fs.writeFileSync(descriptor, runtime.bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    readExactOutputFile(runtime.pending, runtime.bytes, {
      allowedLinks: [1],
      label: 'New historical evidence pending output'
    });
    assertRoot(root, request.rootIdentityFingerprint);
    assertPublicBasis(root, request);
    fs.linkSync(runtime.pending, runtime.file);
    fsyncDirectory(runtime.directory);
    const linked = inspectOutput(runtime);
    if (linked.state !== 'linked') {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_OUTPUT_INVALID', 'New historical evidence output link is not exact.');
    }
    unlinkDurably(runtime.pending);
    pendingIdentity = null;
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (pendingIdentity && fs.existsSync(runtime.pending)) {
      const stat = fs.lstatSync(runtime.pending);
      if (stat.dev === pendingIdentity.dev && stat.ino === pendingIdentity.ino) unlinkDurably(runtime.pending);
    }
    if (error?.code?.startsWith('DEVELOPMENT_HISTORICAL_')) throw error;
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_OUTPUT_INVALID', 'Historical evidence output publication failed closed.', error);
  }
  const exact = inspectOutput(runtime);
  if (exact.state !== 'exact') {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_OUTPUT_INVALID', 'Published historical evidence output is not exact.');
  }
  return { recovered: false, stat: exact.final };
}

function verifyAllOutputs(root, request) {
  const states = [];
  for (const output of request.candidate.outputs) {
    const runtime = outputRuntime(root, output);
    assertNoUnrecognizedPending(runtime);
    const inspected = inspectOutput(runtime);
    if (inspected.state !== 'exact') {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_VERIFY_FAILED', 'One or more sealed historical evidence outputs are missing or unsafe.');
    }
    states.push(inspected.final);
  }
  return states;
}

function removeExactOutput(root, request, output, progress) {
  const parent = confinedPath(root, path.posix.dirname(output.path));
  if (!fs.existsSync(parent)) return progress.state === 'planned'
    || ['begun', 'rolled-back'].includes(progress.state);
  const runtime = outputRuntime(root, output);
  assertNoUnrecognizedPending(runtime);
  let inspected = inspectOutput(runtime);
  if (progress.state === 'planned') return inspected.state === 'missing';
  if (!['begun', 'applied', 'rolled-back'].includes(progress.state)) return false;
  if (inspected.state === 'missing') return ['begun', 'rolled-back'].includes(progress.state);
  if (inspected.state === 'pending') {
    assertRoot(root, request.rootIdentityFingerprint);
    unlinkDurably(runtime.pending);
    return inspectOutput(runtime).state === 'missing';
  }
  if (inspected.state === 'linked') {
    assertRoot(root, request.rootIdentityFingerprint);
    unlinkDurably(runtime.pending);
    inspected = inspectOutput(runtime);
  }
  if (inspected.state !== 'exact') return false;
  assertRoot(root, request.rootIdentityFingerprint);
  unlinkDurably(runtime.file);
  return inspectOutput(runtime).state === 'missing';
}

function rollbackBatch(root, request, consumption, checkpoint, at, reasonCode) {
  checkpoint.state = 'running';
  checkpoint.phase = 'rolling-back';
  checkpoint.failure = null;
  checkpoint.updatedAt = at;
  checkpoint = persistCheckpoint(root, request, consumption, checkpoint);
  const failures = [];
  for (let index = request.candidate.outputs.length - 1; index >= 0; index -= 1) {
      const output = request.candidate.outputs[index];
      const progress = checkpoint.outputs[index];
      try {
      const removed = removeExactOutput(root, request, output, progress);
      progress.state = removed ? 'rolled-back' : 'blocked';
      if (!removed) failures.push(output.path);
    } catch {
      progress.state = 'blocked';
      failures.push(output.path);
    }
    checkpoint.updatedAt = at;
    checkpoint = persistCheckpoint(root, request, consumption, checkpoint);
  }
  for (let index = checkpoint.directories.length - 1; index >= 0; index -= 1) {
    const directory = checkpoint.directories[index];
    if (directory.preState === 'existing') continue;
    const file = confinedPath(root, directory.path);
    try {
      if (directory.state === 'planned') {
        if (fs.existsSync(file)) throw new Error('unowned-directory-appeared');
        directory.state = 'removed';
        checkpoint.updatedAt = at;
        checkpoint = persistCheckpoint(root, request, consumption, checkpoint);
        continue;
      }
      if (fs.existsSync(file)) {
        assertDirectoryExact(root, directory.path);
        if (fs.readdirSync(file).length !== 0) throw new Error('directory-not-empty');
        assertRoot(root, request.rootIdentityFingerprint);
        fs.rmdirSync(file);
        fsyncDirectory(path.dirname(file));
      }
      directory.state = 'removed';
    } catch {
      directory.state = 'blocked';
      failures.push(directory.path);
    }
    checkpoint.updatedAt = at;
    checkpoint = persistCheckpoint(root, request, consumption, checkpoint);
  }
  checkpoint.state = failures.length ? 'needs-attention' : 'rolled-back';
  checkpoint.phase = failures.length ? 'needs-attention' : 'rolled-back';
  checkpoint.failure = {
    reasonCode: failures.length
      ? 'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_ROLLBACK_FAILED'
      : reasonCode,
    summary: failures.length ? NEEDS_ATTENTION_SUMMARY : ROLLED_BACK_SUMMARY
  };
  checkpoint.updatedAt = at;
  return persistCheckpoint(root, request, consumption, checkpoint);
}

function validateRecoveryDirectories(root, request, checkpoint = null) {
  for (const [index, directory] of request.candidate.directories.entries()) {
    const file = confinedPath(root, directory.path);
    if (directory.preState === 'existing') {
      assertDirectoryExact(root, directory.path);
      continue;
    }
    const state = checkpoint?.directories[index]?.state || 'planned';
    if (state === 'planned' || state === 'removed') {
      if (fs.existsSync(file)) {
        fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_DIRECTORY_DRIFT', 'An absent or rolled-back evidence directory appeared without checkpoint ownership.');
      }
      continue;
    }
    if (state === 'creating') {
      if (fs.existsSync(file)) {
        assertDirectoryExact(root, directory.path);
        if (fs.readdirSync(file).length !== 0) {
          fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_DIRECTORY_DRIFT', 'A begun evidence directory contains unowned entries.');
        }
      }
      continue;
    }
    if (state === 'created') {
      if (!fs.existsSync(file)) {
        fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_DIRECTORY_DRIFT', 'A checkpoint-owned evidence directory disappeared.');
      }
      assertDirectoryExact(root, directory.path);
      continue;
    }
    if (state === 'blocked') continue;
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_DIRECTORY_DRIFT', 'Historical evidence directory checkpoint state is invalid.');
  }
}

function requestRuntimeState(root, request) {
  const files = stateFiles(root, request.id);
  const consumptionExists = fs.existsSync(files.consumption);
  const checkpointExists = fs.existsSync(files.checkpoint) || fs.existsSync(files.checkpoint + '.pending');
  if (!consumptionExists && checkpointExists) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_INVALID', 'Historical evidence checkpoint cannot exist without exact request consumption.');
  }
  if (!consumptionExists) return { consumption: null, checkpoint: null };
  const consumption = readConsumption(root, request);
  const checkpoint = checkpointExists ? readCheckpoint(root, request, consumption) : null;
  return { consumption, checkpoint };
}

function readRequestAndCandidate({ root, requestPath }) {
  const resolvedRoot = canonicalRoot(root);
  const request = readPrivateRequest(resolvedRoot, requestPath);
  const state = requestRuntimeState(resolvedRoot, request);
  if (state.checkpoint?.state === 'completed') {
    validateRecoveryDirectories(resolvedRoot, request, state.checkpoint);
    verifyAllOutputs(resolvedRoot, request);
    return {
      root: resolvedRoot,
      request,
      candidate: structuredClone(request.candidate),
      ...state,
      terminalHistorical: true
    };
  }
  const workflowRows = WORKFLOW_IDS.map((workflowId) => ({
    id: workflowId,
    requests: Object.fromEntries(HOSTS.map((host) => {
      const chain = request.candidate.chains.find(
        (item) => item.workflow.id === workflowId && item.host === host
      );
      return [host, chain?.requestId];
    }))
  }));
  const candidate = deriveCandidate({
    root: resolvedRoot,
    workflows: workflowRows,
    requireCurrentCandidateLock: !state.consumption
  });
  compareCandidate(request, candidate, { recovery: Boolean(state.consumption) });
  if (state.consumption) validateRecoveryDirectories(resolvedRoot, request, state.checkpoint);
  return { root: resolvedRoot, request, candidate, ...state, terminalHistorical: false };
}

export function readDevelopmentHistoricalEvidenceBatchRequest({
  root,
  requestPath,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_ARGUMENTS_INVALID', 'Historical evidence request reader received an unknown argument.');
  }
  return readRequestAndCandidate({ root, requestPath });
}

function assertOperationTime(checkpoint, at) {
  const parsed = exactInstant(at, 'Historical evidence operation time');
  if (parsed < Date.parse(checkpoint.createdAt) || parsed < Date.parse(checkpoint.updatedAt)) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_TIME_INVALID', 'Historical evidence operation time cannot move backward.');
  }
}

function runPublication({
  root,
  request,
  consumption,
  checkpoint,
  at,
  selftestFault = null
}) {
  assertOperationTime(checkpoint, at);
  if (checkpoint.state === 'completed' || checkpoint.state === 'rolled-back') return checkpoint;
  if (checkpoint.state === 'needs-attention') {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_NEEDS_ATTENTION', 'Historical evidence batch requires checkpoint-bound reconciliation.');
  }
  try {
    checkpoint = createPlannedDirectories(
      root,
      request,
      consumption,
      checkpoint,
      at,
      selftestFault
    );
    for (let index = 0; index < request.candidate.outputs.length; index += 1) {
      const output = request.candidate.outputs[index];
      const runtime = outputRuntime(root, output);
      let progress = checkpoint.outputs[index];
      assertNoUnrecognizedPending(runtime);
      const before = inspectOutput(runtime);
      if (progress.state === 'planned') {
        if (before.state !== 'missing') {
          fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_UNOWNED_OUTPUT', 'An unbegun historical evidence output or temporary cannot be adopted.');
        }
        progress.state = 'begun';
        checkpoint.updatedAt = at;
        checkpoint = persistCheckpoint(root, request, consumption, checkpoint);
        progress = checkpoint.outputs[index];
        if (selftestFault?.kind === 'crash-after-begun-before-output'
          && selftestFault.index === index) {
          const crash = new Error('Synthetic crash after durable output-begun marker.');
          crash.simulatedCrash = true;
          throw crash;
        }
      } else if (progress.state === 'applied') {
        if (before.state !== 'exact') {
          fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_OUTPUT_COLLISION', 'An applied historical evidence output is no longer exact.');
        }
        continue;
      } else if (progress.state !== 'begun') {
        fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_INVALID', 'Historical evidence publication encountered an impossible output state.');
      }
      const published = publishOutput(root, request, runtime, progress);
      if (selftestFault?.kind === 'crash-after-output' && selftestFault.index === index) {
        const crash = new Error('Synthetic crash after exact output publication.');
        crash.simulatedCrash = true;
        throw crash;
      }
      progress.state = 'applied';
      checkpoint.updatedAt = at;
      checkpoint = persistCheckpoint(root, request, consumption, checkpoint);
      if (selftestFault?.kind === 'failure-after-output' && selftestFault.index === index) {
        fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_SELFTEST_FAILURE', 'Synthetic publication failure.');
      }
      if (published.recovered && checkpoint.outputs[index].state !== 'applied') {
        fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_INVALID', 'Recovered output progress was not sealed.');
      }
    }
    checkpoint.phase = 'verifying';
    checkpoint.updatedAt = at;
    checkpoint = persistCheckpoint(root, request, consumption, checkpoint);
    verifyAllOutputs(root, request);
    checkpoint.outputs.forEach((output) => { output.state = 'verified'; });
    checkpoint.state = 'completed';
    checkpoint.phase = 'completed';
    checkpoint.failure = null;
    checkpoint.updatedAt = at;
    checkpoint = persistCheckpoint(root, request, consumption, checkpoint);
    return checkpoint;
  } catch (error) {
    if (error?.simulatedCrash) throw error;
    const reasonCode = normalizeCode(
      error,
      'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PUBLICATION_FAILED'
    );
    try {
      rollbackBatch(root, request, consumption, checkpoint, at, reasonCode);
    } catch (rollbackError) {
      if (rollbackError?.code === 'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CHECKPOINT_DRIFT') {
        throw rollbackError;
      }
      fail(
        'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_ROLLBACK_FAILED',
        'Historical evidence publication failed and exact rollback could not be completed.',
        error
      );
    }
    throw error;
  }
}

function outputProjectionState(root, request, checkpoint, output, index) {
  if (checkpoint?.outputs[index]?.state === 'rolled-back') return 'rolled-back';
  const parent = confinedPath(root, path.posix.dirname(output.path));
  if (!fs.existsSync(parent)) return 'pending';
  try {
    const runtime = outputRuntime(root, output);
    assertNoUnrecognizedPending(runtime);
    const state = inspectOutput(runtime).state;
    if (state === 'exact') return 'exact';
    if (state === 'pending' || state === 'linked') return 'interrupted';
    return 'pending';
  } catch {
    return 'blocked';
  }
}

function validateInspection(root, inspection) {
  const failures = validateJsonSchema(
    inspection,
    readJson(resolveRepoPath(root, INSPECTION_SCHEMA))
  );
  if (failures.length) {
    fail(
      'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_INSPECTION_INVALID',
      'Historical evidence inspection does not satisfy its closed schema.',
      new Error(failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; '))
    );
  }
  if (containsCredentialMaterial(inspection)
    || JSON.stringify(inspection).includes('.soter/state')
    || JSON.stringify(inspection).includes('development-request.')) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_INSPECTION_PRIVATE_MATERIAL', 'Historical evidence inspection exposes private material.');
  }
  return inspection;
}

function projectInspection(root, request, checkpoint) {
  const outputs = request.candidate.outputs.map((output, index) => ({
    sequence: output.sequence,
    path: output.path,
    documentFingerprint: output.documentFingerprint,
    contentFingerprint: output.contentFingerprint,
    state: outputProjectionState(root, request, checkpoint, output, index)
  }));
  const completed = outputs.filter((output) => output.state === 'exact').length;
  const state = checkpoint?.state || (outputs.some((output) => output.state === 'blocked')
    ? 'needs-attention'
    : 'request-ready');
  const failure = checkpoint?.failure || (state === 'needs-attention' ? {
    reasonCode: 'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_UNOWNED_OUTPUT',
    summary: NEEDS_ATTENTION_SUMMARY
  } : null);
  const current = outputs.find((output) => !['exact', 'rolled-back'].includes(output.state));
  return validateInspection(root, {
    $contract: INSPECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: request.id,
    requestFingerprint: request.requestFingerprint,
    createdAt: request.createdAt,
    validUntil: request.validUntil,
    state,
    basis: {
      publicTreeFingerprint: request.candidate.basis.publicTreeFingerprint,
      developmentTreeFingerprint: request.candidate.basis.developmentTreeFingerprint,
      hostGraphFingerprints: structuredClone(request.candidate.basis.hostGraphFingerprints),
      workflowCount: 7,
      hostCount: 2,
      chainCount: 14
    },
    progress: {
      completed,
      total: 14,
      currentPath: current?.path || null,
      pending: 14 - completed
    },
    outputs,
    failure,
    authority: {
      kind: 'historical-evidence-publication-only',
      grantsExecution: false,
      grantsApproval: false,
      grantsActivation: false,
      grantsFixtureMutation: false,
      grantsFinalLockMutation: false,
      grantsProviderRead: false,
      grantsProviderWrite: false,
      grantsHostCall: false
    },
    privacy: {
      privateRequestPathsIncluded: false,
      privateRequestIdsIncluded: false,
      privateStateIncluded: false,
      absolutePathsIncluded: false,
      rawDiffsIncluded: false,
      credentialsIncluded: false,
      providerResponsesIncluded: false
    },
    claimBoundary: CLAIM_BOUNDARY,
    health: {
      valid: state === 'completed' && completed === 14 ? 'passed' : 'unknown',
      ready: 'unknown',
      verified: 'unknown',
      healthy: 'unknown'
    }
  });
}

function startOrRecover({ root, requestPath, at, recoverOnly }) {
  const loaded = readRequestAndCandidate({ root, requestPath });
  let { consumption, checkpoint } = loaded;
  if (!consumption) {
    if (recoverOnly) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_CONSUMPTION_INVALID', 'Historical evidence recovery requires exact prior request consumption.');
    }
    const freshBasis = publicTreeBasis(
      loaded.root,
      loaded.request.candidate.outputs.map((output) => output.path)
    );
    if (freshBasis.fingerprint !== loaded.request.candidate.basis.publicTreeFingerprint) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_BASIS_DRIFT', 'Public candidate tree changed after exact batch validation.');
    }
    initialOutputPreflight(loaded.root, loaded.request);
    consumption = createConsumption(loaded.root, loaded.request, at);
  }
  if (!checkpoint) {
    if (loaded.request.candidate.outputs.some((output) => {
      const parent = confinedPath(loaded.root, path.posix.dirname(output.path));
      if (!fs.existsSync(parent)) return false;
      return inspectOutput(outputRuntime(loaded.root, output)).state !== 'missing';
    })) {
      fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_UNOWNED_OUTPUT', 'Consumed request without a checkpoint cannot adopt public output.');
    }
    checkpoint = initialCheckpoint(loaded.root, loaded.request, consumption);
  }
  checkpoint = runPublication({
    root: loaded.root,
    request: loaded.request,
    consumption,
    checkpoint,
    at
  });
  return projectInspection(loaded.root, loaded.request, checkpoint);
}

export function executeDevelopmentHistoricalEvidenceBatch({
  root,
  requestPath,
  at,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_ARGUMENTS_INVALID', 'Historical evidence execution received an unknown argument.');
  }
  return startOrRecover({ root, requestPath, at, recoverOnly: false });
}

export function recoverDevelopmentHistoricalEvidenceBatch({
  root,
  requestPath,
  at,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_ARGUMENTS_INVALID', 'Historical evidence recovery received an unknown argument.');
  }
  return startOrRecover({ root, requestPath, at, recoverOnly: true });
}

export function inspectDevelopmentHistoricalEvidenceBatch({
  root,
  requestPath,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length) {
    fail('DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_ARGUMENTS_INVALID', 'Historical evidence inspection received an unknown argument.');
  }
  const loaded = readRequestAndCandidate({ root, requestPath });
  return projectInspection(loaded.root, loaded.request, loaded.checkpoint);
}

export const developmentHistoricalEvidenceBatchContract = Object.freeze({
  request: REQUEST_CONTRACT,
  consumption: CONSUMPTION_CONTRACT,
  checkpoint: CHECKPOINT_CONTRACT,
  inspection: INSPECTION_CONTRACT,
  requestMaxTtlMs: REQUEST_MAX_TTL_MS,
  workflows: WORKFLOW_IDS,
  hosts: HOSTS,
  outputCount: 14,
  outputDirectory: OUTPUT_DIRECTORY
});

function expectCode(run, code) {
  try {
    run();
  } catch (error) {
    if (error?.code === code) return;
    throw error;
  }
  throw new Error('Expected stable failure code ' + code + '.');
}

function selftestRequest(root, id, {
  hostGraphFingerprints = Object.fromEntries(HOSTS.map((host) => [
    host,
    fingerprintJson({ selftest: 'graph.' + host })
  ]))
} = {}) {
  const hash = (label) => fingerprintJson({ selftest: label });
  const outputs = [];
  const chains = [];
  let sequence = 1;
  for (const workflowId of WORKFLOW_IDS) {
    for (const host of HOSTS) {
      const slug = workflowId.slice('automation.'.length);
      const generation = ['r5', 'r11', 'r12'][(sequence - 1) % 3];
      const requestId = `development-request.${host}.${slug}-v2-baseline-${generation}`;
      const document = {
        $contract: 'soter://contracts/development-agent-migration-evidence/v1',
        contractVersion: '1.0.0',
        id: `development-agent-migration-evidence.${host}.${slug}`,
        workflow: { id: workflowId, version: '1.0.0' },
        host: { id: host },
        privacy: {
          scope: 'shareable-sanitized',
          absolutePathsIncluded: false,
          targetPathsIncluded: false,
          requestedOutcomeIncluded: false,
          rawDiffsIncluded: false,
          rawContentIncluded: false,
          rawTranscriptsIncluded: false,
          providerResponsesIncluded: false,
          credentialsIncluded: false
        },
        authority: { kind: 'migration-evidence-only', grantsExecution: false }
      };
      outputs.push({
        sequence,
        path: expectedOutputPath(workflowId, host),
        mode: '0644',
        documentFingerprint: fingerprintJson(document),
        contentFingerprint: sha256(canonicalBytes(document)),
        document
      });
      chains.push({
        requestId,
        requestFingerprint: hash(requestId + '.request'),
        resultFingerprint: hash(requestId + '.result'),
        observationFingerprint: hash(requestId + '.observation'),
        finalizationFingerprint: hash(requestId + '.finalization'),
        finalizedAt: '2026-07-22T11:59:00.000Z',
        workflow: { id: workflowId, version: '1.0.0' },
        host,
        configuration: {
          name: `configuration.${host}`,
          lockPath: `.soter/state/development-candidate-locks/${host}.${slug}.json`,
          lockFingerprint: hash(host + '.' + slug + '.lock'),
          graphFingerprint: hostGraphFingerprints[host]
        },
        workspace: {
          rootIdentityFingerprint: fingerprintJson({ root }),
          revisionFingerprint: hash('revision'),
          treeFingerprint: hash('development-tree'),
          exactInputState: 'clean',
          postTreeFingerprint: hash('development-tree'),
          postExactInputState: 'clean',
          policyFingerprint: hash('policy'),
          settingsFingerprint: hash('settings')
        }
      });
      sequence += 1;
    }
  }
  outputs.sort((left, right) => compareCodepoint(left.path, right.path))
    .forEach((output, index) => { output.sequence = index + 1; });
  const publicBasis = publicTreeBasis(root, outputs.map((output) => output.path));
  const candidate = {
    basis: {
      publicTreeFingerprint: publicBasis.fingerprint,
      developmentTreeFingerprint: hash('development-tree'),
      revisionFingerprint: hash('revision'),
      hostGraphFingerprints: structuredClone(hostGraphFingerprints),
      policyFingerprint: hash('policy'),
      settingsFingerprint: hash('settings')
    },
    directories: [
      directoryState(root, 'soter/evidence'),
      directoryState(root, OUTPUT_DIRECTORY)
    ],
    chains,
    outputs,
    candidateFingerprint: 'sha256:' + '0'.repeat(64)
  };
  candidate.candidateFingerprint = candidateFingerprint(candidate);
  const request = {
    $contract: REQUEST_CONTRACT,
    contractVersion: '1.0.0',
    id,
    requestFingerprint: 'sha256:' + '0'.repeat(64),
    createdAt: '2026-07-22T12:00:00.000Z',
    validUntil: '2026-07-22T12:10:00.000Z',
    rootIdentityFingerprint: rootIdentity(root).fingerprint,
    candidate,
    authority: {
      kind: 'historical-evidence-publication-only',
      grantsExecution: false,
      grantsApproval: false,
      grantsActivation: false,
      grantsFixtureMutation: false,
      grantsFinalLockMutation: false,
      grantsProviderRead: false,
      grantsProviderWrite: false,
      grantsHostCall: false
    }
  };
  request.requestFingerprint = requestFingerprint(request);
  return validateRequest(root, request);
}

function selftestRoot(temp, name) {
  const root = path.join(temp, name);
  fs.mkdirSync(path.join(root, 'soter', 'contracts'), { recursive: true, mode: 0o755 });
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  fs.copyFileSync(
    resolveRepoPath(sourceRoot, INSPECTION_SCHEMA),
    resolveRepoPath(root, INSPECTION_SCHEMA)
  );
  if (process.platform !== 'win32') {
    fs.chmodSync(root, 0o755);
    fs.chmodSync(path.join(root, 'soter'), 0o755);
    fs.chmodSync(path.join(root, 'soter', 'contracts'), 0o755);
    fs.chmodSync(resolveRepoPath(root, INSPECTION_SCHEMA), 0o644);
  }
  return fs.realpathSync(root);
}

function resolvedSelftestHostGraphFingerprints() {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const configurations = {
    claude: 'soter/configurations/harness-development-catalog-claude.config.json',
    codex: 'soter/configurations/harness-development-catalog.config.json'
  };
  const entries = HOSTS.map((host) => {
    const fingerprints = WORKFLOW_IDS.map((workflowId) => {
      return resolveDevelopmentCandidateLock({
        root: sourceRoot,
        configPath: configurations[host],
        workflowId,
        host
      }).graphFingerprint;
    });
    if (new Set(fingerprints).size !== 1 || !HASH.test(fingerprints[0] || '')) {
      throw new Error('Real development candidate locks do not expose one exact graph per host.');
    }
    return [host, fingerprints[0]];
  });
  const basis = Object.fromEntries(entries);
  if (new Set(Object.values(basis)).size !== HOSTS.length) {
    throw new Error('Real Codex and Claude candidate graphs unexpectedly collapse to one host-neutral lock.');
  }
  return basis;
}

export function selftestDevelopmentHistoricalEvidenceBatchPublication() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-historical-evidence-batch-'));
  try {
    const root = selftestRoot(temp, 'success');
    const hostGraphFingerprints = resolvedSelftestHostGraphFingerprints();
    const request = selftestRequest(
      root,
      'development-historical-evidence-batch.success',
      { hostGraphFingerprints }
    );
    const requestGenerations = new Set(request.candidate.chains.map((chain) => {
      return chain.requestId.match(/-(r5|r11|r12)$/)?.[1] || null;
    }));
    if (!same([...requestGenerations].sort(compareCodepoint), ['r11', 'r12', 'r5'])) {
      throw new Error('Historical evidence batch did not preserve mixed private request generations.');
    }
    if (request.candidate.outputs.some((output) => {
      return /-r(?:5|11|12)(?:[.]json)?$/.test(output.document.id)
        || /-r(?:5|11|12)[.]json$/.test(output.path);
    })) {
      throw new Error('Private request generations leaked into stable governed evidence identity.');
    }
    if (!same(request.candidate.basis.hostGraphFingerprints, hostGraphFingerprints)) {
      throw new Error('Historical evidence request did not bind the exact real Codex and Claude candidate graphs.');
    }
    for (const mutation of ['swapped', 'missing', 'duplicated']) {
      const invalid = structuredClone(request);
      if (mutation === 'swapped') {
        invalid.candidate.basis.hostGraphFingerprints = {
          claude: hostGraphFingerprints.codex,
          codex: hostGraphFingerprints.claude
        };
      } else if (mutation === 'missing') {
        delete invalid.candidate.basis.hostGraphFingerprints.claude;
      } else {
        invalid.candidate.basis.hostGraphFingerprints.claude = hostGraphFingerprints.codex;
      }
      invalid.candidate.candidateFingerprint = candidateFingerprint(invalid.candidate);
      invalid.requestFingerprint = requestFingerprint(invalid);
      expectCode(
        () => validateRequest(root, invalid),
        'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_INVALID'
      );
    }
    const externalDirectory = path.join(temp, 'private-request');
    fs.mkdirSync(externalDirectory, { mode: 0o700 });
    const externalRequest = path.join(externalDirectory, 'request.json');
    fs.writeFileSync(externalRequest, canonicalBytes(request), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(externalRequest, 0o600);
    const exactExternalRequest = fs.realpathSync(externalRequest);
    if (readPrivateRequest(root, exactExternalRequest).requestFingerprint !== request.requestFingerprint) {
      throw new Error('Exact external historical evidence request could not be read.');
    }
    expectCode(
      () => readPrivateRequest(
        root,
        path.dirname(exactExternalRequest) + '/../private-request/request.json'
      ),
      'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_PATH_INVALID'
    );
    const alias = path.join(fs.realpathSync(temp), 'private-request-alias');
    fs.symlinkSync(fs.realpathSync(externalDirectory), alias, 'dir');
    expectCode(
      () => readPrivateRequest(root, path.join(alias, 'request.json')),
      'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_PATH_INVALID'
    );
    initialOutputPreflight(root, request);
    const consumption = createConsumption(root, request, '2026-07-22T12:01:00.000Z');
    let checkpoint = initialCheckpoint(root, request, consumption);
    checkpoint = runPublication({
      root,
      request,
      consumption,
      checkpoint,
      at: '2026-07-22T12:02:00.000Z'
    });
    if (checkpoint.state !== 'completed'
      || request.candidate.outputs.some((output) => inspectOutput(outputRuntime(root, output)).state !== 'exact')) {
      throw new Error('Historical evidence batch did not publish all fourteen exact outputs.');
    }
    const inspection = projectInspection(root, request, checkpoint);
    if (inspection.state !== 'completed' || inspection.progress.completed !== 14
      || inspection.health.valid !== 'passed'
      || JSON.stringify(inspection).includes('development-request.')) {
      throw new Error('Historical evidence batch inspection is incomplete or exposes private request identities.');
    }
    const repeated = runPublication({
      root,
      request,
      consumption,
      checkpoint,
      at: '2026-07-22T12:03:00.000Z'
    });
    if (repeated.checkpointFingerprint !== checkpoint.checkpointFingerprint) {
      throw new Error('Completed historical evidence batch re-entry was not idempotent.');
    }
    fs.writeFileSync(
      resolveRepoPath(root, 'soter/post-activation-marker.json'),
      '{"lifecycle":"active"}\n',
      { mode: 0o644 }
    );
    const historicalInspection = inspectDevelopmentHistoricalEvidenceBatch({
      root,
      requestPath: exactExternalRequest
    });
    if (historicalInspection.state !== 'completed' || historicalInspection.progress.completed !== 14) {
      throw new Error('Completed historical evidence became uninspectable after lifecycle-style public drift.');
    }

    const rollbackRoot = selftestRoot(temp, 'rollback');
    const rollbackRequest = selftestRequest(
      rollbackRoot,
      'development-historical-evidence-batch.rollback'
    );
    const rollbackConsumption = createConsumption(
      rollbackRoot,
      rollbackRequest,
      '2026-07-22T12:01:00.000Z'
    );
    const rollbackCheckpoint = initialCheckpoint(
      rollbackRoot,
      rollbackRequest,
      rollbackConsumption
    );
    expectCode(() => runPublication({
      root: rollbackRoot,
      request: rollbackRequest,
      consumption: rollbackConsumption,
      checkpoint: rollbackCheckpoint,
      at: '2026-07-22T12:02:00.000Z',
      selftestFault: { kind: 'failure-after-output', index: 2 }
    }), 'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_SELFTEST_FAILURE');
    const rolledBack = readCheckpoint(rollbackRoot, rollbackRequest, rollbackConsumption);
    if (rolledBack.state !== 'rolled-back'
      || rollbackRequest.candidate.outputs.some((output) => {
        const parent = confinedPath(rollbackRoot, path.posix.dirname(output.path));
        return fs.existsSync(parent) && inspectOutput(outputRuntime(rollbackRoot, output)).state !== 'missing';
      })
      || fs.existsSync(resolveRepoPath(rollbackRoot, OUTPUT_DIRECTORY))) {
      throw new Error('Historical evidence batch exact rollback left public output behind.');
    }

    const driftRoot = selftestRoot(temp, 'effect-drift');
    const driftRequest = selftestRequest(
      driftRoot,
      'development-historical-evidence-batch.effect-drift'
    );
    const driftConsumption = createConsumption(
      driftRoot,
      driftRequest,
      '2026-07-22T12:01:00.000Z'
    );
    const driftCheckpoint = initialCheckpoint(driftRoot, driftRequest, driftConsumption);
    fs.writeFileSync(resolveRepoPath(driftRoot, 'soter/unrelated-drift.json'), '{}\n', { mode: 0o644 });
    expectCode(() => runPublication({
      root: driftRoot,
      request: driftRequest,
      consumption: driftConsumption,
      checkpoint: driftCheckpoint,
      at: '2026-07-22T12:02:00.000Z'
    }), 'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_BASIS_DRIFT');
    if (readCheckpoint(driftRoot, driftRequest, driftConsumption).state !== 'rolled-back'
      || !fs.existsSync(resolveRepoPath(driftRoot, 'soter/unrelated-drift.json'))) {
      throw new Error('Per-effect basis drift did not stop and roll back only checkpoint-owned state.');
    }

    for (const directoryFault of [
      'crash-after-directory-begun-before-create',
      'crash-after-directory-create-before-created'
    ]) {
      const directoryCrashRoot = selftestRoot(temp, directoryFault);
      const directoryCrashRequest = selftestRequest(
        directoryCrashRoot,
        'development-historical-evidence-batch.' + directoryFault
      );
      const directoryCrashConsumption = createConsumption(
        directoryCrashRoot,
        directoryCrashRequest,
        '2026-07-22T12:01:00.000Z'
      );
      let directoryCrashCheckpoint = initialCheckpoint(
        directoryCrashRoot,
        directoryCrashRequest,
        directoryCrashConsumption
      );
      expectCode(() => runPublication({
        root: directoryCrashRoot,
        request: directoryCrashRequest,
        consumption: directoryCrashConsumption,
        checkpoint: directoryCrashCheckpoint,
        at: '2026-07-22T12:02:00.000Z',
        selftestFault: { kind: directoryFault, index: 0 }
      }), undefined);
      directoryCrashCheckpoint = readCheckpoint(
        directoryCrashRoot,
        directoryCrashRequest,
        directoryCrashConsumption
      );
      const directoryExists = fs.existsSync(
        resolveRepoPath(directoryCrashRoot, 'soter/evidence')
      );
      if (directoryCrashCheckpoint.directories[0].state !== 'creating'
        || directoryExists !== directoryFault.includes('create-before-created')) {
        throw new Error('Historical evidence directory crash did not preserve its durable creating boundary.');
      }
      directoryCrashCheckpoint = runPublication({
        root: directoryCrashRoot,
        request: directoryCrashRequest,
        consumption: directoryCrashConsumption,
        checkpoint: directoryCrashCheckpoint,
        at: '2026-07-22T12:03:00.000Z'
      });
      if (directoryCrashCheckpoint.state !== 'completed') {
        throw new Error('Historical evidence batch did not recover an exact checkpoint-owned directory create.');
      }
    }

    const directoryRoot = selftestRoot(temp, 'directory-adoption');
    const directoryRequest = selftestRequest(
      directoryRoot,
      'development-historical-evidence-batch.directory-adoption'
    );
    const directoryConsumption = createConsumption(
      directoryRoot,
      directoryRequest,
      '2026-07-22T12:01:00.000Z'
    );
    const directoryCheckpoint = initialCheckpoint(
      directoryRoot,
      directoryRequest,
      directoryConsumption
    );
    fs.mkdirSync(resolveRepoPath(directoryRoot, 'soter/evidence'), { mode: 0o755 });
    if (process.platform !== 'win32') {
      fs.chmodSync(resolveRepoPath(directoryRoot, 'soter/evidence'), 0o755);
    }
    expectCode(() => runPublication({
      root: directoryRoot,
      request: directoryRequest,
      consumption: directoryConsumption,
      checkpoint: directoryCheckpoint,
      at: '2026-07-22T12:02:00.000Z'
    }), 'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_DIRECTORY_DRIFT');
    if (readCheckpoint(directoryRoot, directoryRequest, directoryConsumption).state !== 'needs-attention'
      || !fs.existsSync(resolveRepoPath(directoryRoot, 'soter/evidence'))) {
      throw new Error('Planned evidence directory was adopted or removed without checkpoint ownership.');
    }

    const noCheckpointRoot = selftestRoot(temp, 'consumed-no-checkpoint');
    const noCheckpointRequest = selftestRequest(
      noCheckpointRoot,
      'development-historical-evidence-batch.consumed-no-checkpoint'
    );
    createConsumption(
      noCheckpointRoot,
      noCheckpointRequest,
      '2026-07-22T12:01:00.000Z'
    );
    fs.mkdirSync(resolveRepoPath(noCheckpointRoot, 'soter/evidence'), { mode: 0o755 });
    if (process.platform !== 'win32') {
      fs.chmodSync(resolveRepoPath(noCheckpointRoot, 'soter/evidence'), 0o755);
    }
    expectCode(
      () => validateRecoveryDirectories(noCheckpointRoot, noCheckpointRequest, null),
      'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_DIRECTORY_DRIFT'
    );
    if (fs.existsSync(stateFiles(noCheckpointRoot, noCheckpointRequest.id).checkpoint)) {
      throw new Error('Consumed request adopted an external directory while reconstructing its checkpoint.');
    }

    const crashRoot = selftestRoot(temp, 'crash');
    const crashRequest = selftestRequest(crashRoot, 'development-historical-evidence-batch.crash');
    const crashConsumption = createConsumption(
      crashRoot,
      crashRequest,
      '2026-07-22T12:01:00.000Z'
    );
    let crashCheckpoint = initialCheckpoint(crashRoot, crashRequest, crashConsumption);
    crashCheckpoint = createPlannedDirectories(
      crashRoot,
      crashRequest,
      crashConsumption,
      crashCheckpoint,
      '2026-07-22T12:02:00.000Z'
    );
    expectCode(() => runPublication({
      root: crashRoot,
      request: crashRequest,
      consumption: crashConsumption,
      checkpoint: crashCheckpoint,
      at: '2026-07-22T12:03:00.000Z',
      selftestFault: { kind: 'crash-after-output', index: 0 }
    }), undefined);
    crashCheckpoint = readCheckpoint(crashRoot, crashRequest, crashConsumption);
    if (crashCheckpoint.outputs[0].state !== 'begun'
      || inspectOutput(outputRuntime(crashRoot, crashRequest.candidate.outputs[0])).state !== 'exact') {
      throw new Error('Synthetic crash did not preserve exact checkpoint/output disagreement for recovery.');
    }
    crashCheckpoint = runPublication({
      root: crashRoot,
      request: crashRequest,
      consumption: crashConsumption,
      checkpoint: crashCheckpoint,
      at: '2026-07-22T12:04:00.000Z'
    });
    if (crashCheckpoint.state !== 'completed') {
      throw new Error('Historical evidence batch did not recover a crash after exact output publication.');
    }

    const begunRoot = selftestRoot(temp, 'begun-before-output');
    const begunRequest = selftestRequest(
      begunRoot,
      'development-historical-evidence-batch.begun-before-output'
    );
    const begunConsumption = createConsumption(
      begunRoot,
      begunRequest,
      '2026-07-22T12:01:00.000Z'
    );
    let begunCheckpoint = initialCheckpoint(begunRoot, begunRequest, begunConsumption);
    expectCode(() => runPublication({
      root: begunRoot,
      request: begunRequest,
      consumption: begunConsumption,
      checkpoint: begunCheckpoint,
      at: '2026-07-22T12:02:00.000Z',
      selftestFault: { kind: 'crash-after-begun-before-output', index: 0 }
    }), undefined);
    begunCheckpoint = readCheckpoint(begunRoot, begunRequest, begunConsumption);
    if (begunCheckpoint.outputs[0].state !== 'begun'
      || inspectOutput(outputRuntime(begunRoot, begunRequest.candidate.outputs[0])).state
        !== 'missing') {
      throw new Error('Historical evidence batch did not seal begun ownership before output mutation.');
    }
    begunCheckpoint = runPublication({
      root: begunRoot,
      request: begunRequest,
      consumption: begunConsumption,
      checkpoint: begunCheckpoint,
      at: '2026-07-22T12:03:00.000Z'
    });
    if (begunCheckpoint.state !== 'completed') {
      throw new Error('Historical evidence batch did not recover a begun output before its effect.');
    }

    for (const plantedState of ['exact', 'pending', 'linked']) {
      const unownedRoot = selftestRoot(temp, 'unowned-' + plantedState);
      const unownedRequest = selftestRequest(
        unownedRoot,
        'development-historical-evidence-batch.unowned-' + plantedState
      );
      const unownedConsumption = createConsumption(
        unownedRoot,
        unownedRequest,
        '2026-07-22T12:01:00.000Z'
      );
      let unownedCheckpoint = initialCheckpoint(
        unownedRoot,
        unownedRequest,
        unownedConsumption
      );
      unownedCheckpoint = createPlannedDirectories(
        unownedRoot,
        unownedRequest,
        unownedConsumption,
        unownedCheckpoint,
        '2026-07-22T12:01:30.000Z'
      );
      const unownedRuntime = outputRuntime(unownedRoot, unownedRequest.candidate.outputs[0]);
      if (plantedState === 'exact') {
        fs.writeFileSync(unownedRuntime.file, unownedRuntime.bytes, { mode: 0o644 });
        if (process.platform !== 'win32') fs.chmodSync(unownedRuntime.file, 0o644);
      } else {
        fs.writeFileSync(unownedRuntime.pending, unownedRuntime.bytes, { mode: 0o644 });
        if (process.platform !== 'win32') fs.chmodSync(unownedRuntime.pending, 0o644);
        if (plantedState === 'linked') fs.linkSync(unownedRuntime.pending, unownedRuntime.file);
      }
      expectCode(() => runPublication({
        root: unownedRoot,
        request: unownedRequest,
        consumption: unownedConsumption,
        checkpoint: unownedCheckpoint,
        at: '2026-07-22T12:02:00.000Z'
      }), 'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_UNOWNED_OUTPUT');
      const unownedAfter = readCheckpoint(unownedRoot, unownedRequest, unownedConsumption);
      if (unownedAfter.state !== 'needs-attention'
        || inspectOutput(unownedRuntime).state !== plantedState) {
        throw new Error('Historical evidence batch adopted or mutated an unbegun ' + plantedState + ' output.');
      }
    }

    for (const ownedState of ['pending', 'linked']) {
      const ownedRoot = selftestRoot(temp, 'owned-' + ownedState);
      const ownedRequest = selftestRequest(
        ownedRoot,
        'development-historical-evidence-batch.owned-' + ownedState
      );
      const ownedConsumption = createConsumption(
        ownedRoot,
        ownedRequest,
        '2026-07-22T12:01:00.000Z'
      );
      let ownedCheckpoint = initialCheckpoint(ownedRoot, ownedRequest, ownedConsumption);
      expectCode(() => runPublication({
        root: ownedRoot,
        request: ownedRequest,
        consumption: ownedConsumption,
        checkpoint: ownedCheckpoint,
        at: '2026-07-22T12:02:00.000Z',
        selftestFault: { kind: 'crash-after-begun-before-output', index: 0 }
      }), undefined);
      ownedCheckpoint = readCheckpoint(ownedRoot, ownedRequest, ownedConsumption);
      const ownedRuntime = outputRuntime(ownedRoot, ownedRequest.candidate.outputs[0]);
      fs.writeFileSync(ownedRuntime.pending, ownedRuntime.bytes, { mode: 0o644 });
      if (process.platform !== 'win32') fs.chmodSync(ownedRuntime.pending, 0o644);
      if (ownedState === 'linked') fs.linkSync(ownedRuntime.pending, ownedRuntime.file);
      ownedCheckpoint = runPublication({
        root: ownedRoot,
        request: ownedRequest,
        consumption: ownedConsumption,
        checkpoint: ownedCheckpoint,
        at: '2026-07-22T12:03:00.000Z'
      });
      if (ownedCheckpoint.state !== 'completed') {
        throw new Error('Historical evidence batch did not recover an exact begun ' + ownedState + ' output.');
      }
    }

    const privateDriftRoot = selftestRoot(temp, 'private-state-drift');
    const privateDriftRequest = selftestRequest(
      privateDriftRoot,
      'development-historical-evidence-batch.private-state-drift'
    );
    const privateDriftConsumption = createConsumption(
      privateDriftRoot,
      privateDriftRequest,
      '2026-07-22T12:01:00.000Z'
    );
    initialCheckpoint(privateDriftRoot, privateDriftRequest, privateDriftConsumption);
    const privateStatePath = resolveRepoPath(privateDriftRoot, '.soter/state');
    fs.chmodSync(privateStatePath, 0o755);
    expectCode(
      () => readCheckpoint(privateDriftRoot, privateDriftRequest, privateDriftConsumption),
      'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PRIVATE_STATE_INVALID'
    );
    fs.chmodSync(privateStatePath, 0o700);
    const privateStateOwned = resolveRepoPath(privateDriftRoot, '.soter/state-owned');
    fs.renameSync(privateStatePath, privateStateOwned);
    fs.symlinkSync(privateStateOwned, privateStatePath, 'dir');
    expectCode(
      () => readCheckpoint(privateDriftRoot, privateDriftRequest, privateDriftConsumption),
      'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_PRIVATE_STATE_INVALID'
    );

    const adoptionRoot = selftestRoot(temp, 'adoption');
    const adoptionRequest = selftestRequest(
      adoptionRoot,
      'development-historical-evidence-batch.adoption'
    );
    fs.mkdirSync(resolveRepoPath(adoptionRoot, OUTPUT_DIRECTORY), { recursive: true, mode: 0o755 });
    if (process.platform !== 'win32') {
      fs.chmodSync(resolveRepoPath(adoptionRoot, 'soter/evidence'), 0o755);
      fs.chmodSync(resolveRepoPath(adoptionRoot, OUTPUT_DIRECTORY), 0o755);
    }
    const planted = adoptionRequest.candidate.outputs[0];
    fs.writeFileSync(resolveRepoPath(adoptionRoot, planted.path), canonicalBytes(planted.document), { mode: 0o644 });
    expectCode(
      () => initialOutputPreflight(adoptionRoot, adoptionRequest),
      'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_UNOWNED_OUTPUT'
    );
    if (fs.existsSync(stateFiles(adoptionRoot, adoptionRequest.id).consumption) === true) {
      throw new Error('Unowned output preflight created private authority.');
    }

    const expiredRoot = selftestRoot(temp, 'expired');
    const expiredRequest = selftestRequest(
      expiredRoot,
      'development-historical-evidence-batch.expired'
    );
    expectCode(
      () => createConsumption(expiredRoot, expiredRequest, expiredRequest.validUntil),
      'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_EXPIRED'
    );

    const replacementPath = path.join(temp, 'root-replacement');
    const replacementRoot = selftestRoot(temp, 'root-replacement');
    const replacementRequest = selftestRequest(
      replacementRoot,
      'development-historical-evidence-batch.root-replacement'
    );
    fs.renameSync(replacementPath, replacementPath + '.original');
    const newReplacementRoot = selftestRoot(temp, 'root-replacement');
    expectCode(
      () => validateRequest(newReplacementRoot, replacementRequest),
      'DEVELOPMENT_HISTORICAL_EVIDENCE_BATCH_REQUEST_INVALID'
    );

    const hostileInspection = structuredClone(inspection);
    hostileInspection.outputs[0].rawBody = 'private selftest body';
    const failures = validateJsonSchema(
      hostileInspection,
      readJson(resolveRepoPath(root, INSPECTION_SCHEMA))
    );
    if (failures.length === 0) {
      throw new Error('Historical evidence inspection schema accepted hostile private output material.');
    }

    return {
      state: 'passed',
      outputs: 14,
      recovery: 'passed',
      rollback: 'passed',
      privacy: 'passed'
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
