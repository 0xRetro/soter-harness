import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifySoter } from '../kernel/verify.mjs';
import {
  fingerprintWorkflowEvaluatedSubject,
  fingerprintWorkflowGuideContent
} from '../kernel/workflow-guides.mjs';
import {
  buildDevelopmentHostFinalEvidenceForBatch
} from './development-host-observations.mjs';
import {
  developmentHostExecutionStateFiles
} from './development-host-runner.mjs';
import {
  assertLegacyFinalizationCandidateBasis,
  readLegacyFinalizationFixtureRequest
} from './legacy-finalization.mjs';
import {
  fingerprintJson,
  readJson,
  resolveRepoPath,
  sha256
} from './lib/canonical-json.mjs';
import {
  fingerprintLock,
  lockMatchesResolution,
  resolveDevelopmentEvidenceFinalizationConfiguration
} from './resolve.mjs';

const CONTRACT = 'soter://private/development-host-evidence-finalization-batch/v1';
const CONFIGURATIONS = Object.freeze([{
  host: 'codex',
  configPath: 'soter/configurations/harness-development-catalog.config.json',
  lockPath: 'soter/fixtures/harness-development-catalog-final/codex.lock.json'
}, {
  host: 'claude',
  configPath: 'soter/configurations/harness-development-catalog-claude.config.json',
  lockPath: 'soter/fixtures/harness-development-catalog-final/claude.lock.json'
}]);
const WORKFLOW_ID = /^automation[.][a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const REQUEST_ID = /^development-request[.][a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const BATCH_ID = /^development-host-evidence-finalization-batch[.][a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const CHECKER_RECEIPT_ID = /^legacy-checker-run[.][a-f0-9]{64}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/;
const REQUEST_MAX_TTL_MS = 15 * 60 * 1000;
const CONSUMPTION_CONTRACT = 'soter://private/development-host-evidence-finalization-consumption/v1';
const CHECKPOINT_CONTRACT = 'soter://private/development-host-evidence-finalization-checkpoint/v1';
const EVIDENCE_PATH = /^soter\/evidence\/development\/evidence[.]development-activation[.](codex|claude)[.]([a-z0-9]+(?:[.-][a-z0-9]+)*)[.]json$/;
const SELFTEST_CRASH = 'DEVELOPMENT_EVIDENCE_FINALIZATION_SELFTEST_CRASH';

function fail(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  throw error;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function same(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n');
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && same(Object.keys(value).sort(compareText), [...keys].sort(compareText));
}

function assertInstant(value, label = 'Development evidence finalization instant') {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!INSTANT.test(value || '')
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_INVALID',
      label + ' must be one canonical UTC instant with millisecond precision.'
    );
  }
  return parsed;
}

function rootIdentity(root) {
  const realPath = fs.realpathSync(path.resolve(root));
  const stat = fs.statSync(realPath);
  if (!stat.isDirectory()) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_BASIS_INVALID',
      'Development evidence finalization root must be one exact directory.'
    );
  }
  return {
    realPath,
    device: Number(stat.dev),
    inode: Number(stat.ino)
  };
}

function rootIdentityFingerprint(root) {
  return fingerprintJson(rootIdentity(root));
}

function rootIdentityMatches(root, expectedFingerprint, remount = null) {
  const current = rootIdentity(root);
  if (fingerprintJson(current) === expectedFingerprint) return true;
  return Boolean(remount
    && current.realPath === remount.realPath
    && current.inode === remount.rootInode
    && current.device === remount.currentDevice
    && remount.sealedDevice !== remount.currentDevice
    && fingerprintJson({
      realPath: current.realPath,
      device: remount.sealedDevice,
      inode: current.inode
    }) === expectedFingerprint);
}

function deviceMatches(observedDevice, sealedDevice, remount = null) {
  return remount
    ? sealedDevice === remount.sealedDevice
      && observedDevice === remount.currentDevice
    : observedDevice === sealedDevice;
}

function developmentChainRootIdentityFingerprint(root) {
  return fingerprintJson({ root: fs.realpathSync(path.resolve(root)) });
}

function developmentChainBindsRoot(root, request) {
  return request?.workspace?.rootIdentityFingerprint
    === developmentChainRootIdentityFingerprint(root);
}

function assertOperationAt(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!INSTANT.test(value || '')
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_AT_INVALID',
      'Development evidence finalization requires one caller-supplied canonical at instant.'
    );
  }
  return parsed;
}

function requestFingerprint(request) {
  const value = structuredClone(request);
  delete value.requestFingerprint;
  return fingerprintJson(value);
}

function readPrivateCanonicalRequest(root, requestedPath) {
  if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_PATH_INVALID',
      'Development evidence finalization request must be one absolute private path outside the repository.'
    );
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const resolvedRequest = path.resolve(requestedPath);
  let stat;
  let real;
  try {
    stat = fs.lstatSync(resolvedRequest);
    real = fs.realpathSync(resolvedRequest);
  } catch (error) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_PATH_INVALID',
      'Development evidence finalization request is unavailable.',
      error
    );
  }
  if (requestedPath !== resolvedRequest || real !== resolvedRequest
    || real === resolvedRoot || real.startsWith(resolvedRoot + path.sep)
    || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o600)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_PATH_INVALID',
      'Development evidence finalization request must be one non-linked external private file with mode 0600.'
    );
  }
  let descriptor = null;
  let bytes;
  try {
    descriptor = fs.openSync(
      resolvedRequest,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1
      || before.dev !== stat.dev || before.ino !== stat.ino
      || (process.platform !== 'win32' && (before.mode & 0o7777) !== 0o600)) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_PATH_INVALID',
        'Development evidence finalization request changed before its exact read.'
      );
    }
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const realAfter = fs.realpathSync(resolvedRequest);
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || after.nlink !== 1 || realAfter !== real) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_PATH_INVALID',
        'Development evidence finalization request changed while it was read.'
      );
    }
  } catch (error) {
    if (error?.code?.startsWith('DEVELOPMENT_EVIDENCE_')) throw error;
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_PATH_INVALID',
      'Development evidence finalization request could not be read exactly.',
      error
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  let request;
  try {
    request = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_INVALID',
      'Development evidence finalization request is not valid JSON.',
      error
    );
  }
  if (!bytes.equals(Buffer.from(JSON.stringify(request, null, 2) + '\n'))) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_INVALID',
      'Development evidence finalization request must contain exact canonical JSON bytes.'
    );
  }
  return request;
}

function activeWorkflowIds(root) {
  const directory = resolveRepoPath(root, 'soter/automations');
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name, 'definition.json'))
    .filter((file) => fs.existsSync(file) && fs.lstatSync(file).isFile())
    .map((file) => readJson(file))
    .filter((definition) => definition.$contract === 'soter://contracts/workflow-definition/v2'
      && definition.lifecycle?.state === 'active-host-guided'
      && definition.lifecycle?.activation?.state === 'active')
    .map((definition) => definition.id)
    .sort(compareText);
}

function readPrivateStateDocument(root, file, label) {
  try {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const privateRoot = resolveRepoPath(resolvedRoot, '.soter');
  const parent = path.dirname(file);
  const relativeParent = path.relative(privateRoot, parent);
  if (relativeParent === '..' || relativeParent.startsWith('..' + path.sep)
    || path.isAbsolute(relativeParent)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_PRIVATE_CHAIN_INVALID',
      label + ' escapes private Soter state.'
    );
  }
  let current = privateRoot;
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || fs.realpathSync(current) !== current
      || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o700)) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_PRIVATE_CHAIN_INVALID',
        label + ' has an unsafe private parent.'
      );
    }
    current = path.join(current, part);
  }
  const parentStat = fs.lstatSync(current);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || fs.realpathSync(current) !== current
    || (process.platform !== 'win32' && (parentStat.mode & 0o7777) !== 0o700)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_PRIVATE_CHAIN_INVALID',
      label + ' has an unsafe private parent.'
    );
  }
  let descriptor = null;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1
      || (process.platform !== 'win32' && (before.mode & 0o7777) !== 0o600)) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_PRIVATE_CHAIN_INVALID',
        label + ' must be one private non-linked 0600 file.'
      );
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || after.nlink !== 1) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_PRIVATE_CHAIN_INVALID',
        label + ' changed while it was read.'
      );
    }
    const value = JSON.parse(bytes.toString('utf8'));
    if (!bytes.equals(Buffer.from(JSON.stringify(value, null, 2) + '\n'))) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_PRIVATE_CHAIN_INVALID',
        label + ' does not contain exact canonical private bytes.'
      );
    }
    return value;
  } catch (error) {
    if (error?.code?.startsWith('DEVELOPMENT_EVIDENCE_')) throw error;
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_PRIVATE_CHAIN_INVALID',
      label + ' is unavailable or malformed.',
      error
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  } catch (error) {
    if (error?.code?.startsWith('DEVELOPMENT_EVIDENCE_')) throw error;
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_PRIVATE_CHAIN_INVALID',
      label + ' is unavailable, unsafe, or malformed.',
      error
    );
  }
}

function readGovernedCanonicalDocument(root, relativePath, expectedFingerprint, label) {
  let descriptor = null;
  try {
    const resolvedRoot = fs.realpathSync(path.resolve(root));
    const file = resolveRepoPath(resolvedRoot, relativePath);
    const real = fs.realpathSync(file);
    if (real !== file || !real.startsWith(resolvedRoot + path.sep)) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_PRIVATE_CHAIN_INVALID',
        label + ' is not one exact governed repository file.'
      );
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1
      || (process.platform !== 'win32' && (before.mode & 0o7777) !== 0o644)) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_PRIVATE_CHAIN_INVALID',
        label + ' must be one non-linked governed 0644 file.'
      );
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || after.nlink !== 1 || fs.realpathSync(file) !== real) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_PRIVATE_CHAIN_INVALID',
        label + ' changed while it was read.'
      );
    }
    const value = JSON.parse(bytes.toString('utf8'));
    if (!bytes.equals(Buffer.from(JSON.stringify(value, null, 2) + '\n'))
      || fingerprintJson(value) !== expectedFingerprint) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_PRIVATE_CHAIN_INVALID',
        label + ' is noncanonical or fingerprint-mismatched.'
      );
    }
    return value;
  } catch (error) {
    if (error?.code?.startsWith('DEVELOPMENT_EVIDENCE_')) throw error;
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_PRIVATE_CHAIN_INVALID',
      label + ' is unavailable, unsafe, or malformed.',
      error
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function workflowBasis(root, workflowId) {
  const slug = workflowId.slice('automation.'.length);
  const definition = readJson(resolveRepoPath(root, `soter/automations/${slug}/definition.json`));
  const guide = readJson(resolveRepoPath(root, `soter/automations/${slug}/guide.json`));
  const evaluations = readJson(resolveRepoPath(root, `soter/automations/${slug}/evaluations.json`));
  return {
    definitionFingerprint: fingerprintJson(definition),
    guideFingerprint: fingerprintJson(guide),
    guideContentFingerprint: fingerprintWorkflowGuideContent(guide),
    evaluationSetFingerprint: fingerprintJson(evaluations),
    evaluatedSubjectFingerprint: fingerprintWorkflowEvaluatedSubject({
      definition,
      guide,
      evaluations
    })
  };
}

function privateChainBinding(root, requestId, host, workflowId, finalEvidence) {
  const suffix = requestId.slice('development-request.'.length);
  const request = readPrivateStateDocument(
    root,
    resolveRepoPath(root, `.soter/state/development-requests/${requestId}.json`),
    'Private development request'
  );
  const result = readPrivateStateDocument(
    root,
    resolveRepoPath(root, `.soter/state/development-results/development-result.${suffix}.json`),
    'Private development result'
  );
  const observation = readPrivateStateDocument(
    root,
    resolveRepoPath(root, `.soter/state/development-host-observations/development-host-observation.${suffix}.json`),
    'Private development observation'
  );
  const finalization = readPrivateStateDocument(
    root,
    developmentHostExecutionStateFiles(root, requestId).finalization,
    'Private development finalization receipt'
  );
  const historical = (finalEvidence.artifacts || []).filter((artifact) => {
    return artifact.role === 'development-agent-migration-evidence';
  });
  if (historical.length !== 1
    || typeof historical[0].path !== 'string'
    || !/^soter\/evidence\/development\/development-agent-migration-evidence[.][a-z0-9]+(?:[.-][a-z0-9]+)*[.]json$/.test(historical[0].path)
    || !HASH.test(historical[0].fingerprint || '')) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_PRIVATE_CHAIN_INVALID',
      'Final evidence does not name one exact historical development receipt.'
    );
  }
  const historicalDocument = readGovernedCanonicalDocument(
    root,
    historical[0].path,
    historical[0].fingerprint,
    'Historical development receipt'
  );
  if (request.id !== requestId
    || request.host?.id !== host
    || request.workflow?.id !== workflowId
    || result.request?.fingerprint !== request.requestFingerprint
    || observation.request?.fingerprint !== request.requestFingerprint
    || finalization.request?.fingerprint !== request.requestFingerprint
    || finalization.result?.fingerprint !== result.resultFingerprint
    || finalization.observation?.fingerprint !== observation.observationFingerprint
    || !developmentChainBindsRoot(root, request)
    || !HASH.test(finalization.finalizationFingerprint || '')
    || historicalDocument.request?.fingerprint !== request.requestFingerprint
    || historicalDocument.result?.fingerprint !== result.resultFingerprint
    || historicalDocument.sourceObservation?.fingerprint !== observation.observationFingerprint) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_PRIVATE_CHAIN_INVALID',
      'Final evidence does not bind one exact root-local private development chain.'
    );
  }
  assertInstant(finalization.finalizedAt, 'Private finalization time');
  return {
    requestId,
    requestFingerprint: request.requestFingerprint,
    resultFingerprint: result.resultFingerprint,
    observationFingerprint: observation.observationFingerprint,
    finalizationFingerprint: finalization.finalizationFingerprint,
    finalizedAt: finalization.finalizedAt,
    historicalEvidencePath: historical[0].path,
    historicalEvidenceFingerprint: historical[0].fingerprint
  };
}

function candidateOutputRows(evidence, locks) {
  const rows = [
    ...evidence.map((value) => ({
      relativePath: `soter/evidence/development/${value.id}.json`,
      value,
      kind: 'evidence'
    })),
    ...CONFIGURATIONS.map((binding) => ({
      relativePath: binding.lockPath,
      value: locks.get(binding.host),
      kind: 'lock'
    }))
  ].sort((left, right) => left.kind === right.kind
    ? compareText(left.relativePath, right.relativePath)
    : left.kind === 'evidence' ? -1 : 1)
    .map((row) => {
      const bytes = Buffer.from(JSON.stringify(row.value, null, 2) + '\n');
      return {
        ...row,
        bytes,
        plan: {
          path: row.relativePath,
          kind: row.kind,
          mode: '0644',
          documentFingerprint: fingerprintJson(row.value),
          contentFingerprint: sha256(bytes)
        }
      };
    });
  if (rows.length !== 16
    || new Set(rows.map((row) => row.relativePath)).size !== rows.length) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_OUTPUT_INVALID',
      'Development evidence finalization must produce exactly fourteen evidence records and two locks.'
    );
  }
  return rows;
}

function requestIdsFromWorkflow(row) {
  return row.requests || {
    codex: row.receipts?.codex?.requestId,
    claude: row.receipts?.claude?.requestId
  };
}

function validateSealedRequestIdentity(request) {
  if (!exactKeys(request, [
    '$contract',
    'contractVersion',
    'id',
    'requestFingerprint',
    'createdAt',
    'validUntil',
    'rootIdentityFingerprint',
    'basis',
    'configurations',
    'workflows',
    'outputs'
  ])
    || request.$contract !== CONTRACT
    || request.contractVersion !== '1.0.0'
    || !BATCH_ID.test(request.id || '')
    || !HASH.test(request.requestFingerprint || '')
    || request.requestFingerprint !== requestFingerprint(request)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_INVALID',
      'Development evidence finalization request identity, shape, or fingerprint is invalid.'
    );
  }
}

function validateSealedRequest(root, request, remount = null) {
  validateSealedRequestIdentity(request);
  const createdAt = assertInstant(request.createdAt, 'Development evidence finalization createdAt');
  const validUntil = assertInstant(request.validUntil, 'Development evidence finalization validUntil');
  if (validUntil <= createdAt || validUntil - createdAt > REQUEST_MAX_TTL_MS
    || !rootIdentityMatches(root, request.rootIdentityFingerprint, remount)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_BASIS_INVALID',
      'Development evidence finalization request has an invalid validity window or target root identity.'
    );
  }
  if (!exactKeys(request.basis, [
    'legacyFinalizationRequestFingerprint',
    'inventoryFingerprint',
    'checkerReceipt'
  ])
    || !HASH.test(request.basis.legacyFinalizationRequestFingerprint || '')
    || !HASH.test(request.basis.inventoryFingerprint || '')
    || !exactKeys(request.basis.checkerReceipt, ['id', 'receiptFingerprint'])
    || !CHECKER_RECEIPT_ID.test(request.basis.checkerReceipt.id || '')
    || !HASH.test(request.basis.checkerReceipt.receiptFingerprint || '')) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_BASIS_INVALID',
      'Development evidence finalization request does not bind the exact legacy finalization basis.'
    );
  }
  if (!Array.isArray(request.configurations)
    || request.configurations.length !== CONFIGURATIONS.length
    || request.configurations.some((row, index) => {
      const expected = CONFIGURATIONS[index];
      return !exactKeys(row, [
        'host',
        'configPath',
        'lockPath',
        'lockFingerprint',
        'graphFingerprint',
        'projectionFingerprint'
      ])
        || row.host !== expected.host
        || row.configPath !== expected.configPath
        || row.lockPath !== expected.lockPath
        || !HASH.test(row.lockFingerprint || '')
        || !HASH.test(row.graphFingerprint || '')
        || !HASH.test(row.projectionFingerprint || '');
    })) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CONFIGURATION_INVALID',
      'Development evidence finalization must use the exact Codex and Claude final configuration outputs.'
    );
  }
  if (!Array.isArray(request.workflows)
    || request.workflows.length !== 7) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_WORKFLOW_SET_INVALID',
      'Development evidence finalization requires exactly the seven active host-guided workflows.'
    );
  }
  const observedIds = [];
  const allRequestIds = [];
  for (const row of request.workflows) {
    if (!exactKeys(row, ['id', 'basis', 'receipts'])
      || !WORKFLOW_ID.test(row.id || '')
      || !exactKeys(row.basis, [
        'definitionFingerprint',
        'guideFingerprint',
        'guideContentFingerprint',
        'evaluationSetFingerprint',
        'evaluatedSubjectFingerprint'
      ])
      || Object.values(row.basis).some((value) => !HASH.test(value || ''))
      || !exactKeys(row.receipts, ['codex', 'claude'])) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_WORKFLOW_SET_INVALID',
        'Each finalized workflow must bind its exact subject and distinct Codex and Claude receipt chains.'
      );
    }
    for (const host of ['codex', 'claude']) {
      const receipt = row.receipts[host];
      if (!exactKeys(receipt, [
        'requestId',
        'requestFingerprint',
        'resultFingerprint',
        'observationFingerprint',
        'finalizationFingerprint',
        'finalizedAt',
        'historicalEvidencePath',
        'historicalEvidenceFingerprint'
      ])
        || !REQUEST_ID.test(receipt.requestId || '')
        || [
          receipt.requestFingerprint,
          receipt.resultFingerprint,
          receipt.observationFingerprint,
          receipt.finalizationFingerprint,
          receipt.historicalEvidenceFingerprint
        ].some((value) => !HASH.test(value || ''))
        || typeof receipt.historicalEvidencePath !== 'string'
        || !/^soter\/evidence\/development\/development-agent-migration-evidence[.][a-z0-9]+(?:[.-][a-z0-9]+)*[.]json$/.test(receipt.historicalEvidencePath)) {
        fail(
          'DEVELOPMENT_EVIDENCE_FINALIZATION_WORKFLOW_SET_INVALID',
          'Each host receipt must seal one exact private chain and historical evidence record.'
        );
      }
      const finalizedAt = assertInstant(receipt.finalizedAt, 'Private receipt finalizedAt');
      if (finalizedAt > createdAt) {
        fail(
          'DEVELOPMENT_EVIDENCE_FINALIZATION_CHRONOLOGY_INVALID',
          'Development evidence finalization cannot predate a sealed private receipt.'
        );
      }
      allRequestIds.push(receipt.requestId);
    }
    if (row.receipts.codex.requestId === row.receipts.claude.requestId) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_WORKFLOW_SET_INVALID',
        'Codex and Claude receipt identities must be distinct.'
      );
    }
    observedIds.push(row.id);
  }
  if (new Set(observedIds).size !== observedIds.length
    || new Set(allRequestIds).size !== allRequestIds.length) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_WORKFLOW_SET_INVALID',
      'Development evidence finalization workflow or private receipt identities are missing, duplicated, or substituted.'
    );
  }
  const expectedEvidencePaths = observedIds.flatMap((workflowId) => {
    const slug = workflowId.slice('automation.'.length);
    return [
      `soter/evidence/development/evidence.development-activation.codex.${slug}.json`,
      `soter/evidence/development/evidence.development-activation.claude.${slug}.json`
    ];
  }).sort(compareText);
  if (!Array.isArray(request.outputs)
    || request.outputs.length !== 16
    || new Set(request.outputs.map((row) => row.path)).size !== 16
    || request.outputs.some((row) => {
      return !exactKeys(row, [
        'path',
        'kind',
        'mode',
        'documentFingerprint',
        'contentFingerprint'
      ])
        || !['evidence', 'lock'].includes(row.kind)
        || row.mode !== '0644'
        || !HASH.test(row.documentFingerprint || '')
        || !HASH.test(row.contentFingerprint || '')
        || !(row.kind === 'evidence' ? EVIDENCE_PATH.test(row.path || '') : CONFIGURATIONS.some(
          (binding) => binding.lockPath === row.path
        ));
    })
    || request.outputs.filter((row) => row.kind === 'evidence').length !== 14
    || request.outputs.filter((row) => row.kind === 'lock').length !== 2
    || !same(
      request.outputs.filter((row) => row.kind === 'evidence')
        .map((row) => row.path)
        .sort(compareText),
      expectedEvidencePaths
    )) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_OUTPUT_INVALID',
      'Development evidence finalization request must seal the exact fourteen-evidence and two-lock output plan.'
    );
  }
  return [...observedIds].sort(compareText);
}

function validateRequest(root, request, legacyRequest) {
  const observedIds = validateSealedRequest(root, request);
  if (request.basis.legacyFinalizationRequestFingerprint !== fingerprintJson(legacyRequest)
    || request.basis.inventoryFingerprint !== legacyRequest.expectedInventoryFingerprint
    || !same(request.basis.checkerReceipt, legacyRequest.checkerReceipt)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_BASIS_INVALID',
      'Development evidence finalization request does not bind the exact legacy finalization basis.'
    );
  }
  const active = activeWorkflowIds(root);
  if (active.length !== 7 || !same(observedIds, active)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_WORKFLOW_SET_INVALID',
      'Development evidence finalization request does not match the current active workflow set.'
    );
  }
  return active;
}

function deriveFinalizationCandidate({ root, legacyRequest, workflowRows, createdAt }) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const workflowIds = activeWorkflowIds(resolvedRoot);
  const requested = [...workflowRows].map((row) => ({
    id: row.id,
    requests: requestIdsFromWorkflow(row)
  })).sort((left, right) => compareText(left.id, right.id));
  if (workflowIds.length !== 7
    || !same(requested.map((row) => row.id), workflowIds)
    || requested.some((row) => !exactKeys(row.requests, ['codex', 'claude'])
      || !REQUEST_ID.test(row.requests.codex || '')
      || !REQUEST_ID.test(row.requests.claude || ''))) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_WORKFLOW_SET_INVALID',
      'Finalization candidate requires the exact seven active workflow and dual-host request identities.'
    );
  }
  const staticVerification = verifySoter(resolvedRoot, { includeRuntimeArtifacts: false });
  assertLegacyFinalizationCandidateBasis({
    root: resolvedRoot,
    expectedInventoryFingerprint: legacyRequest.expectedInventoryFingerprint,
    checkerReceipt: legacyRequest.checkerReceipt,
    evidencePaths: legacyRequest.evidencePaths,
    verification: staticVerification
  });
  const locks = new Map();
  for (const binding of CONFIGURATIONS) {
    const lock = resolveDevelopmentEvidenceFinalizationConfiguration({
      root: resolvedRoot,
      configPath: binding.configPath,
      host: binding.host,
      workflowIds
    });
    if (lock.host.id !== binding.host || lock.configuration.path !== binding.configPath) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_CONFIGURATION_INVALID',
        'Derived finalization lock does not match its exact host and configuration.'
      );
    }
    locks.set(binding.host, lock);
  }
  const evidence = [];
  const workflows = [];
  for (const row of requested) {
    const receipts = {};
    for (const binding of CONFIGURATIONS) {
      const value = buildDevelopmentHostFinalEvidenceForBatch({
        root: resolvedRoot,
        requestId: row.requests[binding.host],
        finalLock: locks.get(binding.host),
        finalLockPath: binding.lockPath,
        createdAt
      });
      const expectedPath = `soter/evidence/development/${value.id}.json`;
      const match = expectedPath.match(EVIDENCE_PATH);
      if (!match || match[1] !== binding.host || `automation.${match[2]}` !== row.id
        || !legacyRequest.evidencePaths.includes(expectedPath)) {
        fail(
          'DEVELOPMENT_EVIDENCE_FINALIZATION_EVIDENCE_SET_INVALID',
          'Built final evidence is not one exact declared host and workflow output.'
        );
      }
      receipts[binding.host] = privateChainBinding(
        resolvedRoot,
        row.requests[binding.host],
        binding.host,
        row.id,
        value
      );
      evidence.push(value);
    }
    workflows.push({
      id: row.id,
      basis: workflowBasis(resolvedRoot, row.id),
      receipts
    });
  }
  const configurations = CONFIGURATIONS.map((binding) => {
    const lock = locks.get(binding.host);
    return {
      host: binding.host,
      configPath: binding.configPath,
      lockPath: binding.lockPath,
      lockFingerprint: fingerprintLock(lock),
      graphFingerprint: lock.graphFingerprint,
      projectionFingerprint: fingerprintJson(lock.projections)
    };
  });
  const outputRows = candidateOutputRows(evidence, locks);
  return {
    workflowIds,
    locks,
    evidence,
    configurations,
    workflows,
    outputRows,
    outputs: outputRows.map((row) => row.plan)
  };
}

function assertCandidateMatchesRequest(request, candidate) {
  if (!same(request.configurations, candidate.configurations)
    || !same(request.workflows, candidate.workflows)
    || !same(request.outputs, candidate.outputs)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CANDIDATE_MISMATCH',
      'Current private chains, workflow subjects, final locks, projections, or output bytes differ from the sealed request.'
    );
  }
}

export function buildDevelopmentHostEvidenceFinalizationRequest({
  root,
  legacyFinalizationPath,
  id,
  createdAt,
  validUntil,
  workflows,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length > 0
    || !BATCH_ID.test(id || '')
    || !Array.isArray(workflows)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_ARGUMENTS_INVALID',
      'Finalization request builder received an unknown or malformed argument.'
    );
  }
  assertInstant(createdAt, 'Development evidence finalization createdAt');
  assertInstant(validUntil, 'Development evidence finalization validUntil');
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const legacyRequest = readLegacyFinalizationFixtureRequest(resolvedRoot, legacyFinalizationPath);
  const candidate = deriveFinalizationCandidate({
    root: resolvedRoot,
    legacyRequest,
    workflowRows: workflows,
    createdAt
  });
  const request = {
    $contract: CONTRACT,
    contractVersion: '1.0.0',
    id,
    requestFingerprint: 'sha256:' + '0'.repeat(64),
    createdAt,
    validUntil,
    rootIdentityFingerprint: rootIdentityFingerprint(resolvedRoot),
    basis: {
      legacyFinalizationRequestFingerprint: fingerprintJson(legacyRequest),
      inventoryFingerprint: legacyRequest.expectedInventoryFingerprint,
      checkerReceipt: structuredClone(legacyRequest.checkerReceipt)
    },
    configurations: candidate.configurations,
    workflows: candidate.workflows,
    outputs: candidate.outputs
  };
  request.requestFingerprint = requestFingerprint(request);
  validateRequest(resolvedRoot, request, legacyRequest);
  return request;
}

function governedDirectoryIdentity(directory, label = 'Governed output directory') {
  let stat;
  let real;
  try {
    stat = fs.lstatSync(directory);
    real = fs.realpathSync(directory);
  } catch (error) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_OUTPUT_INVALID',
      label + ' is unavailable.',
      error
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== directory
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o755)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_OUTPUT_INVALID',
      label + ' must be one exact non-symlink directory with mode 0755.'
    );
  }
  return { device: Number(stat.dev), inode: Number(stat.ino) };
}

function requiredDirectoryPaths(rows) {
  const relativeDirectories = new Set();
  for (const row of rows) {
    const outputPath = row.relativePath || row.path;
    const parts = path.posix.dirname(outputPath).split('/').filter(Boolean);
    for (let index = 1; index <= parts.length; index += 1) {
      relativeDirectories.add(parts.slice(0, index).join('/'));
    }
  }
  return [...relativeDirectories].sort((left, right) => {
    const depth = left.split('/').length - right.split('/').length;
    return depth || compareText(left, right);
  });
}

function requiredDirectoryBasis(root, candidateRows) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const rows = requiredDirectoryPaths(candidateRows);
  const missing = new Set();
  return rows.map((relativePath) => {
    const parentPath = path.posix.dirname(relativePath);
    const directory = resolveRepoPath(resolvedRoot, relativePath);
    if ((parentPath !== '.' && missing.has(parentPath)) || !fs.existsSync(directory)) {
      missing.add(relativePath);
      return {
        path: relativePath,
        ownership: 'checkpoint',
        state: 'planned',
        device: null,
        inode: null,
        ownershipToken: null
      };
    }
    return {
      path: relativePath,
      ownership: 'preexisting',
      state: 'existing',
      ...governedDirectoryIdentity(directory),
      ownershipToken: null
    };
  });
}

function pendingPrefix(file) {
  return '.' + path.basename(file) + '.pending-';
}

function pendingOutputFiles(output) {
  if (!fs.existsSync(output.directory)) return [];
  governedDirectoryIdentity(output.directory);
  return fs.readdirSync(output.directory)
    .filter((name) => name.startsWith(pendingPrefix(output.file)))
    .map((name) => path.join(output.directory, name))
    .sort(compareText);
}

function inspectOutput(output) {
  let stat;
  try {
    stat = fs.lstatSync(output.file);
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'absent' };
    fail('DEVELOPMENT_EVIDENCE_FINALIZATION_OUTPUT_INVALID', 'Governed output is unavailable.', error);
  }
  if (!stat.isFile() || stat.isSymbolicLink()
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o644)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_OUTPUT_INVALID',
      'Governed output must be one exact regular file with mode 0644.'
    );
  }
  const bytes = fs.readFileSync(output.file);
  if (!bytes.equals(output.bytes)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REENTRY_MISMATCH',
      'Create-only finalization cannot adopt or replace different governed bytes.'
    );
  }
  if (stat.nlink !== 1) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_OUTPUT_INVALID',
      'Governed output has an unsafe hardlink count.'
    );
  }
  return { state: 'exact', stat };
}

function fsyncDirectory(directory) {
  try {
    const descriptor = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    // Exact file validation remains authoritative on filesystems without directory fsync.
  }
}

function ensurePrivateDirectoryChain(root, relativeDirectory) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  let current = resolvedRoot;
  for (const part of relativeDirectory.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
      if (process.platform !== 'win32') fs.chmodSync(current, 0o700);
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        fail(
          'DEVELOPMENT_EVIDENCE_FINALIZATION_CONSUMPTION_INVALID',
          'Private finalization consumption directory cannot be created.',
          error
        );
      }
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || fs.realpathSync(current) !== current
      || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o700)) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_CONSUMPTION_INVALID',
        'Private finalization consumption directory must be one exact non-symlink 0700 directory.'
      );
    }
  }
  return current;
}

function consumptionFingerprint(value) {
  const unsigned = structuredClone(value);
  delete unsigned.consumptionFingerprint;
  return fingerprintJson(unsigned);
}

function checkpointPlanFingerprint(request, directoryPlan) {
  return fingerprintJson({
    requestFingerprint: request.requestFingerprint,
    rootIdentityFingerprint: request.rootIdentityFingerprint,
    outputsFingerprint: fingerprintJson(request.outputs),
    directories: directoryPlan
  });
}

function validateDirectoryBasis(request, rows) {
  if (!Array.isArray(rows)
    || !same(rows.map((row) => row.path), requiredDirectoryPaths(request.outputs))
    || new Set(rows.map((row) => row.path)).size !== rows.length
    || rows.some((row) => {
      if (!exactKeys(row, [
        'path',
        'ownership',
        'state',
        'device',
        'inode',
        'ownershipToken'
      ])) return true;
      if (row.ownership === 'preexisting') {
        return row.state !== 'existing'
          || !Number.isSafeInteger(row.device) || row.device < 0
          || !Number.isSafeInteger(row.inode) || row.inode < 0
          || row.ownershipToken !== null;
      }
      return row.ownership !== 'checkpoint'
        || row.state !== 'planned'
        || row.device !== null
        || row.inode !== null
        || row.ownershipToken !== null;
    })) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CONSUMPTION_INVALID',
      'Private finalization consumption has an invalid exact directory basis.'
    );
  }
  return rows;
}

function validateConsumption(root, request, value, remount = null) {
  if (!exactKeys(value, [
    '$contract',
    'contractVersion',
    'id',
    'consumptionFingerprint',
    'startedAt',
    'request',
    'rootIdentityFingerprint',
    'outputsFingerprint',
    'directoryPlan',
    'checkpointPlanFingerprint',
    'authority'
  ])
    || value.$contract !== CONSUMPTION_CONTRACT
    || value.contractVersion !== '1.0.0'
    || value.id !== request.id + '.consumption'
    || value.consumptionFingerprint !== consumptionFingerprint(value)
    || !exactKeys(value.request, ['id', 'fingerprint', 'validUntil'])
    || value.request.id !== request.id
    || value.request.fingerprint !== request.requestFingerprint
    || value.request.validUntil !== request.validUntil
    || !rootIdentityMatches(root, value.rootIdentityFingerprint, remount)
    || value.rootIdentityFingerprint !== request.rootIdentityFingerprint
    || value.outputsFingerprint !== fingerprintJson(request.outputs)
    || value.checkpointPlanFingerprint !== checkpointPlanFingerprint(
      request,
      value.directoryPlan
    )
    || value.authority !== 'exact-evidence-publication-recovery-only') {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CONSUMPTION_INVALID',
      'Private finalization consumption does not bind the exact request, root, and output plan.'
    );
  }
  validateDirectoryBasis(request, value.directoryPlan);
  const startedAt = assertInstant(value.startedAt, 'Development evidence finalization startedAt');
  if (startedAt < Date.parse(request.createdAt) || startedAt >= Date.parse(request.validUntil)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CONSUMPTION_INVALID',
      'Private finalization consumption falls outside the exact request validity window.'
    );
  }
  return value;
}

function consumeFinalizationRequest(root, request, preflight, directoryPlan, consumeAt) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const relativeDirectory = '.soter/state/development-host-evidence-finalizations';
  const directory = resolveRepoPath(resolvedRoot, relativeDirectory);
  const file = path.join(directory, request.id + '.json');
  const observedAt = assertOperationAt(consumeAt);
  if (fs.existsSync(file)) {
    const consumption = validateConsumption(
      resolvedRoot,
      request,
      readPrivateStateDocument(resolvedRoot, file, 'Private finalization consumption')
    );
    if (observedAt < Date.parse(consumption.startedAt)) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_TIME_INVALID',
        'Development evidence finalization recovery time predates its exact consumption.'
      );
    }
    return consumption;
  }
  if (preflight.some((row) => row.state !== 'absent' || row.pendingFiles.length !== 0)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
      'Existing finalization outputs or pending files cannot be adopted without exact transaction ownership.'
    );
  }
  validateDirectoryBasis(request, directoryPlan);
  if (observedAt < Date.parse(request.createdAt)
    || observedAt >= Date.parse(request.validUntil)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_EXPIRED',
      'Development evidence finalization request is not yet valid or has expired.'
    );
  }
  ensurePrivateDirectoryChain(resolvedRoot, relativeDirectory);
  const value = {
    $contract: CONSUMPTION_CONTRACT,
    contractVersion: '1.0.0',
    id: request.id + '.consumption',
    consumptionFingerprint: 'sha256:' + '0'.repeat(64),
    startedAt: consumeAt,
    request: {
      id: request.id,
      fingerprint: request.requestFingerprint,
      validUntil: request.validUntil
    },
    rootIdentityFingerprint: request.rootIdentityFingerprint,
    outputsFingerprint: fingerprintJson(request.outputs),
    directoryPlan: structuredClone(directoryPlan),
    checkpointPlanFingerprint: checkpointPlanFingerprint(request, directoryPlan),
    authority: 'exact-evidence-publication-recovery-only'
  };
  value.consumptionFingerprint = consumptionFingerprint(value);
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
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
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (error?.code === 'EEXIST') {
      return validateConsumption(
        resolvedRoot,
        request,
        readPrivateStateDocument(resolvedRoot, file, 'Private finalization consumption')
      );
    }
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CONSUMPTION_INVALID',
      'Private finalization consumption could not be persisted create-only.',
      error
    );
  }
  return validateConsumption(
    resolvedRoot,
    request,
    readPrivateStateDocument(resolvedRoot, file, 'Private finalization consumption')
  );
}

function readFinalizationConsumption(root, request) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const file = resolveRepoPath(
    resolvedRoot,
    `.soter/state/development-host-evidence-finalizations/${request.id}.json`
  );
  return validateConsumption(
    resolvedRoot,
    request,
    readPrivateStateDocument(resolvedRoot, file, 'Private finalization consumption')
  );
}

function readExistingFinalizationConsumption(root, request) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const file = resolveRepoPath(
    resolvedRoot,
    `.soter/state/development-host-evidence-finalizations/${request.id}.json`
  );
  if (!fs.existsSync(file)) return null;
  return validateConsumption(
    resolvedRoot,
    request,
    readPrivateStateDocument(resolvedRoot, file, 'Private finalization consumption')
  );
}

function readRollbackFinalizationConsumption(root, request) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  validateSealedRequestIdentity(request);
  const file = resolveRepoPath(
    resolvedRoot,
    `.soter/state/development-host-evidence-finalizations/${request.id}.json`
  );
  if (!fs.existsSync(file)) {
    validateSealedRequest(resolvedRoot, request);
    return { consumption: null, remount: null };
  }
  const value = readPrivateStateDocument(
    resolvedRoot,
    file,
    'Private finalization consumption'
  );
  const current = rootIdentity(resolvedRoot);
  let remount = null;
  if (fingerprintJson(current) !== request.rootIdentityFingerprint) {
    const sealedDevices = new Set(
      (Array.isArray(value?.directoryPlan) ? value.directoryPlan : [])
        .filter((row) => row?.ownership === 'preexisting')
        .map((row) => row.device)
    );
    if (sealedDevices.size !== 1) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_BASIS_INVALID',
        'Remount-safe rollback requires one exact sealed filesystem device.'
      );
    }
    const [sealedDevice] = sealedDevices;
    remount = Object.freeze({
      realPath: current.realPath,
      rootInode: current.inode,
      sealedDevice,
      currentDevice: current.device
    });
    if (!Number.isSafeInteger(sealedDevice) || sealedDevice < 0
      || !rootIdentityMatches(resolvedRoot, request.rootIdentityFingerprint, remount)) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_BASIS_INVALID',
        'Remount-safe rollback rejected a changed root path, inode, or non-device identity.'
      );
    }
  }
  validateSealedRequest(resolvedRoot, request, remount);
  const consumption = validateConsumption(resolvedRoot, request, value, remount);
  if (remount && consumption.directoryPlan.some((row) => {
    return row.device !== null && row.device !== remount.sealedDevice;
  })) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CONSUMPTION_INVALID',
      'Remount-safe rollback requires every sealed directory device to match one exact filesystem.'
    );
  }
  return {
    consumption,
    remount
  };
}

function checkpointFingerprint(value) {
  const unsigned = structuredClone(value);
  delete unsigned.checkpointFingerprint;
  return fingerprintJson(unsigned);
}

function checkpointFile(root, request) {
  return resolveRepoPath(
    fs.realpathSync(path.resolve(root)),
    `.soter/state/development-host-evidence-finalizations/${request.id}.checkpoint.json`
  );
}

function validateCheckpoint(root, request, consumption, value, remount = null) {
  if (exactKeys(value?.rollback, ['state', 'failures'])) {
    if (value.checkpointFingerprint !== checkpointFingerprint(value)) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_CHECKPOINT_INVALID',
        'Legacy private finalization checkpoint fingerprint is invalid.'
      );
    }
    value = structuredClone(value);
    value.rollback.terminalState = [
      'rolling-back',
      'rolled-back',
      'needs-attention'
    ].includes(value.state) ? 'rolled-back' : null;
    value.checkpointFingerprint = checkpointFingerprint(value);
  }
  if (!exactKeys(value, [
    '$contract',
    'contractVersion',
    'id',
    'checkpointFingerprint',
    'sequence',
    'observedAt',
    'state',
    'request',
    'consumption',
    'rootIdentityFingerprint',
    'outputsFingerprint',
    'planFingerprint',
    'directories',
    'outputs',
    'rollback',
    'authority'
  ])
    || value.$contract !== CHECKPOINT_CONTRACT
    || value.contractVersion !== '1.0.0'
    || value.id !== request.id + '.checkpoint'
    || value.checkpointFingerprint !== checkpointFingerprint(value)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 0
    || ![
      'running',
      'completed',
      'rolling-back',
      'rolled-back',
      'superseded',
      'needs-attention'
    ].includes(value.state)
    || !exactKeys(value.request, ['id', 'fingerprint'])
    || value.request.id !== request.id
    || value.request.fingerprint !== request.requestFingerprint
    || !exactKeys(value.consumption, ['id', 'fingerprint', 'startedAt'])
    || value.consumption.id !== consumption.id
    || value.consumption.fingerprint !== consumption.consumptionFingerprint
    || value.consumption.startedAt !== consumption.startedAt
    || !rootIdentityMatches(root, value.rootIdentityFingerprint, remount)
    || value.rootIdentityFingerprint !== request.rootIdentityFingerprint
    || value.outputsFingerprint !== fingerprintJson(request.outputs)
    || value.planFingerprint !== consumption.checkpointPlanFingerprint
    || value.authority !== 'checkpoint-bound-evidence-publication-recovery-only') {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CHECKPOINT_INVALID',
      'Private finalization checkpoint does not bind the exact request, consumption, root, and output plan.'
    );
  }
  let observedAt;
  try {
    observedAt = assertOperationAt(value.observedAt);
  } catch (error) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CHECKPOINT_INVALID',
      'Private finalization checkpoint has an invalid observedAt instant.',
      error
    );
  }
  if (observedAt < Date.parse(consumption.startedAt)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CHECKPOINT_INVALID',
      'Private finalization checkpoint predates exact consumption.'
    );
  }
  if (!Array.isArray(value.directories)
    || !same(value.directories.map((row) => row.path), consumption.directoryPlan.map((row) => row.path))
    || value.directories.some((row, index) => {
      const basis = consumption.directoryPlan[index];
      if (!exactKeys(row, [
        'path',
        'ownership',
        'state',
        'device',
        'inode',
        'ownershipToken'
      ]) || row.path !== basis.path || row.ownership !== basis.ownership) return true;
      if (row.ownership === 'preexisting') {
        return row.state !== 'existing'
          || row.device !== basis.device
          || row.inode !== basis.inode
          || row.ownershipToken !== null;
      }
      if (row.state === 'planned') {
        return row.device !== null || row.inode !== null || row.ownershipToken !== null;
      }
      if (row.state === 'creating') {
        return !/^[a-f0-9]{64}$/.test(row.ownershipToken || '')
          || !((row.device === null && row.inode === null)
            || (Number.isSafeInteger(row.device) && row.device >= 0
              && Number.isSafeInteger(row.inode) && row.inode >= 0));
      }
      return row.state !== 'created'
        || !Number.isSafeInteger(row.device) || row.device < 0
        || !Number.isSafeInteger(row.inode) || row.inode < 0
        || row.ownershipToken !== null;
    })) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CHECKPOINT_INVALID',
      'Private finalization checkpoint has an invalid directory ownership state.'
    );
  }
  if (!Array.isArray(value.outputs)
    || value.outputs.length !== request.outputs.length
    || value.outputs.some((row, index) => {
      const basis = request.outputs[index];
      if (!exactKeys(row, [
        'path',
        'kind',
        'mode',
        'documentFingerprint',
        'contentFingerprint',
        'state',
        'pendingPath',
        'device',
        'inode'
      ])
        || !same(Object.fromEntries([
          'path',
          'kind',
          'mode',
          'documentFingerprint',
          'contentFingerprint'
        ].map((key) => [key, row[key]])), basis)) return true;
      if (row.state === 'pending') {
        return row.pendingPath !== null || row.device !== null || row.inode !== null;
      }
      if (row.state === 'writing') {
        const expectedDirectory = path.posix.dirname(row.path);
        return typeof row.pendingPath !== 'string'
          || path.posix.dirname(row.pendingPath) !== expectedDirectory
          || !path.posix.basename(row.pendingPath).startsWith(
            pendingPrefix(path.posix.basename(row.path))
          )
          || !((row.device === null && row.inode === null)
            || (Number.isSafeInteger(row.device) && row.device >= 0
              && Number.isSafeInteger(row.inode) && row.inode >= 0));
      }
      return !['applied', 'verified'].includes(row.state)
        || row.pendingPath !== null
        || !Number.isSafeInteger(row.device) || row.device < 0
        || !Number.isSafeInteger(row.inode) || row.inode < 0;
    })
    || !exactKeys(value.rollback, ['state', 'failures', 'terminalState'])
    || !['not-started', 'running', 'completed', 'needs-attention'].includes(value.rollback.state)
    || ![null, 'rolled-back', 'superseded'].includes(value.rollback.terminalState)
    || !Array.isArray(value.rollback.failures)
    || value.rollback.failures.some((item) => typeof item !== 'string')
    || new Set(value.rollback.failures).size !== value.rollback.failures.length) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CHECKPOINT_INVALID',
      'Private finalization checkpoint has an invalid output or rollback state.'
    );
  }
  if (remount && [
    ...value.directories.map((row) => row.device),
    ...value.outputs.map((row) => row.device)
  ].some((device) => device !== null && device !== remount.sealedDevice)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CHECKPOINT_INVALID',
      'Remount-safe rollback requires every sealed checkpoint device to match one exact filesystem.'
    );
  }
  const allOutputsVerified = value.outputs.every((row) => row.state === 'verified');
  const allOutputsPending = value.outputs.every((row) => row.state === 'pending');
  const ownedDirectoriesCreated = value.directories.every((row) => {
    return row.ownership === 'preexisting' || row.state === 'created';
  });
  const ownedDirectoriesPlanned = value.directories.every((row) => {
    return row.ownership === 'preexisting' || row.state === 'planned';
  });
  if ((value.state === 'completed'
      && (!allOutputsVerified || !ownedDirectoriesCreated
        || value.rollback.state !== 'not-started'))
    || (['rolled-back', 'superseded'].includes(value.state)
      && (!allOutputsPending || !ownedDirectoriesPlanned
        || value.rollback.state !== 'completed'
        || value.rollback.terminalState !== value.state))
    || (value.state === 'needs-attention'
      && (value.rollback.state !== 'needs-attention'
        || !['rolled-back', 'superseded'].includes(value.rollback.terminalState)))
    || (value.state === 'rolling-back'
      && (value.rollback.state !== 'running'
        || !['rolled-back', 'superseded'].includes(value.rollback.terminalState)))
    || (['running', 'completed'].includes(value.state)
      && (value.rollback.state !== 'not-started'
        || value.rollback.terminalState !== null))) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CHECKPOINT_INVALID',
      'Private finalization checkpoint lifecycle families are inconsistent.'
    );
  }
  return value;
}

function readFinalizationCheckpoint(root, request, consumption, remount = null) {
  return validateCheckpoint(
    root,
    request,
    consumption,
    readPrivateStateDocument(
      root,
      checkpointFile(root, request),
      'Private finalization checkpoint'
    ),
    remount
  );
}

function writePrivateCanonicalCreate(file, value, code, label) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
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
    if (error?.code?.startsWith('DEVELOPMENT_EVIDENCE_')) throw error;
    fail(code, label + ' could not be persisted create-only.', error);
  }
}

function persistCheckpoint(root, request, consumption, current, next, remount = null) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  next.sequence = current.sequence + 1;
  next.checkpointFingerprint = checkpointFingerprint(next);
  validateCheckpoint(resolvedRoot, request, consumption, next, remount);
  const file = checkpointFile(resolvedRoot, request);
  const observed = readFinalizationCheckpoint(resolvedRoot, request, consumption, remount);
  if (observed.checkpointFingerprint !== current.checkpointFingerprint) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CHECKPOINT_INVALID',
      'Private finalization checkpoint changed before its exact update.'
    );
  }
  const pending = path.join(
    path.dirname(file),
    '.' + path.basename(file) + '.pending-' + crypto.randomBytes(16).toString('hex')
  );
  const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n');
  let descriptor = null;
  let pendingIdentity = null;
  try {
    descriptor = fs.openSync(
      pending,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    pendingIdentity = fs.fstatSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    const latest = readFinalizationCheckpoint(
      resolvedRoot,
      request,
      consumption,
      remount
    );
    if (latest.checkpointFingerprint !== current.checkpointFingerprint) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_CHECKPOINT_INVALID',
        'Private finalization checkpoint changed during its exact update.'
      );
    }
    fs.renameSync(pending, file);
    pendingIdentity = null;
    fsyncDirectory(path.dirname(file));
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (pendingIdentity) {
      try {
        const stat = fs.lstatSync(pending);
        if (stat.dev === pendingIdentity.dev && stat.ino === pendingIdentity.ino) {
          fs.unlinkSync(pending);
        }
      } catch {
        // Never remove an unrecognized private checkpoint path.
      }
    }
    if (error?.code?.startsWith('DEVELOPMENT_EVIDENCE_')) throw error;
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CHECKPOINT_INVALID',
      'Private finalization checkpoint update failed.',
      error
    );
  }
  return readFinalizationCheckpoint(resolvedRoot, request, consumption, remount);
}

function checkpointMutation(
  root,
  request,
  consumption,
  checkpoint,
  at,
  mutate,
  remount = null
) {
  const next = structuredClone(checkpoint);
  next.observedAt = at;
  mutate(next);
  return persistCheckpoint(root, request, consumption, checkpoint, next, remount);
}

function assertInitialCheckpointBasis(root, consumption, outputs) {
  for (const row of consumption.directoryPlan) {
    const directory = resolveRepoPath(root, row.path);
    if (row.ownership === 'preexisting') {
      const identity = governedDirectoryIdentity(directory);
      if (identity.device !== row.device || identity.inode !== row.inode) {
        fail(
          'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
          'A preexisting governed output directory changed after exact consumption.'
        );
      }
    } else if (fs.existsSync(directory)) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
        'A planned governed output directory appeared without checkpoint ownership.'
      );
    }
  }
  for (const output of outputs) {
    let inspected;
    let pendingFiles;
    try {
      inspected = inspectOutput(output);
      pendingFiles = pendingOutputFiles(output);
    } catch (error) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
        'An unsafe output or pending file appeared before checkpoint ownership was recorded.',
        error
      );
    }
    if (inspected.state !== 'absent' || pendingFiles.length !== 0) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
        'An output or pending file appeared before checkpoint ownership was recorded.'
      );
    }
  }
}

function readOrCreateCheckpoint(root, request, consumption, outputs, at) {
  const file = checkpointFile(root, request);
  if (fs.existsSync(file)) {
    return readFinalizationCheckpoint(root, request, consumption);
  }
  assertInitialCheckpointBasis(root, consumption, outputs);
  const value = {
    $contract: CHECKPOINT_CONTRACT,
    contractVersion: '1.0.0',
    id: request.id + '.checkpoint',
    checkpointFingerprint: 'sha256:' + '0'.repeat(64),
    sequence: 0,
    observedAt: at,
    state: 'running',
    request: { id: request.id, fingerprint: request.requestFingerprint },
    consumption: {
      id: consumption.id,
      fingerprint: consumption.consumptionFingerprint,
      startedAt: consumption.startedAt
    },
    rootIdentityFingerprint: request.rootIdentityFingerprint,
    outputsFingerprint: fingerprintJson(request.outputs),
    planFingerprint: consumption.checkpointPlanFingerprint,
    directories: structuredClone(consumption.directoryPlan),
    outputs: request.outputs.map((row) => ({
      ...structuredClone(row),
      state: 'pending',
      pendingPath: null,
      device: null,
      inode: null
    })),
    rollback: { state: 'not-started', failures: [], terminalState: null },
    authority: 'checkpoint-bound-evidence-publication-recovery-only'
  };
  value.checkpointFingerprint = checkpointFingerprint(value);
  validateCheckpoint(root, request, consumption, value);
  try {
    writePrivateCanonicalCreate(
      file,
      value,
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CHECKPOINT_INVALID',
      'Private finalization checkpoint'
    );
  } catch (error) {
    if (!fs.existsSync(file)) throw error;
  }
  return readFinalizationCheckpoint(root, request, consumption);
}

function invokeTestHook(hooks, name, detail) {
  if (typeof hooks?.[name] === 'function') hooks[name](detail);
}

function isSelftestCrash(error) {
  return error?.code === SELFTEST_CRASH;
}

function assertRequestApplicableAt(root, request, at) {
  const observedAt = assertOperationAt(at);
  const createdAt = Date.parse(request.createdAt);
  const validUntil = Date.parse(request.validUntil);
  const consumption = readExistingFinalizationConsumption(root, request);
  if (consumption) {
    if (observedAt < Date.parse(consumption.startedAt)) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_TIME_INVALID',
        'Development evidence finalization observation time predates its exact consumption.'
      );
    }
    return consumption;
  }
  if (observedAt < createdAt || observedAt >= validUntil) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_EXPIRED',
      'Development evidence finalization request is not yet valid or has expired.'
    );
  }
  return null;
}

function outputInspectionPlan(root, candidateRows) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  return candidateRows.map((row) => {
    const file = resolveRepoPath(resolvedRoot, row.relativePath);
    let current = resolvedRoot;
    for (const part of path.posix.dirname(row.relativePath).split('/').filter(Boolean)) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) continue;
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || fs.realpathSync(current) !== current
        || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o755)) {
        fail(
          'DEVELOPMENT_EVIDENCE_FINALIZATION_OUTPUT_INVALID',
          'Governed output parent must be one exact non-symlink 0755 directory.'
        );
      }
    }
    return { ...row, file, directory: path.dirname(file) };
  });
}

function checkpointDirectoryMarker(directory, token) {
  return path.join(directory, '.soter-finalization-owner-' + token);
}

function assertCheckpointDirectoryMarker(directory, token) {
  const marker = checkpointDirectoryMarker(directory, token);
  let stat;
  let bytes;
  try {
    stat = fs.lstatSync(marker);
    bytes = fs.readFileSync(marker);
  } catch (error) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
      'A creating directory lacks its exact private ownership marker.',
      error
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o600)
    || !bytes.equals(Buffer.from(JSON.stringify(token, null, 2) + '\n'))) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
      'A creating directory has an invalid private ownership marker.'
    );
  }
  return marker;
}

function assertDirectoryIdentity(directory, row, remount = null) {
  const identity = governedDirectoryIdentity(directory);
  if (!deviceMatches(identity.device, row.device, remount)
    || identity.inode !== row.inode) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
      'A governed output directory no longer has its checkpoint-owned identity.'
    );
  }
  return identity;
}

function realizeCheckpointDirectories({
  root,
  request,
  consumption,
  checkpoint,
  at,
  hooks
}) {
  let current = checkpoint;
  for (let index = 0; index < current.directories.length; index += 1) {
    let row = current.directories[index];
    const directory = resolveRepoPath(root, row.path);
    if (row.ownership === 'preexisting') {
      assertDirectoryIdentity(directory, row);
      continue;
    }
    if (row.state === 'planned') {
      if (fs.existsSync(directory)) {
        fail(
          'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
          'A planned governed output directory cannot be adopted.'
        );
      }
      const parent = path.dirname(directory);
      governedDirectoryIdentity(parent, 'Governed output parent directory');
      const token = crypto.randomBytes(32).toString('hex');
      current = checkpointMutation(root, request, consumption, current, at, (next) => {
        next.directories[index] = {
          ...next.directories[index],
          state: 'creating',
          ownershipToken: token
        };
      });
      row = current.directories[index];
      invokeTestHook(hooks, 'afterDirectoryCreatingBeforeEffect', {
        index,
        path: row.path
      });
    }
    if (row.state === 'creating') {
      if (row.device === null) {
        if (!fs.existsSync(directory)) {
          try {
            fs.mkdirSync(directory, { mode: 0o755 });
            if (process.platform !== 'win32') fs.chmodSync(directory, 0o755);
            writePrivateCanonicalCreate(
              checkpointDirectoryMarker(directory, row.ownershipToken),
              row.ownershipToken,
              'DEVELOPMENT_EVIDENCE_FINALIZATION_OUTPUT_INVALID',
              'Governed output directory ownership marker'
            );
          } catch (error) {
            if (error?.code?.startsWith('DEVELOPMENT_EVIDENCE_')) throw error;
            fail(
              'DEVELOPMENT_EVIDENCE_FINALIZATION_OUTPUT_INVALID',
              'Checkpoint-owned governed output directory could not be created.',
              error
            );
          }
        } else {
          governedDirectoryIdentity(directory);
          assertCheckpointDirectoryMarker(directory, row.ownershipToken);
        }
        const identity = governedDirectoryIdentity(directory);
        current = checkpointMutation(root, request, consumption, current, at, (next) => {
          next.directories[index].device = identity.device;
          next.directories[index].inode = identity.inode;
        });
        row = current.directories[index];
        invokeTestHook(hooks, 'afterDirectoryEffectBeforeCreated', {
          index,
          path: row.path
        });
      }
      assertDirectoryIdentity(directory, row);
      const marker = checkpointDirectoryMarker(directory, row.ownershipToken);
      if (fs.existsSync(marker)) {
        assertCheckpointDirectoryMarker(directory, row.ownershipToken);
        fs.unlinkSync(marker);
        fsyncDirectory(directory);
      }
      current = checkpointMutation(root, request, consumption, current, at, (next) => {
        next.directories[index] = {
          ...next.directories[index],
          state: 'created',
          ownershipToken: null
        };
      });
      row = current.directories[index];
    }
    if (row.state === 'created') assertDirectoryIdentity(directory, row);
  }
  return current;
}

function assertOwnedFile(file, output, device, inode, allowedLinks, remount = null) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
      'A checkpoint-owned output path is unavailable.',
      error
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()
    || !allowedLinks.includes(stat.nlink)
    || !deviceMatches(Number(stat.dev), device, remount)
    || Number(stat.ino) !== inode
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o644)
    || !fs.readFileSync(file).equals(output.bytes)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
      'A checkpoint-owned output path differs from its exact bytes or inode.'
    );
  }
  return stat;
}

function realizeCheckpointOutput({
  root,
  request,
  consumption,
  checkpoint,
  output,
  index,
  at,
  hooks
}) {
  let current = checkpoint;
  let row = current.outputs[index];
  const initialState = row.state;
  if (row.state === 'pending') {
    if (fs.existsSync(output.file) || pendingOutputFiles(output).length !== 0) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
        'A pending output or temporary file cannot be adopted.'
      );
    }
    const pendingPath = path.posix.join(
      path.posix.dirname(row.path),
      pendingPrefix(path.posix.basename(row.path)) + crypto.randomBytes(16).toString('hex')
    );
    current = checkpointMutation(root, request, consumption, current, at, (next) => {
      next.outputs[index] = {
        ...next.outputs[index],
        state: 'writing',
        pendingPath
      };
    });
    row = current.outputs[index];
    invokeTestHook(hooks, 'afterOutputWritingBeforeEffect', {
      index,
      path: row.path
    });
  }
  if (row.state === 'writing') {
    const pending = resolveRepoPath(root, row.pendingPath);
    const otherPending = pendingOutputFiles(output).filter((file) => file !== pending);
    if (otherPending.length !== 0) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
        'An undeclared pending output file cannot be adopted.'
      );
    }
    if (row.device === null) {
      if (fs.existsSync(pending) || fs.existsSync(output.file)) {
        fail(
          'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
          'Writing state without an inode cannot adopt a pending or final output.'
        );
      }
      let descriptor = null;
      try {
        descriptor = fs.openSync(
          pending,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
          0o644
        );
        if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o644);
        fs.writeFileSync(descriptor, output.bytes);
        fs.fsyncSync(descriptor);
        const identity = fs.fstatSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = null;
        if (!fs.readFileSync(pending).equals(output.bytes)) {
          fail(
            'DEVELOPMENT_EVIDENCE_FINALIZATION_OUTPUT_INVALID',
            'Pending governed output read-back failed.'
          );
        }
        current = checkpointMutation(root, request, consumption, current, at, (next) => {
          next.outputs[index].device = Number(identity.dev);
          next.outputs[index].inode = Number(identity.ino);
        });
        row = current.outputs[index];
      } catch (error) {
        if (descriptor !== null) fs.closeSync(descriptor);
        if (error?.code?.startsWith('DEVELOPMENT_EVIDENCE_')) throw error;
        fail(
          'DEVELOPMENT_EVIDENCE_FINALIZATION_OUTPUT_INVALID',
          'Pending governed output could not be created exactly.',
          error
        );
      }
    }
    const pendingExists = fs.existsSync(pending);
    const finalExists = fs.existsSync(output.file);
    if (pendingExists) {
      assertOwnedFile(pending, output, row.device, row.inode, finalExists ? [2] : [1]);
    }
    if (finalExists) {
      assertOwnedFile(output.file, output, row.device, row.inode, pendingExists ? [2] : [1]);
    }
    if (!pendingExists && !finalExists) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
        'Checkpoint-owned pending and final output paths are both missing.'
      );
    }
    if (pendingExists && !finalExists) {
      try {
        fs.linkSync(pending, output.file);
      } catch (error) {
        fail(
          'DEVELOPMENT_EVIDENCE_FINALIZATION_OUTPUT_INVALID',
          'Checkpoint-owned output could not be linked create-only.',
          error
        );
      }
      assertOwnedFile(pending, output, row.device, row.inode, [2]);
      assertOwnedFile(output.file, output, row.device, row.inode, [2]);
      invokeTestHook(hooks, 'afterOutputEffectBeforeApplied', {
        index,
        path: row.path
      });
    }
    if (fs.existsSync(pending)) {
      assertOwnedFile(pending, output, row.device, row.inode, [2]);
      fs.unlinkSync(pending);
      fsyncDirectory(output.directory);
    }
    const published = assertOwnedFile(output.file, output, row.device, row.inode, [1]);
    current = checkpointMutation(root, request, consumption, current, at, (next) => {
      next.outputs[index] = {
        ...next.outputs[index],
        state: 'applied',
        pendingPath: null,
        device: Number(published.dev),
        inode: Number(published.ino)
      };
    });
    row = current.outputs[index];
  }
  if (row.state === 'applied') {
    if (pendingOutputFiles(output).length !== 0) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
        'Applied output has an undeclared pending file.'
      );
    }
    assertOwnedFile(output.file, output, row.device, row.inode, [1]);
    current = checkpointMutation(root, request, consumption, current, at, (next) => {
      next.outputs[index].state = 'verified';
    });
    row = current.outputs[index];
  }
  if (row.state === 'verified') {
    if (pendingOutputFiles(output).length !== 0) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
        'Verified output has an undeclared pending file.'
      );
    }
    assertOwnedFile(output.file, output, row.device, row.inode, [1]);
  }
  return {
    checkpoint: current,
    created: initialState === 'pending',
    recovered: initialState === 'writing' || initialState === 'applied'
  };
}

function assertRollbackEffectBasis(
  root,
  request,
  consumption,
  checkpoint,
  remount
) {
  const observedBasis = readRollbackFinalizationConsumption(root, request);
  if (!observedBasis.consumption
    || observedBasis.consumption.consumptionFingerprint
      !== consumption.consumptionFingerprint
    || !same(observedBasis.remount, remount)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CHECKPOINT_INVALID',
      'Explicit rollback consumption or remount identity changed before an effect.'
    );
  }
  const observedCheckpoint = readFinalizationCheckpoint(
    root,
    request,
    observedBasis.consumption,
    remount
  );
  if (observedCheckpoint.checkpointFingerprint !== checkpoint.checkpointFingerprint) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CHECKPOINT_INVALID',
      'Explicit rollback checkpoint changed before an effect.'
    );
  }
  assertResumableRollbackDirectoryBasis(root, observedCheckpoint, remount);
}

function rollbackCheckpoint({
  root,
  request,
  consumption,
  checkpoint,
  outputs,
  at,
  terminalState = 'rolled-back',
  hooks = null,
  remount = null
}) {
  if (!['rolled-back', 'superseded'].includes(terminalState)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_ROLLBACK_INVALID',
      'Finalization rollback requires one explicit terminal checkpoint state.'
    );
  }
  let current = checkpoint;
  let beganRollback = false;
  if (['rolling-back', 'needs-attention'].includes(current.state)) {
    if (current.rollback.terminalState !== terminalState) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_ROLLBACK_INVALID',
        'Finalization rollback cannot change its durable terminal intent.'
      );
    }
    if (current.state === 'needs-attention') {
      current = checkpointMutation(root, request, consumption, current, at, (next) => {
        next.state = 'rolling-back';
        next.rollback = { state: 'running', failures: [], terminalState };
      }, remount);
      beganRollback = true;
    }
  } else {
    current = checkpointMutation(root, request, consumption, current, at, (next) => {
      next.state = 'rolling-back';
      next.rollback = { state: 'running', failures: [], terminalState };
    }, remount);
    beganRollback = true;
  }
  if (beganRollback) {
    invokeTestHook(hooks, 'afterRollbackStartedBeforeEffects', {
      requestId: request.id,
      terminalState
    });
  }
  const failures = [];
  for (let index = current.outputs.length - 1; index >= 0; index -= 1) {
    const row = current.outputs[index];
    const output = outputs[index];
    if (row.state === 'pending') continue;
    try {
      if (row.device === null) {
        if (fs.existsSync(output.file)
          || (row.pendingPath && fs.existsSync(resolveRepoPath(root, row.pendingPath)))) {
          throw new Error('Unowned output exists without a checkpoint inode.');
        }
      } else {
        const pending = row.pendingPath ? resolveRepoPath(root, row.pendingPath) : null;
        if (fs.existsSync(output.file)) {
          assertRollbackEffectBasis(
            root,
            request,
            consumption,
            current,
            remount
          );
          assertOwnedFile(
            output.file,
            output,
            row.device,
            row.inode,
            pending && fs.existsSync(pending) ? [2] : [1],
            remount
          );
          fs.unlinkSync(output.file);
          invokeTestHook(hooks, 'afterRollbackOutputEffectBeforeCheckpoint', {
            index,
            path: row.path,
            effect: 'final-output-removed'
          });
        }
        if (pending && fs.existsSync(pending)) {
          assertRollbackEffectBasis(
            root,
            request,
            consumption,
            current,
            remount
          );
          assertOwnedFile(pending, output, row.device, row.inode, [1], remount);
          fs.unlinkSync(pending);
          invokeTestHook(hooks, 'afterRollbackOutputEffectBeforeCheckpoint', {
            index,
            path: row.pendingPath,
            effect: 'pending-output-removed'
          });
        }
        fsyncDirectory(output.directory);
      }
      current = checkpointMutation(root, request, consumption, current, at, (next) => {
        next.outputs[index] = {
          ...next.outputs[index],
          state: 'pending',
          pendingPath: null,
          device: null,
          inode: null
        };
      }, remount);
    } catch (error) {
      if (isSelftestCrash(error)) throw error;
      failures.push(row.path);
    }
  }
  for (let index = current.directories.length - 1; index >= 0; index -= 1) {
    const row = current.directories[index];
    if (row.ownership !== 'checkpoint' || row.state === 'planned') continue;
    const directory = resolveRepoPath(root, row.path);
    try {
      if (row.device === null) {
        if (fs.existsSync(directory)) throw new Error('Unowned directory has no checkpoint inode.');
      } else {
        if (fs.existsSync(directory)) {
          assertRollbackEffectBasis(
            root,
            request,
            consumption,
            current,
            remount
          );
          assertDirectoryIdentity(directory, row, remount);
          if (row.ownershipToken) {
            const marker = checkpointDirectoryMarker(directory, row.ownershipToken);
            if (fs.existsSync(marker)) {
              assertRollbackEffectBasis(
                root,
                request,
                consumption,
                current,
                remount
              );
              assertDirectoryIdentity(directory, row, remount);
              assertCheckpointDirectoryMarker(directory, row.ownershipToken);
              fs.unlinkSync(marker);
            }
          }
          assertRollbackEffectBasis(
            root,
            request,
            consumption,
            current,
            remount
          );
          assertDirectoryIdentity(directory, row, remount);
          fs.rmdirSync(directory);
          invokeTestHook(hooks, 'afterRollbackDirectoryEffectBeforeCheckpoint', {
            index,
            path: row.path
          });
          fsyncDirectory(path.dirname(directory));
        }
      }
      current = checkpointMutation(root, request, consumption, current, at, (next) => {
        next.directories[index] = {
          ...next.directories[index],
          state: 'planned',
          device: null,
          inode: null,
          ownershipToken: null
        };
      }, remount);
    } catch (error) {
      if (isSelftestCrash(error)) throw error;
      failures.push(row.path + '/');
    }
  }
  if (failures.length !== 0) {
    current = checkpointMutation(root, request, consumption, current, at, (next) => {
      next.state = 'needs-attention';
      next.rollback = {
        state: 'needs-attention',
        failures: [...new Set(failures)].sort(compareText),
        terminalState
      };
    }, remount);
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_ROLLBACK_FAILED',
      'Finalization failed and checkpoint-owned effects could not be rolled back exactly.'
    );
  }
  return checkpointMutation(root, request, consumption, current, at, (next) => {
    next.state = terminalState;
    next.rollback = { state: 'completed', failures: [], terminalState };
  }, remount);
}

function pathEntryExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function readSealedRollbackOutput(file, plan, row, allowedLinks, remount = null) {
  let descriptor = null;
  let bytes;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const before = fs.fstatSync(descriptor);
    const realBefore = fs.realpathSync(file);
    if (!before.isFile()
      || !allowedLinks.includes(before.nlink)
      || !deviceMatches(Number(before.dev), row.device, remount)
      || Number(before.ino) !== row.inode
      || realBefore !== file
      || (process.platform !== 'win32' && (before.mode & 0o7777) !== 0o644)) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
        'A rollback output does not match its sealed checkpoint ownership.'
      );
    }
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const realAfter = fs.realpathSync(file);
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.nlink !== after.nlink
      || before.mode !== after.mode
      || realAfter !== realBefore) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
        'A rollback output changed during its exact read.'
      );
    }
  } catch (error) {
    if (error?.code?.startsWith('DEVELOPMENT_EVIDENCE_')) throw error;
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
      'A rollback output could not be read through its exact checkpoint inode.',
      error
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
      'A rollback output is not canonical JSON.',
      error
    );
  }
  if (!bytes.equals(canonicalBytes(value))
    || sha256(bytes) !== plan.contentFingerprint
    || fingerprintJson(value) !== plan.documentFingerprint) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
      'A rollback output no longer matches its sealed request bytes.'
    );
  }
  return { bytes, value };
}

function rollbackOutput(root, plan, observed = null) {
  const file = resolveRepoPath(root, plan.path);
  return {
    relativePath: plan.path,
    file,
    directory: path.dirname(file),
    bytes: observed?.bytes || Buffer.alloc(0),
    value: observed?.value || null,
    kind: plan.kind,
    plan
  };
}

function assertCompletedRollbackDirectoryBasis(root, checkpoint, remount = null) {
  for (const row of checkpoint.directories) {
    const directory = resolveRepoPath(root, row.path);
    if (row.ownership === 'preexisting' || row.state === 'created') {
      assertDirectoryIdentity(directory, row, remount);
    } else {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_ROLLBACK_INVALID',
        'Completed rollback requires every output directory to be checkpoint-complete.'
      );
    }
  }
}

function assertResumableRollbackDirectoryBasis(root, checkpoint, remount = null) {
  for (const row of checkpoint.directories) {
    const directory = resolveRepoPath(root, row.path);
    if (row.ownership === 'preexisting') {
      assertDirectoryIdentity(directory, row, remount);
      continue;
    }
    const exists = pathEntryExists(directory);
    if (row.device === null) {
      if (exists) {
        fail(
          'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
          'Rollback recovery cannot adopt an output directory without checkpoint ownership.'
        );
      }
    } else if (exists) {
      assertDirectoryIdentity(directory, row, remount);
    }
  }
}

function exactCompletedRollbackOutputs(root, request, checkpoint, remount = null) {
  if (checkpoint.state !== 'completed'
    || checkpoint.outputs.some((row) => row.state !== 'verified')) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_ROLLBACK_INVALID',
      'Explicit finalization rollback requires one exact completed checkpoint.'
    );
  }
  assertCompletedRollbackDirectoryBasis(root, checkpoint, remount);
  return request.outputs.map((plan, index) => {
    const file = resolveRepoPath(root, plan.path);
    const output = rollbackOutput(root, plan);
    if (pendingOutputFiles(output).length !== 0) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
        'A completed finalization output has an undeclared pending sibling.'
      );
    }
    const row = checkpoint.outputs[index];
    return rollbackOutput(
      root,
      plan,
      readSealedRollbackOutput(file, plan, row, [1], remount)
    );
  });
}

function resumableRollbackOutputs(root, request, checkpoint, remount = null) {
  assertResumableRollbackDirectoryBasis(root, checkpoint, remount);
  return request.outputs.map((plan, index) => {
    const row = checkpoint.outputs[index];
    const output = rollbackOutput(root, plan);
    const pendingFiles = pendingOutputFiles(output);
    const declaredPending = row.pendingPath
      ? resolveRepoPath(root, row.pendingPath)
      : null;
    if (pendingFiles.some((file) => file !== declaredPending)) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
        'Rollback recovery found an undeclared pending output.'
      );
    }
    const finalExists = pathEntryExists(output.file);
    const pendingExists = declaredPending ? pathEntryExists(declaredPending) : false;
    if (row.state === 'pending' || row.device === null) {
      if (finalExists || pendingExists || pendingFiles.length !== 0) {
        fail(
          'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
          'Rollback recovery cannot adopt an output without checkpoint ownership.'
        );
      }
      return output;
    }
    let observed = null;
    if (finalExists) {
      observed = readSealedRollbackOutput(
        output.file,
        plan,
        row,
        pendingExists ? [2] : [1],
        remount
      );
    }
    if (pendingExists) {
      const pendingObserved = readSealedRollbackOutput(
        declaredPending,
        plan,
        row,
        finalExists ? [2] : [1],
        remount
      );
      if (observed && !observed.bytes.equals(pendingObserved.bytes)) {
        fail(
          'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
          'Rollback recovery output links do not expose the same sealed bytes.'
        );
      }
      observed ||= pendingObserved;
    }
    return rollbackOutput(root, plan, observed);
  });
}

function assertRolledBackFilesystem(root, request, checkpoint, remount = null) {
  for (const plan of request.outputs) {
    const output = rollbackOutput(root, plan);
    if (pathEntryExists(output.file) || pendingOutputFiles(output).length !== 0) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
        'A terminal finalization rollback path has been repopulated.'
      );
    }
  }
  for (const row of checkpoint.directories) {
    const directory = resolveRepoPath(root, row.path);
    if (row.ownership === 'preexisting') {
      assertDirectoryIdentity(directory, row, remount);
    } else if (pathEntryExists(directory)) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT',
        'A terminal checkpoint-owned output directory has been repopulated.'
      );
    }
  }
}

function rollbackCompletedFinalizationAt({ root, request, at, hooks = null }) {
  const observedAt = assertOperationAt(at);
  const rollbackBasis = readRollbackFinalizationConsumption(root, request);
  const consumption = rollbackBasis.consumption;
  const remount = rollbackBasis.remount;
  if (!consumption) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_ROLLBACK_INVALID',
      'Explicit finalization rollback requires one exact consumed request.'
    );
  }
  let checkpoint = readFinalizationCheckpoint(root, request, consumption, remount);
  if (observedAt < Date.parse(checkpoint.observedAt)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_TIME_INVALID',
      'Explicit finalization rollback cannot predate its durable checkpoint.'
    );
  }
  if (checkpoint.state === 'superseded') {
    assertRolledBackFilesystem(root, request, checkpoint, remount);
    return {
      consumption,
      checkpoint,
      removedOutputCount: 0,
      idempotent: true
    };
  }
  if (checkpoint.state === 'rolled-back') {
    assertRolledBackFilesystem(root, request, checkpoint, remount);
    checkpoint = checkpointMutation(root, request, consumption, checkpoint, at, (next) => {
      next.state = 'superseded';
      next.rollback = {
        state: 'completed',
        failures: [],
        terminalState: 'superseded'
      };
    }, remount);
    return {
      consumption,
      checkpoint,
      removedOutputCount: 0,
      idempotent: false
    };
  }
  if (checkpoint.state === 'running') {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_ROLLBACK_INVALID',
      'Explicit finalization rollback cannot interrupt a running publication checkpoint.'
    );
  }
  const terminalState = checkpoint.state === 'completed'
    ? 'superseded'
    : checkpoint.rollback.terminalState;
  const outputs = checkpoint.state === 'completed'
    ? exactCompletedRollbackOutputs(root, request, checkpoint, remount)
    : resumableRollbackOutputs(root, request, checkpoint, remount);
  const removedOutputCount = outputs.filter((output) => {
    const row = checkpoint.outputs.find((candidate) => candidate.path === output.relativePath);
    return pathEntryExists(output.file)
      || (row?.pendingPath && pathEntryExists(resolveRepoPath(root, row.pendingPath)));
  }).length;
  const superseded = rollbackCheckpoint({
    root,
    request,
    consumption,
    checkpoint,
    outputs,
    at,
    terminalState,
    hooks,
    remount
  });
  assertRolledBackFilesystem(root, request, superseded, remount);
  return {
    consumption,
    checkpoint: superseded,
    removedOutputCount,
    idempotent: false
  };
}

function verifyPublishedCandidateOutputs(root, request, candidate) {
  if (request.rootIdentityFingerprint !== rootIdentityFingerprint(root)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_BASIS_INVALID',
      'Finalization output verification is bound to a different repository root.'
    );
  }
  assertCandidateMatchesRequest(request, candidate);
  const consumption = readFinalizationConsumption(root, request);
  const checkpoint = readFinalizationCheckpoint(root, request, consumption);
  if (checkpoint.state !== 'completed'
    || checkpoint.outputs.some((row) => row.state !== 'verified')) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_VERIFY_FAILED',
      'Exact finalization outputs are not completed and verified by their private checkpoint.'
    );
  }
  for (const row of checkpoint.directories) {
    const directory = resolveRepoPath(root, row.path);
    if (row.ownership === 'preexisting' || row.state === 'created') {
      assertDirectoryIdentity(directory, row);
    } else {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_VERIFY_FAILED',
        'Exact finalization output directories are not checkpoint-complete.'
      );
    }
  }
  const outputs = outputInspectionPlan(root, candidate.outputRows);
  for (let index = 0; index < outputs.length; index += 1) {
    const row = checkpoint.outputs[index];
    assertOwnedFile(outputs[index].file, outputs[index], row.device, row.inode, [1]);
    if (pendingOutputFiles(outputs[index]).length !== 0) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_VERIFY_FAILED',
        'One or more exact sealed finalization outputs has an undeclared pending file.'
      );
    }
  }
  return { consumption, outputs };
}

function publishFinalizationCandidateAt({
  root,
  request,
  candidate,
  consumeAt,
  postVerify,
  hooks = null
}) {
  if (request.rootIdentityFingerprint !== rootIdentityFingerprint(root)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_BASIS_INVALID',
      'Finalization publication is bound to a different repository root.'
    );
  }
  assertCandidateMatchesRequest(request, candidate);
  const inspectionOutputs = outputInspectionPlan(root, candidate.outputRows);
  const existingConsumption = readExistingFinalizationConsumption(root, request);
  const preflight = existingConsumption ? [] : inspectionOutputs.map((output) => ({
    ...inspectOutput(output),
    pendingFiles: pendingOutputFiles(output)
  }));
  const directoryPlan = existingConsumption
    ? existingConsumption.directoryPlan
    : requiredDirectoryBasis(root, candidate.outputRows);
  const consumption = consumeFinalizationRequest(
    root,
    request,
    preflight,
    directoryPlan,
    consumeAt
  );
  invokeTestHook(hooks, 'afterConsumptionBeforeCheckpoint', {
    requestId: request.id
  });
  let checkpoint = readOrCreateCheckpoint(
    root,
    request,
    consumption,
    inspectionOutputs,
    consumeAt
  );
  invokeTestHook(hooks, 'afterCheckpointBeforeEffects', {
    requestId: request.id
  });
  if (checkpoint.state === 'needs-attention') {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_ROLLBACK_FAILED',
      'Private finalization checkpoint requires operator attention before recovery.'
    );
  }
  if (checkpoint.state === 'completed') {
    verifyPublishedCandidateOutputs(root, request, candidate);
    return { consumption, created: [], recoveredCount: 0 };
  }
  if (checkpoint.state === 'superseded') {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_SUPERSEDED',
      'This exact finalization request was permanently superseded by checkpoint-bound rollback.'
    );
  }
  if (['rolling-back', 'needs-attention'].includes(checkpoint.state)) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_ROLLBACK_FAILED',
      'Private finalization checkpoint rollback must be completed before publication can continue.'
    );
  }
  if (checkpoint.state === 'rolled-back') {
    checkpoint = checkpointMutation(root, request, consumption, checkpoint, consumeAt, (next) => {
      next.state = 'running';
      next.rollback = { state: 'not-started', failures: [], terminalState: null };
    });
  }
  const created = [];
  let recoveredCount = 0;
  try {
    checkpoint = realizeCheckpointDirectories({
      root,
      request,
      consumption,
      checkpoint,
      at: consumeAt,
      hooks
    });
    for (let index = 0; index < inspectionOutputs.length; index += 1) {
      const published = realizeCheckpointOutput({
        root,
        request,
        consumption,
        checkpoint,
        output: inspectionOutputs[index],
        index,
        at: consumeAt,
        hooks
      });
      checkpoint = published.checkpoint;
      if (published.recovered) recoveredCount += 1;
      if (published.created) created.push(inspectionOutputs[index].relativePath);
    }
    postVerify();
    checkpoint = checkpointMutation(root, request, consumption, checkpoint, consumeAt, (next) => {
      next.state = 'completed';
    });
    verifyPublishedCandidateOutputs(root, request, candidate);
  } catch (error) {
    if (isSelftestCrash(error)) throw error;
    checkpoint = readFinalizationCheckpoint(root, request, consumption);
    try {
      rollbackCheckpoint({
        root,
        request,
        consumption,
        checkpoint,
        outputs: inspectionOutputs,
        at: consumeAt
      });
    } catch (rollbackError) {
      if (rollbackError?.code === 'DEVELOPMENT_EVIDENCE_FINALIZATION_ROLLBACK_FAILED') {
        fail(
          'DEVELOPMENT_EVIDENCE_FINALIZATION_ROLLBACK_FAILED',
          rollbackError.message,
          error
        );
      }
      throw rollbackError;
    }
    throw error;
  }
  return { consumption, created, recoveredCount };
}

export function readDevelopmentHostEvidenceFinalizationRequest({
  root,
  requestPath,
  legacyFinalizationPath,
  at,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length > 0) {
    fail('DEVELOPMENT_EVIDENCE_FINALIZATION_ARGUMENTS_INVALID', 'Finalization request reader received an unknown argument.');
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const legacyRequest = readLegacyFinalizationFixtureRequest(resolvedRoot, legacyFinalizationPath);
  const request = readPrivateCanonicalRequest(resolvedRoot, requestPath);
  const workflowIds = validateRequest(resolvedRoot, request, legacyRequest);
  const consumption = assertRequestApplicableAt(resolvedRoot, request, at);
  const candidate = deriveFinalizationCandidate({
    root: resolvedRoot,
    legacyRequest,
    workflowRows: request.workflows,
    createdAt: request.createdAt
  });
  assertCandidateMatchesRequest(request, candidate);
  return { request, legacyRequest, workflowIds, candidate, consumption };
}

function finalizeDevelopmentHostEvidenceBatchAt({
  root,
  requestPath,
  legacyFinalizationPath,
  at,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length > 0) {
    fail('DEVELOPMENT_EVIDENCE_FINALIZATION_ARGUMENTS_INVALID', 'Finalization transaction received an unknown argument.');
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const { request, legacyRequest, workflowIds, candidate } = readDevelopmentHostEvidenceFinalizationRequest({
    root: resolvedRoot,
    requestPath,
    legacyFinalizationPath,
    at
  });
  const published = publishFinalizationCandidateAt({
    root: resolvedRoot,
    request,
    candidate,
    consumeAt: at,
    postVerify() {
      const postPublicationVerification = verifySoter(resolvedRoot, { includeRuntimeArtifacts: false });
      assertLegacyFinalizationCandidateBasis({
        root: resolvedRoot,
        expectedInventoryFingerprint: legacyRequest.expectedInventoryFingerprint,
        checkerReceipt: legacyRequest.checkerReceipt,
        evidencePaths: legacyRequest.evidencePaths,
        verification: postPublicationVerification
      });
      for (const binding of CONFIGURATIONS) {
        const reproduced = resolveDevelopmentEvidenceFinalizationConfiguration({
          root: resolvedRoot,
          configPath: binding.configPath,
          host: binding.host,
          workflowIds
        });
        if (fingerprintLock(reproduced) !== fingerprintLock(candidate.locks.get(binding.host))) {
          fail(
            'DEVELOPMENT_EVIDENCE_FINALIZATION_POST_VERIFY_FAILED',
            'Exact finalization-basis lock reproduction rejected a published lock.'
          );
        }
      }
    }
  });

  return {
    id: request.id,
    requestFingerprint: request.requestFingerprint,
    createdAt: request.createdAt,
    startedAt: published.consumption.startedAt,
    idempotent: published.created.length === 0,
    recoveredOutputs: published.recoveredCount,
    evidence: candidate.evidence.map((value) => ({ id: value.id, fingerprint: fingerprintJson(value) })),
    locks: CONFIGURATIONS.map((binding) => ({
      host: binding.host,
      fingerprint: fingerprintLock(candidate.locks.get(binding.host))
    })),
    state: 'pending-fixture-finalization',
    authority: 'evidence-publication-only',
    health: {
      valid: 'unknown',
      ready: 'unknown',
      verified: 'unknown',
      healthy: 'unknown'
    }
  };
}

export function finalizeDevelopmentHostEvidenceBatch(options = {}) {
  return finalizeDevelopmentHostEvidenceBatchAt(options);
}

/**
 * Remove only outputs owned by one exact private finalization checkpoint.
 * A completed batch becomes permanently superseded; an already-running
 * recoverable rollback retains its durable ordinary rollback target. This
 * operation never derives or adopts current candidate bytes, and every
 * existing output must still match the sealed request and checkpoint inode.
 * Only a root device-number remount is tolerated when the sealed real path,
 * root inode, and every stronger directory/output identity remain exact.
 */
export function rollbackCompletedDevelopmentHostEvidenceFinalization({
  root,
  requestPath,
  at,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length > 0) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_ARGUMENTS_INVALID',
      'Finalization rollback received an unknown argument.'
    );
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const request = readPrivateCanonicalRequest(resolvedRoot, requestPath);
  const rolledBack = rollbackCompletedFinalizationAt({
    root: resolvedRoot,
    request,
    at
  });
  return {
    id: request.id,
    requestFingerprint: request.requestFingerprint,
    startedAt: rolledBack.consumption.startedAt,
    rolledBackAt: rolledBack.checkpoint.observedAt,
    state: rolledBack.checkpoint.state,
    idempotent: rolledBack.idempotent,
    removedOutputCount: rolledBack.removedOutputCount,
    authority: 'checkpoint-bound-output-rollback-only',
    health: {
      valid: 'unknown',
      ready: 'unknown',
      verified: 'unknown',
      healthy: 'unknown'
    }
  };
}

/**
 * After the separate exact fixture-finalization operation completes, prove the
 * batch through ordinary Kernel verification and ordinary lock reproduction.
 * This operation is read-only and cannot repair, regenerate, or adopt output.
 */
export function verifyDevelopmentHostEvidenceFinalization({
  root,
  requestPath,
  legacyFinalizationPath,
  at,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length > 0) {
    fail('DEVELOPMENT_EVIDENCE_FINALIZATION_ARGUMENTS_INVALID', 'Finalization verifier received an unknown argument.');
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const { request, workflowIds, candidate } = readDevelopmentHostEvidenceFinalizationRequest({
    root: resolvedRoot,
    requestPath,
    legacyFinalizationPath,
    at
  });
  const { consumption } = verifyPublishedCandidateOutputs(resolvedRoot, request, candidate);
  const verification = verifySoter(resolvedRoot);
  if (verification.health.valid !== 'passed' || verification.violations.length !== 0) {
    fail(
      'DEVELOPMENT_EVIDENCE_FINALIZATION_VERIFY_FAILED',
      'Ordinary full Kernel verification rejected the finalized graph.'
    );
  }
  const locks = [];
  for (const binding of CONFIGURATIONS) {
    const file = resolveRepoPath(resolvedRoot, binding.lockPath);
    let lock;
    try {
      lock = readJson(file);
    } catch (error) {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_VERIFY_FAILED',
        'Finalized lock output is unavailable or malformed.',
        error
      );
    }
    const inspected = inspectOutput({
      file,
      directory: path.dirname(file),
      bytes: Buffer.from(JSON.stringify(lock, null, 2) + '\n')
    });
    if (inspected.state !== 'exact') {
      fail('DEVELOPMENT_EVIDENCE_FINALIZATION_VERIFY_FAILED', 'Finalized lock output is not exact.');
    }
    const reproduction = lockMatchesResolution({
      root: resolvedRoot,
      lock,
      configPath: binding.configPath,
      host: binding.host
    });
    if (!reproduction.matches) {
      fail('DEVELOPMENT_EVIDENCE_FINALIZATION_VERIFY_FAILED', 'Ordinary lock reproduction rejected a finalized lock.');
    }
    const sealed = request.configurations.find((row) => row.host === binding.host);
    if (!sealed
      || sealed.lockFingerprint !== fingerprintLock(lock)
      || sealed.graphFingerprint !== lock.graphFingerprint
      || sealed.projectionFingerprint !== fingerprintJson(lock.projections)) {
      fail('DEVELOPMENT_EVIDENCE_FINALIZATION_VERIFY_FAILED', 'Finalized lock differs from the exact sealed request.');
    }
    locks.push({ host: binding.host, fingerprint: fingerprintLock(lock) });
  }
  const expectedEvidence = candidate.evidence;
  const expectedEvidenceIds = expectedEvidence.map((value) => value.id).sort(compareText);
  const observedEvidenceIds = [];
  for (const value of expectedEvidence) {
    const file = resolveRepoPath(resolvedRoot, `soter/evidence/development/${value.id}.json`);
    const inspected = inspectOutput({
      file,
      directory: path.dirname(file),
      bytes: Buffer.from(JSON.stringify(value, null, 2) + '\n')
    });
    if (inspected.state !== 'exact') {
      fail(
        'DEVELOPMENT_EVIDENCE_FINALIZATION_VERIFY_FAILED',
        'Finalized evidence output is missing, unsafe, or no longer bound to its exact private runner receipt.'
      );
    }
    observedEvidenceIds.push(value.id);
  }
  observedEvidenceIds.sort(compareText);
  if (!same(expectedEvidenceIds, observedEvidenceIds) || workflowIds.length !== 7) {
    fail('DEVELOPMENT_EVIDENCE_FINALIZATION_VERIFY_FAILED', 'Finalized workflow evidence set is incomplete.');
  }
  return {
    id: request.id,
    requestFingerprint: request.requestFingerprint,
    startedAt: consumption.startedAt,
    state: 'verified-finalized-graph',
    evidenceIds: observedEvidenceIds,
    locks,
    authority: 'verification-only',
    health: {
      valid: 'passed',
      ready: 'unknown',
      verified: 'unknown',
      healthy: 'unknown'
    }
  };
}

export const developmentHostEvidenceFinalizationContract = Object.freeze({
  id: CONTRACT,
  configurations: CONFIGURATIONS,
  consumptionContract: CONSUMPTION_CONTRACT,
  checkpointContract: CHECKPOINT_CONTRACT,
  requestMaxTtlMs: REQUEST_MAX_TTL_MS,
  outputCount: 16
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

export function selftestDevelopmentHostEvidenceFinalizationPublication() {
  const temp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'soter-final-evidence-publication-'))
  );
  const root = path.join(temp, 'root');
  try {
    fs.mkdirSync(root, { mode: 0o755 });
    const developmentChainRequest = {
      workspace: {
        rootIdentityFingerprint: developmentChainRootIdentityFingerprint(root)
      }
    };
    const otherDevelopmentRoot = path.join(temp, 'other-development-root');
    fs.mkdirSync(otherDevelopmentRoot, { mode: 0o755 });
    if (!developmentChainBindsRoot(root, developmentChainRequest)
      || developmentChainRequest.workspace.rootIdentityFingerprint
        !== fingerprintJson({ root: fs.realpathSync(root) })
      || developmentChainBindsRoot(otherDevelopmentRoot, developmentChainRequest)
      || developmentChainBindsRoot(root, {
        workspace: { rootIdentityFingerprint: rootIdentityFingerprint(root) }
      })) {
      throw new Error(
        'Private development-chain root identity was confused with finalization transaction identity.'
      );
    }
    const privateRequest = path.join(temp, 'request.json');
    const privateValue = { scope: 'private-selftest' };
    fs.writeFileSync(privateRequest, JSON.stringify(privateValue, null, 2) + '\n', { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(privateRequest, 0o600);
    if (!same(readPrivateCanonicalRequest(root, privateRequest), privateValue)) {
      throw new Error('Private finalization request canonical read failed.');
    }
    fs.appendFileSync(privateRequest, '\n');
    expectCode(
      () => readPrivateCanonicalRequest(root, privateRequest),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_INVALID'
    );
    fs.writeFileSync(privateRequest, JSON.stringify(privateValue, null, 2) + '\n');
    if (process.platform !== 'win32') {
      fs.chmodSync(privateRequest, 0o644);
      expectCode(
        () => readPrivateCanonicalRequest(root, privateRequest),
        'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_PATH_INVALID'
      );
      fs.chmodSync(privateRequest, 0o600);
    }
    const linkedRequest = path.join(temp, 'linked-request.json');
    fs.linkSync(privateRequest, linkedRequest);
    expectCode(
      () => readPrivateCanonicalRequest(root, privateRequest),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_PATH_INVALID'
    );
    fs.rmSync(linkedRequest);
    const realRequestParent = path.join(temp, 'real-request-parent');
    const linkedRequestParent = path.join(temp, 'linked-request-parent');
    fs.mkdirSync(realRequestParent);
    const parentRequest = path.join(realRequestParent, 'request.json');
    fs.writeFileSync(parentRequest, JSON.stringify(privateValue, null, 2) + '\n', {
      mode: 0o600
    });
    if (process.platform !== 'win32') fs.chmodSync(parentRequest, 0o600);
    fs.symlinkSync(realRequestParent, linkedRequestParent, 'dir');
    expectCode(
      () => readPrivateCanonicalRequest(
        root,
        path.join(linkedRequestParent, 'request.json')
      ),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_PATH_INVALID'
    );
    fs.unlinkSync(linkedRequestParent);

    const synthetic = (name, {
      createdAt = '2026-07-22T12:00:00.000Z',
      validUntil = '2026-07-22T12:10:00.000Z'
    } = {}) => {
      const transactionRoot = path.join(temp, name);
      fs.mkdirSync(path.join(transactionRoot, 'soter/automations'), {
        recursive: true,
        mode: 0o755
      });
      const workflowRows = [];
      for (let index = 0; index < 7; index += 1) {
        const slug = 'workflow-' + String(index + 1);
        const id = 'automation.' + slug;
        const directory = path.join(transactionRoot, 'soter/automations', slug);
        fs.mkdirSync(directory, { mode: 0o755 });
        fs.writeFileSync(path.join(directory, 'definition.json'), JSON.stringify({
          $contract: 'soter://contracts/workflow-definition/v2',
          id,
          lifecycle: { state: 'active-host-guided', activation: { state: 'active' } }
        }, null, 2) + '\n');
        const basis = Object.fromEntries([
          'definitionFingerprint',
          'guideFingerprint',
          'guideContentFingerprint',
          'evaluationSetFingerprint',
          'evaluatedSubjectFingerprint'
        ].map((key) => [key, fingerprintJson({ id, key })]));
        const receipts = Object.fromEntries(['codex', 'claude'].map((host) => {
          const requestId = `development-request.${host}.${slug}`;
          return [host, {
            requestId,
            requestFingerprint: fingerprintJson({ requestId }),
            resultFingerprint: fingerprintJson({ requestId, kind: 'result' }),
            observationFingerprint: fingerprintJson({ requestId, kind: 'observation' }),
            finalizationFingerprint: fingerprintJson({ requestId, kind: 'finalization' }),
            finalizedAt: '2026-07-22T11:59:00.000Z',
            historicalEvidencePath: `soter/evidence/development/development-agent-migration-evidence.${host}.${slug}.json`,
            historicalEvidenceFingerprint: fingerprintJson({ requestId, kind: 'historical' })
          }];
        }));
        workflowRows.push({ id, basis, receipts });
      }
      const syntheticLocks = new Map(CONFIGURATIONS.map((binding) => [binding.host, {
        host: { id: binding.host },
        configuration: { path: binding.configPath },
        graphFingerprint: fingerprintJson({ host: binding.host, kind: 'graph' }),
        projections: [{ host: binding.host, state: 'synthetic' }]
      }]));
      const syntheticEvidence = workflowRows.flatMap((workflow) => {
        const slug = workflow.id.slice('automation.'.length);
        return ['codex', 'claude'].map((host) => ({
          id: `evidence.development-activation.${host}.${slug}`,
          state: 'synthetic-full-batch'
        }));
      });
      const outputRows = candidateOutputRows(syntheticEvidence, syntheticLocks);
      const configurations = CONFIGURATIONS.map((binding) => {
        const lock = syntheticLocks.get(binding.host);
        return {
          host: binding.host,
          configPath: binding.configPath,
          lockPath: binding.lockPath,
          lockFingerprint: fingerprintLock(lock),
          graphFingerprint: lock.graphFingerprint,
          projectionFingerprint: fingerprintJson(lock.projections)
        };
      });
      const candidate = {
        workflowIds: workflowRows.map((row) => row.id),
        locks: syntheticLocks,
        evidence: syntheticEvidence,
        configurations,
        workflows: workflowRows,
        outputRows,
        outputs: outputRows.map((row) => row.plan)
      };
      const legacyRequest = {
        expectedInventoryFingerprint: fingerprintJson({ name, kind: 'inventory' }),
        checkerReceipt: {
          id: 'legacy-checker-run.' + 'a'.repeat(64),
          receiptFingerprint: fingerprintJson({ name, kind: 'checker' })
        },
        evidencePaths: syntheticEvidence.map((value) => {
          return `soter/evidence/development/${value.id}.json`;
        }),
        obsoleteFixturePaths: ['soter/fixtures/obsolete/selftest.json']
      };
      const request = {
        $contract: CONTRACT,
        contractVersion: '1.0.0',
        id: 'development-host-evidence-finalization-batch.' + name,
        requestFingerprint: 'sha256:' + '0'.repeat(64),
        createdAt,
        validUntil,
        rootIdentityFingerprint: rootIdentityFingerprint(transactionRoot),
        basis: {
          legacyFinalizationRequestFingerprint: fingerprintJson(legacyRequest),
          inventoryFingerprint: legacyRequest.expectedInventoryFingerprint,
          checkerReceipt: structuredClone(legacyRequest.checkerReceipt)
        },
        configurations,
        workflows: workflowRows,
        outputs: candidate.outputs
      };
      request.requestFingerprint = requestFingerprint(request);
      return { root: transactionRoot, request, candidate, legacyRequest };
    };

    const full = synthetic('full-batch');
    validateRequest(full.root, full.request, full.legacyRequest);
    const fullPublication = publishFinalizationCandidateAt({
      root: full.root,
      request: full.request,
      candidate: full.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    if (fullPublication.created.length !== 16
      || verifyPublishedCandidateOutputs(full.root, full.request, full.candidate).outputs.length !== 16) {
      throw new Error('Synthetic exact full batch and verifier did not cover all sixteen outputs.');
    }
    const fullCheckpointFile = checkpointFile(full.root, full.request);
    if (process.platform !== 'win32'
      && ((fs.lstatSync(fullCheckpointFile).mode & 0o7777) !== 0o600
        || (fs.lstatSync(path.dirname(fullCheckpointFile)).mode & 0o7777) !== 0o700)) {
      throw new Error('Private finalization checkpoint boundary is not exact 0700/0600 state.');
    }
    if (JSON.stringify(fullPublication).includes('.soter')
      || Object.hasOwn(fullPublication, 'checkpoint')) {
      throw new Error('Private finalization checkpoint leaked through the publication result.');
    }
    const fullReentry = publishFinalizationCandidateAt({
      root: full.root,
      request: full.request,
      candidate: full.candidate,
      consumeAt: '2027-07-22T12:01:00.000Z',
      postVerify() {}
    });
    if (fullReentry.created.length !== 0
      || fullReentry.consumption.startedAt !== '2026-07-22T12:01:00.000Z') {
      throw new Error('Consumed exact full batch was not idempotently recoverable after request expiry.');
    }
    const observedConsumed = assertRequestApplicableAt(
      full.root,
      full.request,
      '2027-07-22T12:01:00.000Z'
    );
    if (observedConsumed?.startedAt !== '2026-07-22T12:01:00.000Z') {
      throw new Error('Read-time expiry handling did not retain exact consumed recovery authority.');
    }
    expectCode(
      () => publishFinalizationCandidateAt({
        root: full.root,
        request: full.request,
        candidate: full.candidate,
        consumeAt: 'not-a-canonical-instant',
        postVerify() {}
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_AT_INVALID'
    );
    expectCode(
      () => publishFinalizationCandidateAt({
        root: full.root,
        request: full.request,
        candidate: full.candidate,
        consumeAt: '2026-07-22T12:00:30.000Z',
        postVerify() {}
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_TIME_INVALID'
    );

    const substitutedReceipt = {
      ...full.candidate,
      workflows: structuredClone(full.candidate.workflows)
    };
    substitutedReceipt.workflows[0].receipts.codex.observationFingerprint = fingerprintJson({
      substituted: 'observation'
    });
    expectCode(
      () => publishFinalizationCandidateAt({
        root: full.root,
        request: full.request,
        candidate: substitutedReceipt,
        consumeAt: '2026-07-22T12:02:00.000Z',
        postVerify() {}
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CANDIDATE_MISMATCH'
    );
    const substitutedLock = {
      ...full.candidate,
      configurations: structuredClone(full.candidate.configurations)
    };
    substitutedLock.configurations[0].lockFingerprint = fingerprintJson({ substituted: 'lock' });
    expectCode(
      () => assertCandidateMatchesRequest(full.request, substitutedLock),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CANDIDATE_MISMATCH'
    );
    const substitutedOutput = {
      ...full.candidate,
      outputs: structuredClone(full.candidate.outputs)
    };
    substitutedOutput.outputs[0].contentFingerprint = fingerprintJson({ substituted: 'bytes' });
    expectCode(
      () => assertCandidateMatchesRequest(full.request, substitutedOutput),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CANDIDATE_MISMATCH'
    );

    const wrongRoot = synthetic('wrong-root');
    expectCode(
      () => publishFinalizationCandidateAt({
        root: wrongRoot.root,
        request: full.request,
        candidate: full.candidate,
        consumeAt: '2026-07-22T12:02:00.000Z',
        postVerify() {}
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_BASIS_INVALID'
    );
    const replacedRoot = synthetic('replaced-root');
    const heldRoot = replacedRoot.root + '-held';
    fs.renameSync(replacedRoot.root, heldRoot);
    fs.mkdirSync(replacedRoot.root, { mode: 0o755 });
    expectCode(
      () => publishFinalizationCandidateAt({
        root: replacedRoot.root,
        request: replacedRoot.request,
        candidate: replacedRoot.candidate,
        consumeAt: '2026-07-22T12:02:00.000Z',
        postVerify() {}
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_BASIS_INVALID'
    );
    expectCode(
      () => assertInstant('0', 'Hostile instant'),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_INVALID'
    );
    const expired = synthetic('expired');
    if (assertRequestApplicableAt(
      expired.root,
      expired.request,
      '2026-07-22T12:01:00.000Z'
    ) !== null) {
      throw new Error('Unconsumed current finalization request unexpectedly had recovery authority.');
    }
    expectCode(
      () => assertRequestApplicableAt(
        expired.root,
        expired.request,
        '2026-07-22T12:10:00.000Z'
      ),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_EXPIRED'
    );
    expectCode(
      () => publishFinalizationCandidateAt({
        root: expired.root,
        request: expired.request,
        candidate: expired.candidate,
        consumeAt: '2026-07-22T12:10:00.000Z',
        postVerify() {}
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_EXPIRED'
    );

    const crash = () => fail(SELFTEST_CRASH, 'Planted process interruption.');
    const prepareOutputDirectories = (transaction) => {
      for (const relativePath of requiredDirectoryPaths(transaction.candidate.outputRows)) {
        const directory = resolveRepoPath(transaction.root, relativePath);
        fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
        if (process.platform !== 'win32') fs.chmodSync(directory, 0o755);
      }
      return outputInspectionPlan(transaction.root, transaction.candidate.outputRows);
    };
    const sealSyntheticRemount = (transaction, {
      rootRealPath = null,
      rootInode = null,
      consumptionDirectoryDeviceMismatch = false,
      checkpointOutputDeviceMismatch = false
    } = {}) => {
      const current = rootIdentity(transaction.root);
      const sealedDevice = current.device === Number.MAX_SAFE_INTEGER
        ? current.device - 1
        : current.device + 1;
      transaction.request.rootIdentityFingerprint = fingerprintJson({
        realPath: rootRealPath || current.realPath,
        device: sealedDevice,
        inode: rootInode ?? current.inode
      });
      transaction.request.requestFingerprint = requestFingerprint(transaction.request);

      const consumptionPath = resolveRepoPath(
        transaction.root,
        `.soter/state/development-host-evidence-finalizations/${transaction.request.id}.json`
      );
      const consumption = readJson(consumptionPath);
      consumption.request.fingerprint = transaction.request.requestFingerprint;
      consumption.rootIdentityFingerprint = transaction.request.rootIdentityFingerprint;
      for (const row of consumption.directoryPlan) {
        if (row.device !== null) row.device = sealedDevice;
      }
      if (consumptionDirectoryDeviceMismatch) {
        const mismatch = consumption.directoryPlan.find((row) => row.device !== null);
        mismatch.device = current.device;
      }
      consumption.checkpointPlanFingerprint = checkpointPlanFingerprint(
        transaction.request,
        consumption.directoryPlan
      );
      consumption.consumptionFingerprint = consumptionFingerprint(consumption);
      fs.writeFileSync(consumptionPath, canonicalBytes(consumption), { mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(consumptionPath, 0o600);

      const checkpointPath = checkpointFile(transaction.root, transaction.request);
      const checkpoint = readJson(checkpointPath);
      checkpoint.request.fingerprint = transaction.request.requestFingerprint;
      checkpoint.consumption.fingerprint = consumption.consumptionFingerprint;
      checkpoint.rootIdentityFingerprint = transaction.request.rootIdentityFingerprint;
      checkpoint.planFingerprint = consumption.checkpointPlanFingerprint;
      for (const row of checkpoint.directories) {
        if (row.device === null) continue;
        const basis = consumption.directoryPlan.find((item) => item.path === row.path);
        row.device = row.ownership === 'preexisting'
          ? basis.device
          : sealedDevice;
      }
      for (const row of checkpoint.outputs) {
        if (row.device !== null) row.device = sealedDevice;
      }
      if (checkpointOutputDeviceMismatch) {
        const mismatch = checkpoint.outputs.find((row) => row.device !== null);
        mismatch.device = current.device;
      }
      checkpoint.checkpointFingerprint = checkpointFingerprint(checkpoint);
      fs.writeFileSync(checkpointPath, canonicalBytes(checkpoint), { mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(checkpointPath, 0o600);

      const requestPath = path.join(
        temp,
        transaction.request.id + '.remount-request.json'
      );
      fs.writeFileSync(requestPath, canonicalBytes(transaction.request), { mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(requestPath, 0o600);
      return { current, sealedDevice, requestPath };
    };
    const rollbackMutationSnapshot = (transaction) => ({
      checkpointBytesFingerprint: sha256(fs.readFileSync(
        checkpointFile(transaction.root, transaction.request)
      )),
      outputs: transaction.request.outputs.map((row) => {
        const file = resolveRepoPath(transaction.root, row.path);
        const stat = fs.lstatSync(file);
        return {
          path: row.path,
          device: Number(stat.dev),
          inode: Number(stat.ino),
          mode: stat.mode & 0o7777,
          nlink: stat.nlink,
          contentFingerprint: sha256(fs.readFileSync(file))
        };
      })
    });
    const assertRollbackMutationSnapshot = (transaction, expected, label) => {
      const observed = rollbackMutationSnapshot(transaction);
      if (!same(observed, expected)) {
        throw new Error(label + ' changed rollback-owned state before failing closed.');
      }
    };

    const afterConsumption = synthetic('crash-after-consumption');
    expectCode(
      () => publishFinalizationCandidateAt({
        root: afterConsumption.root,
        request: afterConsumption.request,
        candidate: afterConsumption.candidate,
        consumeAt: '2026-07-22T12:01:00.000Z',
        postVerify() {},
        hooks: { afterConsumptionBeforeCheckpoint: crash }
      }),
      SELFTEST_CRASH
    );
    if (!fs.existsSync(resolveRepoPath(
      afterConsumption.root,
      `.soter/state/development-host-evidence-finalizations/${afterConsumption.request.id}.json`
    )) || fs.existsSync(checkpointFile(afterConsumption.root, afterConsumption.request))) {
      throw new Error('Crash-after-consumption did not preserve only exact single-use consumption.');
    }
    const afterConsumptionRecovery = publishFinalizationCandidateAt({
      root: afterConsumption.root,
      request: afterConsumption.request,
      candidate: afterConsumption.candidate,
      consumeAt: '2027-07-22T12:01:00.000Z',
      postVerify() {}
    });
    if (afterConsumptionRecovery.created.length !== 16) {
      throw new Error('Crash-after-consumption did not recover through a fresh exact checkpoint.');
    }

    const externalExact = synthetic('external-exact-after-consumption');
    const externalExactOutputs = prepareOutputDirectories(externalExact);
    expectCode(
      () => publishFinalizationCandidateAt({
        root: externalExact.root,
        request: externalExact.request,
        candidate: externalExact.candidate,
        consumeAt: '2026-07-22T12:01:00.000Z',
        postVerify() {},
        hooks: { afterConsumptionBeforeCheckpoint: crash }
      }),
      SELFTEST_CRASH
    );
    fs.writeFileSync(externalExactOutputs[0].file, externalExactOutputs[0].bytes, { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(externalExactOutputs[0].file, 0o644);
    expectCode(
      () => publishFinalizationCandidateAt({
        root: externalExact.root,
        request: externalExact.request,
        candidate: externalExact.candidate,
        consumeAt: '2027-07-22T12:01:00.000Z',
        postVerify() {}
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT'
    );

    const externalPending = synthetic('external-pending-after-consumption');
    const externalPendingOutputs = prepareOutputDirectories(externalPending);
    expectCode(
      () => publishFinalizationCandidateAt({
        root: externalPending.root,
        request: externalPending.request,
        candidate: externalPending.candidate,
        consumeAt: '2026-07-22T12:01:00.000Z',
        postVerify() {},
        hooks: { afterConsumptionBeforeCheckpoint: crash }
      }),
      SELFTEST_CRASH
    );
    const unownedPending = path.join(
      externalPendingOutputs[0].directory,
      pendingPrefix(externalPendingOutputs[0].file) + 'external'
    );
    fs.writeFileSync(unownedPending, externalPendingOutputs[0].bytes, { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(unownedPending, 0o644);
    expectCode(
      () => publishFinalizationCandidateAt({
        root: externalPending.root,
        request: externalPending.request,
        candidate: externalPending.candidate,
        consumeAt: '2027-07-22T12:01:00.000Z',
        postVerify() {}
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT'
    );

    const externalPair = synthetic('external-link-pair-after-consumption');
    const externalPairOutputs = prepareOutputDirectories(externalPair);
    expectCode(
      () => publishFinalizationCandidateAt({
        root: externalPair.root,
        request: externalPair.request,
        candidate: externalPair.candidate,
        consumeAt: '2026-07-22T12:01:00.000Z',
        postVerify() {},
        hooks: { afterConsumptionBeforeCheckpoint: crash }
      }),
      SELFTEST_CRASH
    );
    const pairPending = path.join(
      externalPairOutputs[0].directory,
      pendingPrefix(externalPairOutputs[0].file) + 'external-pair'
    );
    fs.writeFileSync(pairPending, externalPairOutputs[0].bytes, { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(pairPending, 0o644);
    fs.linkSync(pairPending, externalPairOutputs[0].file);
    expectCode(
      () => publishFinalizationCandidateAt({
        root: externalPair.root,
        request: externalPair.request,
        candidate: externalPair.candidate,
        consumeAt: '2027-07-22T12:01:00.000Z',
        postVerify() {}
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT'
    );

    const directoryAdoption = synthetic('directory-adoption');
    expectCode(
      () => publishFinalizationCandidateAt({
        root: directoryAdoption.root,
        request: directoryAdoption.request,
        candidate: directoryAdoption.candidate,
        consumeAt: '2026-07-22T12:01:00.000Z',
        postVerify() {},
        hooks: { afterConsumptionBeforeCheckpoint: crash }
      }),
      SELFTEST_CRASH
    );
    const plannedDirectory = readFinalizationConsumption(
      directoryAdoption.root,
      directoryAdoption.request
    ).directoryPlan.find((row) => row.ownership === 'checkpoint');
    fs.mkdirSync(resolveRepoPath(directoryAdoption.root, plannedDirectory.path), {
      recursive: true,
      mode: 0o755
    });
    expectCode(
      () => publishFinalizationCandidateAt({
        root: directoryAdoption.root,
        request: directoryAdoption.request,
        candidate: directoryAdoption.candidate,
        consumeAt: '2027-07-22T12:01:00.000Z',
        postVerify() {}
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT'
    );

    const writingCrash = synthetic('crash-after-writing');
    let writingHookCalls = 0;
    expectCode(
      () => publishFinalizationCandidateAt({
        root: writingCrash.root,
        request: writingCrash.request,
        candidate: writingCrash.candidate,
        consumeAt: '2026-07-22T12:01:00.000Z',
        postVerify() {},
        hooks: {
          afterOutputWritingBeforeEffect() {
            if (writingHookCalls++ === 0) crash();
          }
        }
      }),
      SELFTEST_CRASH
    );
    const writingRecovery = publishFinalizationCandidateAt({
      root: writingCrash.root,
      request: writingCrash.request,
      candidate: writingCrash.candidate,
      consumeAt: '2027-07-22T12:01:00.000Z',
      postVerify() {}
    });
    if (writingRecovery.recoveredCount !== 1) {
      throw new Error('Writing-before-effect checkpoint did not recover exactly once.');
    }

    const effectCrash = synthetic('crash-after-effect');
    let effectHookCalls = 0;
    expectCode(
      () => publishFinalizationCandidateAt({
        root: effectCrash.root,
        request: effectCrash.request,
        candidate: effectCrash.candidate,
        consumeAt: '2026-07-22T12:01:00.000Z',
        postVerify() {},
        hooks: {
          afterOutputEffectBeforeApplied() {
            if (effectHookCalls++ === 0) crash();
          }
        }
      }),
      SELFTEST_CRASH
    );
    const effectRecovery = publishFinalizationCandidateAt({
      root: effectCrash.root,
      request: effectCrash.request,
      candidate: effectCrash.candidate,
      consumeAt: '2027-07-22T12:01:00.000Z',
      postVerify() {}
    });
    if (effectRecovery.recoveredCount !== 1
      || verifyPublishedCandidateOutputs(
        effectCrash.root,
        effectCrash.request,
        effectCrash.candidate
      ).outputs.length !== 16) {
      throw new Error('Effect-before-applied checkpoint did not reconcile exact bytes and inode.');
    }

    const verifySubstitution = synthetic('verify-substitution');
    publishFinalizationCandidateAt({
      root: verifySubstitution.root,
      request: verifySubstitution.request,
      candidate: verifySubstitution.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const verifyOutputs = outputInspectionPlan(
      verifySubstitution.root,
      verifySubstitution.candidate.outputRows
    );
    fs.unlinkSync(verifyOutputs[0].file);
    fs.writeFileSync(verifyOutputs[0].file, verifyOutputs[0].bytes, { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(verifyOutputs[0].file, 0o644);
    expectCode(
      () => verifyPublishedCandidateOutputs(
        verifySubstitution.root,
        verifySubstitution.request,
        verifySubstitution.candidate
      ),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT'
    );

    const rollback = synthetic('rollback-retry');
    expectCode(
      () => publishFinalizationCandidateAt({
        root: rollback.root,
        request: rollback.request,
        candidate: rollback.candidate,
        consumeAt: '2026-07-22T12:01:00.000Z',
        postVerify() {
          fail('DEVELOPMENT_EVIDENCE_FINALIZATION_POST_VERIFY_FAILED', 'Planted post-verify failure.');
        }
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_POST_VERIFY_FAILED'
    );
    if (outputInspectionPlan(rollback.root, rollback.candidate.outputRows)
      .some((output) => fs.existsSync(output.file))) {
      throw new Error('Failed full batch did not roll back every output created by the call.');
    }
    const rollbackRecovery = publishFinalizationCandidateAt({
      root: rollback.root,
      request: rollback.request,
      candidate: rollback.candidate,
      consumeAt: '2027-07-22T12:01:00.000Z',
      postVerify() {}
    });
    if (rollbackRecovery.created.length !== 16) {
      throw new Error('Consumed failed batch could not recover the exact original output plan.');
    }

    const explicitRollback = synthetic('explicit-rollback');
    publishFinalizationCandidateAt({
      root: explicitRollback.root,
      request: explicitRollback.request,
      candidate: explicitRollback.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const explicitRollbackResult = rollbackCompletedFinalizationAt({
      root: explicitRollback.root,
      request: explicitRollback.request,
      at: '2026-07-22T12:02:00.000Z'
    });
    if (explicitRollbackResult.checkpoint.state !== 'superseded'
      || explicitRollbackResult.removedOutputCount !== 16
      || explicitRollbackResult.idempotent
      || outputInspectionPlan(explicitRollback.root, explicitRollback.candidate.outputRows)
        .some((output) => fs.existsSync(output.file))) {
      throw new Error('Explicit completed-batch rollback did not remove the exact output set.');
    }
    const explicitRollbackReentry = rollbackCompletedFinalizationAt({
      root: explicitRollback.root,
      request: explicitRollback.request,
      at: '2026-07-22T12:03:00.000Z'
    });
    if (!explicitRollbackReentry.idempotent
      || explicitRollbackReentry.removedOutputCount !== 0
      || explicitRollbackReentry.checkpoint.state !== 'superseded') {
      throw new Error('Explicit completed-batch rollback was not idempotent.');
    }
    expectCode(
      () => publishFinalizationCandidateAt({
        root: explicitRollback.root,
        request: explicitRollback.request,
        candidate: explicitRollback.candidate,
        consumeAt: '2027-07-22T12:04:00.000Z',
        postVerify() {}
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_SUPERSEDED'
    );

    const legacyCheckpointRollback = synthetic('legacy-checkpoint-rollback');
    publishFinalizationCandidateAt({
      root: legacyCheckpointRollback.root,
      request: legacyCheckpointRollback.request,
      candidate: legacyCheckpointRollback.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const legacyCheckpointPath = checkpointFile(
      legacyCheckpointRollback.root,
      legacyCheckpointRollback.request
    );
    const legacyCheckpointValue = readJson(legacyCheckpointPath);
    delete legacyCheckpointValue.rollback.terminalState;
    legacyCheckpointValue.checkpointFingerprint = checkpointFingerprint(legacyCheckpointValue);
    fs.writeFileSync(legacyCheckpointPath, canonicalBytes(legacyCheckpointValue), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(legacyCheckpointPath, 0o600);
    const legacyCheckpointResult = rollbackCompletedFinalizationAt({
      root: legacyCheckpointRollback.root,
      request: legacyCheckpointRollback.request,
      at: '2026-07-22T12:02:00.000Z'
    });
    if (legacyCheckpointResult.checkpoint.state !== 'superseded'
      || legacyCheckpointResult.removedOutputCount !== 16) {
      throw new Error('Legacy completed checkpoint could not be safely superseded.');
    }

    const explicitRollbackTime = synthetic('explicit-rollback-time');
    publishFinalizationCandidateAt({
      root: explicitRollbackTime.root,
      request: explicitRollbackTime.request,
      candidate: explicitRollbackTime.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    expectCode(
      () => rollbackCompletedFinalizationAt({
        root: explicitRollbackTime.root,
        request: explicitRollbackTime.request,
        at: '2026-07-22T12:00:59.999Z'
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_TIME_INVALID'
    );
    if (!outputInspectionPlan(
      explicitRollbackTime.root,
      explicitRollbackTime.candidate.outputRows
    ).every((output) => pathEntryExists(output.file))) {
      throw new Error('Time-reversed explicit rollback changed an output.');
    }

    const rollbackStartCrash = synthetic('explicit-rollback-start-crash');
    publishFinalizationCandidateAt({
      root: rollbackStartCrash.root,
      request: rollbackStartCrash.request,
      candidate: rollbackStartCrash.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    expectCode(
      () => rollbackCompletedFinalizationAt({
        root: rollbackStartCrash.root,
        request: rollbackStartCrash.request,
        at: '2026-07-22T12:02:00.000Z',
        hooks: { afterRollbackStartedBeforeEffects: crash }
      }),
      SELFTEST_CRASH
    );
    const rollbackStartConsumption = readFinalizationConsumption(
      rollbackStartCrash.root,
      rollbackStartCrash.request
    );
    const rollbackStartCheckpoint = readFinalizationCheckpoint(
      rollbackStartCrash.root,
      rollbackStartCrash.request,
      rollbackStartConsumption
    );
    if (rollbackStartCheckpoint.state !== 'rolling-back'
      || rollbackStartCheckpoint.rollback.terminalState !== 'superseded') {
      throw new Error('Explicit rollback did not durably persist supersession before effects.');
    }
    const rollbackStartRecovery = rollbackCompletedFinalizationAt({
      root: rollbackStartCrash.root,
      request: rollbackStartCrash.request,
      at: '2026-07-22T12:03:00.000Z'
    });
    if (rollbackStartRecovery.checkpoint.state !== 'superseded') {
      throw new Error('Explicit rollback did not resume after its durable start marker.');
    }

    const rollbackOutputCrash = synthetic('explicit-rollback-output-crash');
    publishFinalizationCandidateAt({
      root: rollbackOutputCrash.root,
      request: rollbackOutputCrash.request,
      candidate: rollbackOutputCrash.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    let rollbackOutputCrashCalls = 0;
    expectCode(
      () => rollbackCompletedFinalizationAt({
        root: rollbackOutputCrash.root,
        request: rollbackOutputCrash.request,
        at: '2026-07-22T12:02:00.000Z',
        hooks: {
          afterRollbackOutputEffectBeforeCheckpoint() {
            if (rollbackOutputCrashCalls++ === 0) crash();
          }
        }
      }),
      SELFTEST_CRASH
    );
    const outputCrashRecovery = rollbackCompletedFinalizationAt({
      root: rollbackOutputCrash.root,
      request: rollbackOutputCrash.request,
      at: '2026-07-22T12:03:00.000Z'
    });
    if (outputCrashRecovery.checkpoint.state !== 'superseded') {
      throw new Error('Explicit rollback did not reconcile an unlink-before-checkpoint crash.');
    }

    const rollbackDirectoryCrash = synthetic('explicit-rollback-directory-crash');
    publishFinalizationCandidateAt({
      root: rollbackDirectoryCrash.root,
      request: rollbackDirectoryCrash.request,
      candidate: rollbackDirectoryCrash.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    let rollbackDirectoryCrashCalls = 0;
    expectCode(
      () => rollbackCompletedFinalizationAt({
        root: rollbackDirectoryCrash.root,
        request: rollbackDirectoryCrash.request,
        at: '2026-07-22T12:02:00.000Z',
        hooks: {
          afterRollbackDirectoryEffectBeforeCheckpoint() {
            if (rollbackDirectoryCrashCalls++ === 0) crash();
          }
        }
      }),
      SELFTEST_CRASH
    );
    const directoryCrashRecovery = rollbackCompletedFinalizationAt({
      root: rollbackDirectoryCrash.root,
      request: rollbackDirectoryCrash.request,
      at: '2026-07-22T12:03:00.000Z'
    });
    if (directoryCrashRecovery.checkpoint.state !== 'superseded') {
      throw new Error('Explicit rollback did not reconcile an rmdir-before-checkpoint crash.');
    }

    const rollbackAttention = synthetic('explicit-rollback-needs-attention');
    publishFinalizationCandidateAt({
      root: rollbackAttention.root,
      request: rollbackAttention.request,
      candidate: rollbackAttention.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const attentionSentinel = resolveRepoPath(
      rollbackAttention.root,
      'soter/evidence/development/foreign-sentinel'
    );
    fs.writeFileSync(attentionSentinel, 'FOREIGN\n');
    expectCode(
      () => rollbackCompletedFinalizationAt({
        root: rollbackAttention.root,
        request: rollbackAttention.request,
        at: '2026-07-22T12:02:00.000Z'
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_ROLLBACK_FAILED'
    );
    const explicitAttentionCheckpoint = readFinalizationCheckpoint(
      rollbackAttention.root,
      rollbackAttention.request,
      readFinalizationConsumption(rollbackAttention.root, rollbackAttention.request)
    );
    if (explicitAttentionCheckpoint.state !== 'needs-attention'
      || explicitAttentionCheckpoint.rollback.terminalState !== 'superseded') {
      throw new Error('Explicit rollback did not retain its supersession intent on failure.');
    }
    fs.unlinkSync(attentionSentinel);
    const attentionRecovery = rollbackCompletedFinalizationAt({
      root: rollbackAttention.root,
      request: rollbackAttention.request,
      at: '2026-07-22T12:03:00.000Z'
    });
    if (attentionRecovery.checkpoint.state !== 'superseded') {
      throw new Error('Explicit rollback did not recover from repaired needs-attention state.');
    }

    const graphDriftRollback = synthetic('explicit-rollback-graph-drift');
    publishFinalizationCandidateAt({
      root: graphDriftRollback.root,
      request: graphDriftRollback.request,
      candidate: graphDriftRollback.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const graphDriftRequestPath = path.join(temp, 'graph-drift-request.json');
    fs.writeFileSync(
      graphDriftRequestPath,
      canonicalBytes(graphDriftRollback.request),
      { mode: 0o600 }
    );
    if (process.platform !== 'win32') fs.chmodSync(graphDriftRequestPath, 0o600);
    fs.unlinkSync(path.join(
      graphDriftRollback.root,
      'soter/automations/workflow-1/definition.json'
    ));
    const graphDriftResult = rollbackCompletedDevelopmentHostEvidenceFinalization({
      root: graphDriftRollback.root,
      requestPath: graphDriftRequestPath,
      at: '2027-07-22T12:02:00.000Z'
    });
    if (graphDriftResult.state !== 'superseded'
      || graphDriftResult.removedOutputCount !== 16) {
      throw new Error('Sealed rollback was incorrectly coupled to the current workflow graph.');
    }

    const remountRollback = synthetic('explicit-rollback-device-remount');
    publishFinalizationCandidateAt({
      root: remountRollback.root,
      request: remountRollback.request,
      candidate: remountRollback.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const remountRollbackBasis = sealSyntheticRemount(remountRollback);
    expectCode(
      () => verifyPublishedCandidateOutputs(
        remountRollback.root,
        remountRollback.request,
        remountRollback.candidate
      ),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_BASIS_INVALID'
    );
    expectCode(
      () => publishFinalizationCandidateAt({
        root: remountRollback.root,
        request: remountRollback.request,
        candidate: remountRollback.candidate,
        consumeAt: '2026-07-22T12:02:00.000Z',
        postVerify() {}
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_BASIS_INVALID'
    );
    const remountRollbackResult = rollbackCompletedDevelopmentHostEvidenceFinalization({
      root: remountRollback.root,
      requestPath: remountRollbackBasis.requestPath,
      at: '2026-07-22T12:02:00.000Z'
    });
    if (remountRollbackBasis.current.device === remountRollbackBasis.sealedDevice
      || remountRollbackResult.state !== 'superseded'
      || remountRollbackResult.removedOutputCount !== 16
      || remountRollback.request.outputs.some((row) => {
        return pathEntryExists(resolveRepoPath(remountRollback.root, row.path));
      })) {
      throw new Error('Device-only remount did not preserve exact rollback authority.');
    }
    const remountRollbackReentry = rollbackCompletedDevelopmentHostEvidenceFinalization({
      root: remountRollback.root,
      requestPath: remountRollbackBasis.requestPath,
      at: '2026-07-22T12:03:00.000Z'
    });
    if (!remountRollbackReentry.idempotent
      || remountRollbackReentry.removedOutputCount !== 0) {
      throw new Error('Remount-safe superseded rollback was not idempotent.');
    }

    const remountOutputCrash = synthetic('explicit-rollback-remount-output-crash');
    publishFinalizationCandidateAt({
      root: remountOutputCrash.root,
      request: remountOutputCrash.request,
      candidate: remountOutputCrash.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const remountOutputCrashBasis = sealSyntheticRemount(remountOutputCrash);
    let remountOutputCrashCalls = 0;
    expectCode(
      () => rollbackCompletedFinalizationAt({
        root: remountOutputCrash.root,
        request: remountOutputCrash.request,
        at: '2026-07-22T12:02:00.000Z',
        hooks: {
          afterRollbackOutputEffectBeforeCheckpoint() {
            if (remountOutputCrashCalls++ === 0) crash();
          }
        }
      }),
      SELFTEST_CRASH
    );
    const remountOutputCrashRecovery =
      rollbackCompletedDevelopmentHostEvidenceFinalization({
        root: remountOutputCrash.root,
        requestPath: remountOutputCrashBasis.requestPath,
        at: '2026-07-22T12:03:00.000Z'
      });
    if (remountOutputCrashRecovery.state !== 'superseded'
      || remountOutputCrash.request.outputs.some((row) => {
        return pathEntryExists(resolveRepoPath(remountOutputCrash.root, row.path));
      })) {
      throw new Error('Remount-safe rollback did not recover an output unlink crash.');
    }

    const remountDirectoryCrash = synthetic(
      'explicit-rollback-remount-directory-crash'
    );
    publishFinalizationCandidateAt({
      root: remountDirectoryCrash.root,
      request: remountDirectoryCrash.request,
      candidate: remountDirectoryCrash.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const remountDirectoryCrashBasis = sealSyntheticRemount(remountDirectoryCrash);
    let remountDirectoryCrashCalls = 0;
    expectCode(
      () => rollbackCompletedFinalizationAt({
        root: remountDirectoryCrash.root,
        request: remountDirectoryCrash.request,
        at: '2026-07-22T12:02:00.000Z',
        hooks: {
          afterRollbackDirectoryEffectBeforeCheckpoint() {
            if (remountDirectoryCrashCalls++ === 0) crash();
          }
        }
      }),
      SELFTEST_CRASH
    );
    const remountDirectoryCrashRecovery =
      rollbackCompletedDevelopmentHostEvidenceFinalization({
        root: remountDirectoryCrash.root,
        requestPath: remountDirectoryCrashBasis.requestPath,
        at: '2026-07-22T12:03:00.000Z'
      });
    if (remountDirectoryCrashRecovery.state !== 'superseded'
      || remountDirectoryCrash.request.outputs.some((row) => {
        return pathEntryExists(resolveRepoPath(remountDirectoryCrash.root, row.path));
      })) {
      throw new Error('Remount-safe rollback did not recover a directory removal crash.');
    }

    const remountWrongPath = synthetic('explicit-rollback-remount-wrong-path');
    publishFinalizationCandidateAt({
      root: remountWrongPath.root,
      request: remountWrongPath.request,
      candidate: remountWrongPath.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const remountWrongPathBasis = sealSyntheticRemount(remountWrongPath, {
      rootRealPath: remountWrongPath.root + '-different'
    });
    const remountWrongPathSnapshot = rollbackMutationSnapshot(remountWrongPath);
    expectCode(
      () => rollbackCompletedDevelopmentHostEvidenceFinalization({
        root: remountWrongPath.root,
        requestPath: remountWrongPathBasis.requestPath,
        at: '2026-07-22T12:02:00.000Z'
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_BASIS_INVALID'
    );
    assertRollbackMutationSnapshot(
      remountWrongPath,
      remountWrongPathSnapshot,
      'Wrong remount root path'
    );

    const remountWrongInode = synthetic('explicit-rollback-remount-wrong-inode');
    publishFinalizationCandidateAt({
      root: remountWrongInode.root,
      request: remountWrongInode.request,
      candidate: remountWrongInode.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const currentWrongInode = rootIdentity(remountWrongInode.root);
    const remountWrongInodeBasis = sealSyntheticRemount(remountWrongInode, {
      rootInode: currentWrongInode.inode + 1
    });
    const remountWrongInodeSnapshot = rollbackMutationSnapshot(remountWrongInode);
    expectCode(
      () => rollbackCompletedDevelopmentHostEvidenceFinalization({
        root: remountWrongInode.root,
        requestPath: remountWrongInodeBasis.requestPath,
        at: '2026-07-22T12:02:00.000Z'
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_BASIS_INVALID'
    );
    assertRollbackMutationSnapshot(
      remountWrongInode,
      remountWrongInodeSnapshot,
      'Wrong remount root inode'
    );

    const remountConsumptionDevice = synthetic(
      'explicit-rollback-remount-consumption-device'
    );
    publishFinalizationCandidateAt({
      root: remountConsumptionDevice.root,
      request: remountConsumptionDevice.request,
      candidate: remountConsumptionDevice.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const remountConsumptionDeviceBasis = sealSyntheticRemount(
      remountConsumptionDevice,
      { consumptionDirectoryDeviceMismatch: true }
    );
    const remountConsumptionDeviceSnapshot = rollbackMutationSnapshot(
      remountConsumptionDevice
    );
    expectCode(
      () => rollbackCompletedDevelopmentHostEvidenceFinalization({
        root: remountConsumptionDevice.root,
        requestPath: remountConsumptionDeviceBasis.requestPath,
        at: '2026-07-22T12:02:00.000Z'
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_BASIS_INVALID'
    );
    assertRollbackMutationSnapshot(
      remountConsumptionDevice,
      remountConsumptionDeviceSnapshot,
      'Mixed remount consumption device'
    );

    const remountCheckpointDevice = synthetic(
      'explicit-rollback-remount-checkpoint-device'
    );
    publishFinalizationCandidateAt({
      root: remountCheckpointDevice.root,
      request: remountCheckpointDevice.request,
      candidate: remountCheckpointDevice.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const remountCheckpointDeviceBasis = sealSyntheticRemount(
      remountCheckpointDevice,
      { checkpointOutputDeviceMismatch: true }
    );
    const remountCheckpointDeviceSnapshot = rollbackMutationSnapshot(
      remountCheckpointDevice
    );
    expectCode(
      () => rollbackCompletedDevelopmentHostEvidenceFinalization({
        root: remountCheckpointDevice.root,
        requestPath: remountCheckpointDeviceBasis.requestPath,
        at: '2026-07-22T12:02:00.000Z'
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_CHECKPOINT_INVALID'
    );
    assertRollbackMutationSnapshot(
      remountCheckpointDevice,
      remountCheckpointDeviceSnapshot,
      'Mixed remount checkpoint device'
    );

    const remountStaleRequest = synthetic('explicit-rollback-remount-stale-request');
    publishFinalizationCandidateAt({
      root: remountStaleRequest.root,
      request: remountStaleRequest.request,
      candidate: remountStaleRequest.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const remountStaleRequestBasis = sealSyntheticRemount(remountStaleRequest);
    const staleRequestValue = readJson(remountStaleRequestBasis.requestPath);
    staleRequestValue.requestFingerprint = fingerprintJson({
      stale: 'remount-request-fingerprint'
    });
    fs.writeFileSync(
      remountStaleRequestBasis.requestPath,
      canonicalBytes(staleRequestValue),
      { mode: 0o600 }
    );
    if (process.platform !== 'win32') {
      fs.chmodSync(remountStaleRequestBasis.requestPath, 0o600);
    }
    const remountStaleRequestSnapshot = rollbackMutationSnapshot(
      remountStaleRequest
    );
    expectCode(
      () => rollbackCompletedDevelopmentHostEvidenceFinalization({
        root: remountStaleRequest.root,
        requestPath: remountStaleRequestBasis.requestPath,
        at: '2026-07-22T12:02:00.000Z'
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_REQUEST_INVALID'
    );
    assertRollbackMutationSnapshot(
      remountStaleRequest,
      remountStaleRequestSnapshot,
      'Stale remount request fingerprint'
    );

    const rollbackDirectorySwap = synthetic(
      'explicit-rollback-directory-swap-after-preflight'
    );
    publishFinalizationCandidateAt({
      root: rollbackDirectorySwap.root,
      request: rollbackDirectorySwap.request,
      candidate: rollbackDirectorySwap.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const swapOutputs = outputInspectionPlan(
      rollbackDirectorySwap.root,
      rollbackDirectorySwap.candidate.outputRows
    );
    let directorySwapHookCalls = 0;
    expectCode(
      () => rollbackCompletedFinalizationAt({
        root: rollbackDirectorySwap.root,
        request: rollbackDirectorySwap.request,
        at: '2026-07-22T12:02:00.000Z',
        hooks: {
          afterRollbackStartedBeforeEffects() {
            if (directorySwapHookCalls++ !== 0) return;
            const original = resolveRepoPath(
              rollbackDirectorySwap.root,
              'soter/evidence/development'
            );
            const displaced = path.join(
              rollbackDirectorySwap.root,
              'displaced-evidence-directory-after-preflight'
            );
            fs.renameSync(original, displaced);
            fs.mkdirSync(original, { mode: 0o755 });
            if (process.platform !== 'win32') fs.chmodSync(original, 0o755);
            for (const name of fs.readdirSync(displaced)) {
              fs.renameSync(path.join(displaced, name), path.join(original, name));
            }
          }
        }
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_ROLLBACK_FAILED'
    );
    if (directorySwapHookCalls !== 1
      || !swapOutputs.every((output) => pathEntryExists(output.file))) {
      throw new Error(
        'Directory swap after rollback preflight removed an output before failing closed.'
      );
    }

    const explicitRollbackHardlink = synthetic('explicit-rollback-hardlink');
    publishFinalizationCandidateAt({
      root: explicitRollbackHardlink.root,
      request: explicitRollbackHardlink.request,
      candidate: explicitRollbackHardlink.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const hardlinkOutputs = outputInspectionPlan(
      explicitRollbackHardlink.root,
      explicitRollbackHardlink.candidate.outputRows
    );
    const externalHardlink = path.join(temp, 'external-output-hardlink.json');
    fs.linkSync(hardlinkOutputs[0].file, externalHardlink);
    expectCode(
      () => rollbackCompletedFinalizationAt({
        root: explicitRollbackHardlink.root,
        request: explicitRollbackHardlink.request,
        at: '2026-07-22T12:02:00.000Z'
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT'
    );
    if (!hardlinkOutputs.every((output) => pathEntryExists(output.file))
      || !pathEntryExists(externalHardlink)) {
      throw new Error('Hardlinked output changed before complete rollback preflight.');
    }
    fs.unlinkSync(externalHardlink);

    if (process.platform !== 'win32') {
      const explicitRollbackMode = synthetic('explicit-rollback-mode-drift');
      publishFinalizationCandidateAt({
        root: explicitRollbackMode.root,
        request: explicitRollbackMode.request,
        candidate: explicitRollbackMode.candidate,
        consumeAt: '2026-07-22T12:01:00.000Z',
        postVerify() {}
      });
      const modeOutputs = outputInspectionPlan(
        explicitRollbackMode.root,
        explicitRollbackMode.candidate.outputRows
      );
      fs.chmodSync(modeOutputs[0].file, 0o600);
      expectCode(
        () => rollbackCompletedFinalizationAt({
          root: explicitRollbackMode.root,
          request: explicitRollbackMode.request,
          at: '2026-07-22T12:02:00.000Z'
        }),
        'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT'
      );
      if (!modeOutputs.every((output) => pathEntryExists(output.file))) {
        throw new Error('Mode-drifted output changed before complete rollback preflight.');
      }
    }

    const explicitRollbackBytes = synthetic('explicit-rollback-byte-drift');
    publishFinalizationCandidateAt({
      root: explicitRollbackBytes.root,
      request: explicitRollbackBytes.request,
      candidate: explicitRollbackBytes.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const byteOutputs = outputInspectionPlan(
      explicitRollbackBytes.root,
      explicitRollbackBytes.candidate.outputRows
    );
    const byteInode = Number(fs.lstatSync(byteOutputs[0].file).ino);
    fs.writeFileSync(byteOutputs[0].file, '{"tampered":true}\n');
    if (Number(fs.lstatSync(byteOutputs[0].file).ino) !== byteInode) {
      throw new Error('Byte-drift selftest unexpectedly replaced the governed inode.');
    }
    expectCode(
      () => rollbackCompletedFinalizationAt({
        root: explicitRollbackBytes.root,
        request: explicitRollbackBytes.request,
        at: '2026-07-22T12:02:00.000Z'
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT'
    );
    if (!byteOutputs.every((output) => pathEntryExists(output.file))) {
      throw new Error('Byte-drifted output changed before complete rollback preflight.');
    }

    const explicitRollbackDirectoryDrift = synthetic('explicit-rollback-directory-drift');
    publishFinalizationCandidateAt({
      root: explicitRollbackDirectoryDrift.root,
      request: explicitRollbackDirectoryDrift.request,
      candidate: explicitRollbackDirectoryDrift.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const driftedEvidenceDirectory = resolveRepoPath(
      explicitRollbackDirectoryDrift.root,
      'soter/evidence/development'
    );
    const displacedEvidenceDirectory = path.join(
      explicitRollbackDirectoryDrift.root,
      'displaced-evidence-directory'
    );
    fs.renameSync(driftedEvidenceDirectory, displacedEvidenceDirectory);
    fs.mkdirSync(driftedEvidenceDirectory, { mode: 0o755 });
    if (process.platform !== 'win32') fs.chmodSync(driftedEvidenceDirectory, 0o755);
    for (const name of fs.readdirSync(displacedEvidenceDirectory)) {
      fs.renameSync(
        path.join(displacedEvidenceDirectory, name),
        path.join(driftedEvidenceDirectory, name)
      );
    }
    const directoryDriftOutputs = outputInspectionPlan(
      explicitRollbackDirectoryDrift.root,
      explicitRollbackDirectoryDrift.candidate.outputRows
    );
    expectCode(
      () => rollbackCompletedFinalizationAt({
        root: explicitRollbackDirectoryDrift.root,
        request: explicitRollbackDirectoryDrift.request,
        at: '2026-07-22T12:02:00.000Z'
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT'
    );
    if (!directoryDriftOutputs.every((output) => pathEntryExists(output.file))) {
      throw new Error('Directory drift changed outputs before complete rollback preflight.');
    }

    const explicitRollbackDrift = synthetic('explicit-rollback-drift');
    publishFinalizationCandidateAt({
      root: explicitRollbackDrift.root,
      request: explicitRollbackDrift.request,
      candidate: explicitRollbackDrift.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    const explicitRollbackDriftOutputs = outputInspectionPlan(
      explicitRollbackDrift.root,
      explicitRollbackDrift.candidate.outputRows
    );
    fs.unlinkSync(explicitRollbackDriftOutputs[0].file);
    fs.writeFileSync(
      explicitRollbackDriftOutputs[0].file,
      explicitRollbackDriftOutputs[0].bytes,
      { mode: 0o644 }
    );
    if (process.platform !== 'win32') {
      fs.chmodSync(explicitRollbackDriftOutputs[0].file, 0o644);
    }
    expectCode(
      () => rollbackCompletedFinalizationAt({
        root: explicitRollbackDrift.root,
        request: explicitRollbackDrift.request,
        at: '2026-07-22T12:02:00.000Z'
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT'
    );
    if (!explicitRollbackDriftOutputs.every((output) => fs.existsSync(output.file))) {
      throw new Error('Explicit rollback changed outputs before complete ownership preflight.');
    }

    const terminalRepopulation = synthetic('explicit-rollback-terminal-repopulation');
    publishFinalizationCandidateAt({
      root: terminalRepopulation.root,
      request: terminalRepopulation.request,
      candidate: terminalRepopulation.candidate,
      consumeAt: '2026-07-22T12:01:00.000Z',
      postVerify() {}
    });
    rollbackCompletedFinalizationAt({
      root: terminalRepopulation.root,
      request: terminalRepopulation.request,
      at: '2026-07-22T12:02:00.000Z'
    });
    const terminalOutput = outputInspectionPlan(
      terminalRepopulation.root,
      terminalRepopulation.candidate.outputRows
    )[0];
    fs.mkdirSync(terminalOutput.directory, { recursive: true, mode: 0o755 });
    if (process.platform !== 'win32') fs.chmodSync(terminalOutput.directory, 0o755);
    fs.writeFileSync(terminalOutput.file, terminalOutput.bytes, { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(terminalOutput.file, 0o644);
    expectCode(
      () => rollbackCompletedFinalizationAt({
        root: terminalRepopulation.root,
        request: terminalRepopulation.request,
        at: '2026-07-22T12:03:00.000Z'
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_UNOWNED_OUTPUT'
    );

    const rollbackFailure = synthetic('rollback-needs-attention');
    expectCode(
      () => publishFinalizationCandidateAt({
        root: rollbackFailure.root,
        request: rollbackFailure.request,
        candidate: rollbackFailure.candidate,
        consumeAt: '2026-07-22T12:01:00.000Z',
        postVerify() {
          fs.writeFileSync(
            resolveRepoPath(rollbackFailure.root, 'soter/evidence/development/foreign-sentinel'),
            'FOREIGN\n'
          );
          fail(
            'DEVELOPMENT_EVIDENCE_FINALIZATION_POST_VERIFY_FAILED',
            'Planted rollback-needs-attention failure.'
          );
        }
      }),
      'DEVELOPMENT_EVIDENCE_FINALIZATION_ROLLBACK_FAILED'
    );
    const rollbackFailureConsumption = readFinalizationConsumption(
      rollbackFailure.root,
      rollbackFailure.request
    );
    const attention = readFinalizationCheckpoint(
      rollbackFailure.root,
      rollbackFailure.request,
      rollbackFailureConsumption
    );
    if (attention.state !== 'needs-attention'
      || attention.rollback.state !== 'needs-attention'
      || attention.rollback.failures.length === 0) {
      throw new Error('Rollback failure did not persist a durable needs-attention checkpoint.');
    }
    fs.unlinkSync(resolveRepoPath(
      rollbackFailure.root,
      'soter/evidence/development/foreign-sentinel'
    ));
    const recoverableAttention = rollbackCompletedFinalizationAt({
      root: rollbackFailure.root,
      request: rollbackFailure.request,
      at: '2026-07-22T12:02:00.000Z'
    });
    if (recoverableAttention.checkpoint.state !== 'rolled-back'
      || recoverableAttention.checkpoint.rollback.terminalState !== 'rolled-back') {
      throw new Error('Recoverable needs-attention rollback did not retain ordinary recovery.');
    }
    const republishedAfterAttention = publishFinalizationCandidateAt({
      root: rollbackFailure.root,
      request: rollbackFailure.request,
      candidate: rollbackFailure.candidate,
      consumeAt: '2027-07-22T12:03:00.000Z',
      postVerify() {}
    });
    if (republishedAfterAttention.created.length !== 16) {
      throw new Error('Recoverable rollback could not republish the exact consumed request.');
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return true;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  selftestDevelopmentHostEvidenceFinalizationPublication();
  process.stdout.write(
    'Soter development host evidence finalization exact-request transaction self-test passed.\n'
  );
}
