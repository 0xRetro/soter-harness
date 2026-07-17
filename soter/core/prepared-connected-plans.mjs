import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  fingerprintJson,
  readJson,
  resolveRepoPath
} from './lib/canonical-json.mjs';
import {
  assertPreparedReviewBatch,
  inspectPreparedReviewBatchMaterial
} from './prepared-review-batches.mjs';
import {
  compileAutomationConnectedSelection,
  evaluateAutomationConnectedObservation
} from './connected-compilers.mjs';
import { assertPreparedWork } from './prepared-work.mjs';
import {
  createPreparedConnectedPlanState,
  hasPreparedConnectedPlanState,
  readPreparedConnectedPlanState,
  readPreparedReviewBatchState,
  readPreparedWorkState
} from './runtime-state.mjs';

const CONTRACT = 'soter://contracts/prepared-connected-plan/v1';
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

function planFingerprint(plan) {
  const unsigned = structuredClone(plan);
  delete unsigned.fingerprint;
  delete unsigned.configuration.applicability;
  return fingerprintJson(unsigned);
}

function withPlanFingerprint(plan) {
  return { ...plan, fingerprint: planFingerprint(plan) };
}

function exactPlanId(batch, compiler, operations) {
  const identity = {
    batchId: batch.id,
    batchFingerprint: batch.fingerprint,
    compiler,
    operations: operations.map((operation) => ({
      id: operation.id,
      sourceActionId: operation.sourceActionId,
      inputFingerprint: operation.inputFingerprint,
      verificationInputFingerprint: operation.verification.inputFingerprint,
      expectedFingerprint: operation.verification.expectation.expectedFingerprint
    }))
  };
  return 'prepared-connected-plan.'
    + batch.work.automationId.slice('automation.'.length) + '.'
    + fingerprintJson(identity).slice('sha256:'.length, 39);
}

function readExactContext(root, batchId) {
  let batch;
  let work;
  let material;
  try {
    batch = readPreparedReviewBatchState(root, batchId).batch;
    work = readPreparedWorkState(root, batch.work.id).work;
    work = assertPreparedWork(root, work);
    batch = assertPreparedReviewBatch(root, batch, work);
    material = inspectPreparedReviewBatchMaterial({ root, batchId });
  } catch (error) {
    throw codedError(
      'PREPARED_CONNECTED_PLAN_SOURCE_INVALID',
      'Prepared connected planning requires one exact valid selected review batch.',
      error
    );
  }
  let lock;
  try {
    lock = readJson(resolveRepoPath(root, batch.configuration.lockPath));
  } catch (error) {
    throw codedError(
      'PREPARED_CONNECTED_PLAN_LOCK_INVALID',
      'Prepared connected planning could not read the exact resolved lock.',
      error
    );
  }
  if (fingerprintJson(lock) !== batch.configuration.lockFingerprint
    || lock.graphFingerprint !== batch.configuration.graphFingerprint
    || lock.configuration.name !== batch.configuration.name
    || lock.configuration.path !== batch.configuration.path
    || lock.host.id !== batch.configuration.host) {
    throw codedError(
      'PREPARED_CONNECTED_PLAN_LOCK_INVALID',
      'Prepared connected planning lock does not match the selected batch.'
    );
  }
  return { batch, work, material, lock };
}

function buildPlan(context, operations, createdAt, compiler) {
  const providerMissing = operations.some((operation) => {
    return operation.provider.connectedImplementation === null
      || operation.verification.provider.connectedImplementation === null;
  });
  const blockers = BLOCKERS.filter((code) => {
    return code !== 'CONNECTED_PROVIDER_NOT_DECLARED' || providerMissing;
  });
  return withPlanFingerprint({
    $contract: CONTRACT,
    contractVersion: VERSION,
    id: exactPlanId(context.batch, compiler, operations),
    fingerprint: 'sha256:' + '0'.repeat(64),
    createdAt: new Date(createdAt).toISOString(),
    source: {
      batchId: context.batch.id,
      batchFingerprint: context.batch.fingerprint,
      workId: context.work.id,
      workFingerprint: context.work.fingerprint,
      checkpointId: context.work.checkpoint.id,
      checkpointFingerprint: context.work.checkpoint.fingerprint,
      automationId: context.work.automation.id,
      automationVersion: context.work.automation.version
    },
    configuration: {
      ...structuredClone(context.batch.configuration),
      applicability: context.material.configuration.applicability
    },
    compiler,
    state: 'blocked-review-only',
    executable: false,
    effects: [...new Set(operations.map((operation) => operation.effect))].sort(compareText),
    operations,
    blockers,
    privacy: {
      scope: 'private-local-prepared-connected-plan',
      authority: 'none',
      projection: 'selected-plan-only',
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

async function compileExactPlan(root, context, createdAt) {
  let compiled;
  try {
    compiled = await compileAutomationConnectedSelection({
      root,
      lock: context.lock,
      automationId: context.work.automation.id,
      batch: context.batch,
      material: context.material
    });
  } catch (error) {
    throw codedError(
      error?.code === 'CONNECTED_COMPILER_CREDENTIAL_REJECTED'
        ? 'PREPARED_CONNECTED_PLAN_CREDENTIAL_REJECTED'
        : error?.code === 'CONNECTED_COMPILER_BINDING_INVALID'
          ? 'PREPARED_CONNECTED_PLAN_BINDING_INVALID'
          : 'PREPARED_CONNECTED_PLAN_COMPILER_INVALID',
      'Prepared connected planning could not compile the exact selected batch.',
      error
    );
  }
  return buildPlan(context, compiled.operations, createdAt, compiled.compiler);
}

export async function assertPreparedConnectedPlan(root, plan) {
  const resolvedRoot = path.resolve(root);
  try {
    validate(
      resolvedRoot,
      plan,
      'soter/contracts/prepared-connected-plan.schema.json',
      'Prepared connected plan'
    );
  } catch (error) {
    throw codedError(
      'PREPARED_CONNECTED_PLAN_MALFORMED',
      'Prepared connected plan does not satisfy its private runtime contract.',
      error
    );
  }
  if (plan.fingerprint !== planFingerprint(plan)) {
    throw codedError(
      'PREPARED_CONNECTED_PLAN_TAMPERED',
      'Prepared connected plan fingerprint does not match its immutable contents.'
    );
  }
  const context = readExactContext(resolvedRoot, plan.source.batchId);
  const expected = await compileExactPlan(resolvedRoot, context, plan.createdAt);
  const projectedExpected = structuredClone(expected);
  projectedExpected.configuration.applicability = plan.configuration.applicability;
  if (fingerprintJson(projectedExpected) !== fingerprintJson(plan)
    || plan.configuration.applicability !== context.material.configuration.applicability) {
    throw codedError(
      'PREPARED_CONNECTED_PLAN_BINDING_INVALID',
      'Prepared connected plan does not bind the exact batch, compiler, lock, or operations.'
    );
  }
  return plan;
}

export async function createPreparedConnectedPlan({
  root,
  batchId,
  createdAt = new Date().toISOString()
}) {
  const resolvedRoot = path.resolve(root);
  const context = readExactContext(resolvedRoot, batchId);
  if (context.material.configuration.applicability !== 'current') {
    throw codedError(
      'PREPARED_CONNECTED_PLAN_STALE',
      'A stale selected review batch cannot produce a new connected plan.'
    );
  }
  const plan = await compileExactPlan(resolvedRoot, context, createdAt);
  if (hasPreparedConnectedPlanState(resolvedRoot, plan.id)) {
    try {
      const existing = readPreparedConnectedPlanState(resolvedRoot, plan.id).plan;
      return await assertPreparedConnectedPlan(resolvedRoot, existing);
    } catch (error) {
      if (error?.code?.startsWith('PREPARED_CONNECTED_PLAN_')) throw error;
      throw codedError(
        'PREPARED_CONNECTED_PLAN_MALFORMED',
        'Existing prepared connected plan could not be read or validated.',
        error
      );
    }
  }
  await assertPreparedConnectedPlan(resolvedRoot, plan);
  try {
    createPreparedConnectedPlanState(resolvedRoot, plan);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      try {
        const existing = readPreparedConnectedPlanState(resolvedRoot, plan.id).plan;
        return await assertPreparedConnectedPlan(resolvedRoot, existing);
      } catch (existingError) {
        if (existingError?.code?.startsWith('PREPARED_CONNECTED_PLAN_')) throw existingError;
        throw codedError(
          'PREPARED_CONNECTED_PLAN_MALFORMED',
          'Concurrent prepared connected plan state could not be read or validated.',
          existingError
        );
      }
    }
    throw codedError(
      'PREPARED_CONNECTED_PLAN_WRITE_FAILED',
      'Prepared connected plan could not be stored atomically.',
      error
    );
  }
  return plan;
}

export async function inspectPreparedConnectedPlan({ root, planId }) {
  const resolvedRoot = path.resolve(root);
  if (!hasPreparedConnectedPlanState(resolvedRoot, planId)) {
    throw codedError(
      'PREPARED_CONNECTED_PLAN_MISSING',
      'Prepared connected plan is unavailable.'
    );
  }
  let plan;
  try {
    plan = readPreparedConnectedPlanState(resolvedRoot, planId).plan;
  } catch (error) {
    throw codedError(
      'PREPARED_CONNECTED_PLAN_MALFORMED',
      'Prepared connected plan could not be read.',
      error
    );
  }
  const applicability = readExactContext(
    resolvedRoot,
    plan.source?.batchId
  ).material.configuration.applicability;
  const projected = structuredClone(plan);
  projected.configuration.applicability = applicability;
  await assertPreparedConnectedPlan(resolvedRoot, projected);
  return projected;
}

export async function evaluatePreparedConnectedVerification({ root, planId, operationId, output }) {
  const plan = await inspectPreparedConnectedPlan({ root, planId });
  const operation = plan.operations.find((item) => item.id === operationId);
  if (!operation) {
    throw codedError(
      'PREPARED_CONNECTED_PLAN_BINDING_INVALID',
      'Prepared connected verification requires one exact plan operation.'
    );
  }
  const context = readExactContext(path.resolve(root), plan.source.batchId);
  try {
    return await evaluateAutomationConnectedObservation({
      root: path.resolve(root),
      lock: context.lock,
      automationId: plan.source.automationId,
      compiler: plan.compiler,
      operation,
      phase: 'verification',
      output
    });
  } catch (error) {
    throw codedError(
      'PREPARED_CONNECTED_PLAN_VERIFICATION_INVALID',
      'The Automation verification evaluator rejected the normalized output.',
      error
    );
  }
}
