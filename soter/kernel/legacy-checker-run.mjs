import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fingerprintFile,
  fingerprintJson,
  readJson,
  sha256
} from '../core/lib/canonical-json.mjs';
import { assertLegacyCheckerTransitionCurrent } from './legacy-checker-transition.mjs';
import { validateJsonSchema } from './verify.mjs';

const moduleFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(moduleFile), '..', '..');
const RECEIPT_CONTRACT = 'soter://contracts/legacy-checker-run-receipt/v1';
const RECEIPT_SCHEMA_PATH = 'soter/contracts/legacy-checker-run-receipt.schema.json';
const PROJECTION_CONTRACT = 'soter://contracts/legacy-checker-run-projection/v1';
const PROJECTION_SCHEMA_PATH = 'soter/contracts/legacy-checker-run-projection.schema.json';
export const LEGACY_CHECKER_RUN_PROJECTION_PATH
  = 'soter/fixtures/claude-host-projection/legacy-checker-run.projection.json';
const CHECKER_PATH = '.claude/scripts/check.mjs';
const TRANSITION_PATH = 'soter/kernel/legacy-checker-transition.json';
const CRM_VOCABULARY_PATH = 'soter/contexts/crm/vocabulary.json';
const STATE_DIRECTORY = '.soter/state/legacy-checker-runs';
const EXECUTION_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const CRM_VOCABULARY_BASE_FINGERPRINT
  = 'sha256:931c5deffaa7ce0015879013e0d6260a6288f639af232f9d7cc0eccd1462bbfd';
const TEMPORARY_CHANNEL_ENTRY = Object.freeze({
  sequence: 3,
  id: 'channel',
  term: 'channel',
  aliases: [],
  abbreviation: null,
  definition: 'Temporary compatibility fragment for the immutable v1 checker immediately before legacy source removal; context.communications.collaboration remains the sole canonical owner and this entry must not survive cutover.',
  domain: 'communications-compatibility',
  sourceUris: []
});
const FIXED_LIMITATIONS = Object.freeze([
  'This receipt records one exact immutable legacy checker observation only; it does not grant migration, fallback-removal, execution, provider, publication, or merge authority.',
  'The temporary CRM Channel vocabulary fragment exists only to satisfy the immutable pre-cutover compatibility pointer check and must be removed with the legacy cutover.',
  'Raw checker output, absolute paths, source content, inherited environment values, credentials, provider data, readiness, verification, and health claims are excluded.'
]);
const PROJECTION_LIMITATIONS = Object.freeze([
  'This governed projection preserves only sanitized facts from one exact clean private checker receipt; it grants no migration, fallback-removal, execution, provider, publication, or merge authority.',
  'The projection proves one pre-cutover observation only; post-cutover graph validity, fixture freshness, readiness, connected verification, and health require their own current evidence.'
]);
const SAFE_RECEIPT_ID = /^legacy-checker-run[.][a-f0-9]{64}$/;
const INPUT_TREE_EXCLUDED_ROOTS = Object.freeze(['.git', '.soter', 'node_modules']);
const INPUT_TREE_EXCLUDED_ROOT_SET = new Set(INPUT_TREE_EXCLUDED_ROOTS);
const MARKDOWN_LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

function fail(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactRequest(value, expectedKeys, code) {
  const actual = Object.keys(value || {}).sort(compareCodepoint);
  const expected = [...expectedKeys].sort(compareCodepoint);
  if (fingerprintJson(actual) !== fingerprintJson(expected)) {
    fail(code, 'Legacy checker run request has an unknown or missing field.');
  }
}

function resolvedRepositoryRoot(root) {
  if (typeof root !== 'string' || root.length === 0) {
    fail('LEGACY_CHECKER_RUN_ROOT_INVALID', 'Legacy checker run requires one repository root.');
  }
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved)) {
    fail('LEGACY_CHECKER_RUN_ROOT_INVALID', 'Legacy checker repository root is missing.');
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(resolved) !== resolved) {
    fail('LEGACY_CHECKER_RUN_ROOT_INVALID', 'Legacy checker repository root must be one exact real directory.');
  }
  return resolved;
}

function confinedFile(root, relative, label) {
  if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)
    || relative.includes('\\') || relative.includes('//')
    || relative.split('/').some((segment) => segment === '.' || segment === '..')) {
    fail('LEGACY_CHECKER_RUN_PATH_INVALID', `${label} path is not normalized.`);
  }
  const file = path.resolve(root, relative);
  const confined = path.relative(root, file);
  if (!confined || confined === '..' || confined.startsWith('..' + path.sep)
    || path.isAbsolute(confined)) {
    fail('LEGACY_CHECKER_RUN_PATH_INVALID', `${label} escapes the repository.`);
  }
  return file;
}

function regularFileIdentity(file, label, expectedFingerprint = null) {
  if (!fs.existsSync(file)) {
    fail('LEGACY_CHECKER_RUN_BASIS_INVALID', `${label} is missing.`);
  }
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
    || fs.realpathSync(file) !== path.resolve(file)) {
    fail(
      'LEGACY_CHECKER_RUN_BASIS_INVALID',
      `${label} must be one exact regular non-symlink, non-hardlinked file.`
    );
  }
  const fingerprint = fingerprintFile(file);
  if (expectedFingerprint && fingerprint !== expectedFingerprint) {
    fail('LEGACY_CHECKER_RUN_BASIS_STALE', `${label} bytes do not match their exact governed fingerprint.`);
  }
  return {
    fingerprint,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size
  };
}

function assertSameIdentity(before, after, label) {
  if (before.fingerprint !== after.fingerprint
    || before.device !== after.device
    || before.inode !== after.inode
    || before.size !== after.size) {
    fail('LEGACY_CHECKER_RUN_BASIS_DRIFT', `${label} changed during the immutable checker run.`);
  }
}

function inspectTemporaryCrmVocabulary(root) {
  const file = confinedFile(root, CRM_VOCABULARY_PATH, 'Temporary CRM vocabulary');
  const identity = regularFileIdentity(file, 'Temporary CRM vocabulary');
  let document;
  try {
    document = readJson(file);
  } catch (error) {
    fail('LEGACY_CHECKER_RUN_SHIM_INVALID', 'Temporary CRM vocabulary is not valid JSON.', error);
  }
  const channelEntries = document.entries?.filter((entry) => entry.id === 'channel') || [];
  if (channelEntries.length !== 1
    || fingerprintJson(channelEntries[0]) !== fingerprintJson(TEMPORARY_CHANNEL_ENTRY)) {
    fail(
      'LEGACY_CHECKER_RUN_SHIM_INVALID',
      'Temporary CRM vocabulary does not contain the one exact pre-removal Channel compatibility fragment.'
    );
  }
  const base = structuredClone(document);
  base.entries = base.entries.filter((entry) => entry.id !== 'channel');
  if (fingerprintJson(base) !== CRM_VOCABULARY_BASE_FINGERPRINT) {
    fail(
      'LEGACY_CHECKER_RUN_SHIM_INVALID',
      'Temporary CRM vocabulary changes more than the exact pre-removal Channel compatibility fragment.'
    );
  }
  return {
    identity,
    basis: {
      path: CRM_VOCABULARY_PATH,
      fingerprint: identity.fingerprint,
      baseFingerprint: CRM_VOCABULARY_BASE_FINGERPRINT,
      shimEntryFingerprint: fingerprintJson(TEMPORARY_CHANNEL_ENTRY),
      purpose: 'immutable-pre-removal-channel-fragment-check-only',
      retention: 'must-be-removed-with-legacy-cutover'
    }
  };
}

function fixedCommand() {
  return {
    executable: 'current-node-binary',
    script: CHECKER_PATH,
    arguments: ['--all'],
    cwd: 'repository-root',
    environmentPolicy: 'fixed-minimal-v1',
    timeoutMs: EXECUTION_TIMEOUT_MS
  };
}

function fixedEnvironment() {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC'
  };
}

function assertPrivateStateInvisibleToChecker(root) {
  const privateRoot = path.join(root, '.soter');
  if (!fs.existsSync(privateRoot)) return;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.endsWith('.md')) {
        fail(
          'LEGACY_CHECKER_RUN_INPUT_TREE_INVALID',
          'Private runtime state contains Markdown that the immutable checker would scan.'
        );
      }
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  };
  visit(privateRoot);
}

function assertMarkdownDoesNotReferenceExcludedState(root, file) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const target = match[1].trim().replace(/^<|>$/g, '').split(/\s+/)[0].split('#')[0];
    if (!target || /^(?:https?:|mailto:)/.test(target) || target.startsWith('/')) continue;
    const resolved = path.resolve(path.dirname(file), target);
    const relative = path.relative(root, resolved).split(path.sep).join('/');
    const top = relative.split('/')[0];
    if (INPUT_TREE_EXCLUDED_ROOT_SET.has(top)) {
      fail(
        'LEGACY_CHECKER_RUN_INPUT_TREE_INVALID',
        'Public Markdown links may not make excluded private or tool state checker-visible.'
      );
    }
  }
}

function checkerVisibleInputTree(root) {
  assertPrivateStateInvisibleToChecker(root);
  const directories = [];
  const files = [];
  const visit = (directory, relativeDirectory = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareCodepoint(left.name, right.name));
    for (const entry of entries) {
      if (!relativeDirectory && INPUT_TREE_EXCLUDED_ROOT_SET.has(entry.name)) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        fail(
          'LEGACY_CHECKER_RUN_INPUT_TREE_INVALID',
          'Legacy checker public input tree contains a symbolic link.'
        );
      }
      if (entry.isDirectory()) {
        directories.push({ path: relative, mode: stat.mode & 0o7777 });
        visit(absolute, relative);
        continue;
      }
      if (!entry.isFile() || !stat.isFile() || stat.nlink !== 1
        || fs.realpathSync(absolute) !== absolute) {
        fail(
          'LEGACY_CHECKER_RUN_INPUT_TREE_INVALID',
          'Legacy checker public input tree must contain only regular non-linked files and directories.'
        );
      }
      files.push({
        path: relative,
        mode: stat.mode & 0o7777,
        size: stat.size,
        fingerprint: fingerprintFile(absolute)
      });
      if (entry.name.endsWith('.md')) {
        assertMarkdownDoesNotReferenceExcludedState(root, absolute);
      }
    }
  };
  visit(root);
  const manifest = { directories, files };
  return {
    scope: 'complete-public-repository-tree',
    excludedRoots: [...INPUT_TREE_EXCLUDED_ROOTS],
    directoryCount: directories.length,
    fileCount: files.length,
    treeFingerprint: fingerprintJson(manifest)
  };
}

function frontmatterScalar(text, key) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  for (const line of match[1].split('\n')) {
    const scalar = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!scalar || scalar[1] !== key) continue;
    return scalar[2]
      .replace(/\s*<!--[\s\S]*?-->\s*/g, '')
      .replace(/\s+#\s.*$/, '')
      .trim();
  }
  return null;
}

function gitResult(root, argumentsList) {
  const result = spawnSync('git', ['-C', root, ...argumentsList], {
    cwd: root,
    env: fixedEnvironment(),
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  return {
    status: result.status,
    signal: result.signal,
    errorCode: result.error?.code || null,
    stdout: typeof result.stdout === 'string' ? result.stdout.trim() : ''
  };
}

function gitFreshnessInputs(root) {
  const repository = gitResult(root, ['rev-parse', '--show-toplevel']);
  let repositoryRoot = null;
  try {
    repositoryRoot = repository.status === 0 ? fs.realpathSync(repository.stdout) : null;
  } catch {
    repositoryRoot = null;
  }
  if (repository.errorCode !== null || repository.signal !== null
    || repository.status !== 0 || repositoryRoot !== root) {
    return {
      state: 'unavailable',
      observationCount: 0,
      observationsFingerprint: fingerprintJson({ state: 'unavailable' })
    };
  }

  const observations = [];
  const evalsDirectory = path.join(root, '.claude', 'evals');
  if (fs.existsSync(evalsDirectory)) {
    for (const skillEntry of fs.readdirSync(evalsDirectory, { withFileTypes: true })
      .sort((left, right) => compareCodepoint(left.name, right.name))) {
      if (!skillEntry.isDirectory() || skillEntry.name === 'logs') continue;
      const directory = path.join(evalsDirectory, skillEntry.name);
      for (const caseEntry of fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => compareCodepoint(left.name, right.name))) {
        if (!caseEntry.isFile() || !caseEntry.name.endsWith('.md')) continue;
        const caseFile = path.join(directory, caseEntry.name);
        const text = fs.readFileSync(caseFile, 'utf8');
        const passed = frontmatterScalar(text, 'passed');
        const skill = frontmatterScalar(text, 'skill');
        if (!/^[0-9a-f]{6,40}$/i.test(passed || '')
          || !/^[a-z0-9-]+$/.test(skill || '')) continue;
        const skillPath = `.claude/skills/${skill}/SKILL.md`;
        if (!fs.existsSync(path.join(root, skillPath))) continue;
        const known = gitResult(root, ['cat-file', '-e', `${passed}^{commit}`]);
        if (known.status !== 0 || known.signal !== null || known.errorCode !== null) {
          const shallow = gitResult(root, ['rev-parse', '--is-shallow-repository']);
          observations.push({
            caseFingerprint: fingerprintFile(caseFile),
            state: shallow.status === 0 && shallow.signal === null && shallow.errorCode === null
              ? (shallow.stdout === 'true' ? 'unknown-shallow' : 'unknown-complete-history')
              : 'fail-open'
          });
          continue;
        }
        const diff = gitResult(root, ['diff', '--quiet', passed, 'HEAD', '--', skillPath]);
        const status = gitResult(root, ['status', '--porcelain', '--', skillPath]);
        observations.push({
          caseFingerprint: fingerprintFile(caseFile),
          state: status.status !== 0 || status.signal !== null || status.errorCode !== null
            ? 'fail-open'
            : diff.status === 0 && diff.signal === null && diff.errorCode === null
              && status.stdout.length === 0
              ? 'current'
              : 'stale'
        });
      }
    }
  }
  return {
    state: 'available',
    observationCount: observations.length,
    observationsFingerprint: fingerprintJson(observations)
  };
}

function receiptIdFor(basis, command) {
  return 'legacy-checker-run.' + fingerprintJson({ basis, command }).slice('sha256:'.length);
}

function inspectBasisInternal(root) {
  const resolvedRoot = resolvedRepositoryRoot(root);
  const checkerFile = confinedFile(resolvedRoot, CHECKER_PATH, 'Legacy checker');
  const transitionFile = confinedFile(resolvedRoot, TRANSITION_PATH, 'Checker transition');
  const checkerBefore = regularFileIdentity(checkerFile, 'Legacy checker');
  const transitionBefore = regularFileIdentity(transitionFile, 'Checker transition');
  let declaredTransition;
  try {
    declaredTransition = readJson(transitionFile);
  } catch (error) {
    fail('LEGACY_CHECKER_RUN_BASIS_INVALID', 'Checker transition is not valid JSON.', error);
  }
  if (declaredTransition?.source?.path !== CHECKER_PATH
    || checkerBefore.fingerprint !== declaredTransition?.source?.fingerprint) {
    fail('LEGACY_CHECKER_RUN_BASIS_STALE', 'Legacy checker bytes do not match the immutable transition source fingerprint.');
  }
  const transition = assertLegacyCheckerTransitionCurrent(resolvedRoot);
  const transitionAfter = regularFileIdentity(transitionFile, 'Checker transition');
  assertSameIdentity(transitionBefore, transitionAfter, 'Checker transition');
  const temporaryCrmVocabulary = inspectTemporaryCrmVocabulary(resolvedRoot);
  const nodeBinary = regularFileIdentity(process.execPath, 'Current Node binary');
  const inputTree = checkerVisibleInputTree(resolvedRoot);
  const gitInputs = gitFreshnessInputs(resolvedRoot);
  const basis = {
    checker: {
      path: CHECKER_PATH,
      fingerprint: checkerBefore.fingerprint
    },
    transition: {
      path: TRANSITION_PATH,
      fingerprint: transition.transitionFingerprint,
      documentFingerprint: fingerprintJson(transition)
    },
    temporaryCrmVocabulary: temporaryCrmVocabulary.basis,
    checkerVisibleInputTree: inputTree,
    gitFreshnessInputs: gitInputs,
    runtime: {
      identity: 'current-node-binary',
      version: process.version,
      binaryFingerprint: nodeBinary.fingerprint
    }
  };
  const command = fixedCommand();
  return {
    root: resolvedRoot,
    checkerFile,
    transitionFile,
    basis,
    command,
    receiptId: receiptIdFor(basis, command),
    identities: {
      checker: checkerBefore,
      transition: transitionBefore,
      temporaryCrmVocabulary: temporaryCrmVocabulary.identity,
      nodeBinary,
      checkerVisibleInputTree: inputTree,
      gitFreshnessInputs: gitInputs
    }
  };
}

function assertExecutionBasisUnchanged(inspected) {
  const checkerAfter = regularFileIdentity(
    inspected.checkerFile,
    'Legacy checker',
    inspected.basis.checker.fingerprint
  );
  const transitionAfter = regularFileIdentity(inspected.transitionFile, 'Checker transition');
  const shimAfter = inspectTemporaryCrmVocabulary(inspected.root);
  const nodeAfter = regularFileIdentity(process.execPath, 'Current Node binary');
  const inputTreeAfter = checkerVisibleInputTree(inspected.root);
  const gitInputsAfter = gitFreshnessInputs(inspected.root);
  assertSameIdentity(inspected.identities.checker, checkerAfter, 'Legacy checker');
  assertSameIdentity(inspected.identities.transition, transitionAfter, 'Checker transition');
  assertSameIdentity(
    inspected.identities.temporaryCrmVocabulary,
    shimAfter.identity,
    'Temporary CRM vocabulary'
  );
  assertSameIdentity(inspected.identities.nodeBinary, nodeAfter, 'Current Node binary');
  if (fingerprintJson(inspected.identities.checkerVisibleInputTree)
    !== fingerprintJson(inputTreeAfter)) {
    fail(
      'LEGACY_CHECKER_RUN_INPUT_TREE_DRIFT',
      'Legacy checker public input tree changed during or after the immutable checker run.'
    );
  }
  if (fingerprintJson(inspected.identities.gitFreshnessInputs)
    !== fingerprintJson(gitInputsAfter)) {
    fail(
      'LEGACY_CHECKER_RUN_GIT_BASIS_DRIFT',
      'Legacy checker Git freshness inputs changed during or after the immutable checker run.'
    );
  }
  const currentTransition = assertLegacyCheckerTransitionCurrent(inspected.root);
  if (currentTransition.transitionFingerprint !== inspected.basis.transition.fingerprint
    || fingerprintJson(currentTransition) !== inspected.basis.transition.documentFingerprint) {
    fail('LEGACY_CHECKER_RUN_BASIS_DRIFT', 'Checker transition changed during the immutable checker run.');
  }
}

export function expectedLegacyCheckerChannelShim() {
  return structuredClone(TEMPORARY_CHANNEL_ENTRY);
}

export function inspectLegacyCheckerPreRemovalBasis({ root = defaultRoot, ...unknown } = {}) {
  exactRequest({ root, ...unknown }, ['root'], 'LEGACY_CHECKER_RUN_REQUEST_INVALID');
  const inspected = inspectBasisInternal(root);
  return {
    receiptId: inspected.receiptId,
    basis: structuredClone(inspected.basis),
    command: structuredClone(inspected.command),
    authority: 'none'
  };
}

export function parseLegacyCheckerRunResult({
  status,
  signal,
  errorCode,
  stdout,
  stderr,
  ...unknown
} = {}) {
  exactRequest(
    { status, signal, errorCode, stdout, stderr, ...unknown },
    ['status', 'signal', 'errorCode', 'stdout', 'stderr'],
    'LEGACY_CHECKER_RUN_RESULT_INVALID'
  );
  if (typeof stdout !== 'string' || typeof stderr !== 'string'
    || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES
    || Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
    fail('LEGACY_CHECKER_RUN_RESULT_INVALID', 'Legacy checker output is missing, non-text, or exceeds the fixed bound.');
  }
  const summaries = [...stdout.matchAll(/^Checker: ([0-9]+) error\(s\), ([0-9]+) warning\(s\)[.]$/gm)];
  const census = [...stdout.matchAll(/^Scanned: [0-9]+ CLAUDE[.]md, [0-9]+ skills, [0-9]+ system cards, [0-9]+ molds, [0-9]+ standards, [0-9]+ singletons, [0-9]+ rules, [0-9]+ eval cases, [0-9]+ ADRs, [0-9]+ alias rows[.]$/gm)];
  if (summaries.length !== 1 || census.length !== 1) {
    fail('LEGACY_CHECKER_RUN_OUTPUT_AMBIGUOUS', 'Legacy checker output lacks one exact census and one exact summary.');
  }
  const errorCount = Number.parseInt(summaries[0][1], 10);
  const warningCount = Number.parseInt(summaries[0][2], 10);
  if (errorCode !== null || signal !== null || status !== 0
    || errorCount !== 0 || warningCount !== 0 || stderr.length !== 0) {
    fail('LEGACY_CHECKER_RUN_NOT_CLEAN', 'Legacy checker did not complete with one exact 0-error, 0-warning, empty-stderr result.');
  }
  return {
    exitStatus: status,
    errorCount,
    warningCount,
    stdoutFingerprint: sha256(stdout),
    stderrFingerprint: sha256(stderr)
  };
}

function receiptFingerprint(receipt) {
  const unsigned = structuredClone(receipt);
  unsigned.receiptFingerprint = null;
  return fingerprintJson(unsigned);
}

function projectionFingerprint(projection) {
  const unsigned = structuredClone(projection);
  unsigned.projectionFingerprint = null;
  return fingerprintJson(unsigned);
}

function assertValidInstant(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail('LEGACY_CHECKER_RUN_RECEIPT_INVALID', 'Legacy checker receipt observedAt is not one exact valid instant.');
  }
}

export function assertLegacyCheckerRunReceipt({
  root = defaultRoot,
  receipt,
  expectedBasis = null,
  expectedCommand = null,
  ...unknown
} = {}) {
  exactRequest(
    { root, receipt, expectedBasis, expectedCommand, ...unknown },
    ['root', 'receipt', 'expectedBasis', 'expectedCommand'],
    'LEGACY_CHECKER_RUN_RECEIPT_INVALID'
  );
  const resolvedRoot = resolvedRepositoryRoot(root);
  const schemaFile = confinedFile(resolvedRoot, RECEIPT_SCHEMA_PATH, 'Legacy checker receipt schema');
  regularFileIdentity(schemaFile, 'Legacy checker receipt schema');
  const schema = readJson(schemaFile);
  const failures = validateJsonSchema(receipt, schema);
  if (failures.length || receipt?.$contract !== RECEIPT_CONTRACT) {
    fail(
      'LEGACY_CHECKER_RUN_RECEIPT_INVALID',
      'Legacy checker receipt violates its closed contract.'
    );
  }
  assertValidInstant(receipt.observedAt);
  if (receipt.receiptFingerprint !== receiptFingerprint(receipt)
    || fingerprintJson(receipt.limitations) !== fingerprintJson(FIXED_LIMITATIONS)) {
    fail('LEGACY_CHECKER_RUN_RECEIPT_TAMPERED', 'Legacy checker receipt fingerprint or fixed limitations are invalid.');
  }
  const expectedId = receiptIdFor(receipt.basis, receipt.command);
  if (receipt.id !== expectedId
    || (expectedBasis && fingerprintJson(receipt.basis) !== fingerprintJson(expectedBasis))
    || (expectedCommand && fingerprintJson(receipt.command) !== fingerprintJson(expectedCommand))) {
    fail('LEGACY_CHECKER_RUN_RECEIPT_BINDING_INVALID', 'Legacy checker receipt does not bind the exact requested execution basis.');
  }
  return structuredClone(receipt);
}

export function projectLegacyCheckerRunReceipt({
  root = defaultRoot,
  receipt,
  ...unknown
} = {}) {
  exactRequest(
    { root, receipt, ...unknown },
    ['root', 'receipt'],
    'LEGACY_CHECKER_RUN_PROJECTION_INVALID'
  );
  const exactReceipt = assertLegacyCheckerRunReceipt({ root, receipt });
  const projection = {
    $contract: PROJECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: exactReceipt.id.replace('legacy-checker-run.', 'legacy-checker-run-projection.'),
    observedAt: exactReceipt.observedAt,
    receipt: {
      id: exactReceipt.id,
      fingerprint: exactReceipt.receiptFingerprint
    },
    basis: structuredClone(exactReceipt.basis),
    command: structuredClone(exactReceipt.command),
    result: structuredClone(exactReceipt.result),
    authority: {
      kind: 'none',
      grantsMigration: false,
      grantsFallbackRemoval: false,
      grantsExecution: false,
      grantsProviderRead: false,
      grantsProviderWrite: false,
      grantsPublication: false,
      grantsMerge: false
    },
    privacy: {
      rawOutputIncluded: false,
      privateStatePathIncluded: false,
      absolutePathsIncluded: false,
      sourceContentIncluded: false,
      environmentValuesIncluded: false
    },
    limitations: [...PROJECTION_LIMITATIONS],
    projectionFingerprint: null
  };
  projection.projectionFingerprint = projectionFingerprint(projection);
  return assertLegacyCheckerRunProjection({
    root,
    projection,
    expectedReceipt: exactReceipt
  });
}

export function assertLegacyCheckerRunProjection({
  root = defaultRoot,
  projection,
  expectedReceipt = null,
  ...unknown
} = {}) {
  exactRequest(
    { root, projection, expectedReceipt, ...unknown },
    ['root', 'projection', 'expectedReceipt'],
    'LEGACY_CHECKER_RUN_PROJECTION_INVALID'
  );
  const resolvedRoot = resolvedRepositoryRoot(root);
  const schemaFile = confinedFile(
    resolvedRoot,
    PROJECTION_SCHEMA_PATH,
    'Legacy checker projection schema'
  );
  regularFileIdentity(schemaFile, 'Legacy checker projection schema');
  const failures = validateJsonSchema(projection, readJson(schemaFile));
  if (failures.length || projection?.$contract !== PROJECTION_CONTRACT) {
    fail(
      'LEGACY_CHECKER_RUN_PROJECTION_INVALID',
      'Legacy checker run projection violates its closed contract.'
    );
  }
  assertValidInstant(projection.observedAt);
  if (projection.projectionFingerprint !== projectionFingerprint(projection)
    || fingerprintJson(projection.limitations) !== fingerprintJson(PROJECTION_LIMITATIONS)) {
    fail(
      'LEGACY_CHECKER_RUN_PROJECTION_TAMPERED',
      'Legacy checker run projection fingerprint or fixed limitations are invalid.'
    );
  }
  if (expectedReceipt) {
    const exactReceipt = assertLegacyCheckerRunReceipt({ root: resolvedRoot, receipt: expectedReceipt });
    const expected = {
      id: exactReceipt.id,
      fingerprint: exactReceipt.receiptFingerprint
    };
    if (fingerprintJson(projection.receipt) !== fingerprintJson(expected)
      || projection.observedAt !== exactReceipt.observedAt
      || fingerprintJson(projection.basis) !== fingerprintJson(exactReceipt.basis)
      || fingerprintJson(projection.command) !== fingerprintJson(exactReceipt.command)
      || fingerprintJson(projection.result) !== fingerprintJson(exactReceipt.result)) {
      fail(
        'LEGACY_CHECKER_RUN_PROJECTION_BINDING_INVALID',
        'Governed checker projection does not exactly match its private receipt.'
      );
    }
  }
  return structuredClone(projection);
}

export function inspectLegacyCheckerRunProjection({ root = defaultRoot, ...unknown } = {}) {
  exactRequest(
    { root, ...unknown },
    ['root'],
    'LEGACY_CHECKER_RUN_PROJECTION_INVALID'
  );
  const resolvedRoot = resolvedRepositoryRoot(root);
  const file = confinedFile(
    resolvedRoot,
    LEGACY_CHECKER_RUN_PROJECTION_PATH,
    'Governed legacy checker projection'
  );
  regularFileIdentity(file, 'Governed legacy checker projection');
  let projection;
  try {
    projection = readJson(file);
  } catch (error) {
    fail(
      'LEGACY_CHECKER_RUN_PROJECTION_INVALID',
      'Governed legacy checker projection is malformed.',
      error
    );
  }
  return assertLegacyCheckerRunProjection({ root: resolvedRoot, projection });
}

function receiptPath(root, receiptId) {
  if (typeof receiptId !== 'string' || !SAFE_RECEIPT_ID.test(receiptId)) {
    fail('LEGACY_CHECKER_RUN_RECEIPT_PATH_INVALID', 'Legacy checker receipt id is invalid.');
  }
  return confinedFile(root, `${STATE_DIRECTORY}/${receiptId}.json`, 'Legacy checker receipt');
}

function assertPrivateMode(stat, expected, label) {
  if (process.platform !== 'win32' && (stat.mode & 0o7777) !== expected) {
    fail('LEGACY_CHECKER_RUN_PRIVATE_STATE_INVALID', `${label} must have mode ${expected.toString(8)}.`);
  }
}

function assertPrivateDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(directory) !== directory) {
    fail('LEGACY_CHECKER_RUN_PRIVATE_STATE_INVALID', `${label} must be one exact real directory.`);
  }
  assertPrivateMode(stat, 0o700, label);
}

function assertPrivateReceiptFile(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
    || fs.realpathSync(file) !== file) {
    fail('LEGACY_CHECKER_RUN_PRIVATE_STATE_INVALID', 'Legacy checker receipt must be one exact regular non-linked file.');
  }
  assertPrivateMode(stat, 0o600, 'Legacy checker receipt');
}

function readStoredReceipt(root, receiptId, expectedBasis = null, expectedCommand = null) {
  const file = receiptPath(root, receiptId);
  if (!fs.existsSync(file)) {
    fail('LEGACY_CHECKER_RUN_RECEIPT_MISSING', 'Exact legacy checker receipt is missing.');
  }
  assertPrivateReceiptFile(file);
  let receipt;
  try {
    receipt = readJson(file);
  } catch (error) {
    fail('LEGACY_CHECKER_RUN_RECEIPT_TAMPERED', 'Legacy checker receipt is malformed.', error);
  }
  return assertLegacyCheckerRunReceipt({
    root,
    receipt,
    expectedBasis,
    expectedCommand
  });
}

export function inspectLegacyCheckerRunReceipt({ root = defaultRoot, receiptId, ...unknown } = {}) {
  exactRequest(
    { root, receiptId, ...unknown },
    ['root', 'receiptId'],
    'LEGACY_CHECKER_RUN_RECEIPT_INVALID'
  );
  const resolvedRoot = resolvedRepositoryRoot(root);
  const directory = confinedFile(resolvedRoot, STATE_DIRECTORY, 'Legacy checker receipt directory');
  if (!fs.existsSync(directory)) {
    fail('LEGACY_CHECKER_RUN_RECEIPT_MISSING', 'Exact legacy checker receipt is missing.');
  }
  assertPrivateDirectory(directory, 'Legacy checker receipt directory');
  const receipt = readStoredReceipt(resolvedRoot, receiptId);
  return {
    receiptPath: `${STATE_DIRECTORY}/${receiptId}.json`,
    receipt
  };
}

export function inspectCurrentLegacyCheckerRunReceipt({
  root = defaultRoot,
  receiptId,
  ...unknown
} = {}) {
  exactRequest(
    { root, receiptId, ...unknown },
    ['root', 'receiptId'],
    'LEGACY_CHECKER_RUN_RECEIPT_INVALID'
  );
  const inspected = inspectBasisInternal(root);
  if (receiptId !== inspected.receiptId) {
    fail(
      'LEGACY_CHECKER_RUN_RECEIPT_BASIS_STALE',
      'Legacy checker receipt does not bind the current complete checker input tree.'
    );
  }
  const directory = confinedFile(
    inspected.root,
    STATE_DIRECTORY,
    'Legacy checker receipt directory'
  );
  if (!fs.existsSync(directory)) {
    fail('LEGACY_CHECKER_RUN_RECEIPT_MISSING', 'Exact legacy checker receipt is missing.');
  }
  assertPrivateDirectory(directory, 'Legacy checker receipt directory');
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const expectedName = receiptId + '.json';
  if (entries.length !== 1 || entries[0].name !== expectedName || !entries[0].isFile()) {
    fail(
      'LEGACY_CHECKER_RUN_RECEIPT_REENTRY_MISMATCH',
      'Current legacy checker receipt state is ambiguous or belongs to another execution basis.'
    );
  }
  const receipt = readStoredReceipt(
    inspected.root,
    receiptId,
    inspected.basis,
    inspected.command
  );
  assertExecutionBasisUnchanged(inspected);
  return {
    receiptPath: `${STATE_DIRECTORY}/${receiptId}.json`,
    receipt
  };
}

function existingReceiptForBasis(inspected) {
  const directory = confinedFile(inspected.root, STATE_DIRECTORY, 'Legacy checker receipt directory');
  if (!fs.existsSync(directory)) return null;
  assertPrivateDirectory(directory, 'Legacy checker receipt directory');
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const expectedName = inspected.receiptId + '.json';
  if (entries.length !== 1 || entries[0].name !== expectedName || !entries[0].isFile()) {
    fail(
      entries.length === 0
        ? 'LEGACY_CHECKER_RUN_RECEIPT_MISSING'
        : 'LEGACY_CHECKER_RUN_RECEIPT_REENTRY_MISMATCH',
      'Legacy checker receipt state is missing or belongs to a different execution basis.'
    );
  }
  return readStoredReceipt(
    inspected.root,
    inspected.receiptId,
    inspected.basis,
    inspected.command
  );
}

function ensurePrivateStateDirectory(root) {
  let current = root;
  for (const segment of STATE_DIRECTORY.split('/')) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(current) !== current) {
      fail('LEGACY_CHECKER_RUN_PRIVATE_STATE_INVALID', 'Legacy checker private state path is not one exact directory chain.');
    }
    if (process.platform !== 'win32') fs.chmodSync(current, 0o700);
    assertPrivateMode(fs.lstatSync(current), 0o700, 'Legacy checker private state directory');
  }
  return current;
}

function createReceipt(root, receipt) {
  const directory = ensurePrivateStateDirectory(root);
  const file = receiptPath(root, receipt.id);
  if (fs.existsSync(file)) {
    return readStoredReceipt(root, receipt.id, receipt.basis, receipt.command);
  }
  let descriptor = null;
  try {
    descriptor = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(receipt, null, 2) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    const directoryDescriptor = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (error?.code === 'EEXIST') {
      return readStoredReceipt(root, receipt.id, receipt.basis, receipt.command);
    }
    throw error;
  }
  assertPrivateReceiptFile(file);
  return readStoredReceipt(root, receipt.id, receipt.basis, receipt.command);
}

function buildReceipt(inspected, result) {
  const observedAt = new Date().toISOString();
  assertValidInstant(observedAt);
  const receipt = {
    $contract: RECEIPT_CONTRACT,
    contractVersion: '1.0.0',
    id: inspected.receiptId,
    observedAt,
    basis: structuredClone(inspected.basis),
    command: structuredClone(inspected.command),
    result: structuredClone(result),
    authority: {
      kind: 'none',
      grantsMigration: false,
      grantsFallbackRemoval: false,
      grantsExecution: false,
      grantsProviderRead: false,
      grantsProviderWrite: false,
      grantsPublication: false,
      grantsMerge: false
    },
    privacy: {
      rawOutputIncluded: false,
      absolutePathsIncluded: false,
      sourceContentIncluded: false,
      environmentValuesIncluded: false
    },
    limitations: [...FIXED_LIMITATIONS],
    receiptFingerprint: null
  };
  receipt.receiptFingerprint = receiptFingerprint(receipt);
  return assertLegacyCheckerRunReceipt({
    root: inspected.root,
    receipt,
    expectedBasis: inspected.basis,
    expectedCommand: inspected.command
  });
}

export function runLegacyCheckerPreRemoval({ root = defaultRoot, ...unknown } = {}) {
  exactRequest({ root, ...unknown }, ['root'], 'LEGACY_CHECKER_RUN_REQUEST_INVALID');
  const inspected = inspectBasisInternal(root);
  const existing = existingReceiptForBasis(inspected);
  if (existing) {
    assertExecutionBasisUnchanged(inspected);
    return {
      receiptPath: `${STATE_DIRECTORY}/${inspected.receiptId}.json`,
      receipt: existing
    };
  }

  const execution = spawnSync(
    process.execPath,
    [inspected.checkerFile, '--all'],
    {
      cwd: inspected.root,
      env: fixedEnvironment(),
      encoding: 'utf8',
      timeout: EXECUTION_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  assertExecutionBasisUnchanged(inspected);

  const result = parseLegacyCheckerRunResult({
    status: execution.status,
    signal: execution.signal,
    errorCode: execution.error?.code || null,
    stdout: typeof execution.stdout === 'string' ? execution.stdout : '',
    stderr: typeof execution.stderr === 'string' ? execution.stderr : ''
  });
  const receipt = buildReceipt(inspected, result);
  const stored = createReceipt(inspected.root, receipt);
  return {
    receiptPath: `${STATE_DIRECTORY}/${inspected.receiptId}.json`,
    receipt: stored
  };
}
