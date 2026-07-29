import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
import {
  fingerprintJson,
  fingerprintPath,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from './lib/canonical-json.mjs';
import { fingerprintLock } from './resolve.mjs';
import { assertAutomationReviewProjection, derivedReviewContentFingerprint } from './review-projections.mjs';
import {
  createAutomationProposalMaterialState,
  createAutomationProposalState,
  hasAutomationProposalMaterialState,
  hasAutomationProposalState,
  readAutomationProposalMaterialState,
  readAutomationProposalState,
  writeRunState
} from './runtime-state.mjs';
import { getExactDurableAutomationDecision } from './service.mjs';

const PROPOSAL_CONTRACT = 'soter://contracts/automation-proposal/v1';
const MATERIAL_CONTRACT = 'soter://contracts/automation-proposal-material/v1';
const REVIEW_CONTRACT = 'soter://contracts/automation-review/v1';
const DURABLE_RUN_STATES = new Set(['effects-established', 'executing', 'paused']);

function codedError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function validate(root, value, contractPath, label, code) {
  let schema;
  try {
    schema = readJson(resolveRepoPath(root, contractPath));
  } catch (error) {
    throw codedError(code, label + ' contract could not be read.', error);
  }
  const failures = validateJsonSchema(value, schema);
  if (failures.length) {
    throw codedError(
      code,
      label + ' does not satisfy its contract: '
        + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
}

export function automationProposalFingerprint(proposal) {
  const unsigned = structuredClone(proposal);
  delete unsigned.proposalFingerprint;
  return fingerprintJson(unsigned);
}

export function automationProposalMaterialFingerprint(material) {
  const unsigned = structuredClone(material);
  delete unsigned.fingerprint;
  delete unsigned.applicability;
  return fingerprintJson(unsigned);
}

export function inspectContextSnapshotCurrentness({ root, snapshot, at }) {
  const resolvedRoot = path.resolve(root);
  const currentAt = Date.parse(at);
  if (!snapshot || !Array.isArray(snapshot.entries)) {
    return { state: 'stale', reasonCode: 'CONTEXT_SNAPSHOT_STALE' };
  }
  for (const entry of snapshot.entries) {
    let maximumAgeSeconds;
    try {
      const capability = readJson(path.join(
        resolvedRoot,
        'soter',
        'capabilities',
        entry.capability + '.json'
      ));
      maximumAgeSeconds = capability.freshness?.maxAgeSeconds;
    } catch {
      return { state: 'stale', reasonCode: 'CONTEXT_SNAPSHOT_STALE' };
    }
    if (maximumAgeSeconds === null) continue;
    const observedAt = Date.parse(entry.observedAt);
    const ageSeconds = (currentAt - observedAt) / 1000;
    if (!Number.isInteger(maximumAgeSeconds)
      || maximumAgeSeconds < 0
      || entry.freshness !== 'passed'
      || !Number.isFinite(observedAt)
      || !Number.isFinite(currentAt)
      || ageSeconds < 0
      || ageSeconds > maximumAgeSeconds) {
      return { state: 'stale', reasonCode: 'CONTEXT_SNAPSHOT_STALE' };
    }
  }
  return { state: 'current', reasonCode: 'CONTEXT_SNAPSHOT_CURRENT' };
}

function exactArtifact(root, lock, manifest, artifactPath, role, label) {
  const declared = manifest.artifacts.find((item) => {
    return item.path === artifactPath && item.role === role;
  });
  const lockedPack = lock.packs.find((item) => item.id === manifest.id);
  const locked = lockedPack?.artifacts.find((item) => {
    return item.path === artifactPath && item.role === role;
  });
  let file;
  let fingerprint;
  try {
    file = resolveRepoPath(root, artifactPath);
    fingerprint = fingerprintPath(file);
  } catch (error) {
    throw codedError(
      'AUTOMATION_PROPOSAL_ADAPTER_INVALID',
      label + ' is unavailable from the governed Automation pack.',
      error
    );
  }
  if (!declared || !locked || locked.fingerprint !== fingerprint || !fs.statSync(file).isFile()) {
    throw codedError(
      'AUTOMATION_PROPOSAL_ADAPTER_INVALID',
      label + ' is unowned, absent from the exact lock, or fingerprint-mismatched.'
    );
  }
  return { file, fingerprint };
}

export function loadAutomationProposalDeclaration(root, lock, automationId) {
  const manifestPath = path.join(root, 'soter', 'packs', automationId, 'pack.json');
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    throw codedError(
      'AUTOMATION_PROPOSAL_ADAPTER_INVALID',
      'Automation proposal manifest could not be read.',
      error
    );
  }
  if (manifest.id !== automationId
    || manifest.layer !== 'automation'
    || !manifest.operator?.proposal) {
    throw codedError(
      'AUTOMATION_PROPOSAL_ADAPTER_INVALID',
      'The selected Automation does not declare a proposal adapter.'
    );
  }
  const selected = lock.packs.filter((item) => {
    return item.id === manifest.id && item.layer === 'automation';
  });
  if (selected.length !== 1 || selected[0].version !== manifest.version) {
    throw codedError(
      'AUTOMATION_PROPOSAL_ADAPTER_INVALID',
      'Automation proposal manifest does not match the exact selected lock.'
    );
  }
  const declaration = manifest.operator.proposal;
  const module = exactArtifact(
    root,
    lock,
    manifest,
    declaration.module,
    'implementation',
    'Automation proposal module'
  );
  const proposalSchema = exactArtifact(
    root,
    lock,
    manifest,
    declaration.schema,
    'definition',
    'Automation proposal schema'
  );
  const inputSchema = exactArtifact(
    root,
    lock,
    manifest,
    declaration.inputSchema,
    'definition',
    'Automation proposal input schema'
  );
  const derivedReview = exactArtifact(
    root,
    lock,
    manifest,
    declaration.derivedReviewContract,
    'definition',
    'Automation derived review contract'
  );
  const derivedReviewDefinition = readJson(derivedReview.file);
  validate(
    root,
    derivedReviewDefinition,
    'soter/contracts/automation-derived-review.schema.json',
    'Automation derived review declaration',
    'AUTOMATION_PROPOSAL_ADAPTER_INVALID'
  );
  if (derivedReviewDefinition.automation !== automationId) {
    throw codedError(
      'AUTOMATION_PROPOSAL_ADAPTER_INVALID',
      'Automation derived review declaration belongs to a different Automation.'
    );
  }
  return {
    manifest,
    declaration,
    modulePath: module.file,
    moduleFingerprint: module.fingerprint,
    proposalSchemaPath: proposalSchema.file,
    proposalSchemaFingerprint: proposalSchema.fingerprint,
    inputSchemaPath: inputSchema.file,
    inputSchemaFingerprint: inputSchema.fingerprint,
    derivedReviewDefinition,
    derivedReviewContractFingerprint: derivedReview.fingerprint
  };
}

function proposalInvalid(message, cause = null) {
  return codedError('AUTOMATION_PROPOSAL_BINDING_INVALID', message, cause);
}

function materialInvalid(code, message, cause = null) {
  const suffix = new Set([
    'MALFORMED', 'TAMPERED', 'BINDING_INVALID', 'CREDENTIAL_REJECTED'
  ]).has(code) ? code : 'BINDING_INVALID';
  return codedError('AUTOMATION_PROPOSAL_MATERIAL_' + suffix, message, cause);
}

function replaceExactById(items, value, label) {
  const next = structuredClone(items);
  const index = next.findIndex((item) => item.id === value.id);
  if (index >= 0) {
    if (fingerprintJson(next[index]) !== fingerprintJson(value)) {
      throw proposalInvalid(label + ' conflicts with existing durable state: ' + value.id + '.');
    }
  } else {
    next.push(value);
  }
  return next;
}

function assertProposalAndMaterial({ root, exact, proposal, material, requireRegistered }) {
  const declaration = loadAutomationProposalDeclaration(
    root,
    exact.lock,
    exact.decision.automation.id
  );
  try {
    validate(
      root,
      proposal,
      'soter/contracts/automation-proposal.schema.json',
      'Automation proposal',
      'AUTOMATION_PROPOSAL_MALFORMED'
    );
    validate(
      root,
      proposal.review,
      'soter/contracts/automation-review.schema.json',
      'Automation proposal review',
      'AUTOMATION_PROPOSAL_MALFORMED'
    );
    const domainFailures = validateJsonSchema(proposal, readJson(declaration.proposalSchemaPath));
    if (domainFailures.length) {
      throw codedError(
        'AUTOMATION_PROPOSAL_MALFORMED',
        'Automation proposal exceeds its pack-owned contract: '
          + domainFailures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; ')
      );
    }
  } catch (error) {
    if (error?.code?.startsWith('AUTOMATION_PROPOSAL_')) throw error;
    throw codedError(
      'AUTOMATION_PROPOSAL_MALFORMED',
      'Automation proposal could not be validated.',
      error
    );
  }
  if (proposal.proposalFingerprint !== automationProposalFingerprint(proposal)) {
    throw codedError(
      'AUTOMATION_PROPOSAL_TAMPERED',
      'Automation proposal fingerprint does not match its immutable contents.'
    );
  }
  if (containsCredentialMaterial(proposal)) {
    throw codedError(
      'AUTOMATION_PROPOSAL_CREDENTIAL_REJECTED',
      'Automation proposal cannot contain credential material.'
    );
  }
  if (proposal.$contract !== PROPOSAL_CONTRACT
    || proposal.review.$contract !== REVIEW_CONTRACT) {
    throw proposalInvalid(
      'Automation proposal does not match its exact fingerprint, review, and credential-free contract.'
    );
  }
  const decision = exact.decision;
  const createdAt = Date.parse(proposal.createdAt);
  if (decision.state !== 'ready'
    || proposal.runId !== decision.runId
    || fingerprintJson(proposal.automation) !== fingerprintJson(decision.automation)
    || proposal.configurationLockFingerprint !== decision.configurationLockFingerprint
    || proposal.configurationLockFingerprint !== fingerprintLock(exact.lock)
    || proposal.graphFingerprint !== decision.graphFingerprint
    || proposal.graphFingerprint !== exact.lock.graphFingerprint
    || proposal.decision.id !== decision.id
    || proposal.decision.fingerprint !== decision.decisionFingerprint
    || proposal.decision.decisionType !== decision.decisionType
    || proposal.decision.contextSnapshotId !== decision.context.snapshotId
    || proposal.decision.contextSnapshotFingerprint !== decision.context.snapshotFingerprint
    || !Number.isFinite(createdAt)
    || createdAt < Date.parse(decision.createdAt)
    || (proposal.producer.kind === 'host'
      ? proposal.producer.host !== exact.lock.host.id
      : proposal.producer.host !== null)) {
    throw proposalInvalid(
      'Automation proposal does not bind the exact ready decision, paused run, lock, graph, producer, and context.'
    );
  }

  try {
    validate(
      root,
      material,
      'soter/contracts/automation-proposal-material.schema.json',
      'Automation proposal material',
      'AUTOMATION_PROPOSAL_MATERIAL_MALFORMED'
    );
  } catch (error) {
    if (error?.code?.startsWith('AUTOMATION_PROPOSAL_MATERIAL_')) throw error;
    throw materialInvalid('MALFORMED', 'Automation proposal material could not be validated.', error);
  }
  const derivedReview = { kind: material.kind, items: material.items };
  if (material.$contract !== MATERIAL_CONTRACT
    || material.fingerprint !== automationProposalMaterialFingerprint(material)) {
    throw materialInvalid(
      'TAMPERED',
      'Automation proposal material fingerprint does not match its immutable contents.'
    );
  }
  if (material.createdAt !== proposal.createdAt
    || material.proposal.id !== proposal.id
    || material.proposal.fingerprint !== proposal.proposalFingerprint
    || material.decision.id !== decision.id
    || material.decision.fingerprint !== decision.decisionFingerprint
    || fingerprintJson(material.automation) !== fingerprintJson(proposal.automation)
    || material.configuration.name !== exact.lock.configuration.name
    || material.configuration.lockFingerprint !== proposal.configurationLockFingerprint
    || material.configuration.graphFingerprint !== proposal.graphFingerprint
    || material.applicability !== 'current'
    || material.reviewContractId !== declaration.derivedReviewDefinition.$contract
    || material.reviewContractFingerprint
      !== fingerprintJson(declaration.derivedReviewDefinition)
    || material.kind !== proposal.review.privateReview.kind
    || material.contentFingerprint !== derivedReviewContentFingerprint(derivedReview)
    || material.contentFingerprint !== proposal.review.privateReview.contentFingerprint
    || proposal.review.privateReview.contractId !== material.reviewContractId
    || proposal.review.privateReview.contractFingerprint !== material.reviewContractFingerprint) {
    throw materialInvalid(
      'BINDING_INVALID',
      'Automation proposal material does not bind the exact proposal, decision, lock, review contract, and private content.'
    );
  }
  if (containsCredentialMaterial(material)) {
    throw materialInvalid(
      'CREDENTIAL_REJECTED',
      'Automation proposal material cannot contain credential material.'
    );
  }
  assertAutomationReviewProjection({
    preview: proposal.review,
    derivedReview,
    automationPack: declaration.manifest,
    lock: exact.lock,
    derivedReviewDefinition: declaration.derivedReviewDefinition,
    invalid: proposalInvalid,
    materialInvalid
  });

  if (requireRegistered) {
    const proposalOutput = exact.run.outputs.find((item) => item.id === proposal.id);
    const proposalCheckpoint = exact.run.checkpoints.find((item) => {
      return item.id === 'automation-proposal.' + proposal.id.slice('proposal.'.length);
    });
    if (exact.run.lifecycleState !== 'paused'
      || !proposalOutput
      || proposalOutput.type !== 'automation-proposal'
      || proposalOutput.fingerprint !== proposal.proposalFingerprint
      || proposalCheckpoint?.proposalFingerprint !== proposal.proposalFingerprint
      || proposalCheckpoint?.decisionFingerprint !== decision.decisionFingerprint) {
      throw proposalInvalid('Durable run does not register the exact review-only Automation proposal.');
    }
  }
  return { declaration, proposal, material };
}

function existingPair(root, proposalId) {
  const hasProposal = hasAutomationProposalState(root, proposalId);
  const hasMaterial = hasAutomationProposalMaterialState(root, proposalId);
  if (hasProposal !== hasMaterial) {
    throw codedError(
      'AUTOMATION_PROPOSAL_STATE_INCOMPLETE',
      'Automation proposal private state is incomplete and cannot be reconstructed or replaced.'
    );
  }
  if (!hasProposal) return null;
  try {
    return {
      proposalState: readAutomationProposalState(root, proposalId),
      materialState: readAutomationProposalMaterialState(root, proposalId)
    };
  } catch (error) {
    throw codedError(
      'AUTOMATION_PROPOSAL_STATE_INCOMPLETE',
      'Automation proposal private state could not be read exactly.',
      error
    );
  }
}

function exactDecisionForProposal({ root, lockPath, decisionId, expectedHost }) {
  try {
    return getExactDurableAutomationDecision({ root, lockPath, decisionId, expectedHost });
  } catch (error) {
    if (/\bstale\b/i.test(error?.message || '')) {
      throw codedError(
        'AUTOMATION_PROPOSAL_STALE',
        'Automation proposal requires the current exact configuration lock.',
        error
      );
    }
    throw codedError(
      'AUTOMATION_PROPOSAL_BINDING_INVALID',
      'Automation proposal could not revalidate its exact decision, Context, run, and lock bindings.',
      error
    );
  }
}

export function commitDurableAutomationProposal({
  root,
  lockPath,
  decisionId,
  proposal,
  material,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const exact = exactDecisionForProposal({
    root: resolvedRoot,
    lockPath,
    decisionId,
    expectedHost
  });
  assertProposalAndMaterial({
    root: resolvedRoot,
    exact,
    proposal,
    material,
    requireRegistered: false
  });
  const existing = existingPair(resolvedRoot, proposal.id);
  let proposalState;
  let materialState;
  if (existing) {
    proposalState = existing.proposalState;
    materialState = existing.materialState;
    if (fingerprintJson(proposalState.proposal) !== fingerprintJson(proposal)
      || fingerprintJson(materialState.material) !== fingerprintJson(material)) {
      throw proposalInvalid('Automation proposal conflicts with existing create-only private state.');
    }
  } else {
    try {
      proposalState = createAutomationProposalState(resolvedRoot, proposal);
      materialState = createAutomationProposalMaterialState(resolvedRoot, material);
    } catch (error) {
      throw codedError(
        'AUTOMATION_PROPOSAL_WRITE_FAILED',
        'Automation proposal pair could not be stored atomically and must be inspected before retry.',
        error
      );
    }
  }

  const nextRun = structuredClone(exact.run);
  const competing = nextRun.checkpoints.find((checkpoint) => {
    return checkpoint.kind === 'automation-proposal'
      && checkpoint.decisionId === decisionId
      && checkpoint.proposalId !== proposal.id;
  });
  if (competing) {
    throw proposalInvalid(
      'Automation decision already has a different durable proposal: ' + competing.proposalId + '.'
    );
  }
  nextRun.checkpoints = replaceExactById(nextRun.checkpoints, {
    id: 'automation-proposal.' + proposal.id.slice('proposal.'.length),
    kind: 'automation-proposal',
    state: 'passed',
    decisionId,
    decisionFingerprint: exact.decision.decisionFingerprint,
    proposalId: proposal.id,
    proposalFingerprint: proposal.proposalFingerprint,
    privateMaterialFingerprint: material.fingerprint,
    updatedAt: proposal.createdAt,
    details: 'Automation recorded one exact private review proposal; no approval, continuation, provider call, write, or dispatch authority was created.'
  }, 'Automation proposal checkpoint');
  nextRun.outputs = replaceExactById(nextRun.outputs, {
    id: proposal.id,
    type: 'automation-proposal',
    fingerprint: proposal.proposalFingerprint
  }, 'Automation proposal output');
  nextRun.lifecycleState = 'paused';
  validate(
    resolvedRoot,
    nextRun,
    'soter/contracts/run-envelope.schema.json',
    'Automation proposal run envelope',
    'AUTOMATION_PROPOSAL_BINDING_INVALID'
  );
  if (!DURABLE_RUN_STATES.has(nextRun.lifecycleState)
    || fingerprintJson(nextRun.approvals) !== fingerprintJson(exact.run.approvals)
    || nextRun.effects.length !== exact.run.effects.length) {
    throw proposalInvalid('Automation proposal must keep the exact paused no-authority run boundary.');
  }
  const runState = writeRunState(resolvedRoot, nextRun);
  return {
    proposal,
    proposalPath: proposalState.path || repoRelativePath(resolvedRoot, proposalState.file),
    material: {
      proposal: structuredClone(material.proposal),
      decision: structuredClone(material.decision),
      kind: material.kind,
      contentFingerprint: material.contentFingerprint,
      fingerprint: material.fingerprint,
      applicability: material.applicability,
      authority: structuredClone(material.authority),
      privacy: structuredClone(material.privacy)
    },
    materialPath: materialState.path || repoRelativePath(resolvedRoot, materialState.file),
    run: nextRun,
    runPath: runState.path
  };
}

export function getExactDurableAutomationProposal({
  root,
  lockPath,
  proposalId,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const pair = existingPair(resolvedRoot, proposalId);
  if (!pair) {
    throw codedError('AUTOMATION_PROPOSAL_MISSING', 'Automation proposal does not exist.');
  }
  let proposal = pair.proposalState.proposal;
  if (proposal?.$contract !== PROPOSAL_CONTRACT || typeof proposal.decision?.id !== 'string') {
    throw codedError(
      'AUTOMATION_PROPOSAL_MALFORMED',
      'Durable automation proposal does not expose a valid decision binding.'
    );
  }
  const exact = exactDecisionForProposal({
    root: resolvedRoot,
    lockPath,
    decisionId: proposal.decision.id,
    expectedHost
  });
  const asserted = assertProposalAndMaterial({
    root: resolvedRoot,
    exact,
    proposal,
    material: pair.materialState.material,
    requireRegistered: true
  });
  proposal = asserted.proposal;
  return {
    lock: exact.lock,
    snapshot: exact.snapshot,
    decision: exact.decision,
    proposal,
    proposalPath: repoRelativePath(resolvedRoot, pair.proposalState.file),
    material: asserted.material,
    materialPath: repoRelativePath(resolvedRoot, pair.materialState.file),
    run: exact.run,
    runPath: exact.runPath
  };
}

export function inspectAutomationProposalMaterial(args) {
  const exact = getExactDurableAutomationProposal(args);
  return structuredClone(exact.material);
}
