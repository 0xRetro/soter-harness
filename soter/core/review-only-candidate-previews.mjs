import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  fingerprintJson,
  readJson,
  resolveRepoPath
} from './lib/canonical-json.mjs';
import {
  assertReviewOnlyCandidateSelection,
  inspectReviewOnlyCandidateSelectionMaterial
} from './review-only-candidate-selections.mjs';
import {
  compileAutomationConnectedSelection,
  evaluateAutomationConnectedObservation
} from './connected-compilers.mjs';
import { assertPreparedWork } from './prepared-work.mjs';
import {
  createReviewOnlyCandidatePreviewState,
  hasReviewOnlyCandidatePreviewState,
  readReviewOnlyCandidatePreviewState,
  readReviewOnlyCandidateSelectionState,
  readPreparedWorkState
} from './runtime-state.mjs';

const CONTRACT = 'soter://contracts/review-only-candidate-preview/v1';
const VERSION = '1.0.0';
const BLOCKERS = [
  'CONNECTED_PROVIDER_NOT_DECLARED',
  'CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED',
  'CONNECTED_VERIFICATION_NOT_PROVEN',
  'SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE'
];

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en');
}

function codedError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function validate(root, value, contractPath, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, contractPath)));
  if (failures.length) {
    throw new Error(label + ' does not satisfy its contract: '
      + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; '));
  }
}

function candidatePreviewFingerprint(preview) {
  const unsigned = structuredClone(preview);
  delete unsigned.fingerprint;
  delete unsigned.configuration.applicability;
  return fingerprintJson(unsigned);
}

function withCandidatePreviewFingerprint(preview) {
  return { ...preview, fingerprint: candidatePreviewFingerprint(preview) };
}

function exactCandidatePreviewId(selection, compiler, operations) {
  const identity = {
    selectionId: selection.id,
    selectionFingerprint: selection.fingerprint,
    compiler,
    operations: operations.map((operation) => ({
      id: operation.id,
      sourceActionId: operation.sourceActionId,
      inputFingerprint: operation.inputFingerprint,
      verificationInputFingerprint: operation.verification.inputFingerprint,
      expectedFingerprint: operation.verification.expectation.expectedFingerprint
    }))
  };
  return 'review-only-candidate-preview.'
    + selection.work.automationId.slice('automation.'.length) + '.'
    + fingerprintJson(identity).slice('sha256:'.length, 39);
}

function readExactContext(root, selectionId) {
  let selection;
  let work;
  let material;
  try {
    selection = readReviewOnlyCandidateSelectionState(root, selectionId).selection;
    work = readPreparedWorkState(root, selection.work.id).work;
    work = assertPreparedWork(root, work);
    selection = assertReviewOnlyCandidateSelection(root, selection, work);
    material = inspectReviewOnlyCandidateSelectionMaterial({ root, selectionId });
  } catch (error) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_PREVIEW_SOURCE_INVALID',
      'Review-only candidate preview compilation requires one exact valid candidate selection.',
      error
    );
  }
  let lock;
  try {
    lock = readJson(resolveRepoPath(root, selection.configuration.lockPath));
  } catch (error) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_PREVIEW_LOCK_INVALID',
      'Review-only candidate preview compilation could not read the exact resolved lock.',
      error
    );
  }
  if (fingerprintJson(lock) !== selection.configuration.lockFingerprint
    || lock.graphFingerprint !== selection.configuration.graphFingerprint
    || lock.configuration.name !== selection.configuration.name
    || lock.configuration.path !== selection.configuration.path
    || lock.host.id !== selection.configuration.host) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_PREVIEW_LOCK_INVALID',
      'Review-only candidate preview compilation lock does not match the candidate selection.'
    );
  }
  return { selection, work, material, lock };
}

function buildCandidatePreview(context, operations, createdAt, compiler) {
  const providerMissing = operations.some((operation) => {
    return operation.provider.connectedImplementation === null
      || operation.verification.provider.connectedImplementation === null;
  });
  const blockers = BLOCKERS.filter((code) => {
    return code !== 'CONNECTED_PROVIDER_NOT_DECLARED' || providerMissing;
  });
  return withCandidatePreviewFingerprint({
    $contract: CONTRACT,
    contractVersion: VERSION,
    id: exactCandidatePreviewId(context.selection, compiler, operations),
    fingerprint: 'sha256:' + '0'.repeat(64),
    createdAt: new Date(createdAt).toISOString(),
    source: {
      selectionId: context.selection.id,
      selectionFingerprint: context.selection.fingerprint,
      workId: context.work.id,
      workFingerprint: context.work.fingerprint,
      checkpointId: context.work.checkpoint.id,
      checkpointFingerprint: context.work.checkpoint.fingerprint,
      automationId: context.work.automation.id,
      automationVersion: context.work.automation.version
    },
    configuration: {
      ...structuredClone(context.selection.configuration),
      applicability: context.material.configuration.applicability
    },
    compiler,
    state: 'blocked-review-only',
    executable: false,
    effects: [...new Set(operations.map((operation) => operation.effect))].sort(compareText),
    operations,
    blockers,
    privacy: {
      scope: 'private-local-review-only-candidate-preview',
      authority: 'none',
      projection: 'review-only-candidate-preview-only',
      privateValuesIncluded: true,
      providerArgumentsIncluded: true,
      rawProviderResponsesIncluded: false,
      credentialValuesIncluded: false,
      workspaceInspectionIncluded: false,
      evidenceIncluded: false,
      canonicalArtifactsIncluded: false,
      approvalAuthorityIncluded: false,
      continuationAuthorityIncluded: false,
      executionAuthorityIncluded: false,
      retryAuthorityIncluded: false
    }
  });
}

async function compileExactCandidatePreview(root, context, createdAt) {
  let compiled;
  try {
    compiled = await compileAutomationConnectedSelection({
      root,
      lock: context.lock,
      automationId: context.work.automation.id,
      batch: context.selection,
      material: context.material
    });
  } catch (error) {
    throw codedError(
      error?.code === 'CONNECTED_COMPILER_CREDENTIAL_REJECTED'
        ? 'REVIEW_ONLY_CANDIDATE_PREVIEW_CREDENTIAL_REJECTED'
        : error?.code === 'CONNECTED_COMPILER_BINDING_INVALID'
          ? 'REVIEW_ONLY_CANDIDATE_PREVIEW_BINDING_INVALID'
          : 'REVIEW_ONLY_CANDIDATE_PREVIEW_COMPILER_INVALID',
      'Review-only candidate preview compilation could not compile the exact candidate selection.',
      error
    );
  }
  return buildCandidatePreview(context, compiled.operations, createdAt, compiled.compiler);
}

export async function assertReviewOnlyCandidatePreview(root, preview) {
  const resolvedRoot = path.resolve(root);
  try {
    validate(
      resolvedRoot,
      preview,
      'soter/contracts/review-only-candidate-preview.schema.json',
      'Review-only candidate preview'
    );
  } catch (error) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_PREVIEW_MALFORMED',
      'Review-only candidate preview does not satisfy its private runtime contract.',
      error
    );
  }
  if (preview.fingerprint !== candidatePreviewFingerprint(preview)) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_PREVIEW_TAMPERED',
      'Review-only candidate preview fingerprint does not match its immutable contents.'
    );
  }
  const context = readExactContext(resolvedRoot, preview.source.selectionId);
  const expected = await compileExactCandidatePreview(resolvedRoot, context, preview.createdAt);
  const projectedExpected = structuredClone(expected);
  projectedExpected.configuration.applicability = preview.configuration.applicability;
  if (fingerprintJson(projectedExpected) !== fingerprintJson(preview)
    || preview.configuration.applicability !== context.material.configuration.applicability) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_PREVIEW_BINDING_INVALID',
      'Review-only candidate preview does not bind the exact selection, compiler, lock, or operations.'
    );
  }
  return preview;
}

export async function createReviewOnlyCandidatePreview({
  root,
  selectionId,
  createdAt = new Date().toISOString()
}) {
  const resolvedRoot = path.resolve(root);
  const context = readExactContext(resolvedRoot, selectionId);
  if (context.material.configuration.applicability !== 'current') {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_PREVIEW_STALE',
      'A stale review-only candidate selection cannot produce a new candidate preview.'
    );
  }
  const preview = await compileExactCandidatePreview(resolvedRoot, context, createdAt);
  if (hasReviewOnlyCandidatePreviewState(resolvedRoot, preview.id)) {
    try {
      const existing = readReviewOnlyCandidatePreviewState(resolvedRoot, preview.id).preview;
      return await assertReviewOnlyCandidatePreview(resolvedRoot, existing);
    } catch (error) {
      if (error?.code?.startsWith('REVIEW_ONLY_CANDIDATE_PREVIEW_')) throw error;
      throw codedError(
        'REVIEW_ONLY_CANDIDATE_PREVIEW_MALFORMED',
        'Existing review-only candidate preview could not be read or validated.',
        error
      );
    }
  }
  await assertReviewOnlyCandidatePreview(resolvedRoot, preview);
  try {
    createReviewOnlyCandidatePreviewState(resolvedRoot, preview);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      try {
        const existing = readReviewOnlyCandidatePreviewState(resolvedRoot, preview.id).preview;
        return await assertReviewOnlyCandidatePreview(resolvedRoot, existing);
      } catch (existingError) {
        if (existingError?.code?.startsWith('REVIEW_ONLY_CANDIDATE_PREVIEW_')) throw existingError;
        throw codedError(
          'REVIEW_ONLY_CANDIDATE_PREVIEW_MALFORMED',
          'Concurrent review-only candidate preview state could not be read or validated.',
          existingError
        );
      }
    }
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_PREVIEW_WRITE_FAILED',
      'Review-only candidate preview could not be stored atomically.',
      error
    );
  }
  return preview;
}

export async function inspectReviewOnlyCandidatePreview({ root, candidatePreviewId }) {
  const resolvedRoot = path.resolve(root);
  if (!hasReviewOnlyCandidatePreviewState(resolvedRoot, candidatePreviewId)) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_PREVIEW_MISSING',
      'Review-only candidate preview is unavailable.'
    );
  }
  let preview;
  try {
    preview = readReviewOnlyCandidatePreviewState(resolvedRoot, candidatePreviewId).preview;
  } catch (error) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_PREVIEW_MALFORMED',
      'Review-only candidate preview could not be read.',
      error
    );
  }
  const applicability = readExactContext(
    resolvedRoot,
    preview.source?.selectionId
  ).material.configuration.applicability;
  const projected = structuredClone(preview);
  projected.configuration.applicability = applicability;
  await assertReviewOnlyCandidatePreview(resolvedRoot, projected);
  return projected;
}

export async function evaluateReviewOnlyCandidatePreviewVerification({
  root,
  candidatePreviewId,
  operationId,
  output
}) {
  const preview = await inspectReviewOnlyCandidatePreview({ root, candidatePreviewId });
  const operation = preview.operations.find((item) => item.id === operationId);
  if (!operation) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_PREVIEW_BINDING_INVALID',
      'Prepared connected verification requires one exact preview operation.'
    );
  }
  if (Object.hasOwn(operation.verification, 'inputBindings')) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_PREVIEW_VERIFICATION_RECEIPT_REQUIRED',
      'Write-output-bound verification requires a durable connected transaction receipt.'
    );
  }
  const context = readExactContext(path.resolve(root), preview.source.selectionId);
  try {
    return await evaluateAutomationConnectedObservation({
      root: path.resolve(root),
      lock: context.lock,
      automationId: preview.source.automationId,
      compiler: preview.compiler,
      operation,
      phase: 'verification',
      output
    });
  } catch (error) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_PREVIEW_VERIFICATION_INVALID',
      'The Automation verification evaluator rejected the normalized output.',
      error
    );
  }
}
