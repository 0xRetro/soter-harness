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
import { assertProjectPulseDecision, loadProjectPulseDecision } from './decision.mjs';
import { loadProjectWorkPolicyDefinition } from '../../contexts/projects/project-work-policy.mjs';
import { buildProjectPulseReview } from './prepare.mjs';

const AUTOMATION_ID = 'automation.project-pulse';
const PROPOSAL_TYPE = 'project-pulse.review-proposal';
const REVIEW_KIND = 'project-pulse-review';
const STATUS_ACTION = 'action.project-pulse.status-create';
const DOCUMENT_ACTION = 'action.project-pulse.document-update';
const ZERO_FINGERPRINT = 'sha256:' + '0'.repeat(64);
const LIMITATIONS = [
  'This private review proposal creates no approval, confirmation, continuation, provider call, write, proof, maturity, or migration authority.',
  'When milestone tags change, document update and status creation are one inseparable review batch; approval request, confirmation, one-time start consumption, checkpoint execution, and verification remain separate.'
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
      'Project Pulse proposal input does not satisfy its closed contract: '
        + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
}

function expectedActionIds(analysis) {
  return [
    ...(analysis.document.changed ? [DOCUMENT_ACTION] : []),
    STATUS_ACTION
  ];
}

function buildReview({ root, decision, derivedReviewDefinition }) {
  const definition = loadProjectWorkPolicyDefinition(root);
  if (decision.payload.policy.definitionId !== definition.id
    || decision.payload.policy.definitionFingerprint !== fingerprintJson(definition)) {
    throw new Error('Project Pulse proposal policy definition is stale.');
  }
  const { preview, derivedReview } = buildProjectPulseReview({
    analysis: decision.payload.analysis,
    derivedReviewDefinition
  });
  const expectedIds = expectedActionIds(decision.payload.analysis);
  if (fingerprintJson(preview.proposedChanges.map((change) => change.id))
      !== fingerprintJson(expectedIds)) {
    throw new Error(
      'Project Pulse proposal cannot reconstruct the exact status and milestone review batch from the decision.'
    );
  }
  const review = {
    $contract: 'soter://contracts/automation-review/v1',
    contractVersion: '1.0.0',
    kind: REVIEW_KIND,
    fingerprint: ZERO_FINGERPRINT,
    facts: structuredClone(preview.facts),
    contradictions: structuredClone(preview.contradictions),
    collections: structuredClone(preview.collections),
    privateReview: structuredClone(preview.privateReview),
    proposedChanges: structuredClone(preview.proposedChanges)
  };
  const unsigned = structuredClone(review);
  delete unsigned.fingerprint;
  review.fingerprint = fingerprintJson(unsigned);
  return { review, derivedReview };
}

export function createProjectPulseProposal({
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
  assertProjectPulseDecision({ root: resolvedRoot, lock, snapshot, run, decision });
  if (decision.state !== 'ready') {
    throw new Error('Project Pulse proposal requires one exact ready grounded decision.');
  }
  const declaration = loadAutomationProposalDeclaration(resolvedRoot, lock, AUTOMATION_ID);
  if (declaration.declaration.export !== 'createProjectPulseProposal') {
    throw codedError(
      'AUTOMATION_PROPOSAL_ADAPTER_INVALID',
      'Project Pulse manifest does not select the exact pack-owned proposal builder.'
    );
  }
  assertInput(input, declaration.inputSchemaPath);
  const { review, derivedReview } = buildReview({
    root: resolvedRoot,
    decision,
    derivedReviewDefinition: declaration.derivedReviewDefinition
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

  validate(resolvedRoot, review, 'soter/contracts/automation-review.schema.json', 'Project Pulse proposal review');
  validate(resolvedRoot, proposal, 'soter/contracts/automation-proposal.schema.json', 'Automation proposal');
  validate(resolvedRoot, proposal, declaration.declaration.schema, 'Project Pulse proposal');
  validate(
    resolvedRoot,
    material,
    'soter/contracts/automation-proposal-material.schema.json',
    'Automation proposal material'
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

export function inspectProjectPulseProposalDecision({
  root,
  lockPath,
  decisionId,
  expectedHost
}) {
  const exact = loadProjectPulseDecision({ root, lockPath, decisionId, expectedHost });
  if (exact.decision.state !== 'ready') {
    throw new Error('Project Pulse proposal inspection requires a ready grounded decision.');
  }
  return {
    decision: {
      id: exact.decision.id,
      fingerprint: exact.decision.decisionFingerprint,
      state: exact.decision.state,
      projectFingerprint: exact.decision.payload.analysis.project.fingerprint,
      statusAfterFingerprint: exact.decision.payload.analysis.status.afterFingerprint,
      milestoneChangeCount: exact.decision.payload.analysis.document.updates.length
    },
    inputTemplate: {},
    authority: {
      state: 'none',
      reasonCode: 'AUTOMATION_PROPOSAL_NOT_COMMITTED'
    }
  };
}

export function commitProjectPulseProposal({
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
  const exact = loadProjectPulseDecision({ root: resolvedRoot, lockPath, decisionId, expectedHost });
  const existing = hasAutomationProposalState(resolvedRoot, id)
    ? readAutomationProposalState(resolvedRoot, id).proposal
    : null;
  const { proposal, material } = createProjectPulseProposal({
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

export function loadProjectPulseProposal({ root, lockPath, proposalId, expectedHost }) {
  const exact = getExactDurableAutomationProposal({ root, lockPath, proposalId, expectedHost });
  if (exact.proposal.automation.id !== AUTOMATION_ID
    || exact.proposal.proposalType !== PROPOSAL_TYPE
    || exact.proposal.review.kind !== REVIEW_KIND) {
    throw codedError(
      'AUTOMATION_PROPOSAL_BINDING_INVALID',
      'Durable proposal is not a Project Pulse proposal.'
    );
  }
  let expected;
  try {
    expected = createProjectPulseProposal({
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
      'Durable Project Pulse proposal could not be reconstructed from its exact bindings.',
      error
    );
  }
  if (fingerprintJson(expected.proposal) !== fingerprintJson(exact.proposal)
    || fingerprintJson(expected.material) !== fingerprintJson(exact.material)) {
    throw codedError(
      'AUTOMATION_PROPOSAL_BINDING_INVALID',
      'Durable Project Pulse proposal does not match its deterministic reconstruction.'
    );
  }
  return exact;
}

export function inspectProjectPulseProposalMaterial({ root, lockPath, proposalId, expectedHost }) {
  return structuredClone(loadProjectPulseProposal({ root, lockPath, proposalId, expectedHost }).material);
}
