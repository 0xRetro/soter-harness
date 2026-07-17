#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateJsonSchema } from './verify.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptFile), '..', '..');
const RELEASE_SCHEMA = 'soter/contracts/pack-release.schema.json';
const RELEASE_INSPECTION_SCHEMA = 'soter/contracts/pack-release-inspection.schema.json';
const BUNDLE_SCHEMA = 'soter/contracts/bundle.schema.json';
const BUNDLE_INSPECTION_SCHEMA = 'soter/contracts/bundle-inspection.schema.json';
const PACK_SCHEMA = 'soter/contracts/pack.schema.json';
const EVIDENCE_SCHEMA = 'soter/contracts/evidence-v2.schema.json';
const GENERATOR_VERSION = '1.0.0';
const ALLOWED_MODES = new Set(['0644', '0755']);
const SECRET_RE = /\b(?:secret_[A-Za-z0-9]{32,}|ntn_[A-Za-z0-9]{32,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36})\b/;
const SECRET_REFERENCE_RE = /\b(?:secret-ref\.[a-z0-9]+(?:[.-][a-z0-9]+)*|(?:secret|credential)s?:\/\/[^\s"'<>]+)/i;
const ABSOLUTE_PATH_RE = /(?:^|[\s"'(=])(?:file:\/\/|[A-Za-z]:[\\/]|\/\/[^\s/]+[\\/]|\/(?=$|[),;.!?"'])|\/(?![\/\s])[^\/\s]+)/i;
const FORBIDDEN_JSON_KEYS = new Set([
  'rawproviderresponse',
  'providerresponsebody',
  'privateinputvalue',
  'credentialvalue',
  'secretvalue',
  'accesstoken',
  'refreshtoken'
]);
const EFFECT_ORDER = ['read', 'disclosure', 'write', 'dispatch', 'destructive'];
const FIXED_RELEASE_LIMITATIONS = [
  {
    code: 'LOCAL_CAPSULE_ONLY',
    summary: 'The capsule proves only deterministic local release bytes and their governed source inputs.'
  },
  {
    code: 'DEPENDENCIES_NOT_RESOLVED',
    summary: 'Release creation records dependency constraints but does not resolve, fetch, or install them.'
  },
  {
    code: 'PUBLICATION_AUTHORITY_NOT_GRANTED',
    summary: 'Local build and verification grant no publication, redistribution, marketplace, publisher, or trust authority.'
  },
  {
    code: 'RUNTIME_CLAIMS_NOT_EVALUATED',
    summary: 'Installation, configuration, readiness, verification, provider behavior, and health remain unknown.'
  }
];
const FIXED_BUNDLE_LIMITATIONS = [
  {
    code: 'TRANSPARENT_RECOMMENDATION_ONLY',
    summary: 'The bundle is a transparent pack recommendation and contains no hidden configuration or runtime authority.'
  },
  {
    code: 'NO_INSTALL_OR_AUTO_UPDATE',
    summary: 'Bundle resolution does not fetch, install, configure, realize, upgrade, or automatically update any pack.'
  },
  {
    code: 'PUBLICATION_AUTHORITY_NOT_GRANTED',
    summary: 'The local bundle grants no publication, redistribution, marketplace, publisher, or trust authority.'
  },
  {
    code: 'RUNTIME_CLAIMS_NOT_EVALUATED',
    summary: 'Referenced releases are not thereby installed, configured, ready, verified, healthy, or reachable.'
  }
];

export class DistributionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DistributionError';
    this.code = code;
  }
}

function compareCodepoint(left, right) {
  const leftPoints = [...left].map((value) => value.codePointAt(0));
  const rightPoints = [...right].map((value) => value.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function fail(code, message) {
  throw new DistributionError(code, message);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort(compareCodepoint).map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value) + '\n', 'utf8');
}

function sha256(value) {
  return 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
}

function fingerprintJson(value) {
  return sha256(canonicalJson(value));
}

function readJson(file, code = 'DISTRIBUTION_JSON_INVALID') {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(code, 'A required distribution document is not valid JSON.');
  }
}

function readSchema(root, relative) {
  return readJson(path.join(root, relative), 'DISTRIBUTION_SCHEMA_UNAVAILABLE');
}

function assertSchema(root, relative, value, code) {
  const failures = validateJsonSchema(value, readSchema(root, relative));
  if (failures.length) {
    fail(code, 'The document does not satisfy its closed distribution contract.');
  }
}

function assertDate(value, code) {
  if (typeof value !== 'string' || value.length < 20 || !Number.isFinite(Date.parse(value))) {
    fail(code, 'The distribution timestamp is invalid.');
  }
}

function containsCredentialMaterial(value) {
  if (typeof value === 'string') return SECRET_RE.test(value) || SECRET_REFERENCE_RE.test(value);
  if (Array.isArray(value)) return value.some(containsCredentialMaterial);
  if (value && typeof value === 'object') return Object.values(value).some(containsCredentialMaterial);
  return false;
}

function containsCredentialValue(value) {
  if (typeof value === 'string') return SECRET_RE.test(value);
  if (Array.isArray(value)) return value.some(containsCredentialValue);
  if (value && typeof value === 'object') return Object.values(value).some(containsCredentialValue);
  return false;
}

function assertNoCredentialMaterial(value, code) {
  if (containsCredentialMaterial(value)) {
    fail(code, 'Credential values and secret-reference material cannot enter distribution metadata.');
  }
}

function containsAbsolutePath(value) {
  if (typeof value === 'string') return ABSOLUTE_PATH_RE.test(value);
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  if (value && typeof value === 'object') return Object.values(value).some(containsAbsolutePath);
  return false;
}

function assertSanitizedMetadata(value, credentialCode, privateCode) {
  assertNoCredentialMaterial(value, credentialCode);
  if (containsAbsolutePath(value)) {
    fail(privateCode, 'Absolute local paths cannot enter sanitized distribution metadata.');
  }
}

function releaseMetadataForScan(capsule) {
  return {
    createdAt: capsule.createdAt,
    generator: capsule.generator,
    pack: capsule.pack,
    source: capsule.source,
    packageIntent: capsule.packageIntent,
    legal: capsule.legal,
    trust: capsule.trust,
    evidenceReferences: capsule.evidenceReferences,
    limitations: capsule.limitations
  };
}

function normalizeRelativePath(value, code = 'PACK_RELEASE_PATH_INVALID') {
  if (typeof value !== 'string'
    || !value
    || value.includes('\\')
    || value.includes('\0')
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    || !/^[A-Za-z0-9._/-]+$/.test(value)) {
    fail(code, 'A release path is not a normalized safe relative path.');
  }
  return value;
}

function pathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function assertDistributablePath(relative) {
  const lower = relative.toLowerCase();
  const segments = lower.split('/');
  if (segments.includes('.soter')
    || lower === '.git'
    || lower.startsWith('.git/')
    || lower.startsWith('soter/configurations/')
    || lower.startsWith('soter/locks/')
    || /(?:^|\/)\.env(?:\.|$)/.test(lower)
    || /(?:^|\/)(?:credentials?|secrets?)(?:\.[a-z0-9._-]+)?$/.test(lower)) {
    fail('PACK_RELEASE_PRIVATE_STATE_REJECTED', 'A private, active, or credential-bearing path cannot enter a pack release.');
  }
}

function findForbiddenJsonKey(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenJsonKey(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (FORBIDDEN_JSON_KEYS.has(normalizedKey)) return key;
    const found = findForbiddenJsonKey(child);
    if (found) return found;
  }
  return null;
}

function assertContentSafe(relative, bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)
    || text.charCodeAt(0) === 0xfeff
    || text.includes('\r')
    || text.includes('\0')
    || !text.endsWith('\n')) {
    fail('PACK_RELEASE_ENCODING_INVALID', 'Version 1 release artifacts must be exact UTF-8 text with LF newlines and one final newline.');
  }
  if (SECRET_RE.test(text)) {
    fail('PACK_RELEASE_CREDENTIAL_REJECTED', 'Credential-like material cannot enter a pack release.');
  }
  if (relative.toLowerCase().endsWith('.json')) {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      fail('PACK_RELEASE_ARTIFACT_JSON_INVALID', 'A declared JSON artifact is malformed.');
    }
    if (findForbiddenJsonKey(value)) {
      fail('PACK_RELEASE_RAW_RESPONSE_REJECTED', 'Raw provider, secret, credential, or private-input values cannot enter a pack release.');
    }
    if (containsCredentialValue(value)) {
      fail('PACK_RELEASE_CREDENTIAL_REJECTED', 'Credential-like material cannot enter a pack release.');
    }
  }
}

function modeOf(stat) {
  return '0' + (stat.mode & 0o7777).toString(8).padStart(3, '0');
}

function readSafeSource(root, relative) {
  normalizeRelativePath(relative);
  assertDistributablePath(relative);
  const realRoot = fs.realpathSync(root);
  let current = realRoot;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      fail('PACK_RELEASE_ARTIFACT_MISSING', 'A declared release artifact is missing.');
    }
    if (stat.isSymbolicLink()) {
      fail('PACK_RELEASE_SYMLINK_REJECTED', 'Symlinked release sources and parent paths are prohibited.');
    }
  }
  const stat = fs.lstatSync(current);
  if (!stat.isFile()) {
    fail('PACK_RELEASE_NON_REGULAR_REJECTED', 'Only regular files can enter a pack release.');
  }
  if (stat.nlink !== 1) {
    fail('PACK_RELEASE_HARDLINK_REJECTED', 'Hardlinked release sources are prohibited.');
  }
  const realFile = fs.realpathSync(current);
  if (!pathInside(realRoot, realFile)) {
    fail('PACK_RELEASE_PATH_INVALID', 'A release source resolves outside the source root.');
  }
  const mode = modeOf(stat);
  if (!ALLOWED_MODES.has(mode)) {
    fail('PACK_RELEASE_MODE_UNSUPPORTED', 'A release source has a mode outside the closed 0644/0755 set.');
  }
  const bytes = fs.readFileSync(realFile);
  if (!bytes.length) {
    fail('PACK_RELEASE_EMPTY_ARTIFACT', 'Empty release artifacts are not supported by the version 1 capsule.');
  }
  assertContentSafe(relative, bytes);
  return { bytes, mode };
}

function assertUniquePaths(paths) {
  const exact = new Set();
  const folded = new Set();
  for (const value of paths) {
    const relative = normalizeRelativePath(value);
    const lower = relative.toLowerCase();
    if (exact.has(relative) || folded.has(lower)) {
      fail('PACK_RELEASE_PATH_COLLISION', 'Duplicate or case-colliding release paths are prohibited.');
    }
    exact.add(relative);
    folded.add(lower);
  }
}

function inventorySummary(inventory) {
  return inventory.map(({ path: itemPath, role, mode, bytes, contentFingerprint }) => ({
    path: itemPath,
    role,
    mode,
    bytes,
    contentFingerprint
  }));
}

function sourceInputFingerprint(pack, inventory) {
  return fingerprintJson({
    pack: {
      id: pack.id,
      version: pack.version,
      manifestFingerprint: pack.manifestFingerprint
    },
    inventory: inventorySummary(inventory)
  });
}

function runGit(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function runGitBytes(root, args) {
  const result = spawnSync('git', ['-C', root, ...args]);
  return result.status === 0 ? result.stdout : null;
}

function exactGitInputState(root, revision, inputPaths) {
  const status = runGit(root, ['status', '--porcelain=v1', '--', ...inputPaths]);
  if (status === null) return 'unknown';
  if (status) return 'dirty';
  for (const relative of inputPaths) {
    const treeBytes = runGitBytes(root, ['ls-tree', '-z', '--full-tree', revision, '--', relative]);
    if (treeBytes === null) return 'unknown';
    const entries = treeBytes.toString('utf8').split('\0').filter(Boolean);
    if (entries.length !== 1) return 'dirty';
    const match = /^([0-7]{6}) blob ([0-9a-f]{40,64})\t(.+)$/.exec(entries[0]);
    if (!match || match[3] !== relative) return 'dirty';
    const expectedMode = match[1] === '100644' ? '0644' : match[1] === '100755' ? '0755' : null;
    if (!expectedMode) return 'dirty';
    let currentStat;
    let currentBytes;
    try {
      currentStat = fs.lstatSync(path.join(root, relative));
      currentBytes = fs.readFileSync(path.join(root, relative));
    } catch {
      return 'unknown';
    }
    const revisionBytes = runGitBytes(root, ['cat-file', 'blob', match[2]]);
    if (revisionBytes === null) return 'unknown';
    if (modeOf(currentStat) !== expectedMode || !currentBytes.equals(revisionBytes)) return 'dirty';
  }
  return 'clean';
}

function sourceProvenance(root, inputPaths, inputFingerprint) {
  const revision = runGit(root, ['rev-parse', 'HEAD']);
  if (!revision) {
    return {
      kind: 'filesystem',
      revision: null,
      remoteLocatorFingerprint: null,
      exactInputState: 'unknown',
      inputFingerprint,
      reproducibilityClaim: 'contained-determinism-only'
    };
  }
  const remote = runGit(root, ['config', '--get', 'remote.origin.url']);
  return {
    kind: 'git',
    revision,
    remoteLocatorFingerprint: remote ? sha256(remote) : null,
    exactInputState: exactGitInputState(root, revision, inputPaths),
    inputFingerprint,
    reproducibilityClaim: 'contained-determinism-only'
  };
}

function packageIntent(root) {
  const file = path.join(root, 'package.json');
  if (!fs.existsSync(file)) {
    return {
      state: 'absent',
      private: null,
      sourceFingerprint: null,
      interpretation: 'packaging-intent-only'
    };
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    return {
      state: 'unavailable',
      private: null,
      sourceFingerprint: null,
      interpretation: 'packaging-intent-only'
    };
  }
  const bytes = fs.readFileSync(file);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return {
      state: 'unavailable',
      private: null,
      sourceFingerprint: sha256(bytes),
      interpretation: 'packaging-intent-only'
    };
  }
  if (typeof value.private !== 'boolean') {
    return {
      state: 'unavailable',
      private: null,
      sourceFingerprint: sha256(bytes),
      interpretation: 'packaging-intent-only'
    };
  }
  return {
    state: 'present',
    private: value.private,
    sourceFingerprint: sha256(bytes),
    interpretation: 'packaging-intent-only'
  };
}

function legalBoundary() {
  return {
    publisher: { state: 'unasserted' },
    license: { state: 'no-assertion' },
    publicationEligibility: 'not-evaluated',
    redistributionEligibility: 'not-evaluated',
    marketplaceEligibility: 'not-evaluated',
    legalSufficiency: 'not-evaluated'
  };
}

function trustBoundary() {
  return { state: 'unsigned-untrusted', signature: 'absent' };
}

function generatorFingerprint() {
  return sha256(fs.readFileSync(scriptFile));
}

function releaseGenerator() {
  return { id: 'kernel.soter.pack-release', version: GENERATOR_VERSION, fingerprint: generatorFingerprint() };
}

function bundleGenerator() {
  return { id: 'kernel.soter.bundle', version: GENERATOR_VERSION, fingerprint: generatorFingerprint() };
}

function mergeLimitations(fixed, supplied = []) {
  const values = [...fixed, ...supplied].sort((a, b) => compareCodepoint(a.code, b.code));
  const seen = new Set();
  for (const item of values) {
    if (!item || typeof item !== 'object' || typeof item.code !== 'string' || typeof item.summary !== 'string') {
      fail('DISTRIBUTION_LIMITATION_INVALID', 'Distribution limitations require stable codes and summaries.');
    }
    if (seen.has(item.code)) fail('DISTRIBUTION_LIMITATION_INVALID', 'Distribution limitation codes must be unique.');
    seen.add(item.code);
  }
  return values;
}

function loadEvidenceReferences(root, evidencePaths, pack, inputFingerprint, createdAt) {
  const references = [];
  const seen = new Set();
  for (const requested of evidencePaths || []) {
    const file = path.resolve(requested);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      fail('PACK_RELEASE_EVIDENCE_INVALID', 'A referenced evidence file is unavailable.');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      fail('PACK_RELEASE_EVIDENCE_INVALID', 'Evidence references must be regular non-linked files.');
    }
    const bytes = fs.readFileSync(file);
    let evidence;
    try {
      evidence = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('PACK_RELEASE_EVIDENCE_INVALID', 'A referenced evidence file is malformed.');
    }
    assertNoCredentialMaterial(evidence, 'PACK_RELEASE_CREDENTIAL_REJECTED');
    assertSchema(root, EVIDENCE_SCHEMA, evidence, 'PACK_RELEASE_EVIDENCE_INVALID');
    assertDate(evidence.createdAt, 'PACK_RELEASE_EVIDENCE_INVALID');
    if (Date.parse(evidence.createdAt) > Date.parse(createdAt)) {
      fail('PACK_RELEASE_EVIDENCE_INVALID', 'Evidence created after the release build cannot support that release.');
    }
    if (evidence.freshness.validUntil !== null) {
      assertDate(evidence.freshness.validUntil, 'PACK_RELEASE_EVIDENCE_INVALID');
    }
    if (evidence.subject.type !== 'pack'
      || evidence.subject.id !== pack.id
      || evidence.subject.version !== pack.version
      || evidence.result !== 'passed'
      || evidence.graphFingerprint !== inputFingerprint
      || !['shareable', 'public'].includes(evidence.privacy.scope)
      || !evidence.dependencies.some((dependency) => dependency.id === pack.id
        && dependency.version === pack.version
        && dependency.fingerprint === pack.manifestFingerprint)
      || !Array.isArray(evidence.limitations)
      || !evidence.limitations.length) {
      fail('PACK_RELEASE_EVIDENCE_MISMATCH', 'Evidence does not bind the exact pack source graph and shareable claim boundary.');
    }
    if (evidence.freshness.validUntil !== null
      && Date.parse(evidence.freshness.validUntil) < Date.parse(createdAt)) {
      fail('PACK_RELEASE_EVIDENCE_STALE', 'Stale evidence cannot support a release reference.');
    }
    const fingerprint = sha256(bytes);
    if (seen.has(evidence.id) || seen.has(fingerprint)) {
      fail('PACK_RELEASE_EVIDENCE_INVALID', 'Evidence references must be unique.');
    }
    seen.add(evidence.id);
    seen.add(fingerprint);
    references.push({
      id: evidence.id,
      fingerprint,
      graphFingerprint: evidence.graphFingerprint,
      result: 'passed',
      privacyScope: evidence.privacy.scope,
      validUntil: evidence.freshness.validUntil,
      applicableManifestFingerprint: pack.manifestFingerprint,
      limitations: evidence.limitations
    });
  }
  return references.sort((a, b) => compareCodepoint(a.id, b.id));
}

function ensureOutputDirectory(root, requested) {
  if (!requested) fail('DISTRIBUTION_OUTPUT_INVALID', 'An explicit output directory is required.');
  const directory = path.resolve(requested);
  const realRoot = fs.realpathSync(root);
  let existing = directory;
  const missing = [];
  while (!fs.existsSync(existing)) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const candidate = path.join(fs.realpathSync(existing), ...missing);
  if (pathInside(path.join(realRoot, 'soter'), candidate)
    || pathInside(path.join(realRoot, '.soter'), candidate)) {
    fail('PACK_RELEASE_OUTPUT_SELF_REFERENCE', 'Release outputs must remain outside canonical and private Soter source graphs.');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('DISTRIBUTION_OUTPUT_INVALID', 'The output location must be one real directory.');
  }
  const realDirectory = fs.realpathSync(directory);
  if (pathInside(path.join(realRoot, 'soter'), realDirectory)
    || pathInside(path.join(realRoot, '.soter'), realDirectory)) {
    fail('PACK_RELEASE_OUTPUT_SELF_REFERENCE', 'Release outputs must remain outside canonical and private Soter source graphs.');
  }
  return realDirectory;
}

function writeContentAddressed(directory, base, suffix, bytes) {
  const digest = sha256(bytes);
  const file = path.join(directory, `${base}-${digest.slice('sha256:'.length)}.${suffix}`);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()
      || stat.isSymbolicLink()
      || stat.nlink !== 1
      || modeOf(stat) !== '0644'
      || !fs.readFileSync(file).equals(bytes)) {
      fail('DISTRIBUTION_OUTPUT_CONFLICT', 'An existing content-addressed output does not contain the exact expected bytes.');
    }
    return { file, digest };
  }
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o644 });
  fs.chmodSync(file, 0o644);
  return { file, digest };
}

function packSummary(manifest, manifestPath, manifestBytes) {
  return {
    id: manifest.id,
    version: manifest.version,
    layer: manifest.layer,
    releaseStage: manifest.releaseStage,
    evidenceMaturity: manifest.evidenceMaturity,
    summary: manifest.summary,
    manifestPath,
    manifestFingerprint: fingerprintJson(manifest),
    manifestBytesFingerprint: sha256(manifestBytes),
    dependencies: manifest.dependencies,
    capabilities: manifest.capabilities,
    authorities: manifest.authorities,
    effects: manifest.effects,
    compatibility: manifest.compatibility
  };
}

function buildInventory(root, manifestPath, manifest) {
  const declared = [
    { path: manifestPath, role: 'manifest' },
    ...manifest.artifacts.map((artifact) => ({ path: artifact.path, role: artifact.role }))
  ];
  assertUniquePaths(declared.map((item) => item.path));
  return declared.map((item) => {
    const source = readSafeSource(root, item.path);
    return {
      path: item.path,
      role: item.role,
      mode: source.mode,
      bytes: source.bytes.length,
      contentFingerprint: sha256(source.bytes),
      contentEncoding: 'base64',
      content: source.bytes.toString('base64')
    };
  }).sort((a, b) => compareCodepoint(a.path, b.path));
}

function assertCanonicalPackPath(root, manifestPath, manifest) {
  const expected = `soter/packs/${manifest.id}/pack.json`;
  if (manifestPath !== expected || !fs.existsSync(path.join(root, expected))) {
    fail('PACK_RELEASE_IDENTITY_MISMATCH', 'The pack identifier must match its canonical manifest path.');
  }
}

function releaseClaims() {
  return {
    localReleaseBytes: 'passed',
    dependencyResolution: 'not-evaluated',
    installed: 'unknown',
    configured: 'unknown',
    ready: 'unknown',
    verified: 'unknown',
    healthy: 'unknown',
    networkAvailability: 'unknown',
    publisherIdentity: 'not-evaluated',
    publicationAuthority: 'not-evaluated',
    redistributionAuthority: 'not-evaluated',
    marketplaceEligibility: 'not-evaluated',
    trust: 'not-evaluated'
  };
}

function releaseAuthority() {
  return {
    install: false,
    configure: false,
    realizeHost: false,
    publish: false,
    redistribute: false,
    marketplace: false,
    trust: false
  };
}

function releasePrivacy() {
  return {
    capsuleBytesIncluded: false,
    sourceRootIncluded: false,
    privateStateIncluded: false,
    credentialValuesIncluded: false,
    rawProviderResponsesIncluded: false,
    activeConfigurationIncluded: false
  };
}

function compareSource(capsule, sourceRoot) {
  if (!sourceRoot) {
    return { state: 'unknown', reasonCode: 'PACK_RELEASE_SOURCE_NOT_EVALUATED' };
  }
  try {
    const root = fs.realpathSync(path.resolve(sourceRoot));
    for (const entry of capsule.inventory) {
      const observed = readSafeSource(root, entry.path);
      if (observed.mode !== entry.mode
        || observed.bytes.length !== entry.bytes
        || sha256(observed.bytes) !== entry.contentFingerprint
        || observed.bytes.toString('base64') !== entry.content) {
        return { state: 'failed', reasonCode: 'PACK_RELEASE_SOURCE_MISMATCH' };
      }
    }
    return { state: 'passed', reasonCode: 'PACK_RELEASE_SOURCE_MATCH' };
  } catch {
    return { state: 'failed', reasonCode: 'PACK_RELEASE_SOURCE_MISMATCH' };
  }
}

function packReleaseInspection(capsule, capsuleDigest, sourceComparison) {
  const inspection = {
    $contract: 'soter://contracts/pack-release-inspection/v1',
    contractVersion: '1.0.0',
    kind: 'pack-release',
    release: {
      id: capsule.pack.id,
      version: capsule.pack.version,
      layer: capsule.pack.layer,
      releaseStage: capsule.pack.releaseStage,
      evidenceMaturity: capsule.pack.evidenceMaturity,
      summary: capsule.pack.summary,
      capsuleDigest,
      createdAt: capsule.createdAt,
      generator: capsule.generator,
      manifestFingerprint: capsule.pack.manifestFingerprint,
      sourceInputFingerprint: capsule.sourceInputFingerprint
    },
    integrity: {
      state: 'passed',
      reasonCode: 'PACK_RELEASE_BYTES_VERIFIED',
      inventoryFingerprint: capsule.inventoryFingerprint
    },
    sourceComparison,
    provenance: capsule.source,
    packageIntent: capsule.packageIntent,
    legal: capsule.legal,
    trust: capsule.trust,
    inventory: inventorySummary(capsule.inventory),
    constraints: {
      dependencies: capsule.pack.dependencies,
      capabilities: capsule.pack.capabilities,
      authorities: capsule.pack.authorities,
      effects: capsule.pack.effects,
      compatibility: capsule.pack.compatibility
    },
    evidenceReferences: capsule.evidenceReferences,
    claims: releaseClaims(),
    authority: releaseAuthority(),
    privacy: releasePrivacy(),
    limitations: capsule.limitations
  };
  inspection.inspectionFingerprint = fingerprintJson(inspection);
  return inspection;
}

function decodeInventoryEntry(entry) {
  const bytes = Buffer.from(entry.content, 'base64');
  if (bytes.toString('base64') !== entry.content
    || bytes.length !== entry.bytes
    || sha256(bytes) !== entry.contentFingerprint) {
    fail('PACK_RELEASE_TAMPERED', 'An inventory entry does not match its exact encoded bytes and fingerprint.');
  }
  assertContentSafe(entry.path, bytes);
  return bytes;
}

function assertReleaseEvidenceReferences(capsule) {
  const ids = new Set();
  const fingerprints = new Set();
  for (const reference of capsule.evidenceReferences) {
    if (ids.has(reference.id) || fingerprints.has(reference.fingerprint)) {
      fail('PACK_RELEASE_EVIDENCE_INVALID', 'Release evidence IDs and fingerprints must each be unique.');
    }
    ids.add(reference.id);
    fingerprints.add(reference.fingerprint);
    if (reference.graphFingerprint !== capsule.sourceInputFingerprint
      || reference.applicableManifestFingerprint !== capsule.pack.manifestFingerprint) {
      fail('PACK_RELEASE_EVIDENCE_MISMATCH', 'A release evidence reference does not bind the exact enclosed source graph and manifest.');
    }
    if (reference.validUntil !== null) {
      assertDate(reference.validUntil, 'PACK_RELEASE_EVIDENCE_INVALID');
      if (Date.parse(reference.validUntil) < Date.parse(capsule.createdAt)) {
        fail('PACK_RELEASE_EVIDENCE_STALE', 'A release evidence reference expired before the capsule was built.');
      }
    }
  }
  const ordered = [...capsule.evidenceReferences].sort((a, b) => compareCodepoint(a.id, b.id));
  if (canonicalJson(ordered) !== canonicalJson(capsule.evidenceReferences)) {
    fail('PACK_RELEASE_EVIDENCE_INVALID', 'Release evidence references are not in deterministic identity order.');
  }
}

function verifyPackReleaseInternal({ capsulePath, sourceRoot = null, contractRoot = defaultRoot }) {
  const file = path.resolve(capsulePath);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail('PACK_RELEASE_MISSING', 'The pack release capsule is unavailable.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || modeOf(stat) !== '0644') {
    fail('PACK_RELEASE_FILE_INVALID', 'A pack release capsule must be one regular non-linked file with mode 0644.');
  }
  const bytes = fs.readFileSync(file);
  let capsule;
  try {
    capsule = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('PACK_RELEASE_MALFORMED', 'The pack release capsule is not valid JSON.');
  }
  if (!canonicalBytes(capsule).equals(bytes)) {
    fail('PACK_RELEASE_NON_DETERMINISTIC', 'The pack release capsule is not exact canonical JSON with one final LF.');
  }
  assertSchema(contractRoot, RELEASE_SCHEMA, capsule, 'PACK_RELEASE_SCHEMA_INVALID');
  assertDate(capsule.createdAt, 'PACK_RELEASE_SCHEMA_INVALID');
  assertSanitizedMetadata(
    releaseMetadataForScan(capsule),
    'PACK_RELEASE_CREDENTIAL_REJECTED',
    'PACK_RELEASE_PRIVATE_STATE_REJECTED'
  );
  assertUniquePaths(capsule.inventory.map((entry) => entry.path));
  const sorted = [...capsule.inventory].sort((a, b) => compareCodepoint(a.path, b.path));
  if (canonicalJson(sorted.map((entry) => entry.path)) !== canonicalJson(capsule.inventory.map((entry) => entry.path))) {
    fail('PACK_RELEASE_INVENTORY_INVALID', 'The release inventory is not in deterministic path order.');
  }
  const decoded = new Map();
  for (const entry of capsule.inventory) {
    normalizeRelativePath(entry.path);
    assertDistributablePath(entry.path);
    decoded.set(entry.path, decodeInventoryEntry(entry));
  }
  if (fingerprintJson(inventorySummary(capsule.inventory)) !== capsule.inventoryFingerprint) {
    fail('PACK_RELEASE_TAMPERED', 'The release inventory fingerprint is invalid.');
  }
  const manifests = capsule.inventory.filter((entry) => entry.role === 'manifest');
  if (manifests.length !== 1 || manifests[0].path !== capsule.pack.manifestPath) {
    fail('PACK_RELEASE_INVENTORY_INVALID', 'The release must contain exactly one canonical pack manifest.');
  }
  let manifest;
  try {
    manifest = JSON.parse(decoded.get(capsule.pack.manifestPath).toString('utf8'));
  } catch {
    fail('PACK_RELEASE_MANIFEST_INVALID', 'The embedded pack manifest is malformed.');
  }
  assertSchema(contractRoot, PACK_SCHEMA, manifest, 'PACK_RELEASE_MANIFEST_INVALID');
  const expectedPath = `soter/packs/${manifest.id}/pack.json`;
  if (capsule.pack.manifestPath !== expectedPath
    || capsule.pack.id !== manifest.id
    || capsule.pack.version !== manifest.version
    || capsule.pack.layer !== manifest.layer
    || capsule.pack.releaseStage !== manifest.releaseStage
    || capsule.pack.evidenceMaturity !== manifest.evidenceMaturity
    || capsule.pack.summary !== manifest.summary
    || capsule.pack.manifestFingerprint !== fingerprintJson(manifest)
    || capsule.pack.manifestBytesFingerprint !== sha256(decoded.get(capsule.pack.manifestPath))
    || canonicalJson(capsule.pack.dependencies) !== canonicalJson(manifest.dependencies)
    || canonicalJson(capsule.pack.capabilities) !== canonicalJson(manifest.capabilities)
    || canonicalJson(capsule.pack.authorities) !== canonicalJson(manifest.authorities)
    || canonicalJson(capsule.pack.effects) !== canonicalJson(manifest.effects)
    || canonicalJson(capsule.pack.compatibility) !== canonicalJson(manifest.compatibility)) {
    fail('PACK_RELEASE_IDENTITY_MISMATCH', 'Pack release metadata does not match the enclosed manifest.');
  }
  const expected = [
    { path: expectedPath, role: 'manifest' },
    ...manifest.artifacts.map((artifact) => ({ path: artifact.path, role: artifact.role }))
  ].sort((a, b) => compareCodepoint(a.path, b.path));
  const observed = capsule.inventory.map(({ path: itemPath, role }) => ({ path: itemPath, role }));
  if (canonicalJson(expected) !== canonicalJson(observed)) {
    fail('PACK_RELEASE_INVENTORY_INVALID', 'The release inventory does not exactly equal the manifest and every declared artifact.');
  }
  const expectedInputFingerprint = sourceInputFingerprint(capsule.pack, capsule.inventory);
  if (capsule.sourceInputFingerprint !== expectedInputFingerprint
    || capsule.source.inputFingerprint !== expectedInputFingerprint) {
    fail('PACK_RELEASE_TAMPERED', 'The release source-input fingerprint is invalid.');
  }
  assertReleaseEvidenceReferences(capsule);
  const capsuleDigest = sha256(bytes);
  const inspection = packReleaseInspection(capsule, capsuleDigest, compareSource(capsule, sourceRoot));
  assertSchema(contractRoot, RELEASE_INSPECTION_SCHEMA, inspection, 'PACK_RELEASE_INSPECTION_INVALID');
  return { capsule, capsuleDigest, inspection, manifest };
}

export function verifyPackRelease(options) {
  return verifyPackReleaseInternal(options).inspection;
}

export function buildPackRelease({
  root = defaultRoot,
  pack,
  outputDirectory,
  createdAt,
  evidencePaths = [],
  limitations = []
}) {
  const sourceRoot = fs.realpathSync(path.resolve(root));
  assertDate(createdAt, 'PACK_RELEASE_CREATED_AT_INVALID');
  assertNoCredentialMaterial(limitations, 'PACK_RELEASE_CREDENTIAL_REJECTED');
  const manifestPath = normalizeRelativePath(
    typeof pack === 'string' && pack.includes('/') ? pack : `soter/packs/${pack}/pack.json`
  );
  const manifestSource = readSafeSource(sourceRoot, manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestSource.bytes.toString('utf8'));
  } catch {
    fail('PACK_RELEASE_MANIFEST_INVALID', 'The pack manifest is malformed.');
  }
  assertSchema(sourceRoot, PACK_SCHEMA, manifest, 'PACK_RELEASE_MANIFEST_INVALID');
  assertCanonicalPackPath(sourceRoot, manifestPath, manifest);
  const packData = packSummary(manifest, manifestPath, manifestSource.bytes);
  const inventory = buildInventory(sourceRoot, manifestPath, manifest);
  const inputFingerprint = sourceInputFingerprint(packData, inventory);
  const inputPaths = inventory.map((entry) => entry.path);
  const capsule = {
    $contract: 'soter://contracts/pack-release/v1',
    contractVersion: '1.0.0',
    format: {
      id: 'soter-canonical-json-capsule',
      version: '1.0.0',
      encoding: 'utf-8',
      newline: 'lf-final',
      objectKeyOrder: 'unicode-codepoint',
      inventoryOrder: 'path-ascending',
      timestamps: 'explicit-created-at-only',
      ownershipMetadata: 'absent',
      allowedModes: ['0644', '0755']
    },
    createdAt,
    generator: releaseGenerator(),
    pack: packData,
    source: sourceProvenance(sourceRoot, inputPaths, inputFingerprint),
    packageIntent: packageIntent(sourceRoot),
    legal: legalBoundary(),
    trust: trustBoundary(),
    evidenceReferences: loadEvidenceReferences(sourceRoot, evidencePaths, packData, inputFingerprint, createdAt),
    inventory,
    inventoryFingerprint: fingerprintJson(inventorySummary(inventory)),
    sourceInputFingerprint: inputFingerprint,
    limitations: mergeLimitations(FIXED_RELEASE_LIMITATIONS, limitations)
  };
  assertSanitizedMetadata(
    releaseMetadataForScan(capsule),
    'PACK_RELEASE_CREDENTIAL_REJECTED',
    'PACK_RELEASE_PRIVATE_STATE_REJECTED'
  );
  assertSchema(sourceRoot, RELEASE_SCHEMA, capsule, 'PACK_RELEASE_SCHEMA_INVALID');
  const bytes = canonicalBytes(capsule);
  const directory = ensureOutputDirectory(sourceRoot, outputDirectory);
  const base = `${manifest.id}-${manifest.version}`;
  const written = writeContentAddressed(directory, base, 'soter-pack.json', bytes);
  const verified = verifyPackReleaseInternal({
    capsulePath: written.file,
    sourceRoot,
    contractRoot: sourceRoot
  });
  return { capsulePath: written.file, capsuleDigest: written.digest, inspection: verified.inspection };
}

function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value || '');
  return match ? match.slice(1).map(BigInt) : null;
}

function compareVersions(a, b) {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  if (!av || !bv) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (av[index] !== bv[index]) return av[index] < bv[index] ? -1 : 1;
  }
  return 0;
}

export function satisfiesVersion(version, range) {
  const current = parseVersion(version);
  const match = /^(\^|~|>=|<=|>|<)?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(range || '');
  if (!current || !match) return false;
  const operator = match[1] || '';
  const base = parseVersion(match[2]);
  const comparison = compareVersions(version, match[2]);
  if (!operator) return comparison === 0;
  if (operator === '>=') return comparison >= 0;
  if (operator === '<=') return comparison <= 0;
  if (operator === '>') return comparison > 0;
  if (operator === '<') return comparison < 0;
  if (operator === '~') return comparison >= 0 && current[0] === base[0] && current[1] === base[1];
  if (operator === '^') {
    if (base[0] > 0n) return comparison >= 0 && current[0] === base[0];
    if (base[1] > 0n) return comparison >= 0 && current[0] === 0n && current[1] === base[1];
    return comparison === 0;
  }
  return false;
}

function assertBundleDefinitionInput(value) {
  const allowed = new Set([
    'id', 'version', 'summary', 'releaseStage', 'createdAt', 'target',
    'references', 'limitations'
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.has(key))) {
    fail('BUNDLE_DEFINITION_INVALID', 'Bundle build input contains unsupported fields.');
  }
}

function assertBundleSemantics(bundle) {
  const ids = new Set();
  const packs = new Set();
  for (const reference of bundle.references) {
    if (ids.has(reference.id) || packs.has(reference.pack)) {
      fail('BUNDLE_REFERENCE_INVALID', 'Bundle reference and pack identities must be unique.');
    }
    ids.add(reference.id);
    packs.add(reference.pack);
  }
}

export function buildBundle({ root = defaultRoot, definition, outputDirectory }) {
  const contractRoot = fs.realpathSync(path.resolve(root));
  assertBundleDefinitionInput(definition);
  assertSanitizedMetadata(
    definition,
    'BUNDLE_CREDENTIAL_REJECTED',
    'BUNDLE_PRIVATE_METADATA_REJECTED'
  );
  assertDate(definition.createdAt, 'BUNDLE_CREATED_AT_INVALID');
  const bundle = {
    $contract: 'soter://contracts/bundle/v1',
    contractVersion: '1.0.0',
    id: definition.id,
    version: definition.version,
    summary: definition.summary,
    releaseStage: definition.releaseStage,
    evidenceMaturity: 'declared',
    createdAt: definition.createdAt,
    generator: bundleGenerator(),
    target: definition.target,
    references: definition.references,
    legal: legalBoundary(),
    trust: trustBoundary(),
    limitations: mergeLimitations(FIXED_BUNDLE_LIMITATIONS, definition.limitations || [])
  };
  assertSchema(contractRoot, BUNDLE_SCHEMA, bundle, 'BUNDLE_SCHEMA_INVALID');
  assertBundleSemantics(bundle);
  const bytes = canonicalBytes(bundle);
  const directory = ensureOutputDirectory(contractRoot, outputDirectory);
  const written = writeContentAddressed(directory, `${bundle.id}-${bundle.version}`, 'soter-bundle.json', bytes);
  return {
    bundlePath: written.file,
    bundleDigest: written.digest,
    inspection: inspectBundle({ bundlePath: written.file, releasePaths: [], contractRoot })
  };
}

function readBundle(bundlePath, contractRoot) {
  const file = path.resolve(bundlePath);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail('BUNDLE_MISSING', 'The bundle document is unavailable.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || modeOf(stat) !== '0644') {
    fail('BUNDLE_FILE_INVALID', 'A bundle must be one regular non-linked file with mode 0644.');
  }
  const bytes = fs.readFileSync(file);
  let bundle;
  try {
    bundle = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('BUNDLE_MALFORMED', 'The bundle is not valid JSON.');
  }
  if (!canonicalBytes(bundle).equals(bytes)) {
    fail('BUNDLE_NON_DETERMINISTIC', 'The bundle is not exact canonical JSON with one final LF.');
  }
  assertSchema(contractRoot, BUNDLE_SCHEMA, bundle, 'BUNDLE_SCHEMA_INVALID');
  assertDate(bundle.createdAt, 'BUNDLE_CREATED_AT_INVALID');
  assertSanitizedMetadata(
    bundle,
    'BUNDLE_CREDENTIAL_REJECTED',
    'BUNDLE_PRIVATE_METADATA_REJECTED'
  );
  assertBundleSemantics(bundle);
  return { bundle, digest: sha256(bytes) };
}

function blocker(code, referenceId, pack, summary) {
  return { code, referenceId, pack, summary };
}

function releaseSelection(release) {
  return {
    pack: release.capsule.pack.id,
    version: release.capsule.pack.version,
    capsuleDigest: release.capsuleDigest,
    releaseStage: release.capsule.pack.releaseStage,
    evidenceMaturity: release.capsule.pack.evidenceMaturity
  };
}

function resolveReference(reference, catalog, blockers) {
  const matches = catalog.filter((release) => release.capsule.pack.id === reference.pack);
  let candidates;
  if (reference.selection.kind === 'exact') {
    candidates = matches.filter((release) => release.capsule.pack.version === reference.selection.version
      && release.capsuleDigest === reference.selection.capsuleDigest);
  } else {
    candidates = matches.filter((release) => satisfiesVersion(release.capsule.pack.version, reference.selection.version));
    candidates.sort((a, b) => compareVersions(b.capsule.pack.version, a.capsule.pack.version)
      || compareCodepoint(a.capsuleDigest, b.capsuleDigest));
    if (candidates.length > 1
      && candidates[0].capsule.pack.version === candidates[1].capsule.pack.version
      && candidates[0].capsuleDigest !== candidates[1].capsuleDigest) {
      blockers.push(blocker(
        'BUNDLE_RELEASE_AMBIGUOUS', reference.id, reference.pack,
        'The compatible constraint matches several different capsules at the same highest version.'
      ));
      return null;
    }
  }
  if (!candidates.length) {
    blockers.push(blocker(
      'BUNDLE_RELEASE_MISSING', reference.id, reference.pack,
      'No verified local release satisfies this transparent bundle reference.'
    ));
    return null;
  }
  return candidates[0];
}

function intersection(values) {
  if (!values.length) return [];
  return [...values.slice(1).reduce(
    (current, next) => new Set([...current].filter((value) => next.has(value))),
    new Set(values[0])
  )].sort(compareCodepoint);
}

function bundleClaims(resolved) {
  return {
    localBundleBytes: 'passed',
    referencedReleaseBytes: resolved ? 'passed' : 'unknown',
    installed: 'unknown',
    configured: 'unknown',
    ready: 'unknown',
    verified: 'unknown',
    healthy: 'unknown',
    networkAvailability: 'unknown',
    publisherIdentity: 'not-evaluated',
    publicationAuthority: 'not-evaluated',
    redistributionAuthority: 'not-evaluated',
    marketplaceEligibility: 'not-evaluated',
    trust: 'not-evaluated'
  };
}

function bundleAuthority() {
  return {
    install: false,
    configure: false,
    realizeHost: false,
    publish: false,
    redistribute: false,
    marketplace: false,
    trust: false,
    autoUpdate: false
  };
}

function bundlePrivacy() {
  return {
    capsuleBytesIncluded: false,
    sourcePathsIncluded: false,
    privateStateIncluded: false,
    credentialValuesIncluded: false,
    activeConfigurationIncluded: false
  };
}

export function inspectBundle({ bundlePath, releasePaths = [], contractRoot = defaultRoot }) {
  const root = fs.realpathSync(path.resolve(contractRoot));
  const { bundle, digest } = readBundle(bundlePath, root);
  const catalogByDigest = new Map();
  for (const releasePath of releasePaths) {
    const release = verifyPackReleaseInternal({ capsulePath: releasePath, contractRoot: root });
    catalogByDigest.set(release.capsuleDigest, release);
  }
  const catalog = [...catalogByDigest.values()].sort((a, b) => compareCodepoint(a.capsule.pack.id, b.capsule.pack.id)
    || compareVersions(a.capsule.pack.version, b.capsule.pack.version)
    || compareCodepoint(a.capsuleDigest, b.capsuleDigest));
  const catalogFingerprint = fingerprintJson(catalog.map((release) => ({
    pack: release.capsule.pack.id,
    version: release.capsule.pack.version,
    capsuleDigest: release.capsuleDigest
  })));
  const blockers = [];
  const selectedByPack = new Map();
  const references = bundle.references.map((reference) => {
    const selected = resolveReference(reference, catalog, blockers);
    if (selected) selectedByPack.set(reference.pack, selected);
    return {
      id: reference.id,
      pack: reference.pack,
      selection: reference.selection,
      reason: reference.reason,
      compatibilityLimitations: reference.compatibilityLimitations,
      state: selected ? 'selected' : 'blocked',
      selectedRelease: selected ? releaseSelection(selected) : null
    };
  });
  for (const [consumer, release] of selectedByPack) {
    for (const dependency of release.capsule.pack.dependencies) {
      const selectedDependency = selectedByPack.get(dependency.pack);
      if (!selectedDependency && !dependency.optional) {
        blockers.push(blocker(
          'BUNDLE_DEPENDENCY_MISSING', null, dependency.pack,
          `The selected ${consumer} release has an unresolved declared dependency.`
        ));
      } else if (selectedDependency
        && !satisfiesVersion(selectedDependency.capsule.pack.version, dependency.version)) {
        blockers.push(blocker(
          'BUNDLE_DEPENDENCY_VERSION_MISMATCH', null, dependency.pack,
          `The selected ${consumer} release dependency constraint is not satisfied.`
        ));
      }
    }
    if (!satisfiesVersion(bundle.target.baseContract, release.capsule.pack.compatibility.baseContract)) {
      blockers.push(blocker(
        'BUNDLE_BASE_INCOMPATIBLE', null, consumer,
        'The selected release does not support the bundle target base contract.'
      ));
    }
    for (const host of bundle.target.hosts) {
      if (!release.capsule.pack.compatibility.hosts.includes(host)) {
        blockers.push(blocker(
          'BUNDLE_HOST_INCOMPATIBLE', null, consumer,
          'The selected release does not support every declared bundle target host.'
        ));
      }
    }
  }
  const uniqueBlockers = [...new Map(blockers.map((item) => [canonicalJson(item), item])).values()]
    .sort((a, b) => compareCodepoint(a.code, b.code) || compareCodepoint(a.pack, b.pack));
  const selected = [...selectedByPack.values()];
  const dependencies = selected.flatMap((release) => release.capsule.pack.dependencies.map((dependency) => ({
    consumer: release.capsule.pack.id,
    pack: dependency.pack,
    version: dependency.version,
    optional: dependency.optional
  }))).sort((a, b) => compareCodepoint(a.consumer, b.consumer) || compareCodepoint(a.pack, b.pack));
  const authorities = [...new Set(selected.flatMap((release) => release.capsule.pack.authorities.map((authority) => authority.subject)))].sort(compareCodepoint);
  const effects = EFFECT_ORDER.filter((effect) => selected.some((release) => release.capsule.pack.effects.includes(effect)));
  const compatibleHosts = intersection(selected.map((release) => new Set(release.capsule.pack.compatibility.hosts)))
    .filter((host) => bundle.target.hosts.includes(host));
  const resolutionBasis = {
    bundleDigest: digest,
    catalogFingerprint,
    references,
    blockers: uniqueBlockers
  };
  const resolved = uniqueBlockers.length === 0 && references.every((reference) => reference.state === 'selected');
  const inspection = {
    $contract: 'soter://contracts/bundle-inspection/v1',
    contractVersion: '1.0.0',
    kind: 'bundle',
    bundle: {
      id: bundle.id,
      version: bundle.version,
      summary: bundle.summary,
      releaseStage: bundle.releaseStage,
      evidenceMaturity: bundle.evidenceMaturity,
      digest,
      createdAt: bundle.createdAt,
      target: bundle.target
    },
    integrity: { state: 'passed', reasonCode: 'BUNDLE_BYTES_VERIFIED' },
    resolution: {
      state: resolved ? 'resolved' : 'blocked',
      reasonCode: resolved ? 'BUNDLE_RESOLVED' : 'BUNDLE_BLOCKED',
      catalogFingerprint,
      resolutionFingerprint: fingerprintJson(resolutionBasis),
      blockers: uniqueBlockers
    },
    references,
    aggregate: {
      packs: [...selectedByPack.keys()].sort(compareCodepoint),
      dependencies,
      authorities,
      effects,
      compatibleHosts
    },
    legal: bundle.legal,
    trust: bundle.trust,
    claims: bundleClaims(resolved),
    authority: bundleAuthority(),
    privacy: bundlePrivacy(),
    limitations: bundle.limitations
  };
  inspection.inspectionFingerprint = fingerprintJson(inspection);
  assertSchema(root, BUNDLE_INSPECTION_SCHEMA, inspection, 'BUNDLE_INSPECTION_INVALID');
  return inspection;
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function options(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name) values.push(argv[index + 1]);
  }
  return values;
}

function printResult(result, json) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(JSON.stringify(result));
}

function directMain() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const root = path.resolve(option(argv, '--root', defaultRoot));
  try {
    if (command === 'pack-release-build') {
      const result = buildPackRelease({
        root,
        pack: option(argv, '--pack'),
        outputDirectory: option(argv, '--out'),
        createdAt: option(argv, '--created-at'),
        evidencePaths: options(argv, '--evidence')
      });
      printResult(result, argv.includes('--json'));
      return;
    }
    if (command === 'pack-release-verify') {
      const inspection = verifyPackRelease({
        capsulePath: option(argv, '--capsule'),
        sourceRoot: option(argv, '--source-root'),
        contractRoot: root
      });
      printResult(inspection, argv.includes('--json'));
      return;
    }
    if (command === 'bundle-build') {
      const definition = readJson(path.resolve(option(argv, '--definition')), 'BUNDLE_DEFINITION_INVALID');
      printResult(buildBundle({ root, definition, outputDirectory: option(argv, '--out') }), argv.includes('--json'));
      return;
    }
    if (command === 'bundle-inspect') {
      printResult(inspectBundle({
        bundlePath: option(argv, '--bundle'),
        releasePaths: options(argv, '--release'),
        contractRoot: root
      }), argv.includes('--json'));
      return;
    }
    fail('DISTRIBUTION_COMMAND_INVALID', 'Expected pack-release-build, pack-release-verify, bundle-build, or bundle-inspect.');
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'DISTRIBUTION_INTERNAL_ERROR';
    console.error(`${code}: ${error instanceof DistributionError ? error.message : 'The distribution operation failed.'}`);
    process.exitCode = 1;
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptFile);
if (isDirect) directMain();
