#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildBundle,
  buildPackRelease,
  DistributionError,
  inspectBundle,
  satisfiesVersion,
  verifyPackRelease
} from './distribution.mjs';
import { validateJsonSchema } from './verify.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), '..', '..');
const createdAt = '2026-07-16T12:00:00.000Z';
const laterCreatedAt = '2026-07-16T12:00:01.000Z';
const fingerprint = 'sha256:' + 'a'.repeat(64);
const requiredContracts = [
  'pack.schema.json',
  'pack-release.schema.json',
  'pack-release-inspection.schema.json',
  'bundle.schema.json',
  'bundle-inspection.schema.json',
  'evidence-v2.schema.json'
];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalize(value)) + '\n');
}

function hashJson(value) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  fs.chmodSync(file, 0o644);
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  fs.chmodSync(file, 0o644);
}

function runGitChecked(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function expectCode(code, action) {
  assert.throws(action, (error) => error instanceof DistributionError && error.code === code, code);
}

function expectDistributionFailure(action) {
  assert.throws(action, (error) => error instanceof DistributionError);
}

function expectSchemaRejection(value, schemaRelative) {
  const schema = JSON.parse(fs.readFileSync(path.join(root, schemaRelative), 'utf8'));
  assert(validateJsonSchema(value, schema).length > 0, `${schemaRelative} should reject the planted value`);
}

function baseManifest(id = 'context.synthetic') {
  return {
    $contract: 'soter://contracts/pack/v1',
    contractVersion: '1.0.0',
    id,
    version: '0.1.0',
    layer: 'context',
    releaseStage: 'experimental',
    evidenceMaturity: 'declared',
    summary: 'Synthetic context pack used only by the contained distribution selftest.',
    dependencies: [],
    capabilities: { requires: [], provides: [] },
    authorities: [],
    effects: [],
    artifacts: [
      { path: `soter/contexts/${id}/model.json`, role: 'definition' }
    ],
    compatibility: { baseContract: '^1.0.0', hosts: ['codex', 'claude'] },
    verification: { maxLevel: 'static', scenarios: [] }
  };
}

function syntheticRoot(parent, label, mutate = null) {
  const target = path.join(parent, label);
  fs.mkdirSync(path.join(target, 'soter', 'contracts'), { recursive: true });
  for (const contract of requiredContracts) {
    fs.copyFileSync(path.join(root, 'soter', 'contracts', contract), path.join(target, 'soter', 'contracts', contract));
    fs.chmodSync(path.join(target, 'soter', 'contracts', contract), 0o644);
  }
  writeJson(path.join(target, 'package.json'), { name: 'synthetic-release-source', private: true });
  const manifest = baseManifest();
  if (mutate) mutate({ target, manifest });
  writeJson(path.join(target, 'soter', 'packs', manifest.id, 'pack.json'), manifest);
  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(target, artifact.path);
    if (!fs.existsSync(artifactPath)) {
      writeJson(artifactPath, {
        $contract: 'soter://synthetic/context/v1',
        contractVersion: '1.0.0',
        id: manifest.id,
        statement: 'Synthetic public pack content.'
      });
    }
  }
  return { target, manifest };
}

function evidenceRecord(pack, sourceInputFingerprint, validUntil = '2026-07-17T12:00:00.000Z') {
  const manifest = JSON.parse(fs.readFileSync(path.join(pack.target, 'soter', 'packs', pack.manifest.id, 'pack.json')));
  const manifestFingerprint = hashJson(manifest);
  return {
    $contract: 'soter://contracts/evidence/v2',
    contractVersion: '2.0.0',
    id: 'evidence.synthetic.distribution',
    createdAt: '2026-07-16T11:00:00.000Z',
    claimFamily: 'graph',
    claim: 'The exact synthetic pack source graph passed contained checks.',
    subject: { type: 'pack', id: manifest.id, version: manifest.version },
    configurationLockFingerprint: fingerprint,
    graphFingerprint: sourceInputFingerprint,
    dependencies: [{ id: manifest.id, version: manifest.version, fingerprint: manifestFingerprint }],
    host: { id: 'codex', adapter: 'host.codex', version: '0.2.0', manifestFingerprint: fingerprint },
    integrations: [],
    authorities: [],
    evaluator: { id: 'kernel.soter.distribution.selftest', version: '1.0.0', level: 'contained' },
    environment: { containment: 'fixture', runtime: 'node' },
    acceptanceCriteria: ['Exact source graph and local capsule bytes match.'],
    result: 'passed',
    outcomes: [],
    artifacts: [],
    effects: [],
    failures: [],
    warnings: [],
    skipped: [],
    limitations: ['Synthetic contained evidence does not establish live behavior.'],
    freshness: { policy: 'fixed selftest window', validUntil },
    supersedes: null,
    privacy: { scope: 'shareable', redactions: [] }
  };
}

function readCapsule(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeCanonical(file, value) {
  fs.writeFileSync(file, canonicalBytes(value));
  fs.chmodSync(file, 0o644);
}

function releaseReferences(releases) {
  return releases.map((release) => ({
    id: `bundle-ref.${release.inspection.release.id}`,
    pack: release.inspection.release.id,
    selection: {
      kind: 'exact',
      version: release.inspection.release.version,
      capsuleDigest: release.capsuleDigest
    },
    reason: `Include ${release.inspection.release.id} as an exact transparent local release.`,
    compatibilityLimitations: []
  })).sort((a, b) => a.pack.localeCompare(b.pack));
}

function releaseSelectionForTest(release) {
  return {
    pack: release.inspection.release.id,
    version: release.inspection.release.version,
    capsuleDigest: release.capsuleDigest,
    releaseStage: release.inspection.release.releaseStage,
    evidenceMaturity: release.inspection.release.evidenceMaturity
  };
}

function bundleDefinition(references, id = 'bundle.soter-contained') {
  return {
    id,
    version: '0.1.0',
    summary: 'Transparent contained bundle used to verify exact local release expansion.',
    releaseStage: 'experimental',
    createdAt,
    target: { baseContract: '1.0.0', hosts: ['codex'] },
    references,
    limitations: []
  };
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-distribution-selftest-'));

try {
  assert.equal(satisfiesVersion(
    '9007199254740993.0.0',
    '>9007199254740992.0.0'
  ), true);
  assert.equal(satisfiesVersion('01.0.0', '1.0.0'), false);
  assert.equal(satisfiesVersion('1.0.0', '^01.0.0'), false);

  const outputA = path.join(temporary, 'releases-a');
  const outputB = path.join(temporary, 'releases-b');
  const packIds = fs.readdirSync(path.join(root, 'soter', 'packs'))
    .map((name) => path.join(root, 'soter', 'packs', name, 'pack.json'))
    .filter((manifestPath) => fs.existsSync(manifestPath))
    .map((manifestPath) => JSON.parse(fs.readFileSync(manifestPath)).id)
    .sort();
  const releases = packIds.map((pack) => buildPackRelease({
    root,
    pack,
    outputDirectory: outputA,
    createdAt
  }));
  assert.equal(releases.length, packIds.length);
  const unavailableHostReleases = releases.filter((release) => {
    return (release.inspection.constraints.compatibility.unavailableHosts || []).length > 0;
  });
  assert.deepEqual(
    unavailableHostReleases.map((release) => release.inspection.release.id),
    [
      'automation.slack-channel-ingestion',
      'integration.slack'
    ]
  );
  for (const release of unavailableHostReleases) {
    const capsule = JSON.parse(fs.readFileSync(release.capsulePath, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(
      path.join(root, capsule.pack.manifestPath),
      'utf8'
    ));
    assert.deepEqual(
      capsule.pack.compatibility.unavailableHosts,
      manifest.compatibility.unavailableHosts
    );
    assert.deepEqual(
      release.inspection.constraints.compatibility.unavailableHosts,
      manifest.compatibility.unavailableHosts
    );
  }

  for (const release of releases) {
    assert.equal(release.inspection.integrity.state, 'passed');
    assert.equal(release.inspection.sourceComparison.state, 'passed');
    assert.equal(release.inspection.legal.publisher.state, 'unasserted');
    assert.equal(release.inspection.legal.license.state, 'no-assertion');
    assert.equal(release.inspection.legal.publicationEligibility, 'not-evaluated');
    assert.equal(release.inspection.trust.state, 'unsigned-untrusted');
    assert.equal(release.inspection.authority.publish, false);
    assert.equal(release.inspection.claims.ready, 'unknown');
    assert.equal(release.inspection.claims.verified, 'unknown');
    assert.equal(release.inspection.claims.healthy, 'unknown');
    assert.equal(fs.statSync(release.capsulePath).mode & 0o777, 0o644);
    const independent = verifyPackRelease({ capsulePath: release.capsulePath, contractRoot: root });
    assert.equal(independent.sourceComparison.state, 'unknown');
    const serialized = JSON.stringify(independent);
    assert(!serialized.includes(root));
    assert(!serialized.includes('contentEncoding'));
    assert.equal(independent.privacy.rawProviderResponsesIncluded, false);
    assert.equal(independent.privacy.privateStateIncluded, false);
    assert.equal(independent.privacy.credentialValuesIncluded, false);
    assert(!serialized.includes('github.com/0xRetro'));
  }

  const kernelRelease = releases.find((release) => release.inspection.release.id === 'kernel.soter');
  const secondKernelRelease = buildPackRelease({
    root,
    pack: 'kernel.soter',
    outputDirectory: outputB,
    createdAt
  });
  assert.equal(kernelRelease.capsuleDigest, secondKernelRelease.capsuleDigest);
  assert(fs.readFileSync(kernelRelease.capsulePath).equals(fs.readFileSync(secondKernelRelease.capsulePath)));
  const copiedCapsule = path.join(temporary, 'copied-clean.soter-pack.json');
  fs.copyFileSync(kernelRelease.capsulePath, copiedCapsule);
  fs.chmodSync(copiedCapsule, 0o644);
  assert.equal(verifyPackRelease({ capsulePath: copiedCapsule, contractRoot: root }).integrity.state, 'passed');

  const crossedSourceComparison = structuredClone(kernelRelease.inspection);
  crossedSourceComparison.sourceComparison = {
    state: 'passed',
    reasonCode: 'PACK_RELEASE_SOURCE_MISMATCH'
  };
  expectSchemaRejection(crossedSourceComparison, 'soter/contracts/pack-release-inspection.schema.json');
  const contradictoryPackageIntent = structuredClone(kernelRelease.inspection);
  contradictoryPackageIntent.packageIntent.state = 'absent';
  expectSchemaRejection(contradictoryPackageIntent, 'soter/contracts/pack-release-inspection.schema.json');
  const privateGitRevision = structuredClone(kernelRelease.inspection);
  privateGitRevision.provenance.revision = '/Users/private/source/revision';
  expectSchemaRejection(privateGitRevision, 'soter/contracts/pack-release-inspection.schema.json');

  const fullBundle = buildBundle({
    root,
    definition: bundleDefinition(releaseReferences(releases)),
    outputDirectory: path.join(temporary, 'bundles-a')
  });
  const fullBundleSecond = buildBundle({
    root,
    definition: bundleDefinition(releaseReferences(releases)),
    outputDirectory: path.join(temporary, 'bundles-b')
  });
  assert.equal(fullBundle.bundleDigest, fullBundleSecond.bundleDigest);
  assert(fs.readFileSync(fullBundle.bundlePath).equals(fs.readFileSync(fullBundleSecond.bundlePath)));
  const resolvedBundle = inspectBundle({
    bundlePath: fullBundle.bundlePath,
    releasePaths: releases.map((release) => release.capsulePath),
    contractRoot: root
  });
  assert.equal(resolvedBundle.resolution.state, 'resolved');
  assert.equal(resolvedBundle.resolution.blockers.length, 0);
  assert.deepEqual(resolvedBundle.aggregate.packs, packIds);
  assert.equal(resolvedBundle.authority.install, false);
  assert.equal(resolvedBundle.authority.autoUpdate, false);
  assert.equal(resolvedBundle.claims.ready, 'unknown');

  const crossedResolution = structuredClone(resolvedBundle);
  crossedResolution.resolution.reasonCode = 'BUNDLE_BLOCKED';
  expectSchemaRejection(crossedResolution, 'soter/contracts/bundle-inspection.schema.json');
  const selectedWithoutRelease = structuredClone(resolvedBundle);
  selectedWithoutRelease.references[0].selectedRelease = null;
  expectSchemaRejection(selectedWithoutRelease, 'soter/contracts/bundle-inspection.schema.json');

  const hiddenConfigurationDefinition = bundleDefinition(releaseReferences(releases), 'bundle.hidden-configuration');
  hiddenConfigurationDefinition.configuration = { selected: ['kernel.soter'] };
  expectCode('BUNDLE_DEFINITION_INVALID', () => buildBundle({
    root,
    definition: hiddenConfigurationDefinition,
    outputDirectory: path.join(temporary, 'bundles-hidden-configuration')
  }));

  const hiddenAuthorityBundle = path.join(temporary, 'hidden-authority.soter-bundle.json');
  const hiddenAuthority = JSON.parse(fs.readFileSync(fullBundle.bundlePath, 'utf8'));
  hiddenAuthority.install = { autoUpdate: true, secretReference: 'secret://distribution' };
  writeCanonical(hiddenAuthorityBundle, hiddenAuthority);
  expectCode('BUNDLE_SCHEMA_INVALID', () => inspectBundle({
    bundlePath: hiddenAuthorityBundle,
    releasePaths: releases.map((release) => release.capsulePath),
    contractRoot: root
  }));

  const invalidTimestampBundle = path.join(temporary, 'invalid-timestamp.soter-bundle.json');
  const invalidTimestamp = JSON.parse(fs.readFileSync(fullBundle.bundlePath, 'utf8'));
  invalidTimestamp.createdAt = 'not-a-valid-date-value';
  writeCanonical(invalidTimestampBundle, invalidTimestamp);
  expectCode('BUNDLE_CREATED_AT_INVALID', () => inspectBundle({
    bundlePath: invalidTimestampBundle,
    releasePaths: releases.map((release) => release.capsulePath),
    contractRoot: root
  }));

  const bundleCredential = 'sk-' + 'BUNDLEMETADATACREDENTIAL1234567890';
  const bundleMetadataMutations = [
    (definition) => { definition.summary = `Hostile bundle summary ${bundleCredential}`; },
    (definition) => { definition.references[0].reason = `Hostile inclusion reason ${bundleCredential}`; },
    (definition) => {
      definition.references[0].compatibilityLimitations = [
        'Resolve through secret-ref.gmail before attempting any local use.'
      ];
    },
    (definition) => {
      definition.limitations = [{
        code: 'HOSTILE_CALLER_METADATA',
        summary: `Hostile supplied limitation ${bundleCredential}`
      }];
    }
  ];
  for (let index = 0; index < bundleMetadataMutations.length; index += 1) {
    const definition = bundleDefinition(
      releaseReferences([kernelRelease]),
      `bundle.hostile-metadata-${index}`
    );
    bundleMetadataMutations[index](definition);
    expectCode('BUNDLE_CREDENTIAL_REJECTED', () => buildBundle({
      root,
      definition,
      outputDirectory: path.join(temporary, `bundles-hostile-metadata-${index}`)
    }));
  }

  const hostileInspectionBundle = path.join(temporary, 'hostile-inspection-metadata.soter-bundle.json');
  const hostileInspection = JSON.parse(fs.readFileSync(fullBundle.bundlePath, 'utf8'));
  hostileInspection.summary = `Hostile bundle summary ${bundleCredential}`;
  writeCanonical(hostileInspectionBundle, hostileInspection);
  expectCode('BUNDLE_CREDENTIAL_REJECTED', () => inspectBundle({
    bundlePath: hostileInspectionBundle,
    releasePaths: releases.map((release) => release.capsulePath),
    contractRoot: root
  }));

  const privatePathBundle = path.join(temporary, 'private-path-metadata.soter-bundle.json');
  const privatePathMetadata = JSON.parse(fs.readFileSync(fullBundle.bundlePath, 'utf8'));
  privatePathMetadata.summary = 'Hostile source locator /Users/private/My Project/bundle must not reach inspection.';
  writeCanonical(privatePathBundle, privatePathMetadata);
  expectCode('BUNDLE_PRIVATE_METADATA_REJECTED', () => inspectBundle({
    bundlePath: privatePathBundle,
    releasePaths: releases.map((release) => release.capsulePath),
    contractRoot: root
  }));

  const singleComponentPathDefinition = bundleDefinition(
    releaseReferences([kernelRelease]),
    'bundle.single-component-private-path'
  );
  singleComponentPathDefinition.summary = 'Hostile single-component source locator /tmp must not enter a bundle.';
  expectCode('BUNDLE_PRIVATE_METADATA_REJECTED', () => buildBundle({
    root,
    definition: singleComponentPathDefinition,
    outputDirectory: path.join(temporary, 'bundles-single-component-path')
  }));

  const singleComponentInspectionBundle = path.join(
    temporary,
    'single-component-private-path.soter-bundle.json'
  );
  const singleComponentInspection = JSON.parse(fs.readFileSync(fullBundle.bundlePath, 'utf8'));
  singleComponentInspection.summary = 'Hostile single-component source locator /tmp must not reach inspection.';
  writeCanonical(singleComponentInspectionBundle, singleComponentInspection);
  expectCode('BUNDLE_PRIVATE_METADATA_REJECTED', () => inspectBundle({
    bundlePath: singleComponentInspectionBundle,
    releasePaths: releases.map((release) => release.capsulePath),
    contractRoot: root
  }));

  const unicodePathDefinition = bundleDefinition(
    releaseReferences([kernelRelease]),
    'bundle.unicode-private-path'
  );
  unicodePathDefinition.summary = 'Review the local artifact at /用户 before sharing.';
  expectCode('BUNDLE_PRIVATE_METADATA_REJECTED', () => buildBundle({
    root,
    definition: unicodePathDefinition,
    outputDirectory: path.join(temporary, 'bundles-unicode-path')
  }));

  const unicodeInspectionBundle = path.join(temporary, 'unicode-private-path.soter-bundle.json');
  const unicodeInspection = JSON.parse(fs.readFileSync(fullBundle.bundlePath, 'utf8'));
  unicodeInspection.summary = 'Review the local artifact at /用户 before sharing.';
  writeCanonical(unicodeInspectionBundle, unicodeInspection);
  expectCode('BUNDLE_PRIVATE_METADATA_REJECTED', () => inspectBundle({
    bundlePath: unicodeInspectionBundle,
    releasePaths: releases.map((release) => release.capsulePath),
    contractRoot: root
  }));

  const rootPathDefinition = bundleDefinition(
    releaseReferences([kernelRelease]),
    'bundle.root-private-path'
  );
  rootPathDefinition.summary = 'Hostile source locator is /.';
  expectCode('BUNDLE_PRIVATE_METADATA_REJECTED', () => buildBundle({
    root,
    definition: rootPathDefinition,
    outputDirectory: path.join(temporary, 'bundles-root-path')
  }));

  const proseAndUriDefinition = bundleDefinition(
    releaseReferences([kernelRelease]),
    'bundle.safe-slash-prose'
  );
  proseAndUriDefinition.summary = 'Compare read/write behavior at https://example.invalid/reference without local paths.';
  proseAndUriDefinition.references[0].compatibilityLimitations = [
    'The read / write distinction remains descriptive and grants no authority.'
  ];
  const proseAndUriBundle = buildBundle({
    root,
    definition: proseAndUriDefinition,
    outputDirectory: path.join(temporary, 'bundles-safe-slash-prose')
  });
  assert.equal(proseAndUriBundle.inspection.integrity.state, 'passed');

  const leadingZeroBundle = bundleDefinition(
    releaseReferences([kernelRelease]),
    'bundle.leading-zero-version'
  );
  leadingZeroBundle.version = '01.0.0';
  expectCode('BUNDLE_SCHEMA_INVALID', () => buildBundle({
    root,
    definition: leadingZeroBundle,
    outputDirectory: path.join(temporary, 'bundles-leading-zero')
  }));

  const missingDependencyReferences = releaseReferences(releases)
    .filter((reference) => reference.pack !== 'context.email');
  const missingDependencyBundle = buildBundle({
    root,
    definition: bundleDefinition(missingDependencyReferences, 'bundle.missing-dependency'),
    outputDirectory: path.join(temporary, 'bundles-missing')
  });
  const blockedDependency = inspectBundle({
    bundlePath: missingDependencyBundle.bundlePath,
    releasePaths: releases.map((release) => release.capsulePath),
    contractRoot: root
  });
  assert.equal(blockedDependency.resolution.state, 'blocked');
  assert(blockedDependency.resolution.blockers.some((item) => item.code === 'BUNDLE_DEPENDENCY_MISSING'));

  const optionalConsumerPack = syntheticRoot(temporary, 'optional-consumer', ({ manifest }) => {
    manifest.id = 'context.optional-consumer';
    manifest.dependencies = [{
      pack: 'context.optional-peer',
      version: '^0.1.0',
      optional: true,
      reason: 'Provide optional peer context when a compatible release is selected.'
    }];
    manifest.artifacts = [{
      path: 'soter/contexts/context.optional-consumer/model.json',
      role: 'definition'
    }];
  });
  const optionalPeerPack = syntheticRoot(temporary, 'optional-peer', ({ manifest }) => {
    manifest.id = 'context.optional-peer';
    manifest.version = '0.2.0';
    manifest.artifacts = [{
      path: 'soter/contexts/context.optional-peer/model.json',
      role: 'definition'
    }];
  });
  const optionalConsumerRelease = buildPackRelease({
    root: optionalConsumerPack.target,
    pack: optionalConsumerPack.manifest.id,
    outputDirectory: path.join(temporary, 'optional-releases'),
    createdAt
  });
  const optionalPeerRelease = buildPackRelease({
    root: optionalPeerPack.target,
    pack: optionalPeerPack.manifest.id,
    outputDirectory: path.join(temporary, 'optional-releases'),
    createdAt
  });
  const optionalAbsentBundle = buildBundle({
    root,
    definition: bundleDefinition(
      releaseReferences([optionalConsumerRelease]),
      'bundle.optional-absent'
    ),
    outputDirectory: path.join(temporary, 'bundles-optional-absent')
  });
  const optionalAbsent = inspectBundle({
    bundlePath: optionalAbsentBundle.bundlePath,
    releasePaths: [optionalConsumerRelease.capsulePath, optionalPeerRelease.capsulePath],
    contractRoot: root
  });
  assert.equal(optionalAbsent.resolution.state, 'resolved');
  assert.equal(optionalAbsent.resolution.blockers.length, 0);
  assert(optionalAbsent.aggregate.dependencies.some((dependency) => (
    dependency.pack === 'context.optional-peer' && dependency.optional === true
  )));

  const optionalIncompatibleBundle = buildBundle({
    root,
    definition: bundleDefinition(
      releaseReferences([optionalConsumerRelease, optionalPeerRelease]),
      'bundle.optional-incompatible'
    ),
    outputDirectory: path.join(temporary, 'bundles-optional-incompatible')
  });
  const optionalIncompatible = inspectBundle({
    bundlePath: optionalIncompatibleBundle.bundlePath,
    releasePaths: [optionalConsumerRelease.capsulePath, optionalPeerRelease.capsulePath],
    contractRoot: root
  });
  assert.equal(optionalIncompatible.resolution.state, 'blocked');
  assert(optionalIncompatible.resolution.blockers.some((item) => (
    item.code === 'BUNDLE_DEPENDENCY_VERSION_MISMATCH' && item.pack === 'context.optional-peer'
  )));

  const alternateKernel = buildPackRelease({
    root,
    pack: 'kernel.soter',
    outputDirectory: outputB,
    createdAt: laterCreatedAt
  });
  const compatibleBundle = buildBundle({
    root,
    definition: bundleDefinition([{
      id: 'bundle-ref.kernel-compatible',
      pack: 'kernel.soter',
      selection: { kind: 'compatible', version: '^0.1.0' },
      reason: 'Select the highest locally verified compatible Kernel release.',
      compatibilityLimitations: []
    }], 'bundle.compatible-conflict'),
    outputDirectory: path.join(temporary, 'bundles-compatible')
  });
  const ambiguous = inspectBundle({
    bundlePath: compatibleBundle.bundlePath,
    releasePaths: [kernelRelease.capsulePath, alternateKernel.capsulePath],
    contractRoot: root
  });
  assert.equal(ambiguous.resolution.state, 'blocked');
  assert(ambiguous.resolution.blockers.some((item) => item.code === 'BUNDLE_RELEASE_AMBIGUOUS'));
  const blockedWithRelease = structuredClone(ambiguous);
  blockedWithRelease.references[0].selectedRelease = releaseSelectionForTest(kernelRelease);
  expectSchemaRejection(blockedWithRelease, 'soter/contracts/bundle-inspection.schema.json');

  const tamperedCapsule = path.join(temporary, 'tampered.soter-pack.json');
  const tampered = readCapsule(kernelRelease.capsulePath);
  tampered.inventory[0].content = Buffer.from('tampered\n').toString('base64');
  writeCanonical(tamperedCapsule, tampered);
  expectCode('PACK_RELEASE_TAMPERED', () => verifyPackRelease({ capsulePath: tamperedCapsule, contractRoot: root }));

  const wrongCapsuleMode = path.join(temporary, 'wrong-mode.soter-pack.json');
  fs.copyFileSync(kernelRelease.capsulePath, wrongCapsuleMode);
  fs.chmodSync(wrongCapsuleMode, 0o600);
  expectCode('PACK_RELEASE_FILE_INVALID', () => verifyPackRelease({ capsulePath: wrongCapsuleMode, contractRoot: root }));

  const specialCapsuleMode = path.join(temporary, 'special-mode.soter-pack.json');
  fs.copyFileSync(kernelRelease.capsulePath, specialCapsuleMode);
  fs.chmodSync(specialCapsuleMode, 0o1644);
  assert.equal(fs.lstatSync(specialCapsuleMode).mode & 0o7777, 0o1644);
  expectCode('PACK_RELEASE_FILE_INVALID', () => verifyPackRelease({
    capsulePath: specialCapsuleMode,
    contractRoot: root
  }));

  const wrongBundleMode = path.join(temporary, 'wrong-mode.soter-bundle.json');
  fs.copyFileSync(fullBundle.bundlePath, wrongBundleMode);
  fs.chmodSync(wrongBundleMode, 0o600);
  expectCode('BUNDLE_FILE_INVALID', () => inspectBundle({
    bundlePath: wrongBundleMode,
    releasePaths: releases.map((release) => release.capsulePath),
    contractRoot: root
  }));

  const packHardlinkDirectory = path.join(temporary, 'pack-hardlink-output');
  fs.mkdirSync(packHardlinkDirectory, { mode: 0o755 });
  const packHardlinkExternal = path.join(temporary, 'pack-hardlink-external.json');
  fs.copyFileSync(kernelRelease.capsulePath, packHardlinkExternal);
  fs.chmodSync(packHardlinkExternal, 0o600);
  fs.linkSync(
    packHardlinkExternal,
    path.join(packHardlinkDirectory, path.basename(kernelRelease.capsulePath))
  );
  assert.equal(fs.lstatSync(packHardlinkExternal).nlink, 2);
  expectCode('DISTRIBUTION_OUTPUT_CONFLICT', () => buildPackRelease({
    root,
    pack: 'kernel.soter',
    outputDirectory: packHardlinkDirectory,
    createdAt
  }));
  assert.equal(fs.lstatSync(packHardlinkExternal).mode & 0o7777, 0o600);

  const bundleHardlinkDirectory = path.join(temporary, 'bundle-hardlink-output');
  fs.mkdirSync(bundleHardlinkDirectory, { mode: 0o755 });
  const bundleHardlinkExternal = path.join(temporary, 'bundle-hardlink-external.json');
  fs.copyFileSync(fullBundle.bundlePath, bundleHardlinkExternal);
  fs.chmodSync(bundleHardlinkExternal, 0o600);
  fs.linkSync(
    bundleHardlinkExternal,
    path.join(bundleHardlinkDirectory, path.basename(fullBundle.bundlePath))
  );
  assert.equal(fs.lstatSync(bundleHardlinkExternal).nlink, 2);
  expectCode('DISTRIBUTION_OUTPUT_CONFLICT', () => buildBundle({
    root,
    definition: bundleDefinition(releaseReferences(releases)),
    outputDirectory: bundleHardlinkDirectory
  }));
  assert.equal(fs.lstatSync(bundleHardlinkExternal).mode & 0o7777, 0o600);

  const extraCapsule = path.join(temporary, 'extra.soter-pack.json');
  const extra = readCapsule(kernelRelease.capsulePath);
  extra.inventory.push({ ...extra.inventory[0], path: 'undeclared.txt', role: 'fixture' });
  writeCanonical(extraCapsule, extra);
  expectDistributionFailure(() => verifyPackRelease({ capsulePath: extraCapsule, contractRoot: root }));

  const wrongIdentityCapsule = path.join(temporary, 'wrong-identity.soter-pack.json');
  const wrongIdentity = readCapsule(kernelRelease.capsulePath);
  wrongIdentity.pack.version = '9.9.9';
  writeCanonical(wrongIdentityCapsule, wrongIdentity);
  expectCode('PACK_RELEASE_IDENTITY_MISMATCH', () => verifyPackRelease({ capsulePath: wrongIdentityCapsule, contractRoot: root }));

  const assertedPublisherCapsule = path.join(temporary, 'asserted-publisher.soter-pack.json');
  const assertedPublisher = readCapsule(kernelRelease.capsulePath);
  assertedPublisher.legal.publisher = { state: 'asserted', id: 'inferred-from-git' };
  writeCanonical(assertedPublisherCapsule, assertedPublisher);
  expectCode('PACK_RELEASE_SCHEMA_INVALID', () => verifyPackRelease({ capsulePath: assertedPublisherCapsule, contractRoot: root }));

  const privateRevisionCapsule = path.join(temporary, 'private-revision.soter-pack.json');
  const privateRevision = readCapsule(kernelRelease.capsulePath);
  privateRevision.source.revision = '/Users/private/source/revision';
  writeCanonical(privateRevisionCapsule, privateRevision);
  expectCode('PACK_RELEASE_SCHEMA_INVALID', () => verifyPackRelease({
    capsulePath: privateRevisionCapsule,
    contractRoot: root
  }));

  const contradictoryIntentCapsule = path.join(temporary, 'contradictory-intent.soter-pack.json');
  const contradictoryIntent = readCapsule(kernelRelease.capsulePath);
  contradictoryIntent.packageIntent.state = 'absent';
  writeCanonical(contradictoryIntentCapsule, contradictoryIntent);
  expectCode('PACK_RELEASE_SCHEMA_INVALID', () => verifyPackRelease({
    capsulePath: contradictoryIntentCapsule,
    contractRoot: root
  }));

  const privateMetadataCapsule = path.join(temporary, 'private-metadata.soter-pack.json');
  const privateMetadata = readCapsule(kernelRelease.capsulePath);
  privateMetadata.limitations.push({
    code: 'PRIVATE_SOURCE_PATH',
    summary: 'Hostile source locator /Users/private/My Project/pack must not reach inspection.'
  });
  privateMetadata.limitations.sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  writeCanonical(privateMetadataCapsule, privateMetadata);
  expectCode('PACK_RELEASE_PRIVATE_STATE_REJECTED', () => verifyPackRelease({
    capsulePath: privateMetadataCapsule,
    contractRoot: root
  }));

  const singleComponentMetadataCapsule = path.join(temporary, 'single-component-metadata.soter-pack.json');
  const singleComponentMetadata = readCapsule(kernelRelease.capsulePath);
  singleComponentMetadata.limitations.push({
    code: 'PRIVATE_SINGLE_COMPONENT_PATH',
    summary: 'Hostile single-component source locator /tmp must not reach inspection.'
  });
  singleComponentMetadata.limitations.sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  writeCanonical(singleComponentMetadataCapsule, singleComponentMetadata);
  expectCode('PACK_RELEASE_PRIVATE_STATE_REJECTED', () => verifyPackRelease({
    capsulePath: singleComponentMetadataCapsule,
    contractRoot: root
  }));

  const unicodeMetadataCapsule = path.join(temporary, 'unicode-metadata.soter-pack.json');
  const unicodeMetadata = readCapsule(kernelRelease.capsulePath);
  unicodeMetadata.limitations.push({
    code: 'PRIVATE_UNICODE_PATH',
    summary: 'Review the local artifact at /用户 before sharing.'
  });
  unicodeMetadata.limitations.sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  writeCanonical(unicodeMetadataCapsule, unicodeMetadata);
  expectCode('PACK_RELEASE_PRIVATE_STATE_REJECTED', () => verifyPackRelease({
    capsulePath: unicodeMetadataCapsule,
    contractRoot: root
  }));

  expectCode('PACK_RELEASE_PRIVATE_STATE_REJECTED', () => buildPackRelease({
    root: syntheticRoot(temporary, 'synthetic-single-component-path').target,
    pack: 'context.synthetic',
    outputDirectory: path.join(temporary, 'out-single-component-path'),
    createdAt,
    limitations: [{
      code: 'PRIVATE_SINGLE_COMPONENT_PATH',
      summary: 'Hostile single-component source locator /tmp must not enter a release.'
    }]
  }));

  const unicodePathPack = syntheticRoot(temporary, 'synthetic-unicode-path');
  expectCode('PACK_RELEASE_PRIVATE_STATE_REJECTED', () => buildPackRelease({
    root: unicodePathPack.target,
    pack: unicodePathPack.manifest.id,
    outputDirectory: path.join(temporary, 'out-unicode-path'),
    createdAt,
    limitations: [{
      code: 'PRIVATE_UNICODE_PATH',
      summary: 'Review the local artifact at /用户 before sharing.'
    }]
  }));

  const credentialMetadataCapsule = path.join(temporary, 'credential-metadata.soter-pack.json');
  const credentialMetadata = readCapsule(kernelRelease.capsulePath);
  credentialMetadata.limitations.push({
    code: 'HOSTILE_CREDENTIAL_METADATA',
    summary: 'Hostile supplied limitation sk-' + 'INSPECTIONCREDENTIAL1234567890'
  });
  credentialMetadata.limitations.sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  writeCanonical(credentialMetadataCapsule, credentialMetadata);
  expectCode('PACK_RELEASE_CREDENTIAL_REJECTED', () => verifyPackRelease({
    capsulePath: credentialMetadataCapsule,
    contractRoot: root
  }));

  const synthetic = syntheticRoot(temporary, 'synthetic-valid');
  const syntheticRelease = buildPackRelease({
    root: synthetic.target,
    pack: synthetic.manifest.id,
    outputDirectory: path.join(temporary, 'synthetic-output'),
    createdAt
  });
  assert.equal(syntheticRelease.inspection.packageIntent.private, true);
  assert.equal(syntheticRelease.inspection.packageIntent.interpretation, 'packaging-intent-only');

  const absentPackage = syntheticRoot(temporary, 'synthetic-package-absent');
  fs.rmSync(path.join(absentPackage.target, 'package.json'));
  const absentPackageRelease = buildPackRelease({
    root: absentPackage.target,
    pack: absentPackage.manifest.id,
    outputDirectory: path.join(temporary, 'synthetic-package-absent-output'),
    createdAt
  });
  assert.deepEqual(absentPackageRelease.inspection.packageIntent, {
    state: 'absent',
    private: null,
    sourceFingerprint: null,
    interpretation: 'packaging-intent-only'
  });

  const unavailablePackage = syntheticRoot(temporary, 'synthetic-package-unavailable');
  writeJson(path.join(unavailablePackage.target, 'package.json'), {
    name: 'synthetic-package-without-private-signal'
  });
  const unavailablePackageRelease = buildPackRelease({
    root: unavailablePackage.target,
    pack: unavailablePackage.manifest.id,
    outputDirectory: path.join(temporary, 'synthetic-package-unavailable-output'),
    createdAt
  });
  assert.equal(unavailablePackageRelease.inspection.packageIntent.state, 'unavailable');
  assert.equal(unavailablePackageRelease.inspection.packageIntent.private, null);
  assert.match(unavailablePackageRelease.inspection.packageIntent.sourceFingerprint, /^sha256:[a-f0-9]{64}$/);
  const contradictoryFilesystemProvenance = structuredClone(syntheticRelease.inspection);
  contradictoryFilesystemProvenance.provenance.revision = '/private/tmp/source';
  contradictoryFilesystemProvenance.provenance.exactInputState = 'clean';
  expectSchemaRejection(
    contradictoryFilesystemProvenance,
    'soter/contracts/pack-release-inspection.schema.json'
  );

  const orderingPack = syntheticRoot(temporary, 'synthetic-codepoint-order', ({ manifest }) => {
    manifest.artifacts = ['_b', '0', 'a', 'Z'].map((name) => ({
      path: `soter/contexts/context.synthetic/${name}.json`,
      role: 'fixture'
    }));
  });
  const orderingRelease = buildPackRelease({
    root: orderingPack.target,
    pack: orderingPack.manifest.id,
    outputDirectory: path.join(temporary, 'synthetic-codepoint-order-output'),
    createdAt
  });
  const orderedPaths = readCapsule(orderingRelease.capsulePath).inventory
    .map((entry) => entry.path)
    .filter((entryPath) => entryPath.startsWith('soter/contexts/context.synthetic/'));
  assert.deepEqual(orderedPaths, [
    'soter/contexts/context.synthetic/0.json',
    'soter/contexts/context.synthetic/Z.json',
    'soter/contexts/context.synthetic/_b.json',
    'soter/contexts/context.synthetic/a.json'
  ]);

  const ignoredInput = syntheticRoot(temporary, 'synthetic-ignored-input');
  const ignoredRelative = ignoredInput.manifest.artifacts[0].path;
  writeText(path.join(ignoredInput.target, '.gitignore'), `${ignoredRelative}\n`);
  runGitChecked(ignoredInput.target, ['init', '--quiet']);
  runGitChecked(ignoredInput.target, ['config', 'user.name', 'Soter Distribution Selftest']);
  runGitChecked(ignoredInput.target, ['config', 'user.email', 'distribution-selftest@soter.invalid']);
  runGitChecked(ignoredInput.target, ['config', 'commit.gpgsign', 'false']);
  runGitChecked(ignoredInput.target, ['add', '--', '.']);
  runGitChecked(ignoredInput.target, ['commit', '--quiet', '-m', 'Synthetic governed source']);
  assert.notEqual(spawnSync('git', [
    '-C', ignoredInput.target, 'ls-files', '--error-unmatch', '--', ignoredRelative
  ]).status, 0);
  const ignoredInputRelease = buildPackRelease({
    root: ignoredInput.target,
    pack: ignoredInput.manifest.id,
    outputDirectory: path.join(temporary, 'synthetic-ignored-input-output'),
    createdAt
  });
  assert.equal(ignoredInputRelease.inspection.provenance.kind, 'git');
  assert.equal(ignoredInputRelease.inspection.provenance.exactInputState, 'dirty');

  const evidence = evidenceRecord(synthetic, syntheticRelease.inspection.release.sourceInputFingerprint);
  const evidenceFile = path.join(temporary, 'evidence.valid.json');
  writeJson(evidenceFile, evidence);
  const evidencedRelease = buildPackRelease({
    root: synthetic.target,
    pack: synthetic.manifest.id,
    outputDirectory: path.join(temporary, 'synthetic-evidenced'),
    createdAt,
    evidencePaths: [evidenceFile]
  });
  assert.equal(evidencedRelease.inspection.evidenceReferences.length, 1);
  assert.equal(evidencedRelease.inspection.release.evidenceMaturity, 'declared');

  const tamperedEvidenceReferenceFile = path.join(temporary, 'release.tampered-evidence-reference.json');
  const tamperedEvidenceReference = readCapsule(evidencedRelease.capsulePath);
  tamperedEvidenceReference.evidenceReferences[0].graphFingerprint = 'sha256:' + 'b'.repeat(64);
  tamperedEvidenceReference.evidenceReferences[0].applicableManifestFingerprint = 'sha256:' + 'c'.repeat(64);
  writeCanonical(tamperedEvidenceReferenceFile, tamperedEvidenceReference);
  expectCode('PACK_RELEASE_EVIDENCE_MISMATCH', () => verifyPackRelease({
    capsulePath: tamperedEvidenceReferenceFile,
    contractRoot: synthetic.target
  }));

  const duplicatedEvidenceReferenceFile = path.join(temporary, 'release.duplicate-evidence-reference.json');
  const duplicatedEvidenceReference = readCapsule(evidencedRelease.capsulePath);
  duplicatedEvidenceReference.evidenceReferences.push({
    ...duplicatedEvidenceReference.evidenceReferences[0],
    id: 'evidence.synthetic.distribution-copy'
  });
  writeCanonical(duplicatedEvidenceReferenceFile, duplicatedEvidenceReference);
  expectCode('PACK_RELEASE_EVIDENCE_INVALID', () => verifyPackRelease({
    capsulePath: duplicatedEvidenceReferenceFile,
    contractRoot: synthetic.target
  }));

  const duplicatedEvidenceIdFile = path.join(temporary, 'release.duplicate-evidence-id.json');
  const duplicatedEvidenceId = readCapsule(evidencedRelease.capsulePath);
  duplicatedEvidenceId.evidenceReferences.push({
    ...duplicatedEvidenceId.evidenceReferences[0],
    fingerprint: 'sha256:' + 'd'.repeat(64)
  });
  writeCanonical(duplicatedEvidenceIdFile, duplicatedEvidenceId);
  expectCode('PACK_RELEASE_EVIDENCE_INVALID', () => verifyPackRelease({
    capsulePath: duplicatedEvidenceIdFile,
    contractRoot: synthetic.target
  }));

  const invalidReferenceFreshnessFile = path.join(temporary, 'release.invalid-reference-freshness.json');
  const invalidReferenceFreshness = readCapsule(evidencedRelease.capsulePath);
  invalidReferenceFreshness.evidenceReferences[0].validUntil = 'not-a-valid-date-value';
  writeCanonical(invalidReferenceFreshnessFile, invalidReferenceFreshness);
  expectCode('PACK_RELEASE_EVIDENCE_INVALID', () => verifyPackRelease({
    capsulePath: invalidReferenceFreshnessFile,
    contractRoot: synthetic.target
  }));

  const staleEvidenceFile = path.join(temporary, 'evidence.stale.json');
  writeJson(staleEvidenceFile, evidenceRecord(synthetic, syntheticRelease.inspection.release.sourceInputFingerprint, '2026-07-16T11:30:00.000Z'));
  expectCode('PACK_RELEASE_EVIDENCE_STALE', () => buildPackRelease({
    root: synthetic.target,
    pack: synthetic.manifest.id,
    outputDirectory: path.join(temporary, 'synthetic-stale-evidence'),
    createdAt,
    evidencePaths: [staleEvidenceFile]
  }));

  const invalidFreshnessFile = path.join(temporary, 'evidence.invalid-freshness.json');
  writeJson(invalidFreshnessFile, evidenceRecord(
    synthetic,
    syntheticRelease.inspection.release.sourceInputFingerprint,
    'not-a-valid-date-value'
  ));
  expectCode('PACK_RELEASE_EVIDENCE_INVALID', () => buildPackRelease({
    root: synthetic.target,
    pack: synthetic.manifest.id,
    outputDirectory: path.join(temporary, 'synthetic-invalid-freshness-evidence'),
    createdAt,
    evidencePaths: [invalidFreshnessFile]
  }));

  const invalidCreatedAtEvidence = evidenceRecord(
    synthetic,
    syntheticRelease.inspection.release.sourceInputFingerprint
  );
  invalidCreatedAtEvidence.createdAt = 'not-a-valid-date-value';
  const invalidCreatedAtEvidenceFile = path.join(temporary, 'evidence.invalid-created-at.json');
  writeJson(invalidCreatedAtEvidenceFile, invalidCreatedAtEvidence);
  expectCode('PACK_RELEASE_EVIDENCE_INVALID', () => buildPackRelease({
    root: synthetic.target,
    pack: synthetic.manifest.id,
    outputDirectory: path.join(temporary, 'synthetic-invalid-created-at-evidence'),
    createdAt,
    evidencePaths: [invalidCreatedAtEvidenceFile]
  }));

  const futureEvidence = evidenceRecord(
    synthetic,
    syntheticRelease.inspection.release.sourceInputFingerprint
  );
  futureEvidence.createdAt = '2026-07-16T12:00:01.000Z';
  const futureEvidenceFile = path.join(temporary, 'evidence.future.json');
  writeJson(futureEvidenceFile, futureEvidence);
  expectCode('PACK_RELEASE_EVIDENCE_INVALID', () => buildPackRelease({
    root: synthetic.target,
    pack: synthetic.manifest.id,
    outputDirectory: path.join(temporary, 'synthetic-future-evidence'),
    createdAt,
    evidencePaths: [futureEvidenceFile]
  }));

  const mismatchedEvidence = evidenceRecord(synthetic, syntheticRelease.inspection.release.sourceInputFingerprint);
  mismatchedEvidence.subject.id = 'context.other';
  const mismatchedEvidenceFile = path.join(temporary, 'evidence.mismatch.json');
  writeJson(mismatchedEvidenceFile, mismatchedEvidence);
  expectCode('PACK_RELEASE_EVIDENCE_MISMATCH', () => buildPackRelease({
    root: synthetic.target,
    pack: synthetic.manifest.id,
    outputDirectory: path.join(temporary, 'synthetic-mismatch-evidence'),
    createdAt,
    evidencePaths: [mismatchedEvidenceFile]
  }));

  const modeDriftPath = path.join(synthetic.target, synthetic.manifest.artifacts[0].path);
  fs.chmodSync(modeDriftPath, 0o755);
  assert.equal(verifyPackRelease({
    capsulePath: syntheticRelease.capsulePath,
    sourceRoot: synthetic.target,
    contractRoot: synthetic.target
  }).sourceComparison.state, 'failed');
  fs.chmodSync(modeDriftPath, 0o644);

  const missing = syntheticRoot(temporary, 'synthetic-missing', ({ manifest }) => {
    manifest.artifacts = [{ path: 'soter/contexts/context.synthetic/missing.json', role: 'definition' }];
  });
  fs.rmSync(path.join(missing.target, missing.manifest.artifacts[0].path));
  expectCode('PACK_RELEASE_ARTIFACT_MISSING', () => buildPackRelease({
    root: missing.target, pack: missing.manifest.id, outputDirectory: path.join(temporary, 'out-missing'), createdAt
  }));

  const traversal = syntheticRoot(temporary, 'synthetic-traversal', ({ manifest }) => {
    manifest.artifacts = [{ path: '../escape.json', role: 'definition' }];
  });
  expectCode('PACK_RELEASE_PATH_INVALID', () => buildPackRelease({
    root: traversal.target, pack: traversal.manifest.id, outputDirectory: path.join(temporary, 'out-traversal'), createdAt
  }));

  const collision = syntheticRoot(temporary, 'synthetic-collision', ({ manifest }) => {
    manifest.artifacts = [
      { path: 'soter/contexts/context.synthetic/Model.json', role: 'definition' },
      { path: 'soter/contexts/context.synthetic/model.json', role: 'fixture' }
    ];
  });
  expectCode('PACK_RELEASE_PATH_COLLISION', () => buildPackRelease({
    root: collision.target, pack: collision.manifest.id, outputDirectory: path.join(temporary, 'out-collision'), createdAt
  }));

  const privateState = syntheticRoot(temporary, 'synthetic-private-state', ({ manifest }) => {
    manifest.artifacts = [{ path: '.soter/state/private.json', role: 'fixture' }];
  });
  expectCode('PACK_RELEASE_PRIVATE_STATE_REJECTED', () => buildPackRelease({
    root: privateState.target, pack: privateState.manifest.id, outputDirectory: path.join(temporary, 'out-private'), createdAt
  }));

  const activeConfiguration = syntheticRoot(temporary, 'synthetic-active-configuration', ({ manifest }) => {
    manifest.artifacts = [{ path: 'soter/configurations/private-active.json', role: 'fixture' }];
  });
  expectCode('PACK_RELEASE_PRIVATE_STATE_REJECTED', () => buildPackRelease({
    root: activeConfiguration.target,
    pack: activeConfiguration.manifest.id,
    outputDirectory: path.join(temporary, 'out-active-configuration'),
    createdAt
  }));

  const credential = syntheticRoot(temporary, 'synthetic-credential');
  writeText(
    path.join(credential.target, credential.manifest.artifacts[0].path),
    JSON.stringify({ token: 'sk-' + 'HOSTILECREDENTIALVALUE1234567890' }) + '\n'
  );
  expectCode('PACK_RELEASE_CREDENTIAL_REJECTED', () => buildPackRelease({
    root: credential.target, pack: credential.manifest.id, outputDirectory: path.join(temporary, 'out-credential'), createdAt
  }));

  expectCode('PACK_RELEASE_CREDENTIAL_REJECTED', () => buildPackRelease({
    root: synthetic.target,
    pack: synthetic.manifest.id,
    outputDirectory: path.join(temporary, 'out-hostile-limitation'),
    createdAt,
    limitations: [{
      code: 'HOSTILE_CALLER_METADATA',
      summary: 'Hostile supplied limitation sk-' + 'PACKMETADATACREDENTIAL1234567890'
    }]
  }));

  const rawResponse = syntheticRoot(temporary, 'synthetic-raw-response');
  writeJson(path.join(rawResponse.target, rawResponse.manifest.artifacts[0].path), {
    rawProviderResponse: { private: 'HOSTILE_RAW_PROVIDER_SENTINEL' }
  });
  expectCode('PACK_RELEASE_RAW_RESPONSE_REJECTED', () => buildPackRelease({
    root: rawResponse.target, pack: rawResponse.manifest.id, outputDirectory: path.join(temporary, 'out-raw-response'), createdAt
  }));

  const uppercaseJson = syntheticRoot(temporary, 'synthetic-uppercase-json', ({ manifest }) => {
    manifest.artifacts = [{
      path: 'soter/contexts/context.synthetic/payload.JSON',
      role: 'fixture'
    }];
  });
  writeJson(path.join(uppercaseJson.target, uppercaseJson.manifest.artifacts[0].path), {
    rawProviderResponse: { private: 'HOSTILE_UPPERCASE_EXTENSION_SENTINEL' }
  });
  expectCode('PACK_RELEASE_RAW_RESPONSE_REJECTED', () => buildPackRelease({
    root: uppercaseJson.target,
    pack: uppercaseJson.manifest.id,
    outputDirectory: path.join(temporary, 'out-uppercase-json'),
    createdAt
  }));

  const uppercaseRawKey = syntheticRoot(temporary, 'synthetic-uppercase-raw-key');
  writeJson(path.join(uppercaseRawKey.target, uppercaseRawKey.manifest.artifacts[0].path), {
    RawProviderResponse: { private: 'HOSTILE_UPPERCASE_KEY_SENTINEL' }
  });
  expectCode('PACK_RELEASE_RAW_RESPONSE_REJECTED', () => buildPackRelease({
    root: uppercaseRawKey.target,
    pack: uppercaseRawKey.manifest.id,
    outputDirectory: path.join(temporary, 'out-uppercase-raw-key'),
    createdAt
  }));

  const snakeCaseRawKey = syntheticRoot(temporary, 'synthetic-snake-case-raw-key');
  writeJson(path.join(snakeCaseRawKey.target, snakeCaseRawKey.manifest.artifacts[0].path), {
    raw_provider_response: { private: 'HOSTILE_SNAKE_CASE_KEY_SENTINEL' }
  });
  expectCode('PACK_RELEASE_RAW_RESPONSE_REJECTED', () => buildPackRelease({
    root: snakeCaseRawKey.target,
    pack: snakeCaseRawKey.manifest.id,
    outputDirectory: path.join(temporary, 'out-snake-case-raw-key'),
    createdAt
  }));

  const kebabCaseRawKey = syntheticRoot(temporary, 'synthetic-kebab-case-raw-key');
  writeJson(path.join(kebabCaseRawKey.target, kebabCaseRawKey.manifest.artifacts[0].path), {
    'RAW-PROVIDER-RESPONSE': { private: 'HOSTILE_KEBAB_CASE_KEY_SENTINEL' }
  });
  expectCode('PACK_RELEASE_RAW_RESPONSE_REJECTED', () => buildPackRelease({
    root: kebabCaseRawKey.target,
    pack: kebabCaseRawKey.manifest.id,
    outputDirectory: path.join(temporary, 'out-kebab-case-raw-key'),
    createdAt
  }));

  const harmlessJsonKey = syntheticRoot(temporary, 'synthetic-harmless-json-key');
  writeJson(path.join(harmlessJsonKey.target, harmlessJsonKey.manifest.artifacts[0].path), {
    normalizedResponseSummary: 'Contained public summary without raw provider material.'
  });
  const harmlessJsonKeyRelease = buildPackRelease({
    root: harmlessJsonKey.target,
    pack: harmlessJsonKey.manifest.id,
    outputDirectory: path.join(temporary, 'out-harmless-json-key'),
    createdAt
  });
  assert.equal(harmlessJsonKeyRelease.inspection.integrity.state, 'passed');

  const badMode = syntheticRoot(temporary, 'synthetic-mode');
  fs.chmodSync(path.join(badMode.target, badMode.manifest.artifacts[0].path), 0o600);
  expectCode('PACK_RELEASE_MODE_UNSUPPORTED', () => buildPackRelease({
    root: badMode.target, pack: badMode.manifest.id, outputDirectory: path.join(temporary, 'out-mode'), createdAt
  }));

  const specialMode = syntheticRoot(temporary, 'synthetic-special-mode');
  const specialModePath = path.join(specialMode.target, specialMode.manifest.artifacts[0].path);
  fs.chmodSync(specialModePath, 0o1644);
  assert.equal(fs.lstatSync(specialModePath).mode & 0o7777, 0o1644);
  expectCode('PACK_RELEASE_MODE_UNSUPPORTED', () => buildPackRelease({
    root: specialMode.target,
    pack: specialMode.manifest.id,
    outputDirectory: path.join(temporary, 'out-special-mode'),
    createdAt
  }));

  const crlf = syntheticRoot(temporary, 'synthetic-crlf');
  writeText(path.join(crlf.target, crlf.manifest.artifacts[0].path), '{\r\n  "id": "crlf"\r\n}\r\n');
  expectCode('PACK_RELEASE_ENCODING_INVALID', () => buildPackRelease({
    root: crlf.target, pack: crlf.manifest.id, outputDirectory: path.join(temporary, 'out-crlf'), createdAt
  }));

  const linked = syntheticRoot(temporary, 'synthetic-symlink');
  const linkedPath = path.join(linked.target, linked.manifest.artifacts[0].path);
  const linkedTarget = path.join(temporary, 'symlink-target.json');
  writeJson(linkedTarget, { safe: true });
  fs.unlinkSync(linkedPath);
  fs.symlinkSync(linkedTarget, linkedPath);
  expectCode('PACK_RELEASE_SYMLINK_REJECTED', () => buildPackRelease({
    root: linked.target, pack: linked.manifest.id, outputDirectory: path.join(temporary, 'out-symlink'), createdAt
  }));

  const hardlinked = syntheticRoot(temporary, 'synthetic-hardlink');
  const hardlinkedPath = path.join(hardlinked.target, hardlinked.manifest.artifacts[0].path);
  const hardlinkSource = path.join(temporary, 'hardlink-source.json');
  writeJson(hardlinkSource, { safe: true });
  fs.unlinkSync(hardlinkedPath);
  fs.linkSync(hardlinkSource, hardlinkedPath);
  expectCode('PACK_RELEASE_HARDLINK_REJECTED', () => buildPackRelease({
    root: hardlinked.target, pack: hardlinked.manifest.id, outputDirectory: path.join(temporary, 'out-hardlink'), createdAt
  }));

  const nonRegular = syntheticRoot(temporary, 'synthetic-directory');
  const nonRegularPath = path.join(nonRegular.target, nonRegular.manifest.artifacts[0].path);
  fs.unlinkSync(nonRegularPath);
  fs.mkdirSync(nonRegularPath);
  expectCode('PACK_RELEASE_NON_REGULAR_REJECTED', () => buildPackRelease({
    root: nonRegular.target, pack: nonRegular.manifest.id, outputDirectory: path.join(temporary, 'out-directory'), createdAt
  }));

  const selfReference = syntheticRoot(temporary, 'synthetic-self-reference');
  expectCode('PACK_RELEASE_OUTPUT_SELF_REFERENCE', () => buildPackRelease({
    root: selfReference.target,
    pack: selfReference.manifest.id,
    outputDirectory: path.join(selfReference.target, 'soter', 'generated-release'),
    createdAt
  }));
  assert.equal(fs.existsSync(path.join(selfReference.target, 'soter', 'generated-release')), false);

  console.log(
    `DISTRIBUTION SELFTEST PASS: ${releases.length} governed packs built and independently verified; `
    + 'determinism, exact inventory, modes, path/link safety, privacy, credentials, evidence, legal no-assertion, '
    + 'transparent bundle resolution, dependency blocking, and compatible-release ambiguity checks passed.'
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
