import path from 'node:path';

import { validateJsonSchema } from '../../kernel/verify.mjs';
import {
  automationProposalFingerprint,
  automationProposalMaterialFingerprint,
  commitDurableAutomationProposal,
  getExactDurableAutomationProposal,
  loadAutomationProposalDeclaration
} from '../../core/automation-proposals.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import {
  assertAutomationReviewProjection,
  derivedReviewContentFingerprint
} from '../../core/review-projections.mjs';
import {
  hasAutomationProposalState,
  readAutomationProposalState
} from '../../core/runtime-state.mjs';
import {
  assertProjectPageReconciliationDecision,
  loadProjectPageReconciliationDecision,
  projectPageReconciliationDecisionReview
} from './decision.mjs';

const AUTOMATION_ID = 'automation.project-page-reconciliation';
const PROPOSAL_TYPE = 'project-page-reconciliation.review-proposal';
const REVIEW_KIND = 'project-page-reconciliation-review';
const ZERO_FINGERPRINT = 'sha256:' + '0'.repeat(64);
const LIMITATIONS = [
  'This private review proposal creates no approval, confirmation, continuation, provider call, write, retry, proof, or maturity authority.',
  'Only the exact selected projectType, status, and one-match text replacement actions may enter a separately reviewed connected batch.',
  'Combined property and body operations are sequential and non-atomic; ambiguous outcomes are never retried and require checkpoint-bound reconciliation.'
];

function codedError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function validate(root, value, schemaPath, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    throw new Error(
      label + ' does not satisfy its contract: '
        + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
}

function assertInput(input, schemaPath) {
  const failures = validateJsonSchema(input, readJson(schemaPath));
  if (failures.length) {
    throw new Error(
      'Project page reconciliation proposal input does not satisfy its closed contract: '
        + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
}

function buildReview({ root, lock, snapshot, run, decision }) {
  const exact = projectPageReconciliationDecisionReview({ root, lock, snapshot, run });
  if (decision.payload.review.previewFingerprint !== exact.preview.fingerprint
    || decision.payload.review.derivedReviewContentFingerprint
      !== exact.preview.privateReview.contentFingerprint) {
    throw new Error('Project page reconciliation proposal review basis is stale.');
  }
  const review = {
    $contract: 'soter://contracts/automation-review/v1',
    contractVersion: '1.0.0',
    kind: REVIEW_KIND,
    fingerprint: ZERO_FINGERPRINT,
    facts: structuredClone(exact.preview.facts),
    contradictions: structuredClone(exact.preview.contradictions),
    collections: structuredClone(exact.preview.collections),
    privateReview: structuredClone(exact.preview.privateReview),
    proposedChanges: structuredClone(exact.preview.proposedChanges)
  };
  const unsigned = structuredClone(review);
  delete unsigned.fingerprint;
  review.fingerprint = fingerprintJson(unsigned);
  return { review, derivedReview: exact.derivedReview };
}

export function createProjectPageReconciliationProposal({
  root,
  lock,
  snapshot,
  run,
  decision,
  id,
  createdAt,
  producer,
  input = {}
}) {
  const resolvedRoot = path.resolve(root);
  assertProjectPageReconciliationDecision({
    root: resolvedRoot,
    lock,
    snapshot,
    run,
    decision
  });
  const declaration = loadAutomationProposalDeclaration(resolvedRoot, lock, AUTOMATION_ID);
  if (declaration.declaration.export !== 'createProjectPageReconciliationProposal') {
    throw codedError(
      'AUTOMATION_PROPOSAL_ADAPTER_INVALID',
      'Project page reconciliation manifest does not select its exact proposal builder.'
    );
  }
  assertInput(input, declaration.inputSchemaPath);
  const { review, derivedReview } = buildReview({
    root: resolvedRoot,
    lock,
    snapshot,
    run,
    decision
  });
  const proposal = {
    $contract: 'soter://contracts/automation-proposal/v1',
    contractVersion: '1.0.0',
    id,
    automation: structuredClone(decision.automation),
    runId: decision.runId,
    createdAt: new Date(createdAt).toISOString(),
    configurationLockFingerprint: fingerprintLock(lock),
    graphFingerprint: lock.graphFingerprint,
    decision: {
      id: decision.id,
      fingerprint: decision.decisionFingerprint,
      decisionType: decision.decisionType,
      contextSnapshotId: decision.context.snapshotId,
      contextSnapshotFingerprint: decision.context.snapshotFingerprint
    },
    producer: structuredClone(producer),
    state: 'ready-for-review',
    proposalType: PROPOSAL_TYPE,
    review,
    limitations: structuredClone(LIMITATIONS),
    authority: {
      state: 'none',
      reasonCode: 'AUTOMATION_PROPOSAL_REVIEW_ONLY',
      permittedNextAction: 'inspect-private-proposal-material'
    },
    privacy: {
      scope: 'private-sanitized-proposal',
      rawProviderResponsesIncluded: false,
      credentialValuesIncluded: false,
      privateValuesIncluded: false,
      workspaceInspectionIncluded: false,
      evidenceIncluded: false,
      canonicalArtifactsWritten: false,
      externalWritesPerformed: false
    },
    proposalFingerprint: ZERO_FINGERPRINT
  };
  proposal.proposalFingerprint = automationProposalFingerprint(proposal);
  const material = {
    $contract: 'soter://contracts/automation-proposal-material/v1',
    contractVersion: '1.0.0',
    createdAt: proposal.createdAt,
    proposal: { id: proposal.id, fingerprint: proposal.proposalFingerprint },
    decision: { id: decision.id, fingerprint: decision.decisionFingerprint },
    automation: structuredClone(proposal.automation),
    configuration: {
      name: lock.configuration.name,
      lockFingerprint: proposal.configurationLockFingerprint,
      graphFingerprint: proposal.graphFingerprint
    },
    reviewContractId: declaration.derivedReviewDefinition.$contract,
    reviewContractFingerprint: fingerprintJson(declaration.derivedReviewDefinition),
    applicability: 'current',
    kind: derivedReview.kind,
    contentFingerprint: derivedReviewContentFingerprint(derivedReview),
    items: structuredClone(derivedReview.items),
    authority: {
      state: 'none',
      reasonCode: 'AUTOMATION_PROPOSAL_MATERIAL_REVIEW_ONLY'
    },
    privacy: {
      scope: 'private-local-automation-proposal',
      projection: 'selected-proposal-only',
      rawProviderResponsesIncluded: false,
      credentialValuesIncluded: false,
      workspaceInspectionIncluded: false,
      evidenceIncluded: false,
      canonicalArtifactsIncluded: false
    },
    fingerprint: ZERO_FINGERPRINT
  };
  material.fingerprint = automationProposalMaterialFingerprint(material);

  validate(resolvedRoot, review, 'soter/contracts/automation-review.schema.json', 'Review');
  validate(resolvedRoot, proposal, 'soter/contracts/automation-proposal.schema.json', 'Proposal');
  validate(resolvedRoot, proposal, declaration.declaration.schema, 'Pack proposal');
  validate(
    resolvedRoot,
    material,
    'soter/contracts/automation-proposal-material.schema.json',
    'Proposal material'
  );
  assertAutomationReviewProjection({
    preview: review,
    derivedReview,
    automationPack: declaration.manifest,
    lock,
    derivedReviewDefinition: declaration.derivedReviewDefinition,
    invalid: (message) => codedError('AUTOMATION_PROPOSAL_BINDING_INVALID', message),
    materialInvalid: (code, message) => codedError(
      'AUTOMATION_PROPOSAL_MATERIAL_' + code,
      message
    )
  });
  return { proposal, material };
}

export function inspectProjectPageReconciliationProposalDecision({
  root,
  lockPath,
  decisionId,
  expectedHost
}) {
  const exact = loadProjectPageReconciliationDecision({
    root,
    lockPath,
    decisionId,
    expectedHost
  });
  return {
    decision: {
      id: exact.decision.id,
      fingerprint: exact.decision.decisionFingerprint,
      state: exact.decision.state,
      previewFingerprint: exact.decision.payload.review.previewFingerprint,
      actionIds: structuredClone(exact.decision.payload.review.actionIds)
    },
    inputTemplate: {},
    authority: {
      state: 'none',
      reasonCode: 'AUTOMATION_PROPOSAL_NOT_COMMITTED'
    }
  };
}

export function commitProjectPageReconciliationProposal({
  root,
  lockPath,
  decisionId,
  id,
  input = {},
  producer,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const exact = loadProjectPageReconciliationDecision({
    root: resolvedRoot,
    lockPath,
    decisionId,
    expectedHost
  });
  const existing = hasAutomationProposalState(resolvedRoot, id)
    ? readAutomationProposalState(resolvedRoot, id).proposal
    : null;
  const { proposal, material } = createProjectPageReconciliationProposal({
    root: resolvedRoot,
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    decision: exact.decision,
    id,
    createdAt: existing?.createdAt || at || new Date().toISOString(),
    producer,
    input
  });
  return commitDurableAutomationProposal({
    root: resolvedRoot,
    lockPath,
    decisionId,
    proposal,
    material,
    expectedHost
  });
}

export function loadProjectPageReconciliationProposal({
  root,
  lockPath,
  proposalId,
  expectedHost
}) {
  const exact = getExactDurableAutomationProposal({
    root,
    lockPath,
    proposalId,
    expectedHost
  });
  if (exact.proposal.automation.id !== AUTOMATION_ID
    || exact.proposal.proposalType !== PROPOSAL_TYPE
    || exact.proposal.review.kind !== REVIEW_KIND) {
    throw codedError(
      'AUTOMATION_PROPOSAL_BINDING_INVALID',
      'Durable proposal is not a Project page reconciliation proposal.'
    );
  }
  let expected;
  try {
    expected = createProjectPageReconciliationProposal({
      root: path.resolve(root),
      lock: exact.lock,
      snapshot: exact.snapshot,
      run: exact.run,
      decision: exact.decision,
      id: exact.proposal.id,
      createdAt: exact.proposal.createdAt,
      producer: exact.proposal.producer,
      input: {}
    });
  } catch (error) {
    if (error?.code?.startsWith('AUTOMATION_PROPOSAL_')) throw error;
    throw codedError(
      'AUTOMATION_PROPOSAL_BINDING_INVALID',
      'Durable Project page reconciliation proposal cannot be reconstructed.',
      error
    );
  }
  if (fingerprintJson(expected.proposal) !== fingerprintJson(exact.proposal)
    || fingerprintJson(expected.material) !== fingerprintJson(exact.material)) {
    throw codedError(
      'AUTOMATION_PROPOSAL_BINDING_INVALID',
      'Durable Project page reconciliation proposal does not match reconstruction.'
    );
  }
  return exact;
}

export function inspectProjectPageReconciliationProposalMaterial({
  root,
  lockPath,
  proposalId,
  expectedHost
}) {
  return structuredClone(loadProjectPageReconciliationProposal({
    root,
    lockPath,
    proposalId,
    expectedHost
  }).material);
}
