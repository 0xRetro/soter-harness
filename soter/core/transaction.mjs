import { createFixtureRuntimeState, invokeCapability } from './capabilities.mjs';
import { fingerprintJson } from './lib/canonical-json.mjs';

export function changeSetScopeFingerprint(changeSet) {
  return fingerprintJson({
    id: changeSet.id,
    runId: changeSet.runId,
    configurationLockFingerprint: changeSet.configurationLockFingerprint,
    basis: changeSet.basis || null,
    operations: changeSet.operations.map((operation) => ({
      id: operation.id,
      capability: operation.capability,
      authority: operation.authority,
      inputFingerprint: operation.inputFingerprint
    }))
  });
}

export function approveChangeSet({ changeSet, id, runId, createdAt, actor, reason }) {
  return {
    $contract: 'soter://contracts/approval/v1',
    contractVersion: '1.0.0',
    id,
    runId,
    createdAt,
    actor,
    decision: 'approved',
    scope: {
      changeSetId: changeSet.id,
      fingerprint: changeSet.scopeFingerprint,
      effects: ['write']
    },
    reason
  };
}

function approvalMatches(changeSet, approval) {
  return approval.decision === 'approved'
    && approval.runId === changeSet.runId
    && approval.scope.changeSetId === changeSet.id
    && approval.scope.fingerprint === changeSetScopeFingerprint(changeSet)
    && approval.scope.effects.includes('write');
}

export async function executeContainedChangeSet({
  root,
  lock,
  changeSet,
  approval,
  at,
  verify
}) {
  if (!approvalMatches(changeSet, approval)) {
    throw new Error('Approval does not match the exact current change-set scope.');
  }
  if (typeof verify !== 'function') {
    throw new Error('Contained transaction requires an Automation-owned outcome verifier.');
  }
  let runtimeState = createFixtureRuntimeState(root);
  const checkpoint = structuredClone(runtimeState);
  const checkpointFingerprint = fingerprintJson(checkpoint);
  const effects = [];
  const operations = [];
  let failed = false;

  for (const operation of changeSet.operations) {
    if (failed) {
      operations.push({ ...operation });
      continue;
    }
    const effectId = 'effect.' + changeSet.id.slice('changeset.'.length) + '.' + operation.id.slice('operation.'.length);
    const result = await invokeCapability({
      root,
      lock,
      capability: operation.capability,
      authority: operation.authority,
      containment: 'fixture',
      input: operation.input,
      effectId,
      at,
      approvedEffects: ['write'],
      runtimeState
    });
    effects.push(result.invocation);
    operations.push({
      ...operation,
      state: result.invocation.state === 'passed' ? 'passed' : 'failed',
      effectId,
      outputFingerprint: result.invocation.outputFingerprint,
      error: result.invocation.error
    });
    failed = result.invocation.state !== 'passed';
  }

  if (failed) {
    runtimeState = checkpoint;
    return {
      changeSet: {
        ...changeSet,
        state: 'rolled-back',
        approvalId: approval.id,
        operations: operations.map((operation) => ({
          ...operation,
          state: operation.state === 'passed' ? 'rolled-back' : operation.state
        })),
        transaction: {
          checkpointFingerprint,
          state: 'rolled-back',
          rollbackState: 'passed',
          restoredFingerprint: fingerprintJson(runtimeState)
        },
        verification: {
          ...changeSet.verification,
          state: 'skipped'
        }
      },
      effects,
      verificationOutput: null,
      runtimeState
    };
  }

  let verification;
  try {
    verification = await verify({ root, lock, changeSet, runtimeState, at });
  } catch {
    verification = null;
  }
  if (verification?.invocation) effects.push(verification.invocation);
  if (!verification?.passed) {
    runtimeState = checkpoint;
    return {
      changeSet: {
        ...changeSet,
        state: 'rolled-back',
        approvalId: approval.id,
        operations: operations.map((operation) => ({ ...operation, state: 'rolled-back' })),
        transaction: {
          checkpointFingerprint,
          state: 'rolled-back',
          rollbackState: 'passed',
          restoredFingerprint: fingerprintJson(runtimeState)
        },
        verification: {
          ...changeSet.verification,
          state: 'failed',
          effectId: verification?.invocation?.id || null,
          observedFingerprint: verification?.invocation?.outputFingerprint || null
        }
      },
      effects,
      verificationOutput: verification?.output || null,
      runtimeState
    };
  }
  return {
    changeSet: {
      ...changeSet,
      state: 'committed',
      approvalId: approval.id,
      operations,
      transaction: {
        checkpointFingerprint,
        state: 'committed',
        rollbackState: 'not-required',
        restoredFingerprint: null
      },
      verification: {
        ...changeSet.verification,
        state: 'passed',
        effectId: verification.invocation.id,
        observedFingerprint: verification.invocation.outputFingerprint
      }
    },
    effects,
    verificationOutput: verification.output,
    runtimeState
  };
}
