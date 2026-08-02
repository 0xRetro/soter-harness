#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fingerprintFile,
  fingerprintJson,
  readJson
} from '../core/lib/canonical-json.mjs';
import { inspectManagedHostProjectionOwnership } from '../core/host-realizations.mjs';
import { validateJsonSchema } from './verify.mjs';
import {
  assertLegacyInventoryCurrent,
  assertLegacyInventoryStructureCurrent
} from './legacy-inventory.mjs';
import {
  inspectCurrentLegacyCheckerRunReceipt,
  inspectLegacyCheckerRunProjection,
  inspectLegacyCheckerRunReceipt,
  LEGACY_CHECKER_RUN_PROJECTION_PATH,
  projectLegacyCheckerRunReceipt
} from './legacy-checker-run.mjs';
import { workflowGuideContentFingerprintMatches } from './workflow-guides.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptFile), '..', '..');
const TRANSITION_PATH = 'soter/kernel/legacy-checker-transition.json';
const TRANSITION_SCHEMA_PATH = 'soter/contracts/legacy-checker-transition.schema.json';
const INVENTORY_PATH = 'soter/migrations/legacy-inventory.json';
const INVENTORY_SCHEMA_PATH = 'soter/contracts/legacy-inventory.schema.json';
const EVIDENCE_SCHEMA_PATH = 'soter/contracts/evidence-v2.schema.json';
const MIGRATION_SCHEMA_PATH = 'soter/contracts/migration.schema.json';
const MIGRATION_DIRECTORY = 'soter/migrations';
const LEGACY_CHECKER_SOURCE_PATH = '.claude/scripts/check.mjs';
const PACKED_LEGACY_CHECKER_PATH = 'soter/kernel/legacy-check.mjs';
const RECEIPT_GATED_OPERATIONAL_DELETIONS = Object.freeze([
  {
    path: '.claude-plugin/marketplace.json',
    reasonCode: 'LEGACY_TRACKED_CLAUDE_PLUGIN_OUTPUT_REMOVAL'
  },
  {
    path: '.codex/config.toml',
    reasonCode: 'LEGACY_TRACKED_CODEX_CONFIGURATION_OUTPUT_REMOVAL'
  },
  {
    path: 'AGENTS.md',
    reasonCode: 'LEGACY_TRACKED_CODEX_INSTRUCTIONS_OUTPUT_REMOVAL'
  },
  {
    path: 'CLAUDE.md',
    reasonCode: 'LEGACY_TRACKED_CLAUDE_INSTRUCTIONS_OUTPUT_REMOVAL'
  },
  {
    path: PACKED_LEGACY_CHECKER_PATH,
    reasonCode: 'LEGACY_CHECKER_PACKED_RUNTIME_REMOVAL'
  }
]);
const PACKED_CHECKER_GUARD_REFERENCES = new Set([
  'soter/core/legacy-finalization.mjs',
  'soter/core/legacy-finalization.selftest.mjs',
  'soter/core/repository-cutover.mjs',
  'soter/kernel/legacy-checker-transition.mjs',
  'soter/kernel/legacy-checker-transition.selftest.mjs'
]);
const SOURCE_DEPENDENT_LEGACY_CHECKER_CLI_ROUTES = Object.freeze([
  ['legacy', 'checker', 'pre', 'removal', 'inspect'].join('-'),
  ['legacy', 'checker', 'pre', 'removal', 'run'].join('-'),
  ['legacy', 'checker', 'receipt', 'current'].join('-')
]);
const LEGACY_CLAUDE_HOST_GUARD_REFERENCES = new Set([
  'soter/core/fixtures.mjs',
  'soter/core/legacy-finalization.selftest.mjs',
  'soter/core/legacy-transition-finalization.selftest.mjs'
]);
const RECEIPT_ID_RE = /^legacy-checker-run[.][a-f0-9]{64}$/;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;

function managedHostOutputPaths(root) {
  const outputs = new Set();
  for (const host of ['codex', 'claude']) {
    try {
      const ownership = inspectManagedHostProjectionOwnership({ root, host });
      if (ownership.state !== 'realized') continue;
      for (const outputPath of ownership.outputPaths) outputs.add(outputPath);
    } catch {
      // Missing, stale, malformed, or drifted private ownership fails closed.
    }
  }
  return outputs;
}

const CLAUDE_HOST_COMPLETION_BINDINGS = Object.freeze([
  ['.claude/.claude-plugin/plugin.json', 'host.claude', 'soter/hosts/claude/adapter.json'],
  ['.claude/.mcp.json', 'host.claude', 'soter/hosts/claude/projection.json'],
  ['.claude/agents/eval-runner.md', 'host.claude', 'soter/hosts/claude/adapter.json'],
  ['.claude/hooks/hooks.json', 'host.claude', 'soter/hosts/claude/adapter.json'],
  ['.claude/rules/parallel-sessions.md', 'host.claude', 'soter/hosts/claude/adapter.json'],
  ['.claude/scripts/check.mjs', 'host.claude', 'soter/hosts/claude/adapter.json'],
  ['.claude/settings.json', 'host.claude', 'soter/hosts/claude/adapter.json'],
  ['.claude/systems/platform.md', 'host.claude', 'soter/hosts/claude/adapter.json']
].map(([sourcePath, targetId, targetPath]) => Object.freeze({
  sourcePath,
  targetId,
  targetPath
})));
const CLAUDE_HOST_COMPLETION_KEYS = new Set(CLAUDE_HOST_COMPLETION_BINDINGS.map((binding) => {
  return `${binding.sourcePath}\0${binding.targetId}\0${binding.targetPath}`;
}));

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function portable(relative) {
  return relative.split(path.sep).join('/');
}

function resolveRegularRepositoryFile(root, relative, label) {
  if (typeof relative !== 'string' || !relative.length) {
    fail('LEGACY_FINALIZATION_PATH_INVALID', `Missing ${label} path.`);
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const candidate = path.resolve(resolvedRoot, relative);
  const confined = path.relative(resolvedRoot, candidate);
  if (!confined || confined === '..' || confined.startsWith('..' + path.sep)
    || path.isAbsolute(confined) || !fs.existsSync(candidate)) {
    fail('LEGACY_FINALIZATION_PATH_INVALID', `${label} is missing or escapes the repository: ${relative}`);
  }
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    fail('LEGACY_FINALIZATION_PATH_INVALID', `${label} must be one regular non-symlink, non-hardlinked file: ${relative}`);
  }
  const real = fs.realpathSync(candidate);
  const realConfined = path.relative(resolvedRoot, real);
  if (!realConfined || realConfined === '..' || realConfined.startsWith('..' + path.sep)
    || path.isAbsolute(realConfined)) {
    fail('LEGACY_FINALIZATION_PATH_INVALID', `${label} resolves outside the repository: ${relative}`);
  }
  return candidate;
}

export function extractLegacyCheckerCodes(sourceText) {
  if (typeof sourceText !== 'string') {
    fail('LEGACY_CHECKER_SOURCE_INVALID', 'Legacy checker source must be text.');
  }
  return [...new Set([...sourceText.matchAll(
    /V\([^\n]*?['"]([A-Z][A-Z0-9_]*)['"]/g
  )].map((match) => match[1]))].sort(compareCodepoint);
}

function documentFingerprint(document) {
  const candidate = structuredClone(document);
  candidate.transitionFingerprint = null;
  return fingerprintJson(candidate);
}

function assertTransitionDocument(root, document) {
  const schema = readJson(path.join(root, TRANSITION_SCHEMA_PATH));
  const failures = validateJsonSchema(document, schema);
  if (failures.length) {
    fail(
      'LEGACY_CHECKER_TRANSITION_SCHEMA_INVALID',
      'Legacy checker transition schema failed: '
        + failures.slice(0, 3).map((item) => `${item.path} ${item.message}`).join('; ')
    );
  }
  const inventory = readJson(path.join(root, INVENTORY_PATH));
  const sourceItems = inventory.items.filter((item) => item.sourcePath === document.source.path);
  if (sourceItems.length !== 1
    || sourceItems[0].sourceFingerprint !== document.source.fingerprint) {
    fail(
      'LEGACY_CHECKER_TRANSITION_SOURCE_INVALID',
      'Transition source must match one exact governed legacy inventory item.'
    );
  }

  const sourceFile = path.join(root, document.source.path);
  let sourceCodes = null;
  if (fs.existsSync(sourceFile)) {
    const stat = fs.lstatSync(sourceFile);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
      || fingerprintFile(sourceFile) !== document.source.fingerprint) {
      fail('LEGACY_CHECKER_TRANSITION_SOURCE_INVALID', 'Present legacy checker bytes do not match the frozen transition source.');
    }
    sourceCodes = extractLegacyCheckerCodes(fs.readFileSync(sourceFile, 'utf8'));
  } else if (sourceItems[0].sourcePresence !== 'removed'
    || !['migrated', 'retired'].includes(sourceItems[0].state)
    || sourceItems[0].targets.some((binding) => {
      return !['migrated', 'retired'].includes(binding.state)
        || binding.fallback !== 'removed'
        || !binding.evidence.length;
    })) {
    fail('LEGACY_CHECKER_TRANSITION_SOURCE_INVALID', 'Removed legacy checker lacks one complete exact inventory tombstone.');
  }

  const ruleCodes = document.rules.map((rule) => rule.legacyCode);
  const sortedRuleCodes = [...ruleCodes].sort(compareCodepoint);
  if (new Set(ruleCodes).size !== 47
    || ruleCodes.some((code, index) => code !== sortedRuleCodes[index])
    || document.rules.some((rule, index) => rule.sequence !== index + 1)
    || fingerprintJson(sortedRuleCodes) !== document.source.effectiveCodesFingerprint
    || (sourceCodes && JSON.stringify(sourceCodes) !== JSON.stringify(sortedRuleCodes))) {
    fail('LEGACY_CHECKER_TRANSITION_COVERAGE_INVALID', 'Transition must cover the exact unique sorted frozen 47-code set once.');
  }
  const kernelRuleCount = document.rules.filter((rule) => rule.disposition === 'kernel-rule').length;
  const retirementCount = document.rules.length - kernelRuleCount;
  if (document.source.effectiveCodeCount !== ruleCodes.length
    || document.coverage.kernelRule !== kernelRuleCount
    || document.coverage.intentionalRetirement !== retirementCount
    || document.coverage.total !== ruleCodes.length) {
    fail('LEGACY_CHECKER_TRANSITION_COVERAGE_INVALID', 'Transition summary does not match its exact rule dispositions.');
  }

  for (const rule of document.rules) {
    if (rule.disposition !== 'kernel-rule') continue;
    for (const enforcement of rule.enforcements) {
      const target = resolveRegularRepositoryFile(root, enforcement.path, 'checker replacement');
      const text = fs.readFileSync(target, 'utf8');
      for (const anchor of enforcement.anchors) {
        if (!text.includes(anchor)) {
          fail(
            'LEGACY_CHECKER_TRANSITION_TARGET_INVALID',
            `${rule.legacyCode} replacement anchor is absent from ${enforcement.path}: ${anchor}`
          );
        }
      }
    }
  }
  if (document.transitionFingerprint !== documentFingerprint(document)) {
    fail('LEGACY_CHECKER_TRANSITION_FINGERPRINT_INVALID', 'Legacy checker transition fingerprint is stale.');
  }
  return document;
}

export function assertLegacyCheckerTransitionDocument(root, document) {
  return assertTransitionDocument(root, structuredClone(document));
}

export function assertLegacyCheckerTransitionCurrent(root = defaultRoot) {
  return assertTransitionDocument(root, readJson(path.join(root, TRANSITION_PATH)));
}

function schemaRegistry(root) {
  const registry = new Map();
  const directory = path.join(root, 'soter', 'contracts');
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.schema.json')) continue;
    const schema = readJson(path.join(directory, entry.name));
    if (typeof schema.$id === 'string') registry.set(schema.$id, schema);
  }
  return registry;
}

function exactTargetFingerprint(target) {
  if (target.$contract === 'soter://contracts/workflow-guide/v2') {
    if (!workflowGuideContentFingerprintMatches(target)) {
      fail('LEGACY_FINALIZATION_TARGET_INVALID', 'Workflow guide target content fingerprint is stale.');
    }
    return target.contentFingerprint;
  }
  return fingerprintJson(target);
}

function assertExactMigrationEvidence(
  root,
  item,
  targetPath,
  evidencePaths,
  registry = null,
  authorizationEvidenceOverlay = null
) {
  if (!Array.isArray(evidencePaths) || !evidencePaths.length
    || new Set(evidencePaths).size !== evidencePaths.length) {
    fail('LEGACY_FINALIZATION_EVIDENCE_INVALID', 'Finalization requires a non-empty unique evidence list.');
  }
  const targetFile = resolveRegularRepositoryFile(root, targetPath, 'migration target');
  const target = readJson(targetFile);
  const contracts = registry || schemaRegistry(root);
  const targetSchema = contracts.get(target.$contract);
  if (!targetSchema || validateJsonSchema(target, targetSchema).length) {
    fail('LEGACY_FINALIZATION_TARGET_INVALID', `Migration target does not satisfy one known contract: ${targetPath}`);
  }
  const targetFingerprint = exactTargetFingerprint(target);
  const evidenceSchema = readJson(path.join(root, EVIDENCE_SCHEMA_PATH));
  for (const evidencePath of evidencePaths) {
    const evidence = authorizationEvidenceOverlay?.get(evidencePath)
      || readJson(resolveRegularRepositoryFile(root, evidencePath, 'migration evidence'));
    if (validateJsonSchema(evidence, evidenceSchema).length
      || evidence.$contract !== 'soter://contracts/evidence/v2'
      || evidence.claimFamily !== 'migration'
      || evidence.result !== 'passed') {
      fail('LEGACY_FINALIZATION_EVIDENCE_INVALID', `Evidence is not one passed migration evidence/v2 record: ${evidencePath}`);
    }
    const exactSources = evidence.artifacts.filter((artifact) => {
      return artifact.role === 'migration-source'
        && artifact.path === item.sourcePath
        && artifact.fingerprint === item.sourceFingerprint;
    });
    const exactTargets = evidence.artifacts.filter((artifact) => {
      return artifact.role === 'migration-target'
        && artifact.path === targetPath
        && artifact.fingerprint === targetFingerprint;
    });
    if (exactSources.length !== 1 || exactTargets.length !== 1) {
      fail(
        'LEGACY_FINALIZATION_EVIDENCE_INVALID',
        `Evidence does not bind the exact migration source and target: ${evidencePath}`
      );
    }
  }
}

function aggregateState(targets) {
  const states = targets.map((target) => target.state);
  if (states.every((state) => state === 'retired')) return 'retired';
  if (states.every((state) => ['migrated', 'retired'].includes(state))) return 'migrated';
  if (states.some((state) => state !== 'mapped')) return 'bridged';
  return 'mapped';
}

function recomputeInventory(candidate) {
  candidate.items.forEach((item, sequence) => {
    item.sequence = sequence;
    item.state = aggregateState(item.targets);
  });
  candidate.stateCounts = { mapped: 0, bridged: 0, migrated: 0, retired: 0 };
  candidate.bindingStateCounts = { mapped: 0, bridged: 0, migrated: 0, retired: 0 };
  for (const item of candidate.items) {
    candidate.stateCounts[item.state] += 1;
    for (const binding of item.targets) candidate.bindingStateCounts[binding.state] += 1;
  }
  candidate.inventoryFingerprint = null;
  candidate.inventoryFingerprint = fingerprintJson(candidate);
  return candidate;
}

function transitionKey(transition) {
  return `${transition.sourcePath}\0${transition.targetId}\0${transition.targetPath}`;
}

function isClaudeHostCompletionBinding(sourcePath, targetId, targetPath) {
  return CLAUDE_HOST_COMPLETION_KEYS.has(`${sourcePath}\0${targetId}\0${targetPath}`);
}

function assertEvidencePathList(paths, field) {
  if (!Array.isArray(paths) || paths.length === 0
    || paths.some((value) => typeof value !== 'string' || value.length === 0)
    || new Set(paths).size !== paths.length) {
    fail(
      'LEGACY_FINALIZATION_TRANSITION_INVALID',
      `Finalization transition ${field} must be one non-empty unique path list.`
    );
  }
}

function assertNormalizedEvidencePath(relative, code, label) {
  if (!/^soter\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+[.]json$/.test(relative)
    || relative.includes('//')
    || relative.includes('\\')
    || relative.split('/').some((segment) => segment === '.' || segment === '..')
    || path.isAbsolute(relative)
    || portable(path.normalize(relative)) !== relative) {
    fail(code, `${label} is not one normalized repository-relative Soter JSON path: ${relative}`);
  }
  return relative;
}

function assertPlannedFinalEvidencePath(root, relative) {
  assertNormalizedEvidencePath(
    relative,
    'LEGACY_FINALIZATION_FINAL_EVIDENCE_PATH_INVALID',
    'Planned final evidence path'
  );
  if (!/^soter\/(?:fixtures|evidence)\//.test(relative)) {
    fail(
      'LEGACY_FINALIZATION_FINAL_EVIDENCE_PATH_INVALID',
      'Planned final evidence must be one normalized repository-relative JSON path under soter/fixtures or soter/evidence: '
        + String(relative)
    );
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const candidate = path.resolve(resolvedRoot, relative);
  const confined = path.relative(resolvedRoot, candidate);
  if (!confined || confined === '..' || confined.startsWith('..' + path.sep)
    || path.isAbsolute(confined)) {
    fail(
      'LEGACY_FINALIZATION_FINAL_EVIDENCE_PATH_INVALID',
      'Planned final evidence escapes the repository: ' + relative
    );
  }
  let current = resolvedRoot;
  for (const segment of relative.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(
        'LEGACY_FINALIZATION_FINAL_EVIDENCE_PATH_INVALID',
        'Planned final evidence has a symlinked or non-directory parent: ' + relative
      );
    }
  }
  if (fs.existsSync(candidate)) {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      fail(
        'LEGACY_FINALIZATION_FINAL_EVIDENCE_PATH_INVALID',
        'Existing planned final evidence path is not one regular file: ' + relative
      );
    }
  }
  return relative;
}

function assertCurrentAuthorizationEvidence(
  root,
  item,
  targetPath,
  evidencePaths,
  registry,
  authorizationEvidenceOverlay
) {
  for (const evidencePath of evidencePaths) {
    assertNormalizedEvidencePath(
      evidencePath,
      'LEGACY_FINALIZATION_AUTHORIZATION_EVIDENCE_INVALID',
      'Current authorization evidence path'
    );
  }
  try {
    assertExactMigrationEvidence(
      root,
      item,
      targetPath,
      evidencePaths,
      registry,
      authorizationEvidenceOverlay
    );
  } catch (error) {
    fail(
      'LEGACY_FINALIZATION_AUTHORIZATION_EVIDENCE_INVALID',
      'Current authorization evidence is missing, stale, malformed, or bound to a different source or target: '
        + String(error.message)
    );
  }
}

function normalizeAuthorizationEvidenceOverlay(transitions, overlay) {
  if (overlay === null) return null;
  if (!Array.isArray(overlay) || overlay.length === 0) {
    fail(
      'LEGACY_FINALIZATION_AUTHORIZATION_EVIDENCE_INVALID',
      'Authorization evidence overlay must be one non-empty sealed row set.'
    );
  }
  const expectedPaths = [...new Set(transitions.flatMap((transition) => {
    return transition.authorizationEvidence;
  }))].sort(compareCodepoint);
  const byPath = new Map();
  for (const row of overlay) {
    const keys = Object.keys(row || {}).sort(compareCodepoint);
    if (JSON.stringify(keys) !== JSON.stringify(['document', 'documentFingerprint', 'path'])
      || typeof row.document !== 'object'
      || row.document === null
      || Array.isArray(row.document)
      || !HASH_RE.test(row.documentFingerprint || '')) {
      fail(
        'LEGACY_FINALIZATION_AUTHORIZATION_EVIDENCE_INVALID',
        'Authorization evidence overlay row has an unknown, missing, or invalid field.'
      );
    }
    assertNormalizedEvidencePath(
      row.path,
      'LEGACY_FINALIZATION_AUTHORIZATION_EVIDENCE_INVALID',
      'Authorization evidence overlay path'
    );
    if (fingerprintJson(row.document) !== row.documentFingerprint || byPath.has(row.path)) {
      fail(
        'LEGACY_FINALIZATION_AUTHORIZATION_EVIDENCE_INVALID',
        'Authorization evidence overlay row is duplicated or has a stale document fingerprint.'
      );
    }
    byPath.set(row.path, structuredClone(row.document));
  }
  const observedPaths = [...byPath.keys()].sort(compareCodepoint);
  if (JSON.stringify(observedPaths) !== JSON.stringify(expectedPaths)) {
    fail(
      'LEGACY_FINALIZATION_AUTHORIZATION_EVIDENCE_INVALID',
      'Authorization evidence overlay is not exactly the current transition evidence path set.'
    );
  }
  return byPath;
}

function migrationBindingKey(sourcePath, targetId, targetPath) {
  return `${sourcePath}\0${targetId}\0${targetPath}`;
}

function migrationFiles(root) {
  const directory = path.join(root, MIGRATION_DIRECTORY);
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.migration.json'))
    .map((entry) => {
      const relativePath = `${MIGRATION_DIRECTORY}/${entry.name}`;
      if (!entry.isFile()) {
        fail(
          'LEGACY_FINALIZATION_MIGRATION_BINDING_INVALID',
          'Ordinary migration document is not one regular file: ' + relativePath
        );
      }
      resolveRegularRepositoryFile(root, relativePath, 'ordinary migration document');
      return relativePath;
    })
    .sort(compareCodepoint);
}

function assertCurrentMigrationBinding(item, binding, migrationItem, migrationPath) {
  const currentEvidence = migrationItem.evidence || [];
  if (migrationItem.sourcePath !== item.sourcePath
    || migrationItem.targetPath !== binding.path
    || migrationItem.targetPack !== binding.id
    || (migrationItem.sourceFingerprint !== undefined
      && migrationItem.sourceFingerprint !== item.sourceFingerprint)
    || migrationItem.state !== binding.state
    || fingerprintJson([...currentEvidence].sort(compareCodepoint))
      !== fingerprintJson([...binding.evidence].sort(compareCodepoint))) {
    fail(
      'LEGACY_FINALIZATION_MIGRATION_BINDING_INVALID',
      `Ordinary migration binding disagrees with current inventory: ${migrationPath}: ${item.sourcePath} -> ${binding.id} -> ${binding.path}`
    );
  }
}

function loadOrdinaryMigrationBasis(root, inventory) {
  const schema = readJson(path.join(root, MIGRATION_SCHEMA_PATH));
  const documents = new Map();
  const bindings = new Map();
  for (const relativePath of migrationFiles(root)) {
    const document = readJson(path.join(root, relativePath));
    const failures = validateJsonSchema(document, schema);
    if (failures.length || document.$contract !== 'soter://contracts/migration/v1') {
      fail(
        'LEGACY_FINALIZATION_MIGRATION_BINDING_INVALID',
        'Ordinary migration document is invalid: ' + relativePath
      );
    }
    documents.set(relativePath, {
      path: relativePath,
      document,
      fileFingerprint: fingerprintFile(path.join(root, relativePath)),
      documentFingerprint: fingerprintJson(document)
    });
    document.items.forEach((item, index) => {
      const key = migrationBindingKey(item.sourcePath, item.targetPack, item.targetPath);
      if (bindings.has(key)) {
        fail(
          'LEGACY_FINALIZATION_MIGRATION_BINDING_INVALID',
          'Ordinary migration binding is duplicated: ' + key.replaceAll('\0', ' -> ')
        );
      }
      bindings.set(key, { migrationPath: relativePath, index, item });
    });
  }

  const expected = new Map();
  for (const item of inventory.items) {
    for (const binding of item.targets) {
      const key = migrationBindingKey(item.sourcePath, binding.id, binding.path);
      if (isClaudeHostCompletionBinding(item.sourcePath, binding.id, binding.path)) continue;
      if (expected.has(key)) {
        fail(
          'LEGACY_FINALIZATION_MIGRATION_BINDING_INVALID',
          'Inventory ordinary migration binding is duplicated: ' + key.replaceAll('\0', ' -> ')
        );
      }
      expected.set(key, { source: item, binding });
      const observed = bindings.get(key);
      if (!observed) {
        fail(
          'LEGACY_FINALIZATION_MIGRATION_BINDING_INVALID',
          'Inventory binding has no exact ordinary migration item: ' + key.replaceAll('\0', ' -> ')
        );
      }
      assertCurrentMigrationBinding(item, binding, observed.item, observed.migrationPath);
    }
  }
  const unexpected = [...bindings.keys()].filter((key) => !expected.has(key));
  if (unexpected.length) {
    fail(
      'LEGACY_FINALIZATION_MIGRATION_BINDING_INVALID',
      'Ordinary migration item does not match one inventory binding: '
        + unexpected.sort(compareCodepoint)[0].replaceAll('\0', ' -> ')
    );
  }
  return { schema, documents, bindings, ordinaryBindingCount: expected.size };
}

function finalizedMigrationBridge(binding, transition) {
  const authority = transition.state === 'migrated'
    ? 'The exact target now owns this responsibility.'
    : 'This exact responsibility is intentionally retired and grants no replacement authority.';
  const parity = transition.parity === 'proven'
    ? 'The final evidence records proven parity.'
    : 'The final evidence records an intentional behavior change.';
  return `${authority} ${parity} The legacy source is retained only as an exact fingerprinted tombstone; no operational fallback remains. Scope: ${binding.responsibility}`;
}

function assertTransitionInput(transition) {
  const expectedKeys = [
    'authorizationEvidence',
    'finalEvidence',
    'parity',
    'sourcePath',
    'state',
    'targetId',
    'targetPath'
  ];
  const actualKeys = Object.keys(transition || {}).sort(compareCodepoint);
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
    || !['migrated', 'retired'].includes(transition.state)
    || !['proven', 'intentional-change'].includes(transition.parity)) {
    fail('LEGACY_FINALIZATION_TRANSITION_INVALID', 'Finalization transition has an unknown, missing, or invalid field.');
  }
  assertEvidencePathList(transition.authorizationEvidence, 'authorizationEvidence');
  assertEvidencePathList(transition.finalEvidence, 'finalEvidence');
}

function isWorkflowGuideOrEvaluationSource(sourcePath) {
  return /^\.claude\/skills\/[^/]+\/SKILL[.]md$/.test(sourcePath)
    || /^\.claude\/evals\/[^/]+\/[^/]+[.]md$/.test(sourcePath);
}

function assertCheckerReceiptReferenceShape(reference) {
  const keys = Object.keys(reference || {}).sort(compareCodepoint);
  if (JSON.stringify(keys) !== JSON.stringify(['id', 'receiptFingerprint'])
    || !RECEIPT_ID_RE.test(reference?.id || '')
    || !HASH_RE.test(reference?.receiptFingerprint || '')) {
    fail(
      'LEGACY_FINALIZATION_CHECKER_RECEIPT_REQUIRED',
      'Legacy checker removal requires one exact current private checker receipt reference.'
    );
  }
  return structuredClone(reference);
}

function exactCheckerReceiptReference(root, reference) {
  const exactReference = assertCheckerReceiptReferenceShape(reference);
  let inspected;
  try {
    inspected = inspectCurrentLegacyCheckerRunReceipt({ root, receiptId: exactReference.id });
  } catch (error) {
    fail(
      'LEGACY_FINALIZATION_CHECKER_RECEIPT_INVALID',
      'Legacy checker removal requires the exact current clean pre-removal receipt: '
        + String(error.code || 'invalid')
    );
  }
  if (inspected.receipt.receiptFingerprint !== exactReference.receiptFingerprint) {
    fail(
      'LEGACY_FINALIZATION_CHECKER_RECEIPT_INVALID',
      'Legacy checker receipt fingerprint does not match the exact current receipt.'
    );
  }
  const governedProjection = projectLegacyCheckerRunReceipt({
    root,
    receipt: inspected.receipt
  });
  return {
    id: inspected.receipt.id,
    receiptFingerprint: inspected.receipt.receiptFingerprint,
    observedAt: inspected.receipt.observedAt,
    checkerFingerprint: inspected.receipt.basis.checker.fingerprint,
    inputTreeFingerprint: inspected.receipt.basis.checkerVisibleInputTree.treeFingerprint,
    temporaryCrmVocabularyFingerprint:
      inspected.receipt.basis.temporaryCrmVocabulary.fingerprint,
    temporaryCrmVocabularyBaseFingerprint:
      inspected.receipt.basis.temporaryCrmVocabulary.baseFingerprint,
    authority: 'none',
    governedProjection: {
      path: LEGACY_CHECKER_RUN_PROJECTION_PATH,
      fingerprint: governedProjection.projectionFingerprint,
      document: governedProjection
    }
  };
}

export function buildLegacyFinalizationCandidate(
  root = defaultRoot,
  transitions = [],
  checkerReceipt = null,
  authorizationEvidenceOverlay = null
) {
  if (!Array.isArray(transitions) || !transitions.length) {
    fail('LEGACY_FINALIZATION_TRANSITION_INVALID', 'At least one exact finalization transition is required.');
  }
  transitions.forEach(assertTransitionInput);
  const removesLegacyChecker = transitions.some((transition) => {
    return transition.sourcePath === LEGACY_CHECKER_SOURCE_PATH;
  });
  if (!removesLegacyChecker && checkerReceipt !== null) {
    fail(
      'LEGACY_FINALIZATION_CHECKER_RECEIPT_UNEXPECTED',
      'A legacy checker receipt may be supplied only with the exact checker-source transition.'
    );
  }
  if (removesLegacyChecker) assertCheckerReceiptReferenceShape(checkerReceipt);
  transitions = transitions.map((transition) => ({
    ...structuredClone(transition),
    authorizationEvidence: [...transition.authorizationEvidence].sort(compareCodepoint),
    finalEvidence: [...transition.finalEvidence].sort(compareCodepoint)
  }));
  const exactAuthorizationEvidenceOverlay = normalizeAuthorizationEvidenceOverlay(
    transitions,
    authorizationEvidenceOverlay
  );
  const current = exactAuthorizationEvidenceOverlay
    ? assertLegacyInventoryStructureCurrent(root)
    : assertLegacyInventoryCurrent(root);
  const checkerRun = removesLegacyChecker
    ? exactCheckerReceiptReference(root, checkerReceipt)
    : null;
  const migrationBasis = loadOrdinaryMigrationBasis(root, current);
  const byKey = new Map();
  const plannedPaths = new Map();
  const authorizationPaths = new Set();
  const currentEvidencePaths = new Set(current.items.flatMap((item) => {
    return item.targets.flatMap((binding) => binding.evidence.map((evidencePath) => {
      return evidencePath.toLowerCase();
    }));
  }));
  for (const transition of transitions) {
    for (const evidencePath of transition.authorizationEvidence) {
      authorizationPaths.add(evidencePath.toLowerCase());
    }
  }
  for (const transition of transitions) {
    const key = transitionKey(transition);
    if (byKey.has(key)) {
      fail('LEGACY_FINALIZATION_TRANSITION_INVALID', 'Finalization transition is duplicated: ' + key.replaceAll('\0', ' -> '));
    }
    byKey.set(key, transition);
    for (const evidencePath of transition.finalEvidence) {
      assertPlannedFinalEvidencePath(root, evidencePath);
      const collisionKey = evidencePath.toLowerCase();
      if (authorizationPaths.has(collisionKey)) {
        fail(
          'LEGACY_FINALIZATION_FINAL_EVIDENCE_COLLISION',
          'Planned final evidence collides with current authorization evidence: ' + evidencePath
        );
      }
      if (currentEvidencePaths.has(collisionKey)) {
        fail(
          'LEGACY_FINALIZATION_FINAL_EVIDENCE_COLLISION',
          'Planned final evidence collides with one existing inventory evidence reference: '
            + evidencePath
        );
      }
      const owner = plannedPaths.get(collisionKey);
      if (owner) {
        const exactSharedSet = owner.path === evidencePath
          && isWorkflowGuideOrEvaluationSource(owner.sourcePath)
          && isWorkflowGuideOrEvaluationSource(transition.sourcePath)
          && owner.targetId === transition.targetId
          && owner.state === transition.state
          && owner.parity === transition.parity
          && fingerprintJson(owner.finalEvidence) === fingerprintJson(transition.finalEvidence);
        if (!exactSharedSet) {
          fail(
            'LEGACY_FINALIZATION_FINAL_EVIDENCE_COLLISION',
            `Planned final evidence path is case-colliding or shared across incompatible owners: ${evidencePath}; first owner ${owner.key.replaceAll('\0', ' -> ')}`
          );
        }
        continue;
      }
      plannedPaths.set(collisionKey, {
        key,
        path: evidencePath,
        sourcePath: transition.sourcePath,
        targetId: transition.targetId,
        state: transition.state,
        parity: transition.parity,
        finalEvidence: [...transition.finalEvidence]
      });
    }
  }
  const candidate = structuredClone(current);
  const registry = schemaRegistry(root);
  const deletePaths = new Set();
  const sourceDeletions = new Map();
  const used = new Set();
  const migrationCandidates = new Map();

  for (const item of candidate.items) {
    const itemTransitions = transitions.filter((transition) => transition.sourcePath === item.sourcePath);
    if (!itemTransitions.length) continue;
    if (item.sourcePresence !== 'present') {
      fail('LEGACY_FINALIZATION_TRANSITION_INVALID', 'Finalization source is not a present exact fallback: ' + item.sourcePath);
    }
    const sourceFile = resolveRegularRepositoryFile(root, item.sourcePath, 'legacy source');
    if (fingerprintFile(sourceFile) !== item.sourceFingerprint) {
      fail('LEGACY_FINALIZATION_SOURCE_INVALID', 'Legacy source bytes drifted before finalization: ' + item.sourcePath);
    }
    for (const binding of item.targets) {
      if (['migrated', 'retired'].includes(binding.state)) continue;
      const key = `${item.sourcePath}\0${binding.id}\0${binding.path}`;
      const transition = byKey.get(key);
      if (!transition) {
        fail(
          'LEGACY_FINALIZATION_PARTIAL_SOURCE',
          `Every unfinished responsibility must finish before removing ${item.sourcePath}: ${binding.id} -> ${binding.path}`
        );
      }
      if (fingerprintJson(transition.authorizationEvidence)
        !== fingerprintJson([...binding.evidence].sort(compareCodepoint))) {
        fail(
          'LEGACY_FINALIZATION_AUTHORIZATION_EVIDENCE_INVALID',
          `Authorization evidence is not the exact current inventory evidence set: ${item.sourcePath} -> ${binding.id} -> ${binding.path}`
        );
      }
      assertCurrentAuthorizationEvidence(
        root,
        item,
        binding.path,
        transition.authorizationEvidence,
        registry,
        exactAuthorizationEvidenceOverlay
      );
      binding.status = 'existing';
      binding.state = transition.state;
      binding.canonicalAuthority = transition.state === 'migrated' ? 'target' : 'none';
      binding.fallback = 'removed';
      binding.parity = transition.parity;
      binding.evidence = [...transition.finalEvidence];

      if (!isClaudeHostCompletionBinding(item.sourcePath, binding.id, binding.path)) {
        const migrationBinding = migrationBasis.bindings.get(key);
        if (!migrationBinding) {
          fail(
            'LEGACY_FINALIZATION_MIGRATION_BINDING_INVALID',
            'Finalization transition has no exact ordinary migration binding: '
              + key.replaceAll('\0', ' -> ')
          );
        }
        let migrationCandidate = migrationCandidates.get(migrationBinding.migrationPath);
        if (!migrationCandidate) {
          migrationCandidate = structuredClone(
            migrationBasis.documents.get(migrationBinding.migrationPath).document
          );
          migrationCandidates.set(migrationBinding.migrationPath, migrationCandidate);
        }
        const migrationItem = migrationCandidate.items[migrationBinding.index];
        if (migrationBindingKey(
          migrationItem.sourcePath,
          migrationItem.targetPack,
          migrationItem.targetPath
        ) !== key) {
          fail(
            'LEGACY_FINALIZATION_MIGRATION_BINDING_INVALID',
            'Ordinary migration item shifted while constructing the deterministic plan: '
              + key.replaceAll('\0', ' -> ')
          );
        }
        migrationItem.sourceFingerprint = item.sourceFingerprint;
        migrationItem.state = transition.state;
        migrationItem.bridge = finalizedMigrationBridge(binding, transition);
        migrationItem.evidence = [...transition.finalEvidence];
      }
      used.add(key);
    }
    item.sourcePresence = 'removed';
    item.state = aggregateState(item.targets);
    if (!['migrated', 'retired'].includes(item.state)) {
      fail('LEGACY_FINALIZATION_PARTIAL_SOURCE', 'Finalization left an operational fallback binding: ' + item.sourcePath);
    }
    deletePaths.add(item.sourcePath);
    sourceDeletions.set(item.sourcePath, {
      path: item.sourcePath,
      fingerprint: item.sourceFingerprint
    });
  }
  const unused = [...byKey.keys()].filter((key) => !used.has(key));
  if (unused.length) {
    fail('LEGACY_FINALIZATION_TRANSITION_INVALID', 'Finalization transition does not match one unfinished exact binding: ' + unused[0].replaceAll('\0', ' -> '));
  }

  recomputeInventory(candidate);
  const inventorySchema = readJson(path.join(root, INVENTORY_SCHEMA_PATH));
  const failures = validateJsonSchema(candidate, inventorySchema);
  if (failures.length) {
    fail(
      'LEGACY_FINALIZATION_CANDIDATE_INVALID',
      'Final inventory candidate violates legacy-inventory/v2: '
      + failures.slice(0, 3).map((item) => `${item.path} ${item.message}`).join('; ')
    );
  }

  const migrationUpdates = [...migrationCandidates].map(([migrationPath, document]) => {
    const validation = validateJsonSchema(document, migrationBasis.schema);
    if (validation.length) {
      fail(
        'LEGACY_FINALIZATION_MIGRATION_BINDING_INVALID',
        'Final ordinary migration candidate is invalid: ' + migrationPath + ': '
          + validation.slice(0, 3).map((item) => `${item.path} ${item.message}`).join('; ')
      );
    }
    const basis = migrationBasis.documents.get(migrationPath);
    return {
      path: migrationPath,
      currentFileFingerprint: basis.fileFingerprint,
      currentDocumentFingerprint: basis.documentFingerprint,
      candidateDocumentFingerprint: fingerprintJson(document),
      document
    };
  }).sort((left, right) => compareCodepoint(left.path, right.path));
  const sortedDeletePaths = [...deletePaths].sort(compareCodepoint);
  const finalEvidencePaths = [...new Set(candidate.items.flatMap((item) => {
    return item.targets
      .filter((binding) => ['migrated', 'retired'].includes(binding.state))
      .flatMap((binding) => binding.evidence);
  }))]
    .sort(compareCodepoint);
  const plan = {
    contract: 'legacy-finalization-plan/v1',
    state: 'planned',
    authority: {
      kind: 'none',
      writesRepository: false,
      deletesSources: false,
      generatesEvidence: false,
      executesMigration: false,
      removesFallbacks: false
    },
    basis: {
      inventoryPath: INVENTORY_PATH,
      inventoryFingerprint: current.inventoryFingerprint,
      authorizationEvidence: exactAuthorizationEvidenceOverlay
        ? {
            kind: 'sealed-in-memory-overlay',
            evidenceCount: exactAuthorizationEvidenceOverlay.size,
            overlayFingerprint: fingerprintJson(
              [...exactAuthorizationEvidenceOverlay.entries()]
                .sort(([left], [right]) => compareCodepoint(left, right))
                .map(([evidencePath, document]) => ({
                  path: evidencePath,
                  documentFingerprint: fingerprintJson(document),
                  document
                }))
            )
          }
        : {
            kind: 'governed-files',
            evidenceCount: authorizationPaths.size,
            overlayFingerprint: null
          },
      legacyCheckerRun: checkerRun,
      ordinaryMigrationDocuments: [...migrationBasis.documents.values()].map((entry) => ({
        path: entry.path,
        fileFingerprint: entry.fileFingerprint,
        documentFingerprint: entry.documentFingerprint,
        itemCount: entry.document.items.length
      })).sort((left, right) => compareCodepoint(left.path, right.path)),
      ordinaryMigrationBindingCount: migrationBasis.ordinaryBindingCount
    },
    inventoryUpdate: {
      path: INVENTORY_PATH,
      currentFileFingerprint: fingerprintFile(path.join(root, INVENTORY_PATH)),
      currentFingerprint: current.inventoryFingerprint,
      candidateFingerprint: candidate.inventoryFingerprint
    },
    bindingTransitions: transitions.map((transition) => ({
      sourcePath: transition.sourcePath,
      targetId: transition.targetId,
      targetPath: transition.targetPath,
      state: transition.state,
      parity: transition.parity,
      authorizationEvidence: [...transition.authorizationEvidence],
      finalEvidence: [...transition.finalEvidence]
    })).sort((left, right) => compareCodepoint(transitionKey(left), transitionKey(right))),
    candidate,
    migrationUpdates,
    sourceDeletions: [...sourceDeletions.values()].sort((left, right) => {
      return compareCodepoint(left.path, right.path);
    }),
    requiredOperationalDeletions: removesLegacyChecker
      ? RECEIPT_GATED_OPERATIONAL_DELETIONS.map((entry) => ({ ...entry }))
      : [],
    requiredGovernedOutputs: checkerRun
      ? [structuredClone(checkerRun.governedProjection)]
      : [],
    deletePaths: sortedDeletePaths,
    finalEvidencePaths,
    summary: {
      transitionCount: transitions.length,
      sourceDeletionCount: sortedDeletePaths.length,
      operationalDeletionCount: removesLegacyChecker
        ? RECEIPT_GATED_OPERATIONAL_DELETIONS.length
        : 0,
      governedOutputCount: checkerRun ? 1 : 0,
      ordinaryMigrationUpdateCount: migrationUpdates.length,
      finalEvidenceOutputCount: finalEvidencePaths.length
    },
    limitations: [
      'This deterministic plan validates current authorization evidence and plans final evidence paths, inventory updates, ordinary migration updates, and exact source deletions; it writes, deletes, generates, promotes, or executes nothing.',
      'Planned final evidence paths are not evidence until their exact bodies independently validate against the final graph and every final inventory and migration reference.'
    ],
    planFingerprint: null
  };
  plan.planFingerprint = fingerprintJson(plan);
  return plan;
}

function blocker(code, detail) {
  return { code, detail };
}

function exactTextReferences(root, needle) {
  const references = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile() || !/[.](?:json|mjs|md)$/.test(entry.name)) continue;
      if (fs.readFileSync(absolute, 'utf8').includes(needle)) {
        references.push(portable(path.relative(root, absolute)));
      }
    }
  };
  visit(path.join(root, 'soter'));
  return references.sort(compareCodepoint);
}

function exactRepositoryTextReferences(root, needle) {
  const references = [];
  const skipDirectories = new Set(['.git', '.claude', '.soter', 'node_modules']);
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && skipDirectories.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile() || !/[.](?:json|mjs|md)$/.test(entry.name)) continue;
      if (fs.readFileSync(absolute, 'utf8').includes(needle)) {
        references.push(portable(path.relative(root, absolute)));
      }
    }
  };
  visit(path.resolve(root));
  return references.sort(compareCodepoint);
}

function legacyClaudeHostCleanupDecision(root, inventory) {
  const legacyName = ['legacy', 'claude', 'host'].join('-');
  const fixturePrefix = `soter/fixtures/${legacyName}/`;
  const legacyConfigurationPath = `soter/configurations/${legacyName}.config.json`;
  const legacyFixtureDirectory = fixturePrefix.slice(0, -1);
  const targetConfigurationPath = 'soter/configurations/claude-host-projection.config.json';
  const targetFixtureDirectory = 'soter/fixtures/claude-host-projection';
  const relevantBindings = [];
  for (const item of inventory.items) {
    for (const binding of item.targets) {
      if (binding.id !== 'host.claude'
        || !['soter/hosts/claude/adapter.json', 'soter/hosts/claude/projection.json']
          .includes(binding.path)) {
        continue;
      }
      relevantBindings.push({
        sourcePath: item.sourcePath,
        sourceFingerprint: item.sourceFingerprint,
        sourcePresence: item.sourcePresence,
        sourceState: item.state,
        targetId: binding.id,
        targetPath: binding.path,
        state: binding.state,
        canonicalAuthority: binding.canonicalAuthority,
        fallback: binding.fallback,
        parity: binding.parity,
        evidence: [...binding.evidence]
      });
    }
  }
  relevantBindings.sort((left, right) => {
    return compareCodepoint(transitionKey(left), transitionKey(right));
  });
  const observedKeys = relevantBindings.map(transitionKey);
  const expectedKeys = CLAUDE_HOST_COMPLETION_BINDINGS.map(transitionKey).sort(compareCodepoint);
  const exactBindingSet = JSON.stringify(observedKeys) === JSON.stringify(expectedKeys);
  const byKey = new Map(relevantBindings.map((binding) => [transitionKey(binding), binding]));
  const bindings = CLAUDE_HOST_COMPLETION_BINDINGS.map((expected) => {
    return byKey.get(transitionKey(expected));
  }).filter(Boolean);
  const incompleteBindings = bindings.filter((binding) => {
    return binding.sourcePresence !== 'removed'
      || !['migrated', 'retired'].includes(binding.sourceState)
      || !['migrated', 'retired'].includes(binding.state)
      || binding.canonicalAuthority !== (binding.state === 'migrated' ? 'target' : 'none')
      || binding.fallback !== 'removed'
      || !['proven', 'intentional-change'].includes(binding.parity)
      || binding.evidence.length === 0;
  });
  const allReferences = exactTextReferences(root, legacyName);
  const historicalGuardReferences = allReferences.filter((reference) => {
    return LEGACY_CLAUDE_HOST_GUARD_REFERENCES.has(reference);
  });
  const exactOperationalReferences = allReferences.filter((reference) => {
    return !LEGACY_CLAUDE_HOST_GUARD_REFERENCES.has(reference);
  });
  const legacyConfigurationPresent = fs.existsSync(path.join(root, legacyConfigurationPath));
  const legacyFixtureRoot = path.join(root, legacyFixtureDirectory);
  const legacyFixtureEntries = fs.existsSync(legacyFixtureRoot)
    ? fs.readdirSync(legacyFixtureRoot).sort(compareCodepoint)
    : [];
  const targetConfigurationPresent = fs.existsSync(path.join(root, targetConfigurationPath));
  const targetFixtureRoot = path.join(root, targetFixtureDirectory);
  const targetFixturePresent = fs.existsSync(targetFixtureRoot)
    && fs.lstatSync(targetFixtureRoot).isDirectory()
    && fs.readdirSync(targetFixtureRoot).length > 0;
  const complete = exactBindingSet
    && bindings.length === CLAUDE_HOST_COMPLETION_BINDINGS.length
    && incompleteBindings.length === 0
    && !legacyConfigurationPresent
    && legacyFixtureEntries.length === 0
    && exactOperationalReferences.length === 0
    && targetConfigurationPresent
    && targetFixturePresent;
  return {
    id: 'claude-host-projection-configuration-reframe',
    state: complete ? 'complete' : 'required',
    reasonCode: complete
      ? 'LEGACY_HOST_CONFIGURATION_REFRAME_COMPLETE'
      : 'LEGACY_HOST_CONFIGURATION_IDENTITY_RETAINED',
    current: {
      configurationPath: legacyConfigurationPath,
      configurationName: legacyName,
      fixtureDirectory: legacyFixtureDirectory,
      configurationState: legacyConfigurationPresent ? 'present' : 'absent',
      fixtureEntryCount: legacyFixtureEntries.length,
      operationalUse: complete ? 'none' : 'legacy identity remains operational'
    },
    target: {
      configurationPath: targetConfigurationPath,
      configurationName: 'claude-host-projection',
      fixtureDirectory: targetFixtureDirectory,
      configurationState: targetConfigurationPresent ? 'present' : 'absent',
      fixtureState: targetFixturePresent ? 'present' : 'absent',
      claimBoundary: 'Static host-projection migration evidence only; no host launch, realization, tool authentication, readiness, verification, or health authority.'
    },
    exactReferences: allReferences,
    exactOperationalReferences,
    historicalGuardReferences,
    exactBindingSet,
    bindings,
    historicalProvenance: {
      retainSourcePathsAndFingerprints: true,
      renameHistoricalSourcePaths: false,
      rule: 'The eight .claude source paths remain exact migration-source tombstone facts after their operational files are removed.'
    },
    finalization: {
      automaticPromotion: false,
      rule: 'The rename or fixture regeneration does not finish any host binding. Each of the eight source responsibilities still requires exact current migration evidence, target authority or explicit retirement, fallback removal, parity or intentional-change disposition, and complete source removal in one finalization candidate.'
    },
    blockers: [
      ...(legacyConfigurationPresent
        ? [blocker('LEGACY_HOST_CONFIGURATION_RENAME_REQUIRED', legacyConfigurationPath)]
        : []),
      ...(legacyFixtureEntries.length
        ? [blocker('LEGACY_HOST_FIXTURE_NAMESPACE_REGENERATION_REQUIRED', legacyFixtureDirectory)]
        : []),
      ...(incompleteBindings.length
        ? [blocker('LEGACY_HOST_BINDINGS_NOT_FINAL', String(incompleteBindings.length))]
        : []),
      ...(!targetConfigurationPresent
        ? [blocker('LEGACY_HOST_TARGET_CONFIGURATION_MISSING', targetConfigurationPath)]
        : []),
      ...(!targetFixturePresent
        ? [blocker('LEGACY_HOST_TARGET_FIXTURE_MISSING', targetFixtureDirectory)]
        : []),
      ...exactOperationalReferences.map((reference) => {
        return blocker('LEGACY_HOST_OPERATIONAL_REFERENCE_REMAINS', reference);
      }),
      ...(!exactBindingSet
        ? [blocker('LEGACY_HOST_BINDING_SET_DRIFT', observedKeys.join(', '))]
        : [])
    ]
  };
}

function legacyCheckerRemovalDecision(root, inventory) {
  const checkerPath = PACKED_LEGACY_CHECKER_PATH;
  const checkerSourcePath = LEGACY_CHECKER_SOURCE_PATH;
  const source = inventory.items.find((item) => item.sourcePath === checkerSourcePath);
  const completed = source?.sourcePresence === 'removed'
    && ['migrated', 'retired'].includes(source.state)
    && source.targets.every((binding) => {
      return ['migrated', 'retired'].includes(binding.state)
        && binding.fallback === 'removed'
        && binding.evidence.length > 0;
    });
  let exactReceipt = null;
  try {
    const directory = path.join(root, '.soter/state/legacy-checker-runs');
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
    if (entries.length === 1) {
      const receiptId = entries[0].name.slice(0, -'.json'.length);
      const inspected = inspectLegacyCheckerRunReceipt({ root, receiptId });
      if (inspected.receipt.basis.checker.fingerprint === source?.sourceFingerprint) {
        exactReceipt = {
          id: inspected.receipt.id,
          receiptFingerprint: inspected.receipt.receiptFingerprint,
          inputTreeFingerprint:
            inspected.receipt.basis.checkerVisibleInputTree.treeFingerprint
        };
      }
    }
  } catch {
    exactReceipt = null;
  }
  let governedProjection = null;
  try {
    const projection = inspectLegacyCheckerRunProjection({ root });
    if (projection.basis.checker.fingerprint === source?.sourceFingerprint) {
      governedProjection = {
        id: projection.id,
        projectionFingerprint: projection.projectionFingerprint,
        receiptId: projection.receipt.id,
        receiptFingerprint: projection.receipt.fingerprint,
        inputTreeFingerprint: projection.basis.checkerVisibleInputTree.treeFingerprint
      };
    }
  } catch {
    governedProjection = null;
  }
  const managedOutputs = managedHostOutputPaths(root);
  const remainingOperationalDeletions = RECEIPT_GATED_OPERATIONAL_DELETIONS.filter((entry) => {
    try {
      fs.lstatSync(path.join(root, entry.path));
      return !managedOutputs.has(entry.path);
    } catch (error) {
      return error?.code !== 'ENOENT';
    }
  });
  const routeReferences = SOURCE_DEPENDENT_LEGACY_CHECKER_CLI_ROUTES.flatMap((route) => {
    return exactRepositoryTextReferences(root, route);
  });
  const allReferences = [...new Set([
    ...exactRepositoryTextReferences(root, checkerPath),
    ...routeReferences
  ])].sort(compareCodepoint);
  const historicalGuardReferences = allReferences.filter((reference) => {
    return PACKED_CHECKER_GUARD_REFERENCES.has(reference);
  });
  const references = allReferences.filter((reference) => {
    return !PACKED_CHECKER_GUARD_REFERENCES.has(reference);
  });
  const cutoverComplete = completed
    && governedProjection !== null
    && remainingOperationalDeletions.length === 0
    && references.length === 0;
  return {
    id: 'legacy-checker-operational-removal',
    state: cutoverComplete ? 'complete' : 'required',
    reasonCode: cutoverComplete
      ? 'LEGACY_CHECKER_RECEIPT_GATED_CUTOVER_COMPLETE'
      : 'LEGACY_CHECKER_OPERATIONAL_DEPENDENCY_REMAINS',
    immutableSource: {
      path: checkerSourcePath,
      fingerprint: source?.sourceFingerprint || null,
      finalRunRecorded: exactReceipt !== null || governedProjection !== null,
      receipt: exactReceipt,
      governedProjection,
      rule: 'Run the immutable v1 checker exactly once immediately before source deletion; bind that exact result and the target-only transition catalog in final migration evidence.'
    },
    targetOnlyReplacement: {
      catalog: TRANSITION_PATH,
      module: 'soter/kernel/legacy-checker-transition.mjs',
      selftest: 'soter/kernel/legacy-checker-transition.selftest.mjs',
      invokesLegacyChecker: false
    },
    exactOperationalReferences: references,
    historicalGuardReferences,
    requiredOperationalDeletions: RECEIPT_GATED_OPERATIONAL_DELETIONS.map((entry) => ({
      ...entry,
      state: remainingOperationalDeletions.some((remaining) => remaining.path === entry.path)
        ? 'present'
        : 'absent'
    })),
    requiredRemoval: {
      implementation: checkerPath,
      kernelPackArtifact: 'Remove the legacy implementation entry and declare the transition schema, catalog, module, and selftest.',
      packageScripts: 'Remove soter:legacy-check commands or replace them with target-only transition and inventory commands.',
      fixtureGenerator: 'Replace the Email completion assertion that requires legacy-check.mjs in the Kernel pack with the target-only transition catalog/module assertion.',
      generatedLocks: 'Regenerate once after the Kernel artifact graph no longer contains legacy-check.mjs.',
      documentation: 'Remove commands that invoke legacy-check.mjs; historical source identity remains only in tombstones and evidence.'
    },
    bindings: structuredClone(source?.targets || []),
    blockers: [
      ...(exactReceipt === null && governedProjection === null
        ? [blocker('LEGACY_CHECKER_FINAL_RUN_RECEIPT_REQUIRED', checkerSourcePath)]
        : []),
      ...(!completed
        ? [blocker('LEGACY_CHECKER_FINAL_MIGRATION_EVIDENCE_REQUIRED', checkerSourcePath)]
        : []),
      ...remainingOperationalDeletions.map((entry) => blocker(
        entry.path === PACKED_LEGACY_CHECKER_PATH
          ? 'LEGACY_CHECKER_PACKED_RUNTIME_REMAINS'
          : entry.reasonCode,
        entry.path
      )),
      ...(references.length
        ? [blocker('LEGACY_CHECKER_OPERATIONAL_REFERENCES_REMAIN', String(references.length))]
        : [])
    ]
  };
}

function bindingFinalizationBlockers(root, item, binding, registry) {
  const blockers = [];
  if (binding.status !== 'existing') blockers.push(blocker('LEGACY_TARGET_NOT_EXISTING', binding.status));
  if (!['migrated', 'retired'].includes(binding.state)) blockers.push(blocker('LEGACY_BINDING_NOT_FINAL', binding.state));
  const expectedAuthority = binding.state === 'migrated' ? 'target'
    : binding.state === 'retired' ? 'none' : null;
  if (!expectedAuthority || binding.canonicalAuthority !== expectedAuthority) {
    blockers.push(blocker('LEGACY_AUTHORITY_NOT_FINAL', binding.canonicalAuthority));
  }
  if (binding.fallback !== 'removed') blockers.push(blocker('LEGACY_FALLBACK_RETAINED', binding.fallback));
  if (!['proven', 'intentional-change'].includes(binding.parity)) {
    blockers.push(blocker('LEGACY_PARITY_NOT_DECIDED', binding.parity));
  }
  try {
    assertExactMigrationEvidence(root, item, binding.path, binding.evidence, registry);
  } catch (error) {
    blockers.push(blocker('LEGACY_MIGRATION_EVIDENCE_NOT_FINAL', error.code || 'invalid'));
  }
  return blockers;
}

export function inspectLegacyFinalizationBlockers(root = defaultRoot) {
  const inventory = readJson(path.join(root, INVENTORY_PATH));
  let freshness = { state: 'current', reasonCode: null, reason: null };
  try {
    assertLegacyInventoryCurrent(root);
  } catch (error) {
    freshness = {
      state: 'stale',
      reasonCode: 'LEGACY_INVENTORY_STALE',
      reason: String(error.message)
    };
  }
  const registry = schemaRegistry(root);
  const items = [];
  for (const item of inventory.items) {
    const bindings = item.targets.map((binding) => ({
      id: binding.id,
      path: binding.path,
      blockers: bindingFinalizationBlockers(root, item, binding, registry)
    })).filter((binding) => binding.blockers.length);
    const sourceBlockers = [];
    if (item.sourcePresence !== 'removed') {
      sourceBlockers.push(blocker('LEGACY_SOURCE_PRESENT', item.sourcePath));
    }
    if (!['migrated', 'retired'].includes(item.state)) {
      sourceBlockers.push(blocker('LEGACY_SOURCE_STATE_NOT_FINAL', item.state));
    }
    if (sourceBlockers.length || bindings.length) {
      items.push({
        sourcePath: item.sourcePath,
        sourceFingerprint: item.sourceFingerprint,
        sourceBlockers,
        bindings
      });
    }
  }
  const incompleteBindings = items.reduce((count, item) => count + item.bindings.length, 0);
  const inventoryRemainingArtifacts = inventory.stateCounts.mapped + inventory.stateCounts.bridged;
  const inventoryRemainingBindings = inventory.bindingStateCounts.mapped
    + inventory.bindingStateCounts.bridged;
  return {
    contract: 'legacy-finalization-blocker-report/v1',
    inventoryFingerprint: inventory.inventoryFingerprint,
    freshness,
    goal: {
      artifacts: inventory.basis.fileCount,
      mapped: 0,
      bridged: 0,
      migratedOrRetired: inventory.basis.fileCount
    },
    remaining: {
      inventoryArtifacts: inventoryRemainingArtifacts,
      inventoryBindings: inventoryRemainingBindings,
      revalidationBlockedArtifacts: items.length,
      revalidationBlockedBindings: incompleteBindings
    },
    current: {
      stateCounts: structuredClone(inventory.stateCounts),
      bindingStateCounts: structuredClone(inventory.bindingStateCounts)
    },
    cleanupDecisions: [
      legacyClaudeHostCleanupDecision(root, inventory),
      legacyCheckerRemovalDecision(root, inventory)
    ],
    items
  };
}

function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex === -1 ? defaultRoot : path.resolve(args[rootIndex + 1]);
  if (args.includes('--blockers')) {
    process.stdout.write(JSON.stringify(inspectLegacyFinalizationBlockers(root), null, 2) + '\n');
    return;
  }
  const candidateIndex = args.indexOf('--candidate');
  if (candidateIndex !== -1) {
    const requestPath = args[candidateIndex + 1];
    if (!requestPath) fail('LEGACY_FINALIZATION_TRANSITION_INVALID', '--candidate requires one JSON transition request path.');
    const requestFile = resolveRegularRepositoryFile(root, portable(requestPath), 'finalization request');
    const request = readJson(requestFile);
    const requestKeys = Object.keys(request || {}).sort(compareCodepoint);
    if (JSON.stringify(requestKeys) !== JSON.stringify(['checkerReceipt', 'transitions'])) {
      fail(
        'LEGACY_FINALIZATION_TRANSITION_INVALID',
        'Finalization request requires exactly transitions and checkerReceipt.'
      );
    }
    process.stdout.write(JSON.stringify(
      buildLegacyFinalizationCandidate(root, request.transitions, request.checkerReceipt),
      null,
      2
    ) + '\n');
    return;
  }
  const document = assertLegacyCheckerTransitionCurrent(root);
  const report = inspectLegacyFinalizationBlockers(root);
  const inventoryFinal = report.remaining.inventoryArtifacts === 0
    && report.remaining.inventoryBindings === 0
    && report.remaining.revalidationBlockedArtifacts === 0
    && report.remaining.revalidationBlockedBindings === 0;
  const incompleteCleanup = report.cleanupDecisions.filter((decision) => {
    return decision.state !== 'complete';
  });
  if (inventoryFinal && incompleteCleanup.length) {
    fail(
      'LEGACY_FINALIZATION_CLEANUP_INCOMPLETE',
      'Legacy inventory is final but cleanup decisions remain incomplete: '
        + incompleteCleanup.map((decision) => decision.id).join(', ')
    );
  }
  process.stdout.write(
    `Legacy checker transition: ${document.coverage.total} exact codes; `
      + `kernel rules=${document.coverage.kernelRule}, intentional retirements=${document.coverage.intentionalRetirement}; `
      + `inventory remaining artifacts=${report.remaining.inventoryArtifacts}, bindings=${report.remaining.inventoryBindings}; `
      + `revalidation blocked artifacts=${report.remaining.revalidationBlockedArtifacts}, bindings=${report.remaining.revalidationBlockedBindings}; `
      + `cleanup complete=${report.cleanupDecisions.filter((decision) => {
        return decision.state === 'complete';
      }).length}/${report.cleanupDecisions.length}; `
      + `inventory=${report.freshness.state}.\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.code || 'LEGACY_CHECKER_TRANSITION_INVALID'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
