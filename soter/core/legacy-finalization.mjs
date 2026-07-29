import fs from 'node:fs';
import path from 'node:path';

import {
  fingerprintJson,
  readJson,
  repoRelativePath
} from './lib/canonical-json.mjs';
import {
  inspectLegacyCheckerRunProjection,
  inspectLegacyCheckerRunReceipt,
  projectLegacyCheckerRunReceipt
} from '../kernel/legacy-checker-run.mjs';

const INVENTORY_PATH = 'soter/migrations/legacy-inventory.json';
const LEGACY_BASELINE = Object.freeze({
  id: 'legacy.claude.v1-baseline',
  sourceRoot: '.claude',
  baselineBranch: 'soter-harness-v1',
  baselineCommit: 'c54a50a48db18b70e7e2519ca81b75ad1fc6ce66',
  fileCount: 143,
  treeFingerprint: 'sha256:d258131ce50208df5bfd00b071056925ec34518907d99cd9a139d6756eb79875'
});
const FINAL_MIGRATION_ITEM_COUNT = 213;
const HOST_COMPLETION_BINDINGS = Object.freeze([
  ['.claude/.claude-plugin/plugin.json', 'host.claude', 'soter/hosts/claude/adapter.json'],
  ['.claude/.mcp.json', 'host.claude', 'soter/hosts/claude/projection.json'],
  ['.claude/agents/eval-runner.md', 'host.claude', 'soter/hosts/claude/adapter.json'],
  ['.claude/hooks/hooks.json', 'host.claude', 'soter/hosts/claude/adapter.json'],
  ['.claude/rules/parallel-sessions.md', 'host.claude', 'soter/hosts/claude/adapter.json'],
  ['.claude/scripts/check.mjs', 'host.claude', 'soter/hosts/claude/adapter.json'],
  ['.claude/settings.json', 'host.claude', 'soter/hosts/claude/adapter.json'],
  ['.claude/systems/platform.md', 'host.claude', 'soter/hosts/claude/adapter.json']
]);
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const SOURCE_RE = /^[.]claude\/[A-Za-z0-9._+/-]+$/;
const FINAL_EVIDENCE_RE = /^soter\/(?:fixtures|evidence)\/[A-Za-z0-9._+/-]+[.]json$/;
const OBSOLETE_FIXTURE_RE = /^soter\/fixtures\/[A-Za-z0-9._+/-]+[.]json$/;
const MIGRATION_RE = /^soter\/migrations\/[A-Za-z0-9._+/-]+[.]migration[.]json$/;
const CHECKER_RECEIPT_ID_RE = /^legacy-checker-run[.][a-f0-9]{64}$/;
const CHECKER_SOURCE_PATH = '.claude/scripts/check.mjs';
const PACKED_CHECKER_PATH = 'soter/kernel/legacy-check.mjs';
const TRACKED_HOST_OUTPUT_PATHS = Object.freeze([
  '.claude-plugin/marketplace.json',
  '.codex/config.toml',
  'AGENTS.md',
  'CLAUDE.md'
]);
const CRM_VOCABULARY_PATH = 'soter/contexts/crm/vocabulary.json';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function sameJson(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function confinedRepositoryPath(root, requestedPath, code, label) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, requestedPath);
  const relative = path.relative(resolvedRoot, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep)
    || path.isAbsolute(relative)) {
    fail(code, label + ' escapes the candidate repository: ' + requestedPath);
  }
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(code, label + ' has an unsafe parent path: ' + requestedPath);
    }
  }
  return target;
}

function assertRegularIfPresent(root, requestedPath) {
  const target = confinedRepositoryPath(
    root,
    requestedPath,
    'LEGACY_FINALIZATION_EVIDENCE_SCOPE_INVALID',
    'Declared evidence output'
  );
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    fail(
      'LEGACY_FINALIZATION_EVIDENCE_SCOPE_INVALID',
      'Declared evidence output is not one regular non-linked file: ' + requestedPath
    );
  }
}

function normalizedEvidencePaths(root, evidencePaths) {
  if (!Array.isArray(evidencePaths) || evidencePaths.length === 0) {
    fail(
      'LEGACY_FINALIZATION_REQUEST_INVALID',
      'Finalization requires the complete non-empty set of exact evidence outputs.'
    );
  }
  const normalized = evidencePaths.map((requestedPath) => {
    if (typeof requestedPath !== 'string'
      || !FINAL_EVIDENCE_RE.test(requestedPath)
      || requestedPath.includes('//')
      || requestedPath.split('/').includes('..')) {
      fail(
        'LEGACY_FINALIZATION_EVIDENCE_SCOPE_INVALID',
        'Finalization evidence output is not one normalized governed fixture or development-evidence path.'
      );
    }
    assertRegularIfPresent(root, requestedPath);
    return requestedPath;
  });
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    fail(
      'LEGACY_FINALIZATION_EVIDENCE_SCOPE_INVALID',
      'Finalization evidence outputs contain a duplicate path.'
    );
  }
  return [...unique].sort(compareCodepoint);
}

function normalizedObsoleteFixturePaths(root, obsoleteFixturePaths) {
  if (!Array.isArray(obsoleteFixturePaths) || obsoleteFixturePaths.length === 0) {
    fail(
      'LEGACY_FINALIZATION_REQUEST_INVALID',
      'Finalization requires the complete non-empty set of obsolete governed fixture outputs.'
    );
  }
  const normalized = obsoleteFixturePaths.map((requestedPath) => {
    if (typeof requestedPath !== 'string'
      || !OBSOLETE_FIXTURE_RE.test(requestedPath)
      || requestedPath.includes('//')
      || requestedPath.split('/').includes('..')) {
      fail(
        'LEGACY_FINALIZATION_OBSOLETE_FIXTURE_SCOPE_INVALID',
        'Obsolete fixture output is not one normalized governed fixture path.'
      );
    }
    const target = confinedRepositoryPath(
      root,
      requestedPath,
      'LEGACY_FINALIZATION_OBSOLETE_FIXTURE_SCOPE_INVALID',
      'Obsolete fixture output'
    );
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
        fail(
          'LEGACY_FINALIZATION_OBSOLETE_FIXTURE_SCOPE_INVALID',
          'Obsolete fixture output is not one regular non-linked file: ' + requestedPath
        );
      }
    }
    return requestedPath;
  });
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    fail(
      'LEGACY_FINALIZATION_OBSOLETE_FIXTURE_SCOPE_INVALID',
      'Obsolete fixture outputs contain a duplicate path.'
    );
  }
  return [...unique].sort(compareCodepoint);
}

function normalizedCheckerReceipt(root, checkerReceipt) {
  const keys = Object.keys(checkerReceipt || {}).sort(compareCodepoint);
  if (!sameJson(keys, ['id', 'receiptFingerprint'])
    || !CHECKER_RECEIPT_ID_RE.test(checkerReceipt?.id || '')
    || !HASH_RE.test(checkerReceipt?.receiptFingerprint || '')) {
    fail(
      'LEGACY_FINALIZATION_CHECKER_RECEIPT_REQUIRED',
      'Legacy finalization requires one exact private pre-removal checker receipt reference.'
    );
  }
  let inspected;
  try {
    inspected = inspectLegacyCheckerRunReceipt({ root, receiptId: checkerReceipt.id });
  } catch (error) {
    fail(
      'LEGACY_FINALIZATION_CHECKER_RECEIPT_INVALID',
      'Legacy finalization checker receipt is missing, malformed, private-state-invalid, or tampered: '
        + String(error.code || 'invalid')
    );
  }
  if (inspected.receipt.receiptFingerprint !== checkerReceipt.receiptFingerprint) {
    fail(
      'LEGACY_FINALIZATION_CHECKER_RECEIPT_INVALID',
      'Legacy finalization checker receipt fingerprint does not match the stored receipt.'
    );
  }
  return {
    reference: {
      id: inspected.receipt.id,
      receiptFingerprint: inspected.receipt.receiptFingerprint
    },
    receipt: inspected.receipt
  };
}

function assertFinalizationRequestShape(root, request) {
  const expectedKeys = [
    'checkerReceipt',
    'evidencePaths',
    'expectedInventoryFingerprint',
    'obsoleteFixturePaths'
  ];
  const actualKeys = Object.keys(request || {}).sort(compareCodepoint);
  if (!sameJson(actualKeys, expectedKeys)
    || !HASH_RE.test(request?.expectedInventoryFingerprint || '')) {
    fail(
      'LEGACY_FINALIZATION_REQUEST_INVALID',
      'Legacy finalization request must contain only one exact inventory fingerprint and evidence path set.'
    );
  }
  const evidencePaths = normalizedEvidencePaths(root, request.evidencePaths);
  const obsoleteFixturePaths = normalizedObsoleteFixturePaths(root, request.obsoleteFixturePaths);
  const checkerReceipt = normalizedCheckerReceipt(root, request.checkerReceipt);
  if (obsoleteFixturePaths.some((requestedPath) => evidencePaths.includes(requestedPath))) {
    fail(
      'LEGACY_FINALIZATION_OBSOLETE_FIXTURE_SCOPE_INVALID',
      'A final evidence output cannot also be declared obsolete.'
    );
  }
  return {
    expectedInventoryFingerprint: request.expectedInventoryFingerprint,
    checkerReceipt: checkerReceipt.reference,
    evidencePaths,
    obsoleteFixturePaths
  };
}

function assertFinalCheckerCutover(root, inventory, checkerReceipt) {
  const checkerItems = inventory.items.filter((item) => item.sourcePath === CHECKER_SOURCE_PATH);
  if (checkerItems.length !== 1
    || checkerItems[0].sourcePresence !== 'removed'
    || checkerItems[0].sourceFingerprint !== checkerReceipt.basis.checker.fingerprint) {
    fail(
      'LEGACY_FINALIZATION_CHECKER_RECEIPT_INVALID',
      'Final checker tombstone does not bind the exact checker bytes recorded by the clean receipt.'
    );
  }
  if (fs.existsSync(confinedRepositoryPath(
    root,
    PACKED_CHECKER_PATH,
    'LEGACY_FINALIZATION_CHECKER_RUNTIME_REMAINS',
    'Packed legacy checker'
  ))) {
    fail(
      'LEGACY_FINALIZATION_CHECKER_RUNTIME_REMAINS',
      'Packed legacy checker implementation remains after the receipt-gated cutover.'
    );
  }
  for (const outputPath of TRACKED_HOST_OUTPUT_PATHS) {
    const target = confinedRepositoryPath(
      root,
      outputPath,
      'LEGACY_FINALIZATION_HOST_OUTPUT_REMAINS',
      'Tracked generated host output'
    );
    try {
      fs.lstatSync(target);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      fail(
        'LEGACY_FINALIZATION_HOST_OUTPUT_REMAINS',
        'Tracked generated host output could not be proven absent after cutover: '
          + outputPath
      );
    }
    fail(
      'LEGACY_FINALIZATION_HOST_OUTPUT_REMAINS',
      'Tracked generated host output remains after the receipt-gated cutover: '
        + outputPath
    );
  }
  const vocabularyFile = confinedRepositoryPath(
    root,
    CRM_VOCABULARY_PATH,
    'LEGACY_FINALIZATION_CHECKER_SHIM_REMAINS',
    'CRM vocabulary'
  );
  if (!fs.existsSync(vocabularyFile)) {
    fail(
      'LEGACY_FINALIZATION_CHECKER_SHIM_REMAINS',
      'CRM vocabulary is missing after the receipt-gated cutover.'
    );
  }
  const vocabularyStat = fs.lstatSync(vocabularyFile);
  let vocabulary;
  try {
    vocabulary = readJson(vocabularyFile);
  } catch {
    fail(
      'LEGACY_FINALIZATION_CHECKER_SHIM_REMAINS',
      'CRM vocabulary is malformed after the receipt-gated cutover.'
    );
  }
  if (vocabularyStat.isSymbolicLink() || !vocabularyStat.isFile() || vocabularyStat.nlink !== 1
    || fingerprintJson(vocabulary)
      !== checkerReceipt.basis.temporaryCrmVocabulary.baseFingerprint
    || vocabulary.entries?.some((entry) => entry.id === 'channel')) {
    fail(
      'LEGACY_FINALIZATION_CHECKER_SHIM_REMAINS',
      'Temporary CRM Channel compatibility fragment was not removed exactly with cutover.'
    );
  }
  let projection;
  try {
    projection = inspectLegacyCheckerRunProjection({ root });
  } catch (error) {
    fail(
      'LEGACY_FINALIZATION_CHECKER_PROJECTION_INVALID',
      'Receipt-gated cutover requires one closed governed sanitized checker projection: '
        + String(error.code || 'invalid')
    );
  }
  const expectedProjection = projectLegacyCheckerRunReceipt({ root, receipt: checkerReceipt });
  if (projection.projectionFingerprint !== expectedProjection.projectionFingerprint
    || fingerprintJson(projection) !== fingerprintJson(expectedProjection)) {
    fail(
      'LEGACY_FINALIZATION_CHECKER_PROJECTION_INVALID',
      'Governed checker projection does not match the exact private cutover receipt.'
    );
  }
  return projection;
}

export function readLegacyFinalizationFixtureRequest(root, requestedPath) {
  if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)) {
    fail(
      'LEGACY_FINALIZATION_REQUEST_PATH_INVALID',
      'Legacy finalization request path must be absolute and outside the candidate repository.'
    );
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const resolvedRequest = path.resolve(requestedPath);
  let stat;
  let realRequest;
  try {
    stat = fs.lstatSync(resolvedRequest);
    realRequest = fs.realpathSync(resolvedRequest);
  } catch {
    fail(
      'LEGACY_FINALIZATION_REQUEST_PATH_INVALID',
      'Legacy finalization request path does not identify one private request file.'
    );
  }
  if (requestedPath !== resolvedRequest || realRequest !== resolvedRequest
    || realRequest === resolvedRoot || realRequest.startsWith(resolvedRoot + path.sep)
    || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
    || (stat.mode & 0o7777) !== 0o600) {
    fail(
      'LEGACY_FINALIZATION_REQUEST_PATH_INVALID',
      'Legacy finalization request must be one non-linked private file with mode 0600.'
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
        'LEGACY_FINALIZATION_REQUEST_PATH_INVALID',
        'Legacy finalization request changed before its exact read.'
      );
    }
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    let realAfter;
    try {
      realAfter = fs.realpathSync(resolvedRequest);
    } catch {
      fail(
        'LEGACY_FINALIZATION_REQUEST_PATH_INVALID',
        'Legacy finalization request changed while it was read.'
      );
    }
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || after.nlink !== 1 || realAfter !== realRequest) {
      fail(
        'LEGACY_FINALIZATION_REQUEST_PATH_INVALID',
        'Legacy finalization request changed while it was read.'
      );
    }
  } catch (error) {
    if (error?.code?.startsWith('LEGACY_FINALIZATION_')) throw error;
    fail(
      'LEGACY_FINALIZATION_REQUEST_PATH_INVALID',
      'Legacy finalization request could not be read exactly.'
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  let request;
  try {
    request = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(
        'LEGACY_FINALIZATION_REQUEST_INVALID',
        'Legacy finalization request is not valid JSON.'
      );
    }
    fail('LEGACY_FINALIZATION_REQUEST_INVALID', 'Legacy finalization request is not valid JSON.');
  }
  const canonicalBytes = Buffer.from(JSON.stringify(request, null, 2) + '\n', 'utf8');
  if (!bytes.equals(canonicalBytes)) {
    fail(
      'LEGACY_FINALIZATION_REQUEST_INVALID',
      'Legacy finalization request must use exact canonical persisted JSON bytes.'
    );
  }
  return assertFinalizationRequestShape(resolvedRoot, request);
}

export function assertLegacyFinalizationFixtureRequest(root, request) {
  return assertFinalizationRequestShape(path.resolve(root), request);
}

function exactCounts(items) {
  const stateCounts = { mapped: 0, bridged: 0, migrated: 0, retired: 0 };
  const bindingStateCounts = { mapped: 0, bridged: 0, migrated: 0, retired: 0 };
  for (const item of items) {
    if (Object.hasOwn(stateCounts, item.state)) stateCounts[item.state] += 1;
    for (const binding of item.targets || []) {
      if (Object.hasOwn(bindingStateCounts, binding.state)) {
        bindingStateCounts[binding.state] += 1;
      }
    }
  }
  return { stateCounts, bindingStateCounts };
}

function aggregateFinalSourceState(targets) {
  if (targets.every((binding) => binding.state === 'retired')) return 'retired';
  if (targets.every((binding) => ['migrated', 'retired'].includes(binding.state))) {
    return 'migrated';
  }
  return null;
}

function assertFinalInventory(root, inventory, {
  expectedInventoryFingerprint,
  declaredEvidence
}) {
  if (inventory?.$contract !== 'soter://contracts/legacy-inventory/v2'
    || inventory.id !== LEGACY_BASELINE.id
    || inventory.basis?.sourceRoot !== LEGACY_BASELINE.sourceRoot
    || inventory.basis?.baselineBranch !== LEGACY_BASELINE.baselineBranch
    || inventory.basis?.baselineCommit !== LEGACY_BASELINE.baselineCommit
    || inventory.basis?.fileCount !== LEGACY_BASELINE.fileCount
    || inventory.basis?.treeFingerprint !== LEGACY_BASELINE.treeFingerprint
    || !Array.isArray(inventory.items)
    || inventory.items.length !== LEGACY_BASELINE.fileCount) {
    fail(
      'LEGACY_FINALIZATION_INVENTORY_INVALID',
      'Finalization candidate does not contain the exact expected legacy inventory basis.'
    );
  }
  if (!HASH_RE.test(expectedInventoryFingerprint || '')
    || inventory.inventoryFingerprint !== expectedInventoryFingerprint) {
    fail(
      'LEGACY_FINALIZATION_INVENTORY_INVALID',
      'Finalization candidate inventory does not match the explicitly authorized fingerprint.'
    );
  }
  const unsigned = structuredClone(inventory);
  unsigned.inventoryFingerprint = null;
  if (fingerprintJson(unsigned) !== inventory.inventoryFingerprint) {
    fail(
      'LEGACY_FINALIZATION_INVENTORY_INVALID',
      'Finalization candidate inventory fingerprint is internally invalid.'
    );
  }

  const sourcePaths = new Set();
  const evidence = new Set();
  for (const [sequence, item] of inventory.items.entries()) {
    if (item.sequence !== sequence
      || typeof item.sourcePath !== 'string'
      || !SOURCE_RE.test(item.sourcePath)
      || sourcePaths.has(item.sourcePath)
      || !HASH_RE.test(item.sourceFingerprint || '')
      || item.sourcePresence !== 'removed'
      || !Array.isArray(item.targets)
      || item.targets.length === 0) {
      fail(
        'LEGACY_FINALIZATION_INVENTORY_INVALID',
        'Finalization candidate has an invalid or non-final legacy source entry.'
      );
    }
    sourcePaths.add(item.sourcePath);
    const sourceFile = confinedRepositoryPath(
      root,
      item.sourcePath,
      'LEGACY_FINALIZATION_INVENTORY_INVALID',
      'Legacy source'
    );
    if (fs.existsSync(sourceFile)) {
      fail(
        'LEGACY_FINALIZATION_SOURCE_PRESENT',
        'Finalization candidate still contains an operational legacy source: ' + item.sourcePath
      );
    }

    const targetKeys = new Set();
    for (const binding of item.targets) {
      const key = `${binding.id}\0${binding.path}`;
      const final = ['migrated', 'retired'].includes(binding.state)
        && binding.status === 'existing'
        && binding.fallback === 'removed'
        && ['proven', 'intentional-change'].includes(binding.parity)
        && binding.canonicalAuthority === (binding.state === 'migrated' ? 'target' : 'none')
        && Array.isArray(binding.evidence)
        && binding.evidence.length > 0;
      if (!final || targetKeys.has(key) || new Set(binding.evidence).size !== binding.evidence.length) {
        fail(
          'LEGACY_FINALIZATION_INVENTORY_INVALID',
          'Finalization candidate leaves a partial, duplicate, or authority-inconsistent binding: '
            + item.sourcePath
        );
      }
      targetKeys.add(key);
      for (const evidencePath of binding.evidence) evidence.add(evidencePath);
    }
    if (item.state !== aggregateFinalSourceState(item.targets)) {
      fail(
        'LEGACY_FINALIZATION_INVENTORY_INVALID',
        'Finalization candidate source state disagrees with its exact target bindings: '
          + item.sourcePath
      );
    }
  }
  const sortedSources = [...sourcePaths].sort(compareCodepoint);
  if (!sameJson(sortedSources, inventory.items.map((item) => item.sourcePath))) {
    fail(
      'LEGACY_FINALIZATION_INVENTORY_INVALID',
      'Finalization candidate source order is not deterministic.'
    );
  }
  const treeFingerprint = fingerprintJson(inventory.items.map((item) => ({
    sourcePath: item.sourcePath,
    sourceFingerprint: item.sourceFingerprint
  })));
  if (inventory.basis.treeFingerprint !== treeFingerprint) {
    fail(
      'LEGACY_FINALIZATION_INVENTORY_INVALID',
      'Finalization candidate legacy tree fingerprint is stale.'
    );
  }
  const counts = exactCounts(inventory.items);
  if (!sameJson(counts.stateCounts, inventory.stateCounts)
    || !sameJson(counts.bindingStateCounts, inventory.bindingStateCounts)
    || counts.stateCounts.mapped !== 0
    || counts.stateCounts.bridged !== 0
    || counts.bindingStateCounts.mapped !== 0
    || counts.bindingStateCounts.bridged !== 0) {
    fail(
      'LEGACY_FINALIZATION_INVENTORY_INVALID',
      'Finalization candidate counts do not prove zero mapped or bridged responsibilities.'
    );
  }
  const inventoryEvidence = [...evidence].sort(compareCodepoint);
  if (!sameJson(inventoryEvidence, declaredEvidence)) {
    fail(
      'LEGACY_FINALIZATION_EVIDENCE_SCOPE_INVALID',
      'Declared evidence outputs are not exactly the complete final inventory evidence set.'
    );
  }
  return inventoryEvidence;
}

function bindingKey(sourcePath, targetId, targetPath) {
  return `${sourcePath}\0${targetId}\0${targetPath}`;
}

function assertFinalMigrationDocuments(root, inventory, declaredEvidence) {
  const bindings = new Map();
  for (const item of inventory.items) {
    for (const binding of item.targets) {
      bindings.set(bindingKey(item.sourcePath, binding.id, binding.path), {
        sourceFingerprint: item.sourceFingerprint,
        state: binding.state,
        evidence: binding.evidence
      });
    }
  }
  const expectedOrdinary = new Set(bindings.keys());
  for (const [sourcePath, targetId, targetPath] of HOST_COMPLETION_BINDINGS) {
    const key = bindingKey(sourcePath, targetId, targetPath);
    if (!expectedOrdinary.delete(key)) {
      fail(
        'LEGACY_FINALIZATION_MIGRATION_INVALID',
        'Finalization candidate is missing one exact host-completion inventory binding.'
      );
    }
  }
  const migrationDirectory = confinedRepositoryPath(
    root,
    'soter/migrations',
    'LEGACY_FINALIZATION_MIGRATION_INVALID',
    'Migration directory'
  );
  const names = fs.readdirSync(migrationDirectory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.migration.json'))
    .sort((left, right) => compareCodepoint(left.name, right.name));
  const observed = new Set();
  let itemCount = 0;
  const declared = new Set(declaredEvidence);
  for (const entry of names) {
    const relativePath = 'soter/migrations/' + entry.name;
    const file = path.join(migrationDirectory, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail(
        'LEGACY_FINALIZATION_MIGRATION_INVALID',
        'Ordinary migration document is not one regular file: ' + relativePath
      );
    }
    let migration;
    try {
      migration = readJson(file);
    } catch {
      fail(
        'LEGACY_FINALIZATION_MIGRATION_INVALID',
        'Ordinary migration document is malformed: ' + relativePath
      );
    }
    if (!Array.isArray(migration.items)) {
      fail(
        'LEGACY_FINALIZATION_MIGRATION_INVALID',
        'Ordinary migration document has no exact item set: ' + relativePath
      );
    }
    for (const item of migration.items) {
      itemCount += 1;
      const key = bindingKey(item.sourcePath, item.targetPack, item.targetPath);
      const exact = bindings.get(key);
      if (observed.has(key)
        || !exact
        || !['migrated', 'retired'].includes(item.state)
        || item.state !== exact.state
        || item.sourceFingerprint !== exact.sourceFingerprint
        || !Array.isArray(item.evidence)
        || item.evidence.length === 0
        || item.evidence.some((evidencePath) => !declared.has(evidencePath))
        || !sameJson(item.evidence, exact.evidence)) {
        fail(
          'LEGACY_FINALIZATION_MIGRATION_INVALID',
          'Ordinary migration item is unfinished, duplicated, or disagrees with the final inventory: '
            + relativePath
        );
      }
      observed.add(key);
    }
  }
  if (itemCount !== FINAL_MIGRATION_ITEM_COUNT) {
    fail(
      'LEGACY_FINALIZATION_MIGRATION_INVALID',
      'Finalization candidate ordinary migration item count changed: expected '
        + FINAL_MIGRATION_ITEM_COUNT + ', found ' + itemCount + '.'
    );
  }
  if (observed.size !== expectedOrdinary.size
    || [...observed].some((key) => !expectedOrdinary.has(key))
    || [...expectedOrdinary].some((key) => !observed.has(key))) {
    fail(
      'LEGACY_FINALIZATION_MIGRATION_INVALID',
      'Ordinary migration items are not exactly the final inventory bindings minus the closed host-completion set.'
    );
  }
  return itemCount;
}

function migrationRelativePath(root, file) {
  if (typeof file !== 'string') return null;
  const relative = path.isAbsolute(file)
    ? repoRelativePath(root, file)
    : file.split(path.sep).join('/');
  return MIGRATION_RE.test(relative) ? relative : null;
}

function violationHasExactMigrationAnchor(root, violation, declaredEvidence) {
  const migrationPath = migrationRelativePath(root, violation.file);
  if (!migrationPath) return false;
  const migrationFile = confinedRepositoryPath(
    root,
    migrationPath,
    'LEGACY_FINALIZATION_GRAPH_INVALID',
    'Migration manifest'
  );
  if (!fs.existsSync(migrationFile) || fs.lstatSync(migrationFile).isSymbolicLink()) return false;
  let migration;
  try {
    migration = readJson(migrationFile);
  } catch {
    return false;
  }
  if (!Array.isArray(migration.items) || typeof violation.what !== 'string') return false;
  const declared = new Set(declaredEvidence);
  return migration.items.some((item) => {
    if (!['migrated', 'retired'].includes(item.state)
      || !Array.isArray(item.evidence)
      || item.evidence.length === 0
      || item.evidence.some((evidencePath) => !declared.has(evidencePath))) {
      return false;
    }
    return [item.sourcePath, item.targetPath, ...item.evidence].some((anchor) => {
      return typeof anchor === 'string' && violation.what.includes(anchor);
    });
  });
}

/**
 * Authorizes only a completely tombstoned legacy inventory with an exact declared
 * evidence output set. The static graph may already be clean when runtime evidence
 * content is excluded, or full verification may be blocked solely by those declared
 * outputs awaiting deterministic regeneration.
 */
export function assertLegacyFinalizationCandidateBasis({
  root,
  expectedInventoryFingerprint,
  checkerReceipt,
  evidencePaths,
  verification,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length > 0) {
    fail(
      'LEGACY_FINALIZATION_REQUEST_INVALID',
      'Legacy finalization candidate basis contains an unknown caller-controlled field.'
    );
  }
  const resolvedRoot = path.resolve(root || '.');
  const exactCheckerReceipt = normalizedCheckerReceipt(resolvedRoot, checkerReceipt);
  const declaredEvidence = normalizedEvidencePaths(resolvedRoot, evidencePaths);
  const inventoryFile = confinedRepositoryPath(
    resolvedRoot,
    INVENTORY_PATH,
    'LEGACY_FINALIZATION_INVENTORY_INVALID',
    'Legacy inventory'
  );
  if (!fs.existsSync(inventoryFile)
    || fs.lstatSync(inventoryFile).isSymbolicLink()
    || !fs.lstatSync(inventoryFile).isFile()) {
    fail('LEGACY_FINALIZATION_INVENTORY_INVALID', 'Finalization candidate has no regular legacy inventory.');
  }
  const inventory = readJson(inventoryFile);
  const exactEvidence = assertFinalInventory(resolvedRoot, inventory, {
    expectedInventoryFingerprint,
    declaredEvidence
  });
  const checkerProjection = assertFinalCheckerCutover(
    resolvedRoot,
    inventory,
    exactCheckerReceipt.receipt
  );
  const migrationItemCount = assertFinalMigrationDocuments(
    resolvedRoot,
    inventory,
    exactEvidence
  );

  if (!verification || !Array.isArray(verification.violations)) {
    fail(
      'LEGACY_FINALIZATION_GRAPH_INVALID',
      'Finalization resolver requires one current Kernel verification report.'
    );
  }
  const staticClean = verification.violations.length === 0
    && verification.health?.valid === 'passed';
  if (!staticClean) {
    if (verification.violations.length === 0 || verification.health?.valid !== 'failed') {
      fail(
        'LEGACY_FINALIZATION_GRAPH_INVALID',
        'Finalization candidate is neither static-clean nor blocked only by exact migration evidence.'
      );
    }
    for (const violation of verification.violations) {
      if (violation.code !== 'SOTER_MIGRATION_EVIDENCE') {
        fail(
          'LEGACY_FINALIZATION_GRAPH_INVALID',
          'Finalization candidate has a non-evidence graph violation: ' + String(violation.code)
        );
      }
      if (!violationHasExactMigrationAnchor(resolvedRoot, violation, exactEvidence)) {
        fail(
          'LEGACY_FINALIZATION_VIOLATION_UNATTRIBUTED',
          'Migration evidence violation is not attributable to one declared final binding.'
        );
      }
    }
  }
  return {
    inventoryFingerprint: inventory.inventoryFingerprint,
    checkerReceipt: exactCheckerReceipt.reference,
    checkerProjection: {
      id: checkerProjection.id,
      fingerprint: checkerProjection.projectionFingerprint
    },
    sourceCount: inventory.items.length,
    migrationItemCount,
    evidencePaths: exactEvidence,
    pendingEvidenceViolations: verification.violations.length
  };
}
