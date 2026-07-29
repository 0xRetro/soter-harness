import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  assertLegacyInventoryCurrent,
  assertLegacyInventoryStructureCurrent
} from '../kernel/legacy-inventory.mjs';
import {
  buildLegacyFinalizationCandidate
} from '../kernel/legacy-checker-transition.mjs';
import {
  fingerprintWorkflowGuideContent,
  workflowLegacySourceProjection
} from '../kernel/workflow-guides.mjs';
import {
  buildDevelopmentWorkflowLifecycleFinalizationCandidate,
  developmentWorkflowLifecycleFinalizationContract
} from './development-workflow-lifecycle-finalization.mjs';
import {
  workflowFinalEvidencePaths
} from './host-projections.mjs';
import {
  assertLegacyFinalizationFixtureRequest
} from './legacy-finalization.mjs';
import {
  buildLegacyTransitionAuthorizationFixtures,
  planLegacyFinalizationObsoleteFixturePaths
} from './fixtures.mjs';
import {
  fingerprintFile,
  fingerprintJson,
  readJson,
  sha256
} from './lib/canonical-json.mjs';

const DECLARATION_PATH = 'soter/migrations/legacy-nonworkflow-final-dispositions.json';
const DECLARATION_SCHEMA_PATH
  = 'soter/contracts/legacy-nonworkflow-final-dispositions.schema.json';
const INVENTORY_PATH = 'soter/migrations/legacy-inventory.json';
const REQUEST_CONTRACT = 'soter://private/legacy-finalization-transition-request/v1';
const REQUEST_ID = /^legacy-finalization-transition[.][a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_REQUEST_LIFETIME_MS = 15 * 60 * 1000;
const EXPECTED = Object.freeze({
  unfinishedBindings: 108,
  directWorkflowBindings: 42,
  nonworkflowBindings: 66,
  nonworkflowSources: 38,
  nonworkflowMigrated: 55,
  nonworkflowRetired: 11,
  totalMigrated: 85,
  totalRetired: 23,
  sourceDeletions: 79
});
const RETIRED_CLAUDE_DELIVERY_SOURCES = new Set([
  '.claude/.claude-plugin/plugin.json',
  '.claude/agents/eval-runner.md',
  '.claude/hooks/hooks.json',
  '.claude/scripts/check.mjs',
  '.claude/settings.json'
]);
const WORKFLOW_SCHEMAS = Object.freeze({
  definition: 'soter/contracts/workflow-definition.schema.json',
  evaluations: 'soter/contracts/workflow-evaluation-set.schema.json',
  guide: 'soter/contracts/workflow-guide.schema.json'
});

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  throw error;
}

function same(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && same(Object.keys(value).sort(compareCodepoint), [...keys].sort(compareCodepoint));
}

function transitionKey(row) {
  return `${row.sourcePath}\0${row.targetId}\0${row.targetPath}`;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function legacyTransitionRootIdentity(root) {
  const resolved = path.resolve(root);
  const lstat = fs.lstatSync(resolved);
  const real = fs.realpathSync(resolved);
  if (!lstat.isDirectory() || lstat.isSymbolicLink() || real !== resolved) {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_ROOT_INVALID',
      'Legacy transition root must be one exact real directory.'
    );
  }
  const stat = fs.statSync(resolved);
  const basis = {
    realPath: resolved,
    device: Number(stat.dev),
    inode: Number(stat.ino)
  };
  return { ...basis, fingerprint: fingerprintJson(basis) };
}

function rootIdentityFingerprint(root) {
  return legacyTransitionRootIdentity(root).fingerprint;
}

function signedWithNull(value, field) {
  const unsigned = structuredClone(value);
  unsigned[field] = null;
  return fingerprintJson(unsigned);
}

function isExactMillisecondInstant(value) {
  if (typeof value !== 'string'
    || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertRequestWindow(createdAt, validUntil, at) {
  if (!isExactMillisecondInstant(createdAt) || !isExactMillisecondInstant(validUntil)) {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_REQUEST_INVALID',
      'Legacy transition request times must be exact UTC millisecond instants.'
    );
  }
  const lifetime = Date.parse(validUntil) - Date.parse(createdAt);
  if (lifetime <= 0 || lifetime > MAX_REQUEST_LIFETIME_MS) {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_REQUEST_INVALID',
      'Legacy transition request lifetime must be positive and no longer than fifteen minutes.'
    );
  }
  if (!isExactMillisecondInstant(at)) {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_AT_INVALID',
      'Legacy transition request validation requires one caller-supplied exact UTC millisecond instant.'
    );
  }
  if (Date.parse(at) < Date.parse(createdAt) || Date.parse(at) >= Date.parse(validUntil)) {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_REQUEST_EXPIRED',
      'Legacy transition request is not current.'
    );
  }
}

function exactPrivateExternalRequest(root, requestPath) {
  if (typeof requestPath !== 'string' || !path.isAbsolute(requestPath)) {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_REQUEST_PATH_INVALID',
      'Legacy transition request must be one absolute private path outside the repository.'
    );
  }
  const realRoot = fs.realpathSync(path.resolve(root));
  const resolvedRequest = path.resolve(requestPath);
  let stat;
  let real;
  try {
    stat = fs.lstatSync(resolvedRequest);
    real = fs.realpathSync(resolvedRequest);
  } catch (error) {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_REQUEST_PATH_INVALID',
      'Legacy transition request is unavailable.',
      error
    );
  }
  if (requestPath !== resolvedRequest || real !== resolvedRequest
    || real === realRoot || real.startsWith(realRoot + path.sep)
    || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o600)) {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_REQUEST_PATH_INVALID',
      'Legacy transition request must be one external non-linked file with mode 0600.'
    );
  }
  let descriptor = null;
  let bytes;
  try {
    descriptor = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.dev !== stat.dev || before.ino !== stat.ino
      || (process.platform !== 'win32' && (before.mode & 0o7777) !== 0o600)) {
      fail(
        'LEGACY_FINALIZATION_TRANSITION_REQUEST_PATH_INVALID',
        'Legacy transition request changed before its exact read.'
      );
    }
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || after.nlink !== 1
      || fs.realpathSync(resolvedRequest) !== real) {
      fail(
        'LEGACY_FINALIZATION_TRANSITION_REQUEST_PATH_INVALID',
        'Legacy transition request changed during its exact read.'
      );
    }
  } catch (error) {
    if (error?.code?.startsWith('LEGACY_FINALIZATION_')) throw error;
    fail(
      'LEGACY_FINALIZATION_TRANSITION_REQUEST_PATH_INVALID',
      'Legacy transition request could not be read exactly.',
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
      'LEGACY_FINALIZATION_TRANSITION_REQUEST_INVALID',
      'Legacy transition request is not valid JSON.',
      error
    );
  }
  if (!bytes.equals(canonicalBytes(request))) {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_REQUEST_INVALID',
      'Legacy transition request must use exact canonical JSON bytes.'
    );
  }
  return request;
}

function workflowFiles(root, workflowId) {
  const slug = workflowId.slice('automation.'.length);
  const paths = {
    definition: `soter/automations/${slug}/definition.json`,
    evaluations: `soter/automations/${slug}/evaluations.json`,
    guide: `soter/automations/${slug}/guide.json`
  };
  return {
    paths,
    definition: readJson(path.join(root, paths.definition)),
    evaluations: readJson(path.join(root, paths.evaluations)),
    guide: readJson(path.join(root, paths.guide))
  };
}

function directWorkflowBindingKeys(root) {
  const keys = new Set();
  for (const workflowId of [
    ...developmentWorkflowLifecycleFinalizationContract.activeWorkflows,
    ...developmentWorkflowLifecycleFinalizationContract.retiredWorkflows
  ]) {
    const files = workflowFiles(root, workflowId);
    for (const source of workflowLegacySourceProjection(files)) {
      const targetPath = source.kind === 'workflow-guide'
        ? files.paths.guide
        : files.paths.evaluations;
      const key = `${source.path}\0${workflowId}\0${targetPath}`;
      if (keys.has(key)) {
        fail(
          'LEGACY_NONWORKFLOW_DISPOSITIONS_INVALID',
          'Direct workflow lifecycle source binding is duplicated.'
        );
      }
      keys.add(key);
    }
  }
  if (keys.size !== EXPECTED.directWorkflowBindings) {
    fail(
      'LEGACY_NONWORKFLOW_DISPOSITIONS_INVALID',
      'Direct workflow lifecycle source set is not exactly forty-two bindings.'
    );
  }
  return keys;
}

function unfinishedBindings(inventory) {
  return inventory.items.flatMap((item) => item.targets
    .filter((binding) => ['mapped', 'bridged'].includes(binding.state))
    .map((binding) => ({
      sourcePath: item.sourcePath,
      sourceFingerprint: item.sourceFingerprint,
      targetId: binding.id,
      targetPath: binding.path,
      authorizationEvidence: [...binding.evidence].sort(compareCodepoint)
    })))
    .sort((left, right) => compareCodepoint(transitionKey(left), transitionKey(right)));
}

function expectedDisposition(row) {
  if (['automation.pushing-to-notion', 'automation.updating-a-notion-page']
    .includes(row.targetId)) {
    return {
      state: 'retired',
      reasonCode: 'PROVIDER_SHAPED_WORKFLOW_INTENTIONALLY_RETIRED'
    };
  }
  if (row.targetId === 'host.claude' && RETIRED_CLAUDE_DELIVERY_SOURCES.has(row.sourcePath)) {
    return {
      state: 'retired',
      reasonCode: 'UNSUPPORTED_CLAUDE_DELIVERY_INTENTIONALLY_RETIRED'
    };
  }
  if (row.targetId === 'host.claude') {
    return {
      state: 'migrated',
      reasonCode: 'GOVERNED_HOST_PROJECTION_INTENTIONAL_CHANGE'
    };
  }
  if (row.targetId === 'kernel.soter') {
    return {
      state: 'migrated',
      reasonCode: 'KERNEL_GOVERNANCE_AUTHORITY_INTENTIONAL_CHANGE'
    };
  }
  if (row.targetId === 'core.runtime') {
    return {
      state: 'migrated',
      reasonCode: 'CORE_TRANSACTION_AUTHORITY_INTENTIONAL_CHANGE'
    };
  }
  if (row.targetId.startsWith('configuration.')) {
    return {
      state: 'migrated',
      reasonCode: 'PRIVATE_CONFIGURATION_AUTHORITY_INTENTIONAL_CHANGE'
    };
  }
  if (row.targetId.startsWith('context.')) {
    return {
      state: 'migrated',
      reasonCode: 'PORTABLE_CONTEXT_AUTHORITY_INTENTIONAL_CHANGE'
    };
  }
  if (row.targetId.startsWith('integration.')) {
    return {
      state: 'migrated',
      reasonCode: 'TYPED_INTEGRATION_AUTHORITY_INTENTIONAL_CHANGE'
    };
  }
  if (row.targetId.startsWith('automation.')) {
    return {
      state: 'migrated',
      reasonCode: 'AUTOMATION_AUTHORITY_INTENTIONAL_CHANGE'
    };
  }
  fail(
    'LEGACY_NONWORKFLOW_DISPOSITIONS_INVALID',
    'Non-workflow disposition target has no governed ownership class: ' + row.targetId
  );
}

export function assertLegacyNonworkflowFinalDispositions(root, supplied = null) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const declaration = structuredClone(supplied || readJson(path.join(resolvedRoot, DECLARATION_PATH)));
  const schema = readJson(path.join(resolvedRoot, DECLARATION_SCHEMA_PATH));
  const failures = validateJsonSchema(declaration, schema);
  if (failures.length) {
    fail(
      'LEGACY_NONWORKFLOW_DISPOSITIONS_SCHEMA_INVALID',
      'Non-workflow final dispositions violate their closed contract: '
        + failures.slice(0, 3).map((row) => `${row.path} ${row.message}`).join('; ')
    );
  }
  if (signedWithNull(declaration, 'declarationFingerprint')
    !== declaration.declarationFingerprint) {
    fail(
      'LEGACY_NONWORKFLOW_DISPOSITIONS_FINGERPRINT_INVALID',
      'Non-workflow final disposition fingerprint is stale.'
    );
  }
  const inventory = assertLegacyInventoryStructureCurrent(resolvedRoot);
  const unfinished = unfinishedBindings(inventory);
  const directKeys = directWorkflowBindingKeys(resolvedRoot);
  const nonworkflow = unfinished.filter((row) => !directKeys.has(transitionKey(row)));
  if (inventory.inventoryFingerprint !== declaration.basis.inventoryFingerprint
    || declaration.basis.unfinishedBindingSetFingerprint !== fingerprintJson(unfinished)
    || unfinished.length !== EXPECTED.unfinishedBindings
    || nonworkflow.length !== EXPECTED.nonworkflowBindings
    || new Set(nonworkflow.map((row) => row.sourcePath)).size !== EXPECTED.nonworkflowSources) {
    fail(
      'LEGACY_NONWORKFLOW_DISPOSITIONS_BASIS_INVALID',
      'Non-workflow final dispositions do not bind the exact current unfinished inventory.'
    );
  }
  const expectedByKey = new Map(nonworkflow.map((row) => [transitionKey(row), row]));
  const observedKeys = new Set();
  const finalPaths = new Set();
  for (const [index, row] of declaration.rows.entries()) {
    const key = transitionKey(row);
    const current = expectedByKey.get(key);
    const disposition = expectedDisposition(row);
    if (row.sequence !== index + 1
      || (index > 0 && compareCodepoint(transitionKey(declaration.rows[index - 1]), key) >= 0)
      || observedKeys.has(key)
      || !current
      || row.sourceFingerprint !== current.sourceFingerprint
      || row.state !== disposition.state
      || row.reasonCode !== disposition.reasonCode
      || row.parity !== 'intentional-change') {
      fail(
        'LEGACY_NONWORKFLOW_DISPOSITIONS_ROW_INVALID',
        'Non-workflow final disposition row is reordered, substituted, duplicated, or authority-inconsistent.'
      );
    }
    observedKeys.add(key);
    for (const evidencePath of row.finalEvidence) {
      const folded = evidencePath.toLowerCase();
      if (finalPaths.has(folded)
        || unfinished.some((unfinishedRow) => unfinishedRow.authorizationEvidence.some((currentPath) => {
          return currentPath.toLowerCase() === folded;
        }))) {
        fail(
          'LEGACY_NONWORKFLOW_DISPOSITIONS_EVIDENCE_COLLISION',
          'Non-workflow final evidence path is duplicated or collides with current authorization evidence.'
        );
      }
      finalPaths.add(folded);
    }
  }
  if (observedKeys.size !== expectedByKey.size
    || [...expectedByKey.keys()].some((key) => !observedKeys.has(key))) {
    fail(
      'LEGACY_NONWORKFLOW_DISPOSITIONS_COVERAGE_INVALID',
      'Non-workflow final dispositions do not cover the exact sixty-six binding complement.'
    );
  }
  const migrated = declaration.rows.filter((row) => row.state === 'migrated').length;
  const retired = declaration.rows.length - migrated;
  if (migrated !== EXPECTED.nonworkflowMigrated
    || retired !== EXPECTED.nonworkflowRetired
    || declaration.summary.migrated !== migrated
    || declaration.summary.retired !== retired) {
    fail(
      'LEGACY_NONWORKFLOW_DISPOSITIONS_SUMMARY_INVALID',
      'Non-workflow final disposition summary is stale.'
    );
  }
  return { declaration, inventory, directKeys, unfinished };
}

function lifecycleAfterDocuments(root, candidate, workflowId) {
  const slug = workflowId.slice('automation.'.length);
  const paths = {
    definition: `soter/automations/${slug}/definition.json`,
    evaluations: `soter/automations/${slug}/evaluations.json`,
    guide: `soter/automations/${slug}/guide.json`
  };
  const result = { paths };
  for (const [kind, relativePath] of Object.entries(paths)) {
    const matches = candidate.files.filter((file) => file.kind === kind && file.path === relativePath);
    const planned = candidate.plan.files.filter((file) => {
      return file.kind === kind && file.path === relativePath;
    });
    if (matches.length !== 1
      || planned.length !== 1
      || !exactKeys(matches[0], [
        'after',
        'afterFileFingerprint',
        'afterFingerprint',
        'before',
        'beforeFileFingerprint',
        'beforeFingerprint',
        'kind',
        'mode',
        'path'
      ])
      || !exactKeys(planned[0], [
        'afterFileFingerprint',
        'afterFingerprint',
        'beforeFileFingerprint',
        'beforeFingerprint',
        'kind',
        'mode',
        'path'
      ])
      || matches[0].mode !== '0644'
      || !same(
        Object.fromEntries(Object.entries(matches[0]).filter(([key]) => {
          return !['after', 'before'].includes(key);
        })),
        planned[0]
      )
      || matches[0].beforeFingerprint !== fingerprintJson(matches[0].before)
      || matches[0].beforeFileFingerprint !== sha256(canonicalBytes(matches[0].before))
      || matches[0].afterFingerprint !== fingerprintJson(matches[0].after)
      || matches[0].afterFileFingerprint !== sha256(canonicalBytes(matches[0].after))) {
      fail(
        'LEGACY_FINALIZATION_LIFECYCLE_INVALID',
        'Workflow lifecycle candidate does not contain one exact plan-bound after document.'
      );
    }
    const currentFile = path.join(root, relativePath);
    const stat = fs.lstatSync(currentFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o644)
      || fingerprintFile(currentFile) !== matches[0].beforeFileFingerprint
      || fingerprintJson(readJson(currentFile)) !== matches[0].beforeFingerprint) {
      fail(
        'LEGACY_FINALIZATION_LIFECYCLE_INVALID',
        'Workflow lifecycle current source no longer matches its exact plan basis.'
      );
    }
    const schema = readJson(path.join(root, WORKFLOW_SCHEMAS[kind]));
    const failures = validateJsonSchema(matches[0].after, schema);
    if (failures.length) {
      fail(
        'LEGACY_FINALIZATION_LIFECYCLE_INVALID',
        'Workflow lifecycle after document is not valid against its closed contract.'
      );
    }
    result[kind] = matches[0].after;
  }
  if (result.definition.id !== workflowId
    || result.guide.workflow?.id !== workflowId
    || result.evaluations.workflow !== workflowId
    || result.definition.guide?.id !== result.guide.id
    || result.definition.guide?.path !== paths.guide
    || result.definition.evaluationSet?.id !== result.evaluations.id
    || result.definition.evaluationSet?.path !== paths.evaluations
    || result.guide.workflow?.version !== result.definition.version
    || result.guide.workflow?.definitionPath !== paths.definition
    || result.guide.workflow?.definitionFingerprint !== fingerprintJson(result.definition)
    || result.guide.workflow?.evaluationSetPath !== paths.evaluations
    || result.guide.workflow?.evaluationSetFingerprint !== fingerprintJson(result.evaluations)
    || result.guide.contentFingerprint !== fingerprintWorkflowGuideContent(result.guide)) {
    fail(
      'LEGACY_FINALIZATION_LIFECYCLE_INVALID',
      'Workflow lifecycle after documents have crossed or stale identities.'
    );
  }
  return result;
}

function exactWorkflowLifecycleFacts(files, workflowId, disposition) {
  const slug = workflowId.slice('automation.'.length);
  const normalization = files.guide.source?.normalization;
  const lifecycleParity = normalization
    === 'behavior-preserving-with-explicit-authority-boundary'
    ? 'passed'
    : normalization === 'intentional-change-with-explicit-authority-boundary'
      ? 'intentional-change'
      : null;
  const guideEvidence = files.guide.status?.evidence;
  const definitionEvidence = disposition === 'active'
    ? files.definition.lifecycle?.activation?.evidence
    : files.definition.lifecycle?.retirement?.evidence;
  if (!lifecycleParity
    || files.guide.status?.behaviorParity !== lifecycleParity
    || !same(guideEvidence, definitionEvidence)) {
    fail(
      'LEGACY_FINALIZATION_LIFECYCLE_INVALID',
      'Workflow lifecycle parity or evidence disagrees across its finalized definition, guide, and source normalization.'
    );
  }

  if (disposition === 'active') {
    if (files.definition.lifecycle?.state !== 'active-host-guided'
      || !exactKeys(files.definition.lifecycle?.activation, [
        'behaviorParity',
        'delivery',
        'evidence',
        'permittedNextAction',
        'proceduralAuthority',
        'reasonCode',
        'state'
      ])
      || files.definition.lifecycle.activation.state !== 'active'
      || files.definition.lifecycle.activation.reasonCode
        !== 'WORKFLOW_HOST_GUIDANCE_ACTIVE'
      || files.definition.lifecycle.activation.proceduralAuthority !== 'target'
      || files.definition.lifecycle.activation.delivery !== 'host-skill'
      || files.definition.lifecycle.activation.behaviorParity !== lifecycleParity
      || files.definition.lifecycle.activation.permittedNextAction
        !== 'invoke-through-selected-host'
      || !exactKeys(files.guide.status, [
        'behaviorParity',
        'delivery',
        'evidence',
        'permittedNextAction',
        'proceduralAuthority',
        'reasonCode',
        'state'
      ])
      || files.guide.status.state !== 'active'
      || files.guide.status.reasonCode !== 'WORKFLOW_GUIDE_ACTIVE'
      || files.guide.status.proceduralAuthority !== 'target'
      || files.guide.status.delivery !== 'host-skill'
      || files.guide.status.permittedNextAction !== 'invoke-through-selected-host'
      || !exactKeys(files.evaluations.lifecycle, [
        'activation',
        'authority',
        'permittedNextAction',
        'state'
      ])
      || files.evaluations.lifecycle.state !== 'active-host-guided'
      || files.evaluations.lifecycle.activation !== 'active'
      || files.evaluations.lifecycle.authority !== 'request-bound-development-evidence'
      || files.evaluations.lifecycle.permittedNextAction
        !== 'run-exact-evaluation-suite'
      || !Array.isArray(guideEvidence)
      || guideEvidence.length !== 2
      || !same(guideEvidence.map((reference) => reference.host), ['claude', 'codex'])
      || guideEvidence.some((reference) => {
        return !exactKeys(reference, ['fingerprint', 'host', 'path'])
          || !HASH.test(reference.fingerprint || '')
          || reference.path !== 'soter/evidence/development/'
            + 'development-agent-migration-evidence.'
            + reference.host + '.' + slug + '.json';
      })) {
      fail(
        'LEGACY_FINALIZATION_LIFECYCLE_INVALID',
        'Active workflow lifecycle evidence is not the exact Claude and Codex historical receipt set.'
      );
    }
    const finalEvidence = workflowFinalEvidencePaths({
      guide: files.guide,
      definition: files.definition
    });
    const expectedFinalEvidence = ['claude', 'codex'].map((host) => {
      return 'soter/evidence/development/evidence.development-activation.'
        + host + '.' + slug + '.json';
    });
    if (!same(finalEvidence, expectedFinalEvidence)) {
      fail(
        'LEGACY_FINALIZATION_LIFECYCLE_INVALID',
        'Active workflow lifecycle does not derive one exact dual-host final evidence set.'
      );
    }
    return { lifecycleParity, finalEvidence };
  }

  const retirementPath = 'soter/fixtures/harness-development-catalog/'
    + slug + '.intentional-retirement.evidence.json';
  if (lifecycleParity !== 'intentional-change'
    || files.definition.lifecycle?.state !== 'retired'
    || !exactKeys(files.definition.lifecycle?.retirement, [
      'evidence',
      'fallback',
      'permittedNextAction',
      'proceduralAuthority',
      'reasonCode',
      'state'
    ])
    || files.definition.lifecycle.retirement.state !== 'complete'
    || files.definition.lifecycle.retirement.reasonCode !== 'WORKFLOW_RETIRED'
    || files.definition.lifecycle.retirement.proceduralAuthority !== 'none'
    || files.definition.lifecycle.retirement.fallback !== 'removed'
    || files.definition.lifecycle.retirement.permittedNextAction !== 'inspect-replacement'
    || !exactKeys(files.guide.status, [
      'behaviorParity',
      'delivery',
      'evidence',
      'permittedNextAction',
      'proceduralAuthority',
      'reasonCode',
      'state'
    ])
    || files.guide.status.state !== 'retired'
    || files.guide.status.reasonCode !== 'WORKFLOW_GUIDE_RETIRED'
    || files.guide.status.proceduralAuthority !== 'none'
    || files.guide.status.delivery !== 'unavailable'
    || files.guide.status.permittedNextAction !== 'inspect-replacement'
    || !exactKeys(files.evaluations.lifecycle, [
      'authority',
      'permittedNextAction',
      'retirement',
      'state'
    ])
    || files.evaluations.lifecycle.state !== 'retired'
    || files.evaluations.lifecycle.retirement !== 'complete'
    || files.evaluations.lifecycle.authority !== 'none'
    || files.evaluations.lifecycle.permittedNextAction !== 'inspect-replacement'
    || !Array.isArray(guideEvidence)
    || guideEvidence.length !== 1
    || !exactKeys(guideEvidence[0], ['path'])
    || guideEvidence[0].path !== retirementPath) {
    fail(
      'LEGACY_FINALIZATION_LIFECYCLE_INVALID',
      'Retired workflow lifecycle evidence is not its exact intentional-retirement record.'
    );
  }
  return { lifecycleParity, finalEvidence: [retirementPath] };
}

export function deriveLegacyWorkflowTransitions(root, lifecycleCandidate, inventory = null) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const current = inventory || assertLegacyInventoryCurrent(resolvedRoot);
  const currentBindings = new Map(unfinishedBindings(current).map((row) => [transitionKey(row), row]));
  if (lifecycleCandidate?.request?.$contract
      !== developmentWorkflowLifecycleFinalizationContract.request
    || lifecycleCandidate.plan?.contract
      !== 'development-workflow-lifecycle-finalization-plan/v1'
    || lifecycleCandidate.plan.requestFingerprint !== lifecycleCandidate.request.requestFingerprint
    || lifecycleCandidate.plan.authority?.repositoryWrites !== false
    || lifecycleCandidate.plan.authority?.sourceDeletion !== false
    || lifecycleCandidate.plan.authority?.fallbackRemoval !== false
    || lifecycleCandidate.plan.workflows?.length !== 10
    || lifecycleCandidate.plan.files?.length !== 30
    || lifecycleCandidate.files?.length !== 30
    || signedWithNull(lifecycleCandidate.plan, 'planFingerprint')
      !== lifecycleCandidate.plan.planFingerprint) {
    fail(
      'LEGACY_FINALIZATION_LIFECYCLE_INVALID',
      'Workflow lifecycle candidate is incomplete, stale, or grants forbidden authority.'
    );
  }
  const workflowRows = new Map(lifecycleCandidate.plan.workflows.map((row) => [row.id, row]));
  const transitions = [];
  for (const workflowId of [
    ...developmentWorkflowLifecycleFinalizationContract.activeWorkflows,
    ...developmentWorkflowLifecycleFinalizationContract.retiredWorkflows
  ].sort(compareCodepoint)) {
    const workflow = workflowRows.get(workflowId);
    const files = lifecycleAfterDocuments(resolvedRoot, lifecycleCandidate, workflowId);
    let sources;
    try {
      sources = workflowLegacySourceProjection(files);
    } catch (error) {
      fail(
        'LEGACY_FINALIZATION_LIFECYCLE_BINDING_INVALID',
        'Workflow lifecycle source tombstones are partial, crossed, or malformed.',
        error
      );
    }
    const expectedDisposition = developmentWorkflowLifecycleFinalizationContract.activeWorkflows
      .includes(workflowId) ? 'active' : 'retired';
    const state = expectedDisposition === 'active' ? 'migrated' : 'retired';
    const lifecycle = exactWorkflowLifecycleFacts(
      files,
      workflowId,
      expectedDisposition
    );
    const finalEvidence = [...lifecycle.finalEvidence].sort(compareCodepoint);
    if (!workflow || workflow.disposition !== expectedDisposition
      || workflow.parity !== lifecycle.lifecycleParity
      || sources.some((source) => source.presence !== 'removed')
      || finalEvidence.length !== (state === 'migrated' ? 2 : 1)
      || new Set(finalEvidence).size !== finalEvidence.length) {
      fail(
        'LEGACY_FINALIZATION_LIFECYCLE_INVALID',
        'Workflow lifecycle disposition, parity, source tombstone, or final evidence is incomplete.'
      );
    }
    for (const source of sources) {
      const targetPath = source.kind === 'workflow-guide'
        ? files.paths.guide
        : files.paths.evaluations;
      const key = `${source.path}\0${workflowId}\0${targetPath}`;
      const currentBinding = currentBindings.get(key);
      if (!currentBinding || currentBinding.sourceFingerprint !== source.fingerprint) {
        fail(
          'LEGACY_FINALIZATION_LIFECYCLE_BINDING_INVALID',
          'Workflow lifecycle source does not match one exact unfinished inventory binding.'
        );
      }
      transitions.push({
        sourcePath: source.path,
        targetId: workflowId,
        targetPath,
        state,
        parity: lifecycle.lifecycleParity === 'passed'
          ? 'proven'
          : 'intentional-change',
        authorizationEvidence: [...currentBinding.authorizationEvidence],
        finalEvidence: [...finalEvidence]
      });
    }
  }
  transitions.sort((left, right) => compareCodepoint(transitionKey(left), transitionKey(right)));
  if (transitions.length !== EXPECTED.directWorkflowBindings
    || new Set(transitions.map(transitionKey)).size !== transitions.length
    || transitions.filter((row) => row.state === 'migrated').length !== 30
    || transitions.filter((row) => row.state === 'retired').length !== 12) {
    fail(
      'LEGACY_FINALIZATION_LIFECYCLE_COVERAGE_INVALID',
      'Workflow lifecycle candidate did not derive the exact thirty migrated and twelve retired bindings.'
    );
  }
  return transitions;
}

function combineTransitions(root, declarationBasis, lifecycleCandidate) {
  const workflowTransitions = deriveLegacyWorkflowTransitions(
    root,
    lifecycleCandidate,
    declarationBasis.inventory
  );
  const nonworkflowTransitions = declarationBasis.declaration.rows.map((row) => ({
    sourcePath: row.sourcePath,
    targetId: row.targetId,
    targetPath: row.targetPath,
    state: row.state,
    parity: row.parity,
    authorizationEvidence: declarationBasis.unfinished.find((current) => {
      return transitionKey(current) === transitionKey(row);
    }).authorizationEvidence,
    finalEvidence: [...row.finalEvidence]
  }));
  const transitions = [...workflowTransitions, ...nonworkflowTransitions]
    .sort((left, right) => compareCodepoint(transitionKey(left), transitionKey(right)));
  if (transitions.length !== EXPECTED.unfinishedBindings
    || new Set(transitions.map(transitionKey)).size !== transitions.length
    || transitions.filter((row) => row.state === 'migrated').length !== EXPECTED.totalMigrated
    || transitions.filter((row) => row.state === 'retired').length !== EXPECTED.totalRetired
    || !same(transitions.map(transitionKey), declarationBasis.unfinished.map(transitionKey))) {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_COVERAGE_INVALID',
      'Combined lifecycle and governed non-workflow transitions are not the exact 108-binding set.'
    );
  }
  return transitions;
}

function evidenceBindsOwner(document, owner) {
  if (document?.$contract !== 'soter://contracts/evidence/v2'
    || document.claimFamily !== 'migration'
    || document.result !== 'passed'
    || !Array.isArray(document.artifacts)) return false;
  return document.artifacts.filter((artifact) => {
    return artifact.role === 'migration-source'
      && artifact.path === owner.sourcePath
      && artifact.fingerprint === owner.sourceFingerprint;
  }).length === 1 && document.artifacts.filter((artifact) => {
    return artifact.role === 'migration-target' && artifact.path === owner.targetPath;
  }).length === 1;
}

function buildAuthorizationEvidenceOverlay(currentFixtures, transitions, inventory) {
  const inventoryRows = new Map(unfinishedBindings(inventory).map((row) => [transitionKey(row), row]));
  const byEvidencePath = new Map();
  for (const transition of transitions) {
    const owner = inventoryRows.get(transitionKey(transition));
    if (!owner) {
      fail(
        'LEGACY_FINALIZATION_AUTHORIZATION_OVERLAY_INVALID',
        'Authorization overlay transition has no exact inventory owner.'
      );
    }
    for (const evidencePath of transition.authorizationEvidence) {
      if (byEvidencePath.has(evidencePath)) {
        fail(
          'LEGACY_FINALIZATION_AUTHORIZATION_OVERLAY_INVALID',
          'Authorization evidence path is shared across transition owners.'
        );
      }
      let document = currentFixtures.get(evidencePath);
      if (!document || !evidenceBindsOwner(document, owner)) {
        const matches = [...currentFixtures.values()].filter((candidate) => {
          return evidenceBindsOwner(candidate, owner);
        });
        if (matches.length !== 1) {
          fail(
            'LEGACY_FINALIZATION_AUTHORIZATION_OVERLAY_INVALID',
            'Fresh in-memory fixture graph did not produce one exact authorization evidence record: '
              + evidencePath
          );
        }
        [document] = matches;
      }
      byEvidencePath.set(evidencePath, {
        path: evidencePath,
        documentFingerprint: fingerprintJson(document),
        document: structuredClone(document)
      });
    }
  }
  return [...byEvidencePath.values()].sort((left, right) => compareCodepoint(left.path, right.path));
}

async function exactDerivedBasis({ root, lifecycleRequestPath, checkerReceipt }) {
  const declarationBasis = assertLegacyNonworkflowFinalDispositions(root);
  const lifecycleCandidate = buildDevelopmentWorkflowLifecycleFinalizationCandidate({
    root,
    requestPath: lifecycleRequestPath
  });
  const transitions = combineTransitions(root, declarationBasis, lifecycleCandidate);
  const currentInventoryEvidencePaths = [...new Set(
    declarationBasis.inventory.items.flatMap((item) => {
      return item.targets.flatMap((binding) => binding.evidence);
    })
  )].sort(compareCodepoint);
  const currentFixtures = await buildLegacyTransitionAuthorizationFixtures(root, {
    expectedInventoryFingerprint: declarationBasis.inventory.inventoryFingerprint,
    evidencePaths: currentInventoryEvidencePaths
  });
  const authorizationEvidenceOverlay = buildAuthorizationEvidenceOverlay(
    currentFixtures,
    transitions,
    declarationBasis.inventory
  );
  const legacyPlan = buildLegacyFinalizationCandidate(
    root,
    transitions,
    checkerReceipt,
    authorizationEvidenceOverlay
  );
  if (legacyPlan.summary.transitionCount !== EXPECTED.unfinishedBindings
    || legacyPlan.summary.sourceDeletionCount !== EXPECTED.sourceDeletions) {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_CANDIDATE_INVALID',
      'Legacy finalization candidate does not remove the exact 108 bindings and 79 source files.'
    );
  }
  const obsoleteFixturePlan = planLegacyFinalizationObsoleteFixturePaths(root, {
    currentFixtures,
    transitions,
    authorizationEvidenceOverlay
  });
  const fixtureRequest = assertLegacyFinalizationFixtureRequest(root, {
    expectedInventoryFingerprint: legacyPlan.candidate.inventoryFingerprint,
    checkerReceipt: structuredClone(checkerReceipt),
    evidencePaths: [...legacyPlan.finalEvidencePaths],
    obsoleteFixturePaths: [...obsoleteFixturePlan.obsoleteFixturePaths]
  });
  return {
    declarationBasis,
    lifecycleCandidate,
    transitions,
    authorizationEvidenceOverlay,
    legacyPlan,
    obsoleteFixturePlan,
    fixtureRequest
  };
}

function requestValue({ id, createdAt, validUntil, checkerReceipt }, basis, root) {
  const request = {
    $contract: REQUEST_CONTRACT,
    contractVersion: '1.0.0',
    id,
    createdAt,
    validUntil,
    rootIdentityFingerprint: rootIdentityFingerprint(root),
    declaration: {
      path: DECLARATION_PATH,
      fingerprint: basis.declarationBasis.declaration.declarationFingerprint,
      inventoryFingerprint: basis.declarationBasis.inventory.inventoryFingerprint
    },
    lifecycle: {
      requestFingerprint: basis.lifecycleCandidate.request.requestFingerprint,
      planFingerprint: basis.lifecycleCandidate.plan.planFingerprint,
      candidateFingerprint: fingerprintJson(basis.lifecycleCandidate)
    },
    checkerReceipt: structuredClone(checkerReceipt),
    transitions: structuredClone(basis.transitions),
    transitionsFingerprint: fingerprintJson(basis.transitions),
    authorizationEvidenceOverlay: structuredClone(basis.authorizationEvidenceOverlay),
    authorizationEvidenceOverlayFingerprint:
      fingerprintJson(basis.authorizationEvidenceOverlay),
    obsoleteFixturePlan: structuredClone(basis.obsoleteFixturePlan),
    fixtureRequest: structuredClone(basis.fixtureRequest),
    candidate: {
      planFingerprint: basis.legacyPlan.planFingerprint,
      inventoryFingerprint: basis.legacyPlan.candidate.inventoryFingerprint,
      finalEvidencePathsFingerprint: fingerprintJson(basis.legacyPlan.finalEvidencePaths),
      sourceDeletionPathsFingerprint: fingerprintJson(basis.legacyPlan.deletePaths)
    },
    authority: {
      kind: 'none',
      writesRepository: false,
      writesFixtures: false,
      deletesSources: false,
      removesFixtures: false,
      generatesEvidence: false,
      executesCutover: false
    },
    requestFingerprint: null
  };
  request.requestFingerprint = signedWithNull(request, 'requestFingerprint');
  return request;
}

function assertRequestShape(request) {
  const keys = [
    '$contract',
    'authorizationEvidenceOverlay',
    'authorizationEvidenceOverlayFingerprint',
    'authority',
    'candidate',
    'checkerReceipt',
    'contractVersion',
    'createdAt',
    'declaration',
    'fixtureRequest',
    'id',
    'lifecycle',
    'obsoleteFixturePlan',
    'requestFingerprint',
    'rootIdentityFingerprint',
    'transitions',
    'transitionsFingerprint',
    'validUntil'
  ].sort(compareCodepoint);
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || !same(Object.keys(request).sort(compareCodepoint), keys)
    || request.$contract !== REQUEST_CONTRACT
    || request.contractVersion !== '1.0.0'
    || !REQUEST_ID.test(request.id || '')
    || !HASH.test(request.requestFingerprint || '')
    || !HASH.test(request.rootIdentityFingerprint || '')
    || !HASH.test(request.transitionsFingerprint || '')
    || !HASH.test(request.authorizationEvidenceOverlayFingerprint || '')
    || request.authority?.kind !== 'none'
    || request.authority?.writesRepository !== false
    || request.authority?.writesFixtures !== false
    || request.authority?.deletesSources !== false
    || request.authority?.removesFixtures !== false
    || request.authority?.generatesEvidence !== false
    || request.authority?.executesCutover !== false
    || signedWithNull(request, 'requestFingerprint') !== request.requestFingerprint
    || fingerprintJson(request.transitions) !== request.transitionsFingerprint
    || fingerprintJson(request.authorizationEvidenceOverlay)
      !== request.authorizationEvidenceOverlayFingerprint) {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_REQUEST_INVALID',
      'Legacy transition request has an unknown, missing, stale, or authority-bearing field.'
    );
  }
  return request;
}

export async function buildLegacyFinalizationTransitionRequest({
  root,
  id,
  createdAt,
  validUntil,
  at,
  lifecycleRequestPath,
  checkerReceipt,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length || typeof root !== 'string') {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_ARGUMENTS_INVALID',
      'Legacy transition request builder received an unknown or invalid argument.'
    );
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  assertRequestWindow(createdAt, validUntil, at);
  const basis = await exactDerivedBasis({
    root: resolvedRoot,
    lifecycleRequestPath,
    checkerReceipt
  });
  return structuredClone(assertRequestShape(requestValue({
    id,
    createdAt,
    validUntil,
    checkerReceipt
  }, basis, resolvedRoot)));
}

export async function readLegacyFinalizationTransitionRequest({
  root,
  requestPath,
  lifecycleRequestPath,
  at,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length || typeof root !== 'string') {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_ARGUMENTS_INVALID',
      'Legacy transition request reader received an unknown or invalid argument.'
    );
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const request = assertRequestShape(exactPrivateExternalRequest(resolvedRoot, requestPath));
  assertRequestWindow(request.createdAt, request.validUntil, at);
  if (request.rootIdentityFingerprint !== rootIdentityFingerprint(resolvedRoot)) {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_ROOT_INVALID',
      'Legacy transition request is bound to a different repository root.'
    );
  }
  const basis = await exactDerivedBasis({
    root: resolvedRoot,
    lifecycleRequestPath,
    checkerReceipt: request.checkerReceipt
  });
  const expected = requestValue({
    id: request.id,
    createdAt: request.createdAt,
    validUntil: request.validUntil,
    checkerReceipt: request.checkerReceipt
  }, basis, resolvedRoot);
  if (!same(request, expected)) {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_REQUEST_STALE',
      'Legacy transition request no longer matches its exact declaration, lifecycle, fixture, authorization-evidence, or candidate basis.'
    );
  }
  return {
    request: structuredClone(request),
    transitions: structuredClone(basis.transitions),
    authorizationEvidenceOverlay: structuredClone(basis.authorizationEvidenceOverlay),
    legacyPlan: structuredClone(basis.legacyPlan),
    obsoleteFixturePlan: structuredClone(basis.obsoleteFixturePlan),
    fixtureRequest: structuredClone(basis.fixtureRequest)
  };
}

export const legacyTransitionFinalizationContract = Object.freeze({
  declaration: 'soter://contracts/legacy-nonworkflow-final-dispositions/v1',
  declarationPath: DECLARATION_PATH,
  request: REQUEST_CONTRACT,
  expected: EXPECTED
});
