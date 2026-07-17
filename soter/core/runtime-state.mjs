import fs from 'node:fs';
import path from 'node:path';

import { readJson, repoRelativePath, resolveRepoPath } from './lib/canonical-json.mjs';

const STATE_ROOT = '.soter/state';
const SAFE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error(label + ' is not a safe runtime-state identifier.');
  }
  return value;
}

function stateFile(root, directory, id) {
  return resolveRepoPath(root, path.join(STATE_ROOT, directory, safeId(id, directory + ' id') + '.json'));
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Some filesystems do not expose POSIX permissions; atomic placement still applies.
  }
}

function atomicWriteJson(file, value) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'w', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, 0o600);
      const directory = fs.openSync(path.dirname(file), 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } catch {
      // Some filesystems do not support POSIX modes or directory fsync.
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function atomicCreateJson(file, value) {
  ensurePrivateDirectory(path.dirname(file));
  let descriptor = null;
  try {
    descriptor = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Some filesystems do not expose POSIX permissions.
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function runtimeStateRoot(root) {
  return resolveRepoPath(root, STATE_ROOT);
}

export function runStatePath(root, runId) {
  return stateFile(root, 'runs', safeId(runId, 'run id'));
}

export function hostCallCheckpointPath(root, checkpointId) {
  return stateFile(root, 'host-calls', safeId(checkpointId, 'checkpoint id'));
}

export function contextSnapshotStatePath(root, snapshotId) {
  return stateFile(root, 'context-snapshots', safeId(snapshotId, 'context snapshot id'));
}

export function automationDecisionStatePath(root, decisionId) {
  return stateFile(root, 'automation-decisions', safeId(decisionId, 'automation decision id'));
}

export function automationProposalStatePath(root, proposalId) {
  return stateFile(root, 'automation-proposals', safeId(proposalId, 'automation proposal id'));
}

export function automationProposalMaterialStatePath(root, proposalId) {
  return stateFile(
    root,
    'automation-proposal-material',
    safeId(proposalId, 'automation proposal material id')
  );
}

export function approvalRequestStatePath(root, requestId) {
  return stateFile(root, 'approval-requests', safeId(requestId, 'approval request id'));
}

export function connectedApprovalStatePath(root, approvalId) {
  return stateFile(root, 'approvals', safeId(approvalId, 'approval id'));
}

export function approvalConsumptionStatePath(root, consumptionId) {
  return stateFile(root, 'approval-consumptions', safeId(consumptionId, 'approval consumption id'));
}

export function preparedWorkStatePath(root, workId) {
  return stateFile(root, 'prepared-work', safeId(workId, 'prepared work id'));
}

export function preparedWorkEvidenceStatePath(root, evidenceId) {
  return stateFile(root, 'prepared-work-evidence', safeId(evidenceId, 'prepared work evidence id'));
}

export function preparedWorkReviewMaterialStatePath(root, workId) {
  return stateFile(root, 'prepared-work-review', safeId(workId, 'prepared work review id'));
}

export function preparedWorkDerivedReviewMaterialStatePath(root, workId) {
  return stateFile(root, 'prepared-work-derived-review', safeId(workId, 'prepared work derived review id'));
}

export function preparedReviewBatchStatePath(root, batchId) {
  return stateFile(root, 'prepared-review-batches', safeId(batchId, 'prepared review batch id'));
}

export function preparedConnectedPlanStatePath(root, planId) {
  return stateFile(root, 'prepared-connected-plans', safeId(planId, 'prepared connected plan id'));
}

export function configurationChangePlanStatePath(root, planId) {
  return stateFile(root, 'configuration-change-plans', safeId(planId, 'configuration change plan id'));
}

export function configurationChangeRequestStatePath(root, requestId) {
  return stateFile(root, 'configuration-change-requests', safeId(requestId, 'configuration change request id'));
}

export function configurationChangeConfirmationStatePath(root, confirmationId) {
  return stateFile(
    root,
    'configuration-change-confirmations',
    safeId(confirmationId, 'configuration change confirmation id')
  );
}

export function configurationChangeConsumptionStatePath(root, consumptionId) {
  return stateFile(
    root,
    'configuration-change-consumptions',
    safeId(consumptionId, 'configuration change consumption id')
  );
}

export function configurationTransactionCheckpointStatePath(root, checkpointId) {
  return stateFile(
    root,
    'configuration-transactions',
    safeId(checkpointId, 'configuration transaction checkpoint id')
  );
}

export function hostRealizationPlanStatePath(root, planId) {
  return stateFile(root, 'host-realization-plans', safeId(planId, 'host realization plan id'));
}

export function hostRealizationRequestStatePath(root, requestId) {
  return stateFile(root, 'host-realization-requests', safeId(requestId, 'host realization request id'));
}

export function hostRealizationConfirmationStatePath(root, confirmationId) {
  return stateFile(
    root,
    'host-realization-confirmations',
    safeId(confirmationId, 'host realization confirmation id')
  );
}

export function hostRealizationConsumptionStatePath(root, consumptionId) {
  return stateFile(
    root,
    'host-realization-consumptions',
    safeId(consumptionId, 'host realization consumption id')
  );
}

export function hostRealizationCheckpointStatePath(root, checkpointId) {
  return stateFile(
    root,
    'host-realization-checkpoints',
    safeId(checkpointId, 'host realization checkpoint id')
  );
}

export function hostManagedManifestStatePath(root, hostId) {
  return stateFile(root, 'host-projections', safeId(hostId, 'host projection id'));
}

export function packInstallPlanStatePath(root, planId) {
  return stateFile(root, 'pack-install-plans', safeId(planId, 'pack install plan id'));
}

export function packInstallRequestStatePath(root, requestId) {
  return stateFile(root, 'pack-install-requests', safeId(requestId, 'pack install request id'));
}

export function packInstallConfirmationStatePath(root, confirmationId) {
  return stateFile(
    root,
    'pack-install-confirmations',
    safeId(confirmationId, 'pack install confirmation id')
  );
}

export function packInstallConsumptionStatePath(root, consumptionId) {
  return stateFile(
    root,
    'pack-install-consumptions',
    safeId(consumptionId, 'pack install consumption id')
  );
}

export function packInstallCheckpointStatePath(root, checkpointId) {
  return stateFile(
    root,
    'pack-install-checkpoints',
    safeId(checkpointId, 'pack install checkpoint id')
  );
}

export function packInstallManagedManifestStatePath(root) {
  return stateFile(root, 'pack-install-manifests', 'managed');
}

export function activeConfigurationLockStatePath(root, configurationName) {
  return stateFile(
    root,
    'configuration-locks',
    safeId(configurationName, 'active configuration lock name')
  );
}

export function hasHostCallCheckpoint(root, checkpointId) {
  return fs.existsSync(hostCallCheckpointPath(root, checkpointId));
}

export function hasRunState(root, runId) {
  return fs.existsSync(runStatePath(root, runId));
}

export function hasContextSnapshotState(root, snapshotId) {
  return fs.existsSync(contextSnapshotStatePath(root, snapshotId));
}

export function hasAutomationDecisionState(root, decisionId) {
  return fs.existsSync(automationDecisionStatePath(root, decisionId));
}

export function hasAutomationProposalState(root, proposalId) {
  return fs.existsSync(automationProposalStatePath(root, proposalId));
}

export function hasAutomationProposalMaterialState(root, proposalId) {
  return fs.existsSync(automationProposalMaterialStatePath(root, proposalId));
}

export function hasApprovalRequestState(root, requestId) {
  return fs.existsSync(approvalRequestStatePath(root, requestId));
}

export function hasConnectedApprovalState(root, approvalId) {
  return fs.existsSync(connectedApprovalStatePath(root, approvalId));
}

export function hasApprovalConsumptionState(root, consumptionId) {
  return fs.existsSync(approvalConsumptionStatePath(root, consumptionId));
}

export function hasPreparedWorkState(root, workId) {
  return fs.existsSync(preparedWorkStatePath(root, workId));
}

export function hasPreparedWorkReviewMaterialState(root, workId) {
  return fs.existsSync(preparedWorkReviewMaterialStatePath(root, workId));
}

export function hasPreparedWorkDerivedReviewMaterialState(root, workId) {
  return fs.existsSync(preparedWorkDerivedReviewMaterialStatePath(root, workId));
}

export function hasPreparedReviewBatchState(root, batchId) {
  return fs.existsSync(preparedReviewBatchStatePath(root, batchId));
}

export function hasPreparedConnectedPlanState(root, planId) {
  return fs.existsSync(preparedConnectedPlanStatePath(root, planId));
}

export function hasConfigurationChangePlanState(root, planId) {
  return fs.existsSync(configurationChangePlanStatePath(root, planId));
}

export function hasConfigurationChangeRequestState(root, requestId) {
  return fs.existsSync(configurationChangeRequestStatePath(root, requestId));
}

export function hasConfigurationChangeConfirmationState(root, confirmationId) {
  return fs.existsSync(configurationChangeConfirmationStatePath(root, confirmationId));
}

export function hasConfigurationChangeConsumptionState(root, consumptionId) {
  return fs.existsSync(configurationChangeConsumptionStatePath(root, consumptionId));
}

export function hasConfigurationTransactionCheckpointState(root, checkpointId) {
  return fs.existsSync(configurationTransactionCheckpointStatePath(root, checkpointId));
}

export function hasHostRealizationPlanState(root, planId) {
  return fs.existsSync(hostRealizationPlanStatePath(root, planId));
}

export function hasHostRealizationRequestState(root, requestId) {
  return fs.existsSync(hostRealizationRequestStatePath(root, requestId));
}

export function hasHostRealizationConfirmationState(root, confirmationId) {
  return fs.existsSync(hostRealizationConfirmationStatePath(root, confirmationId));
}

export function hasHostRealizationConsumptionState(root, consumptionId) {
  return fs.existsSync(hostRealizationConsumptionStatePath(root, consumptionId));
}

export function hasHostRealizationCheckpointState(root, checkpointId) {
  return fs.existsSync(hostRealizationCheckpointStatePath(root, checkpointId));
}

export function hasHostManagedManifestState(root, hostId) {
  return fs.existsSync(hostManagedManifestStatePath(root, hostId));
}

export function hasPackInstallPlanState(root, planId) {
  return fs.existsSync(packInstallPlanStatePath(root, planId));
}

export function hasPackInstallRequestState(root, requestId) {
  return fs.existsSync(packInstallRequestStatePath(root, requestId));
}

export function hasPackInstallConfirmationState(root, confirmationId) {
  return fs.existsSync(packInstallConfirmationStatePath(root, confirmationId));
}

export function hasPackInstallConsumptionState(root, consumptionId) {
  return fs.existsSync(packInstallConsumptionStatePath(root, consumptionId));
}

export function hasPackInstallCheckpointState(root, checkpointId) {
  return fs.existsSync(packInstallCheckpointStatePath(root, checkpointId));
}

export function hasPackInstallManagedManifestState(root) {
  return fs.existsSync(packInstallManagedManifestStatePath(root));
}

export function hasActiveConfigurationLockState(root, configurationName) {
  return fs.existsSync(activeConfigurationLockStatePath(root, configurationName));
}

export function readRunState(root, runId) {
  const file = runStatePath(root, runId);
  if (!fs.existsSync(file)) throw new Error('Durable run state does not exist: ' + runId + '.');
  return { file, run: readJson(file) };
}

export function writeRunState(root, run) {
  const file = runStatePath(root, run.id);
  atomicWriteJson(file, run);
  return { file, path: repoRelativePath(root, file) };
}

export function readContextSnapshotState(root, snapshotId) {
  const file = contextSnapshotStatePath(root, snapshotId);
  if (!fs.existsSync(file)) {
    throw new Error('Durable context snapshot does not exist: ' + snapshotId + '.');
  }
  return { file, snapshot: readJson(file) };
}

export function writeContextSnapshotState(root, snapshot) {
  const file = contextSnapshotStatePath(root, snapshot.id);
  atomicWriteJson(file, snapshot);
  return { file, path: repoRelativePath(root, file) };
}

export function readAutomationDecisionState(root, decisionId) {
  const file = automationDecisionStatePath(root, decisionId);
  if (!fs.existsSync(file)) {
    throw new Error('Durable automation decision does not exist: ' + decisionId + '.');
  }
  return { file, decision: readJson(file) };
}

export function writeAutomationDecisionState(root, decision) {
  const file = automationDecisionStatePath(root, decision.id);
  atomicWriteJson(file, decision);
  return { file, path: repoRelativePath(root, file) };
}

export function readAutomationProposalState(root, proposalId) {
  const file = automationProposalStatePath(root, proposalId);
  if (!fs.existsSync(file)) {
    throw new Error('Durable automation proposal does not exist: ' + proposalId + '.');
  }
  return { file, proposal: readJson(file) };
}

export function createAutomationProposalState(root, proposal) {
  const file = automationProposalStatePath(root, proposal.id);
  atomicCreateJson(file, proposal);
  return { file, path: repoRelativePath(root, file) };
}

export function readAutomationProposalMaterialState(root, proposalId) {
  const file = automationProposalMaterialStatePath(root, proposalId);
  if (!fs.existsSync(file)) {
    throw new Error('Durable automation proposal material does not exist: ' + proposalId + '.');
  }
  return { file, material: readJson(file) };
}

export function createAutomationProposalMaterialState(root, material) {
  const file = automationProposalMaterialStatePath(root, material.proposal.id);
  atomicCreateJson(file, material);
  return { file, path: repoRelativePath(root, file) };
}

export function readApprovalRequestState(root, requestId) {
  const file = approvalRequestStatePath(root, requestId);
  if (!fs.existsSync(file)) {
    throw new Error('Durable approval request does not exist: ' + requestId + '.');
  }
  return { file, request: readJson(file) };
}

export function writeApprovalRequestState(root, request) {
  const file = approvalRequestStatePath(root, request.id);
  atomicCreateJson(file, request);
  return { file, path: repoRelativePath(root, file) };
}

export function readConnectedApprovalState(root, approvalId) {
  const file = connectedApprovalStatePath(root, approvalId);
  if (!fs.existsSync(file)) {
    throw new Error('Durable connected approval does not exist: ' + approvalId + '.');
  }
  return { file, approval: readJson(file) };
}

export function writeConnectedApprovalState(root, approval) {
  const file = connectedApprovalStatePath(root, approval.id);
  atomicCreateJson(file, approval);
  return { file, path: repoRelativePath(root, file) };
}

export function readApprovalConsumptionState(root, consumptionId) {
  const file = approvalConsumptionStatePath(root, consumptionId);
  if (!fs.existsSync(file)) {
    throw new Error('Durable approval consumption does not exist: ' + consumptionId + '.');
  }
  return { file, consumption: readJson(file) };
}

export function createApprovalConsumptionState(root, consumption) {
  const file = approvalConsumptionStatePath(root, consumption.id);
  atomicCreateJson(file, consumption);
  return { file, path: repoRelativePath(root, file) };
}

export function writeApprovalConsumptionState(root, consumption) {
  const file = approvalConsumptionStatePath(root, consumption.id);
  atomicWriteJson(file, consumption);
  return { file, path: repoRelativePath(root, file) };
}

export function readPreparedWorkState(root, workId) {
  const file = preparedWorkStatePath(root, workId);
  if (!fs.existsSync(file)) throw new Error('Durable prepared work does not exist: ' + workId + '.');
  return { file, work: readJson(file) };
}

export function writePreparedWorkState(root, work) {
  const file = preparedWorkStatePath(root, work.id);
  atomicWriteJson(file, work);
  return { file, path: repoRelativePath(root, file) };
}

export function writePreparedWorkEvidenceState(root, evidence) {
  const file = preparedWorkEvidenceStatePath(root, evidence.id);
  atomicWriteJson(file, evidence);
  return { file, path: repoRelativePath(root, file) };
}

export function readPreparedWorkReviewMaterialState(root, workId) {
  const file = preparedWorkReviewMaterialStatePath(root, workId);
  if (!fs.existsSync(file)) {
    throw new Error('Durable prepared-work review material does not exist: ' + workId + '.');
  }
  return { file, material: readJson(file) };
}

export function createPreparedWorkReviewMaterialState(root, material) {
  const file = preparedWorkReviewMaterialStatePath(root, material.workId);
  atomicCreateJson(file, material);
  return { file, path: repoRelativePath(root, file) };
}

export function readPreparedWorkDerivedReviewMaterialState(root, workId) {
  const file = preparedWorkDerivedReviewMaterialStatePath(root, workId);
  if (!fs.existsSync(file)) {
    throw new Error('Durable prepared-work derived review material does not exist: ' + workId + '.');
  }
  return { file, material: readJson(file) };
}

export function createPreparedWorkDerivedReviewMaterialState(root, material) {
  const file = preparedWorkDerivedReviewMaterialStatePath(root, material.workId);
  atomicCreateJson(file, material);
  return { file, path: repoRelativePath(root, file) };
}

export function readPreparedReviewBatchState(root, batchId) {
  const file = preparedReviewBatchStatePath(root, batchId);
  if (!fs.existsSync(file)) {
    throw new Error('Durable prepared review batch does not exist: ' + batchId + '.');
  }
  return { file, batch: readJson(file) };
}

export function createPreparedReviewBatchState(root, batch) {
  const file = preparedReviewBatchStatePath(root, batch.id);
  atomicCreateJson(file, batch);
  return { file, path: repoRelativePath(root, file) };
}

export function readPreparedConnectedPlanState(root, planId) {
  const file = preparedConnectedPlanStatePath(root, planId);
  if (!fs.existsSync(file)) {
    throw new Error('Durable prepared connected plan does not exist: ' + planId + '.');
  }
  return { file, plan: readJson(file) };
}

export function createPreparedConnectedPlanState(root, plan) {
  const file = preparedConnectedPlanStatePath(root, plan.id);
  atomicCreateJson(file, plan);
  return { file, path: repoRelativePath(root, file) };
}

function readRequiredState(file, label, id, property) {
  if (!fs.existsSync(file)) throw new Error(label + ' does not exist: ' + id + '.');
  return { file, [property]: readJson(file) };
}

export function readConfigurationChangePlanState(root, planId) {
  const file = configurationChangePlanStatePath(root, planId);
  return readRequiredState(file, 'Durable configuration change plan', planId, 'plan');
}

export function createConfigurationChangePlanState(root, plan) {
  const file = configurationChangePlanStatePath(root, plan.id);
  atomicCreateJson(file, plan);
  return { file, path: repoRelativePath(root, file) };
}

export function readConfigurationChangeRequestState(root, requestId) {
  const file = configurationChangeRequestStatePath(root, requestId);
  return readRequiredState(file, 'Durable configuration change request', requestId, 'request');
}

export function createConfigurationChangeRequestState(root, request) {
  const file = configurationChangeRequestStatePath(root, request.id);
  atomicCreateJson(file, request);
  return { file, path: repoRelativePath(root, file) };
}

export function readConfigurationChangeConfirmationState(root, confirmationId) {
  const file = configurationChangeConfirmationStatePath(root, confirmationId);
  return readRequiredState(
    file,
    'Durable configuration change confirmation',
    confirmationId,
    'confirmation'
  );
}

export function createConfigurationChangeConfirmationState(root, confirmation) {
  const file = configurationChangeConfirmationStatePath(root, confirmation.id);
  atomicCreateJson(file, confirmation);
  return { file, path: repoRelativePath(root, file) };
}

export function readConfigurationChangeConsumptionState(root, consumptionId) {
  const file = configurationChangeConsumptionStatePath(root, consumptionId);
  return readRequiredState(
    file,
    'Durable configuration change consumption',
    consumptionId,
    'consumption'
  );
}

export function createConfigurationChangeConsumptionState(root, consumption) {
  const file = configurationChangeConsumptionStatePath(root, consumption.id);
  atomicCreateJson(file, consumption);
  return { file, path: repoRelativePath(root, file) };
}

export function writeConfigurationChangeConsumptionState(root, consumption) {
  const file = configurationChangeConsumptionStatePath(root, consumption.id);
  atomicWriteJson(file, consumption);
  return { file, path: repoRelativePath(root, file) };
}

export function readConfigurationTransactionCheckpointState(root, checkpointId) {
  const file = configurationTransactionCheckpointStatePath(root, checkpointId);
  return readRequiredState(
    file,
    'Durable configuration transaction checkpoint',
    checkpointId,
    'checkpoint'
  );
}

export function createConfigurationTransactionCheckpointState(root, checkpoint) {
  const file = configurationTransactionCheckpointStatePath(root, checkpoint.id);
  atomicCreateJson(file, checkpoint);
  return { file, path: repoRelativePath(root, file) };
}

export function writeConfigurationTransactionCheckpointState(root, checkpoint) {
  const file = configurationTransactionCheckpointStatePath(root, checkpoint.id);
  atomicWriteJson(file, checkpoint);
  return { file, path: repoRelativePath(root, file) };
}

export function readActiveConfigurationLockState(root, configurationName) {
  const file = activeConfigurationLockStatePath(root, configurationName);
  return readRequiredState(file, 'Active configuration lock', configurationName, 'lock');
}

export function writeActiveConfigurationLockState(root, configurationName, lock) {
  const file = activeConfigurationLockStatePath(root, configurationName);
  atomicWriteJson(file, lock);
  return { file, path: repoRelativePath(root, file) };
}

export function removeActiveConfigurationLockState(root, configurationName) {
  const file = activeConfigurationLockStatePath(root, configurationName);
  if (fs.existsSync(file)) fs.rmSync(file);
  return { file, path: repoRelativePath(root, file) };
}

export function readHostRealizationPlanState(root, planId) {
  const file = hostRealizationPlanStatePath(root, planId);
  return readRequiredState(file, 'Durable host realization plan', planId, 'plan');
}

export function createHostRealizationPlanState(root, plan) {
  const file = hostRealizationPlanStatePath(root, plan.id);
  atomicCreateJson(file, plan);
  return { file, path: repoRelativePath(root, file) };
}

export function readHostRealizationRequestState(root, requestId) {
  const file = hostRealizationRequestStatePath(root, requestId);
  return readRequiredState(file, 'Durable host realization request', requestId, 'request');
}

export function createHostRealizationRequestState(root, request) {
  const file = hostRealizationRequestStatePath(root, request.id);
  atomicCreateJson(file, request);
  return { file, path: repoRelativePath(root, file) };
}

export function readHostRealizationConfirmationState(root, confirmationId) {
  const file = hostRealizationConfirmationStatePath(root, confirmationId);
  return readRequiredState(file, 'Durable host realization confirmation', confirmationId, 'confirmation');
}

export function createHostRealizationConfirmationState(root, confirmation) {
  const file = hostRealizationConfirmationStatePath(root, confirmation.id);
  atomicCreateJson(file, confirmation);
  return { file, path: repoRelativePath(root, file) };
}

export function readHostRealizationConsumptionState(root, consumptionId) {
  const file = hostRealizationConsumptionStatePath(root, consumptionId);
  return readRequiredState(file, 'Durable host realization consumption', consumptionId, 'consumption');
}

export function createHostRealizationConsumptionState(root, consumption) {
  const file = hostRealizationConsumptionStatePath(root, consumption.id);
  atomicCreateJson(file, consumption);
  return { file, path: repoRelativePath(root, file) };
}

export function writeHostRealizationConsumptionState(root, consumption) {
  const file = hostRealizationConsumptionStatePath(root, consumption.id);
  atomicWriteJson(file, consumption);
  return { file, path: repoRelativePath(root, file) };
}

export function readHostRealizationCheckpointState(root, checkpointId) {
  const file = hostRealizationCheckpointStatePath(root, checkpointId);
  return readRequiredState(file, 'Durable host realization checkpoint', checkpointId, 'checkpoint');
}

export function createHostRealizationCheckpointState(root, checkpoint) {
  const file = hostRealizationCheckpointStatePath(root, checkpoint.id);
  atomicCreateJson(file, checkpoint);
  return { file, path: repoRelativePath(root, file) };
}

export function writeHostRealizationCheckpointState(root, checkpoint) {
  const file = hostRealizationCheckpointStatePath(root, checkpoint.id);
  atomicWriteJson(file, checkpoint);
  return { file, path: repoRelativePath(root, file) };
}

export function readHostManagedManifestState(root, hostId) {
  const file = hostManagedManifestStatePath(root, hostId);
  return readRequiredState(file, 'Managed host projection manifest', hostId, 'manifest');
}

export function writeHostManagedManifestState(root, manifest) {
  const file = hostManagedManifestStatePath(root, manifest.host);
  atomicWriteJson(file, manifest);
  return { file, path: repoRelativePath(root, file) };
}

export function removeHostManagedManifestState(root, hostId) {
  const file = hostManagedManifestStatePath(root, hostId);
  if (fs.existsSync(file)) fs.rmSync(file);
  return { file, path: repoRelativePath(root, file) };
}

export function readPackInstallPlanState(root, planId) {
  const file = packInstallPlanStatePath(root, planId);
  return readRequiredState(file, 'Durable pack install plan', planId, 'plan');
}

export function createPackInstallPlanState(root, plan) {
  const file = packInstallPlanStatePath(root, plan.id);
  atomicCreateJson(file, plan);
  return { file, path: repoRelativePath(root, file) };
}

export function readPackInstallRequestState(root, requestId) {
  const file = packInstallRequestStatePath(root, requestId);
  return readRequiredState(file, 'Durable pack install request', requestId, 'request');
}

export function createPackInstallRequestState(root, request) {
  const file = packInstallRequestStatePath(root, request.id);
  atomicCreateJson(file, request);
  return { file, path: repoRelativePath(root, file) };
}

export function readPackInstallConfirmationState(root, confirmationId) {
  const file = packInstallConfirmationStatePath(root, confirmationId);
  return readRequiredState(file, 'Durable pack install confirmation', confirmationId, 'confirmation');
}

export function createPackInstallConfirmationState(root, confirmation) {
  const file = packInstallConfirmationStatePath(root, confirmation.id);
  atomicCreateJson(file, confirmation);
  return { file, path: repoRelativePath(root, file) };
}

export function readPackInstallConsumptionState(root, consumptionId) {
  const file = packInstallConsumptionStatePath(root, consumptionId);
  return readRequiredState(file, 'Durable pack install consumption', consumptionId, 'consumption');
}

export function createPackInstallConsumptionState(root, consumption) {
  const file = packInstallConsumptionStatePath(root, consumption.id);
  atomicCreateJson(file, consumption);
  return { file, path: repoRelativePath(root, file) };
}

export function writePackInstallConsumptionState(root, consumption) {
  const file = packInstallConsumptionStatePath(root, consumption.id);
  atomicWriteJson(file, consumption);
  return { file, path: repoRelativePath(root, file) };
}

export function readPackInstallCheckpointState(root, checkpointId) {
  const file = packInstallCheckpointStatePath(root, checkpointId);
  return readRequiredState(file, 'Durable pack install checkpoint', checkpointId, 'checkpoint');
}

export function createPackInstallCheckpointState(root, checkpoint) {
  const file = packInstallCheckpointStatePath(root, checkpoint.id);
  atomicCreateJson(file, checkpoint);
  return { file, path: repoRelativePath(root, file) };
}

export function writePackInstallCheckpointState(root, checkpoint) {
  const file = packInstallCheckpointStatePath(root, checkpoint.id);
  atomicWriteJson(file, checkpoint);
  return { file, path: repoRelativePath(root, file) };
}

export function readPackInstallManagedManifestState(root) {
  const file = packInstallManagedManifestStatePath(root);
  return readRequiredState(file, 'Managed pack install manifest', 'managed', 'manifest');
}

export function writePackInstallManagedManifestState(root, manifest) {
  const file = packInstallManagedManifestStatePath(root);
  atomicWriteJson(file, manifest);
  return { file, path: repoRelativePath(root, file) };
}

export function removePackInstallManagedManifestState(root) {
  const file = packInstallManagedManifestStatePath(root);
  if (fs.existsSync(file)) fs.rmSync(file);
  return { file, path: repoRelativePath(root, file) };
}

export function listHostManagedManifestDocuments(root) {
  const directory = resolveRepoPath(root, path.join(STATE_ROOT, 'host-projections'));
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      return { file, manifest: readJson(file) };
    })
    .sort((left, right) => left.manifest.host.localeCompare(right.manifest.host, 'en'));
}

export function listPreparedWorkDocuments(root) {
  const directory = resolveRepoPath(root, path.join(STATE_ROOT, 'prepared-work'));
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      return { file, work: readJson(file) };
    })
    .sort((left, right) => left.work.id.localeCompare(right.work.id, 'en'));
}

export function listConnectedApprovalDocuments(root) {
  const directory = resolveRepoPath(root, path.join(STATE_ROOT, 'approvals'));
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      return { file, approval: readJson(file) };
    })
    .sort((left, right) => left.approval.id.localeCompare(right.approval.id, 'en'));
}

export function readHostCallCheckpoint(root, checkpointId) {
  const file = hostCallCheckpointPath(root, checkpointId);
  if (!fs.existsSync(file)) {
    throw new Error('Durable host call checkpoint does not exist: ' + checkpointId + '.');
  }
  return { file, checkpoint: readJson(file) };
}

export function writeHostCallCheckpoint(root, checkpoint) {
  const file = hostCallCheckpointPath(root, checkpoint.id);
  atomicWriteJson(file, checkpoint);
  return { file, path: repoRelativePath(root, file) };
}

export function listHostCallCheckpointDocuments(root) {
  const directory = resolveRepoPath(root, path.join(STATE_ROOT, 'host-calls'));
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      return { file, checkpoint: readJson(file) };
    })
    .sort((left, right) => left.checkpoint.id.localeCompare(right.checkpoint.id, 'en'));
}
