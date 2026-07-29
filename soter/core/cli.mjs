#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workflowEvidenceBasisForPath } from '../kernel/workflow-evidence-bases.mjs';
import { formatDoctorReport, runConnectedDoctor, runOfflineDoctor } from './doctor.mjs';
import {
  finalizeMeetingIntakeConnectedContext,
  prepareMeetingIntakeConnectedContext
} from '../automations/meeting-intake/context.mjs';
import {
  finalizeEmailTriageConnectedAcquisition,
  prepareEmailTriageConnectedAcquisition
} from '../automations/email-triage/context.mjs';
import {
  finalizeTaskCaptureConnectedAcquisition,
  prepareTaskCaptureConnectedAcquisition
} from '../automations/task-capture/context.mjs';
import {
  finalizeOrganizationCaptureConnectedAcquisition,
  prepareOrganizationCaptureConnectedAcquisition
} from '../automations/organization-capture/context.mjs';
import {
  finalizeProjectCaptureConnectedAcquisition,
  prepareProjectCaptureConnectedAcquisition
} from '../automations/project-capture/context.mjs';
import {
  finalizeContactCaptureConnectedAcquisition,
  prepareContactCaptureConnectedAcquisition
} from '../automations/contact-capture/context.mjs';
import {
  finalizeProjectPulseConnectedAcquisition,
  prepareProjectPulseConnectedAcquisition
} from '../automations/project-pulse/context.mjs';
import {
  finalizeSlackConversationReviewConnectedAcquisition,
  inspectSlackConversationReviewConnected,
  inspectSlackConversationReviewConnectedPrivateReview,
  prepareSlackConversationReviewConnectedAcquisition
} from '../automations/slack-conversation-review/context.mjs';
import {
  commitMeetingIntakeDecision,
  inspectMeetingIntakeDecisionContext
} from '../automations/meeting-intake/decision.mjs';
import {
  commitEmailTriageDecision,
  inspectEmailTriageDecisionContext
} from '../automations/email-triage/decision.mjs';
import {
  commitTaskCaptureDecision,
  inspectTaskCaptureDecisionContext
} from '../automations/task-capture/decision.mjs';
import {
  commitOrganizationCaptureDecision,
  inspectOrganizationCaptureDecisionContext
} from '../automations/organization-capture/decision.mjs';
import {
  commitProjectCaptureDecision,
  inspectProjectCaptureDecisionContext
} from '../automations/project-capture/decision.mjs';
import {
  commitContactCaptureDecision,
  inspectContactCaptureDecisionContext
} from '../automations/contact-capture/decision.mjs';
import {
  commitProjectPulseDecision,
  inspectProjectPulseDecisionContext
} from '../automations/project-pulse/decision.mjs';
import {
  commitEmailTriageProposal,
  inspectEmailTriageProposalDecision,
  inspectEmailTriageProposalMaterial
} from '../automations/email-triage/proposal.mjs';
import {
  commitTaskCaptureProposal,
  inspectTaskCaptureProposalDecision,
  inspectTaskCaptureProposalMaterial
} from '../automations/task-capture/proposal.mjs';
import {
  commitOrganizationCaptureProposal,
  inspectOrganizationCaptureProposalDecision,
  inspectOrganizationCaptureProposalMaterial
} from '../automations/organization-capture/proposal.mjs';
import {
  commitProjectCaptureProposal,
  inspectProjectCaptureProposalDecision,
  inspectProjectCaptureProposalMaterial
} from '../automations/project-capture/proposal.mjs';
import {
  commitContactCaptureProposal,
  inspectContactCaptureProposalDecision,
  inspectContactCaptureProposalMaterial
} from '../automations/contact-capture/proposal.mjs';
import {
  commitProjectPulseProposal,
  inspectProjectPulseProposalDecision,
  inspectProjectPulseProposalMaterial
} from '../automations/project-pulse/proposal.mjs';
import {
  commitMeetingIntakeProposal,
  inspectMeetingIntakeProposalDecision,
  inspectMeetingIntakeProposalMaterial
} from '../automations/meeting-intake/proposal.mjs';
import {
  createResolutionEvidence,
  createRunPreparationEvidence
} from './evidence.mjs';
import {
  checkSoterFixtures,
  writeLegacyFinalizationFixtures,
  writeSoterFixtures
} from './fixtures.mjs';
import {
  buildConfigurationView,
  formatConfigurationView
} from './configuration-view.mjs';
import {
  readJson,
  readPrivateJsonInput,
  repoRelativePath,
  resolveRepoPath,
  writeJson
} from './lib/canonical-json.mjs';
import {
  readLegacyFinalizationFixtureRequest
} from './legacy-finalization.mjs';
import {
  inspectLegacyCheckerRunProjection,
  inspectLegacyCheckerRunReceipt
} from '../kernel/legacy-checker-run.mjs';
import {
  fingerprintLock,
  lockMatchesResolution,
  resolveConfiguration
} from './resolve.mjs';
import { prepareRunEnvelope } from './run.mjs';
import {
  completeDurableCapabilityExecution,
  completeDurableConnectedTransactionExecution,
  completeDurableOperationPlanExecution,
  completeDurableProviderProbeExecution,
  failDurableHostExecution,
  getDurableHostExecution,
  getDurableProviderProbeObservation,
  listDurableHostExecutions,
  prepareDurableConnectedTransactionExecution,
  prepareDurableConnectedTransactionReconciliation,
  prepareDurableProviderProbeExecution
} from './service.mjs';
import {
  beginProposalConnectedApprovalRequest,
  confirmProposalConnectedApprovalRequest
} from './operator-authority.mjs';
import { createProposalConnectedBatch } from './proposal-connected-batches.mjs';
import { inspectConnectedApprovalReviewMaterial } from './connected-approval-review.mjs';
import { inspectConnectedOperatorActivity } from './operator-inspection.mjs';
import { inspectConnectedAcceptance } from './connected-acceptance-inspection.mjs';
import {
  inspectPreparedAutomationDerivedReviewMaterial,
  inspectPreparedAutomationReviewMaterial,
  inspectPreparedAutomationWork,
  prepareAutomationRun
} from './prepared-work.mjs';
import {
  createPreparedReviewBatch,
  inspectPreparedReviewBatchMaterial
} from './prepared-review-batches.mjs';
import {
  createPreparedConnectedPlan,
  inspectPreparedConnectedPlan
} from './prepared-connected-plans.mjs';
import {
  beginConfigurationChangeRequest,
  confirmConfigurationChangeRequest,
  executeConfigurationChange,
  inspectConfigurationChange,
  prepareConfigurationChange,
  prepareConfigurationChangeExecution,
  recoverConfigurationChange
} from './configuration-transactions.mjs';
import {
  beginHostRealizationRequest,
  confirmHostRealizationRequest,
  executeHostRealization,
  inspectHostRealization,
  prepareHostRealization,
  prepareHostRealizationExecution,
  recoverHostRealization
} from './host-realizations.mjs';
import {
  beginPackInstallRequest,
  confirmPackInstallRequest,
  executePackInstall,
  inspectPackInstall,
  preparePackInstall,
  preparePackInstallExecution,
  recoverPackInstall
} from './pack-installs.mjs';
import {
  buildDevelopmentEvaluationInvocation,
  inspectDevelopmentRun,
  prepareDevelopmentRequest,
  recordDevelopmentResult
} from './development-runs.mjs';
import { materializeDevelopmentCandidateLock } from './development-candidate-locks.mjs';
import {
  finalizeDevelopmentHostEvaluation,
  runDevelopmentHostEvaluation,
  runDevelopmentHostJudgment
} from './development-host-runner.mjs';
import {
  buildDevelopmentHistoricalEvidenceBatchRequest,
  executeDevelopmentHistoricalEvidenceBatch,
  inspectDevelopmentHistoricalEvidenceBatch,
  recoverDevelopmentHistoricalEvidenceBatch
} from './development-historical-evidence-batch.mjs';
import {
  buildDevelopmentHostEvidenceFinalizationRequest,
  finalizeDevelopmentHostEvidenceBatch,
  rollbackCompletedDevelopmentHostEvidenceFinalization,
  verifyDevelopmentHostEvidenceFinalization
} from './development-host-evidence-finalization.mjs';
import {
  buildDevelopmentWorkflowLifecycleFinalizationRequest,
  planDevelopmentWorkflowLifecycleFinalization
} from './development-workflow-lifecycle-finalization.mjs';
import {
  buildRepositoryCutoverRequest,
  executeRepositoryCutover,
  inspectRepositoryCutover,
  prepareRepositoryCutover,
  recoverRepositoryCutover,
  rollbackRepositoryCutover
} from './repository-cutover.mjs';
import {
  buildLegacyFinalizationTransitionRequest
} from './legacy-transition-finalization.mjs';
import {
  persistCanonicalPrivateRequest
} from './private-request-files.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(name + ' requires a value.');
  }
  return args[index + 1];
}

function options(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    if (!args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error(name + ' requires a value.');
    }
    values.push(args[index + 1]);
  }
  return values;
}

function requiredOption(args, name) {
  const value = option(args, name);
  if (!value) throw new Error('Missing required option ' + name + '.');
  return value;
}

function assertExactCommandArguments(args, {
  valueOptions = [],
  flagOptions = [],
  repeatableValueOptions = []
}) {
  const repeatableValues = new Set(repeatableValueOptions);
  const allowedValues = new Set(['--root', ...valueOptions, ...repeatableValues]);
  const allowedFlags = new Set(['--json', ...flagOptions]);
  const observed = new Set();
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (allowedFlags.has(argument)) {
      if (observed.has(argument)) throw new Error('Duplicate option ' + argument + '.');
      observed.add(argument);
      continue;
    }
    if (allowedValues.has(argument)) {
      if (observed.has(argument) && !repeatableValues.has(argument)) {
        throw new Error('Duplicate option ' + argument + '.');
      }
      observed.add(argument);
      if (!args[index + 1] || args[index + 1].startsWith('--')) {
        throw new Error(argument + ' requires a value.');
      }
      index += 1;
      continue;
    }
    throw new Error('Unexpected argument for ' + args[0] + ': ' + argument + '.');
  }
}

function nowIdPart(createdAt) {
  return createdAt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function writeEvidence(root, directory, records) {
  if (!directory) return;
  const targetDirectory = resolveRepoPath(root, directory);
  for (const record of records) {
    writeJson(path.join(targetDirectory, record.id + '.json'), record);
  }
}

function readDocumentInput(root, requestedPath) {
  return path.isAbsolute(requestedPath)
    ? readPrivateJsonInput(root, requestedPath)
    : readJson(resolveRepoPath(root, requestedPath));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const root = path.resolve(option(args, '--root', defaultRoot));
  const json = args.includes('--json');
  const createdAt = option(args, '--at', new Date().toISOString());
  const idPart = nowIdPart(createdAt);

  if (command === 'legacy-checker-receipt-inspect') {
    assertExactCommandArguments(args, { valueOptions: ['--receipt-id'] });
    const receiptId = requiredOption(args, '--receipt-id');
    const result = inspectLegacyCheckerRunReceipt({ root, receiptId });
    if (json) print(result);
    else process.stdout.write(
      'Inspected historical legacy checker receipt ' + result.receipt.id + '.\n'
        + 'Receipt fingerprint: ' + result.receipt.receiptFingerprint + '\n'
        + 'Checker-visible tree: '
          + result.receipt.basis.checkerVisibleInputTree.treeFingerprint + '\n'
        + 'Migration or fallback-removal authority: none\n'
    );
    return;
  }

  if (command === 'legacy-checker-projection-inspect') {
    assertExactCommandArguments(args, {});
    const projection = inspectLegacyCheckerRunProjection({ root });
    if (json) print(projection);
    else process.stdout.write(
      'Inspected governed sanitized legacy checker projection ' + projection.id + '.\n'
        + 'Projection fingerprint: ' + projection.projectionFingerprint + '\n'
        + 'Receipt fingerprint: ' + projection.receipt.fingerprint + '\n'
        + 'Checker-visible tree: '
          + projection.basis.checkerVisibleInputTree.treeFingerprint + '\n'
        + 'Private receipt path or raw output included: no\n'
        + 'Migration or fallback-removal authority: none\n'
    );
    return;
  }

  if (command === 'resolve') {
    const configPath = option(args, '--config');
    const host = option(args, '--host');
    const lock = resolveConfiguration({ root, configPath, host });
    const output = option(args, '--output');
    if (output) writeJson(resolveRepoPath(root, output), lock);
    if (json) {
      print(lock);
    } else {
      process.stdout.write(
        'Resolved ' + lock.configuration.name + ' for ' + lock.host.id
          + ' to ' + lock.packs.length + ' packs.\n'
          + 'Lock: ' + fingerprintLock(lock) + '\n'
          + (output ? 'Wrote: ' + output + '\n' : '')
      );
    }
    return;
  }

  if (command === 'config-inspect') {
    const configPath = option(args, '--config');
    const host = option(args, '--host');
    const lockPath = option(args, '--lock');
    if (lockPath && (configPath || host)) {
      throw new Error('config-inspect accepts either --lock or configuration/host selection, not both.');
    }
    let lock;
    let basis;
    if (lockPath) {
      lock = readJson(resolveRepoPath(root, lockPath));
      const exact = lockMatchesResolution({ lock, root });
      if (!exact.matches) {
        throw new Error(
          'Configuration lock is stale: expected ' + fingerprintLock(exact.expected)
            + ' but observed ' + fingerprintLock(lock) + '.'
        );
      }
      basis = 'lock';
    } else {
      lock = resolveConfiguration({ root, configPath, host });
      basis = 'configuration';
    }
    const view = buildConfigurationView({ root, lock, basis });
    const output = option(args, '--output');
    if (output) writeJson(resolveRepoPath(root, output), view);
    if (json) {
      print(view);
    } else {
      process.stdout.write(formatConfigurationView(view));
      if (output) process.stdout.write('Wrote: ' + output + '\n');
    }
    return;
  }

  if (command === 'configuration-change-plan') {
    const name = requiredOption(args, '--configuration');
    const planId = option(args, '--plan-id', 'configuration-change-plan.' + name + '.' + idPart);
    const candidateConfiguration = readPrivateJsonInput(root, requiredOption(args, '--candidate'));
    prepareConfigurationChange({
      root,
      name,
      candidateConfiguration,
      id: planId,
      createdAt
    });
    const inspection = inspectConfigurationChange({ root, planId, at: createdAt });
    if (json) {
      print(inspection);
    } else {
      process.stdout.write(
        'Prepared exact private configuration plan ' + planId + '.\n'
          + 'Candidate lock: ' + inspection.configuration.candidateLockFingerprint + '\n'
          + 'Changed subjects: ' + inspection.scope.changes.length + '\n'
          + 'Execution authority created: no\n'
      );
    }
    return;
  }

  if (command === 'configuration-change-request') {
    const planId = requiredOption(args, '--plan-id');
    const requestId = option(args, '--request-id', 'configuration-change-request.' + idPart);
    beginConfigurationChangeRequest({
      root,
      planId,
      id: requestId,
      reason: requiredOption(args, '--reason'),
      createdAt,
      expiresAt: requiredOption(args, '--expires-at')
    });
    const inspection = inspectConfigurationChange({ root, planId, requestId, at: createdAt });
    if (json) print(inspection);
    else process.stdout.write(
      'Requested exact configuration confirmation ' + requestId + '.\n'
        + 'Expires: ' + inspection.request.expiresAt + '\n'
        + 'Execution authority created: no\n'
    );
    return;
  }

  if (command === 'configuration-change-confirm') {
    const requestId = requiredOption(args, '--request-id');
    const confirmationId = option(args, '--confirmation-id', 'configuration-change-confirmation.' + idPart);
    const result = confirmConfigurationChangeRequest({
      root,
      requestId,
      id: confirmationId,
      actor: { type: 'local-operator', id: requiredOption(args, '--actor') },
      reason: requiredOption(args, '--reason'),
      confirmedAt: createdAt
    });
    const planId = result.confirmation.plan.id;
    const inspection = inspectConfigurationChange({
      root,
      planId,
      requestId,
      confirmationId,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Confirmed exact configuration request as ' + confirmationId + '.\n'
        + 'One-time start consumed: no\n'
        + 'Desired configuration changed: no\n'
    );
    return;
  }

  if (command === 'configuration-change-start') {
    const confirmationId = requiredOption(args, '--confirmation-id');
    const checkpointId = option(args, '--checkpoint-id', 'checkpoint.configuration.' + idPart);
    const result = prepareConfigurationChangeExecution({
      root,
      confirmationId,
      checkpointId,
      at: createdAt
    });
    const inspection = inspectConfigurationChange({
      root,
      planId: result.checkpoint.plan.id,
      requestId: result.checkpoint.request.id,
      confirmationId,
      consumptionId: result.consumption.id,
      checkpointId,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Consumed exact confirmation into checkpoint ' + checkpointId + '.\n'
        + 'Checkpoint state: ' + inspection.checkpoint.state + '\n'
        + 'Desired configuration changed: no\n'
    );
    return;
  }

  if (command === 'configuration-change-execute' || command === 'configuration-change-recover') {
    const checkpointId = requiredOption(args, '--checkpoint-id');
    const checkpoint = command === 'configuration-change-execute'
      ? executeConfigurationChange({ root, checkpointId, at: createdAt })
      : recoverConfigurationChange({ root, checkpointId, at: createdAt });
    const inspection = inspectConfigurationChange({
      root,
      planId: checkpoint.plan.id,
      requestId: checkpoint.request.id,
      confirmationId: checkpoint.confirmation.id,
      consumptionId: checkpoint.consumption.id,
      checkpointId,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Configuration checkpoint ' + checkpointId + ' is ' + checkpoint.state + '.\n'
        + 'Phase: ' + checkpoint.phase + '\n'
        + 'Provider calls executed: 0\n'
    );
    if (checkpoint.state === 'needs-attention') process.exitCode = 1;
    return;
  }

  if (command === 'configuration-change-inspect') {
    const inspection = inspectConfigurationChange({
      root,
      planId: requiredOption(args, '--plan-id'),
      requestId: option(args, '--request-id'),
      confirmationId: option(args, '--confirmation-id'),
      consumptionId: option(args, '--consumption-id'),
      checkpointId: option(args, '--checkpoint-id'),
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Configuration plan ' + inspection.plan.id + ' is ' + inspection.configuration.applicability + '.\n'
        + 'Next action: ' + inspection.resume.permittedNextAction + '\n'
        + 'Inspection authority: none\n'
    );
    return;
  }

  if (command === 'host-realization-plan') {
    const configurationName = requiredOption(args, '--configuration');
    const planId = option(args, '--plan-id', 'host-realization-plan.' + configurationName + '.' + idPart);
    prepareHostRealization({
      root,
      configurationName,
      id: planId,
      createdAt,
      validUntil: requiredOption(args, '--valid-until')
    });
    const inspection = inspectHostRealization({ root, planId, at: createdAt });
    if (json) print(inspection);
    else process.stdout.write(
      'Prepared exact private host realization plan ' + planId + '.\n'
        + 'Target fingerprint: ' + inspection.target.fingerprint + '\n'
        + 'Managed file effects: ' + inspection.scope.outputs.length + '\n'
        + 'Execution authority created: no\n'
    );
    return;
  }

  if (command === 'host-realization-request') {
    const planId = requiredOption(args, '--plan-id');
    const requestId = option(args, '--request-id', 'host-realization-request.' + idPart);
    beginHostRealizationRequest({
      root,
      planId,
      id: requestId,
      reason: requiredOption(args, '--reason'),
      createdAt,
      expiresAt: requiredOption(args, '--expires-at')
    });
    const inspection = inspectHostRealization({ root, planId, requestId, at: createdAt });
    if (json) print(inspection);
    else process.stdout.write(
      'Requested exact host realization confirmation ' + requestId + '.\n'
        + 'One-time start consumed: no\n'
    );
    return;
  }

  if (command === 'host-realization-confirm') {
    const requestId = requiredOption(args, '--request-id');
    const confirmationId = option(args, '--confirmation-id', 'host-realization-confirmation.' + idPart);
    const result = confirmHostRealizationRequest({
      root,
      requestId,
      id: confirmationId,
      actor: { type: 'local-operator', id: requiredOption(args, '--actor') },
      reason: requiredOption(args, '--reason'),
      confirmedAt: createdAt
    });
    const inspection = inspectHostRealization({
      root,
      planId: result.confirmation.plan.id,
      requestId,
      confirmationId,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Confirmed exact host realization request as ' + confirmationId + '.\n'
        + 'Next action: ' + inspection.resume.permittedNextAction + '\n'
        + 'Host files changed: no\n'
    );
    return;
  }

  if (command === 'host-realization-start') {
    const confirmationId = requiredOption(args, '--confirmation-id');
    const checkpointId = option(args, '--checkpoint-id', 'checkpoint.host-realization.' + idPart);
    const result = prepareHostRealizationExecution({
      root,
      confirmationId,
      checkpointId,
      at: createdAt
    });
    const inspection = inspectHostRealization({
      root,
      planId: result.checkpoint.plan.id,
      requestId: result.checkpoint.request.id,
      confirmationId,
      consumptionId: result.consumption.id,
      checkpointId,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Consumed exact host confirmation into checkpoint ' + checkpointId + '.\n'
        + 'Next action: ' + inspection.resume.permittedNextAction + '\n'
        + 'Host files changed: no\n'
    );
    return;
  }

  if (command === 'host-realization-execute' || command === 'host-realization-recover') {
    const checkpointId = requiredOption(args, '--checkpoint-id');
    const checkpoint = command === 'host-realization-execute'
      ? executeHostRealization({ root, checkpointId, at: createdAt })
      : recoverHostRealization({ root, checkpointId, at: createdAt });
    const inspection = inspectHostRealization({
      root,
      planId: checkpoint.plan.id,
      requestId: checkpoint.request.id,
      confirmationId: checkpoint.confirmation.id,
      consumptionId: checkpoint.consumption.id,
      checkpointId,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Host realization checkpoint ' + checkpointId + ' is ' + checkpoint.state + '.\n'
        + 'Local projection claim: ' + inspection.claims.localProjection + '\n'
        + 'Host launch claim: ' + inspection.claims.hostLaunch + '\n'
        + 'Provider calls executed: 0\n'
    );
    if (checkpoint.state === 'needs-attention') process.exitCode = 1;
    return;
  }

  if (command === 'host-realization-inspect') {
    const inspection = inspectHostRealization({
      root,
      planId: requiredOption(args, '--plan-id'),
      requestId: option(args, '--request-id'),
      confirmationId: option(args, '--confirmation-id'),
      consumptionId: option(args, '--consumption-id'),
      checkpointId: option(args, '--checkpoint-id'),
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Host realization plan ' + inspection.plan.id + ' is ' + inspection.plan.applicability + '.\n'
        + 'Next action: ' + inspection.resume.permittedNextAction + '\n'
        + 'Inspection authority: none\n'
    );
    return;
  }

  if (command === 'pack-install-plan') {
    const targetRoot = requiredOption(args, '--target');
    const planId = option(args, '--plan-id', 'pack-install-plan.' + idPart);
    const inspection = preparePackInstall({
      sourceRoot: root,
      targetRoot,
      capsulePaths: options(args, '--capsule'),
      bundlePath: option(args, '--bundle'),
      baseContract: option(args, '--base-contract', '1.0.0'),
      planId,
      createdAt,
      validUntil: requiredOption(args, '--valid-until')
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Prepared exact private local pack install plan ' + planId + '.\n'
        + 'Target fingerprint: ' + inspection.plan.targetFingerprint + '\n'
        + 'Verified releases: ' + inspection.plan.releases.length + '\n'
        + 'Managed file effects: ' + inspection.plan.effects.length + '\n'
        + 'Execution authority created: no\n'
    );
    return;
  }

  if (command === 'pack-install-request') {
    const targetRoot = requiredOption(args, '--target');
    const planId = requiredOption(args, '--plan-id');
    const requestId = option(args, '--request-id', 'pack-install-request.' + idPart);
    const inspection = beginPackInstallRequest({
      sourceRoot: root,
      targetRoot,
      planId,
      requestId,
      reason: requiredOption(args, '--reason'),
      createdAt,
      expiresAt: requiredOption(args, '--expires-at')
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Requested exact local pack install confirmation ' + requestId + '.\n'
        + 'One-time start consumed: no\n'
    );
    return;
  }

  if (command === 'pack-install-confirm') {
    const targetRoot = requiredOption(args, '--target');
    const confirmationId = option(args, '--confirmation-id', 'pack-install-confirmation.' + idPart);
    const inspection = confirmPackInstallRequest({
      sourceRoot: root,
      targetRoot,
      requestId: requiredOption(args, '--request-id'),
      confirmationId,
      actor: requiredOption(args, '--actor'),
      reason: requiredOption(args, '--reason'),
      confirmedAt: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Confirmed exact local pack install request as ' + confirmationId + '.\n'
        + 'Next action: ' + inspection.resume.permittedNextAction + '\n'
        + 'Managed files changed: no\n'
    );
    return;
  }

  if (command === 'pack-install-start') {
    const checkpointId = option(args, '--checkpoint-id', 'checkpoint.pack-install.' + idPart);
    const inspection = preparePackInstallExecution({
      sourceRoot: root,
      targetRoot: requiredOption(args, '--target'),
      confirmationId: requiredOption(args, '--confirmation-id'),
      checkpointId,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Consumed exact pack install confirmation into checkpoint ' + checkpointId + '.\n'
        + 'Next action: ' + inspection.resume.permittedNextAction + '\n'
        + 'Managed files changed: no\n'
    );
    return;
  }

  if (command === 'pack-install-execute' || command === 'pack-install-recover') {
    const targetRoot = requiredOption(args, '--target');
    const checkpointId = requiredOption(args, '--checkpoint-id');
    const inspection = command === 'pack-install-execute'
      ? executePackInstall({ sourceRoot: root, targetRoot, checkpointId, at: createdAt })
      : recoverPackInstall({ sourceRoot: root, targetRoot, checkpointId, at: createdAt });
    if (json) print(inspection);
    else process.stdout.write(
      'Local pack install checkpoint ' + checkpointId + ' is ' + inspection.checkpoint.state + '.\n'
        + 'Local materialization claim: ' + inspection.claims.localMaterialization + '\n'
        + 'Installed registry claim: ' + inspection.claims.installedRegistry + '\n'
        + 'Network and package-manager effects executed: 0\n'
    );
    if (inspection.checkpoint.state === 'needs-attention') process.exitCode = 1;
    return;
  }

  if (command === 'pack-install-inspect') {
    const references = {
      planId: option(args, '--plan-id'),
      requestId: option(args, '--request-id'),
      confirmationId: option(args, '--confirmation-id'),
      consumptionId: option(args, '--consumption-id'),
      checkpointId: option(args, '--checkpoint-id')
    };
    if (!Object.values(references).some(Boolean)) {
      throw new Error('pack-install-inspect requires at least one exact transaction identifier.');
    }
    const inspection = inspectPackInstall({
      sourceRoot: root,
      targetRoot: requiredOption(args, '--target'),
      ...references,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Local pack install plan ' + inspection.plan.id + '.\n'
        + 'Next action: ' + inspection.resume.permittedNextAction + '\n'
        + 'Inspection authority: none\n'
    );
    return;
  }

  if (command === 'prepare') {
    const lockPath = requiredOption(args, '--lock');
    const lock = readJson(resolveRepoPath(root, lockPath));
    const scenarioPath = option(args, '--scenario');
    const runId = option(args, '--run-id', 'run.' + lock.configuration.name + '.' + idPart);
    const resolutionEvidenceId = option(
      args,
      '--resolution-evidence-id',
      'evidence.' + lock.configuration.name + '.resolution.' + idPart
    );
    const preparationEvidenceId = option(
      args,
      '--preparation-evidence-id',
      'evidence.' + lock.configuration.name + '.preparation.' + idPart
    );
    const envelope = prepareRunEnvelope({
      root,
      lock,
      lockPath,
      scenarioPath,
      automationId: option(args, '--automation'),
      runId,
      createdAt,
      requestedOutcome: option(args, '--outcome'),
      evidenceIds: [resolutionEvidenceId, preparationEvidenceId]
    });
    const evidence = [
      createResolutionEvidence({ lock, id: resolutionEvidenceId, createdAt }),
      createRunPreparationEvidence({
        lock,
        envelope,
        id: preparationEvidenceId,
        createdAt
      })
    ];
    const output = option(args, '--output');
    if (output) writeJson(resolveRepoPath(root, output), envelope);
    writeEvidence(root, option(args, '--evidence-dir'), evidence);
    if (json) {
      print({ envelope, evidence });
    } else {
      process.stdout.write(
        'Prepared ' + envelope.id + ' at lifecycle state ' + envelope.lifecycleState + '.\n'
          + 'External effects executed: 0\n'
          + (output ? 'Wrote: ' + output + '\n' : '')
      );
    }
    return;
  }

  if (command === 'doctor') {
    const lockPath = requiredOption(args, '--lock');
    const resolvedLockPath = resolveRepoPath(root, lockPath);
    const historicalBasis = workflowEvidenceBasisForPath(
      repoRelativePath(root, resolvedLockPath)
    );
    if (historicalBasis) {
      const error = new Error(
        'SOTER_HISTORICAL_EVIDENCE_LOCK_NOT_OPERATIONAL: '
          + historicalBasis.path
          + ' is an immutable workflow-evidence basis, not an operational doctor lock.'
      );
      error.code = 'SOTER_HISTORICAL_EVIDENCE_LOCK_NOT_OPERATIONAL';
      throw error;
    }
    const lock = readJson(resolvedLockPath);
    const level = option(args, '--level', 'offline');
    if (!['offline', 'connected'].includes(level)) {
      throw new Error('doctor --level must be offline or connected; canary execution is not implemented.');
    }
    const evidenceId = option(
      args,
      '--evidence-id',
      'evidence.' + lock.configuration.name + '.doctor.' + idPart
    );
    const doctorOptions = {
      root,
      configPath: option(args, '--config'),
      lock,
      doctorId: option(args, '--doctor-id', 'doctor.' + lock.configuration.name + '.' + idPart),
      evidenceId,
      createdAt
    };
    const checkpointObservations = level === 'connected'
      ? options(args, '--probe-checkpoint').map((checkpointId) => {
        return getDurableProviderProbeObservation({ root, checkpointId });
      })
      : [];
    const result = level === 'connected'
      ? runConnectedDoctor({
        ...doctorOptions,
        providerProbes: [
          ...options(args, '--probe').map((probePath) => {
            return readJson(resolveRepoPath(root, probePath));
          }),
          ...checkpointObservations.filter((observation) => {
            return observation.$contract === 'soter://contracts/provider-probe/v2';
          })
        ],
        providerProbeAttempts: checkpointObservations.filter((observation) => {
          return observation.$contract === 'soter://contracts/provider-probe-attempt/v1';
        })
      })
      : runOfflineDoctor(doctorOptions);
    const output = option(args, '--output');
    if (output) writeJson(resolveRepoPath(root, output), result.report);
    writeEvidence(root, option(args, '--evidence-dir'), result.evidence);
    if (json) {
      print(result.report);
    } else {
      process.stdout.write(formatDoctorReport(result.report) + '\n');
      if (output) process.stdout.write('Wrote: ' + output + '\n');
    }
    if (result.report.states.valid === 'failed' || result.report.states.valid === 'stale') {
      process.exitCode = 1;
    }
    if (level === 'connected' && result.report.states.ready !== 'passed') {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'probe-prepare') {
    if (option(args, '--output')) {
      throw new Error(
        'Provider probe checkpoints are private runtime state and cannot be exported.'
      );
    }
    const lockPath = requiredOption(args, '--lock');
    const providerImplementation = requiredOption(args, '--provider');
    const prepared = await prepareDurableProviderProbeExecution({
      root,
      configurationBasis: requiredOption(args, '--configuration-basis'),
      lockPath,
      providerImplementation,
      probeId: option(args, '--probe-id'),
      at: createdAt,
      validForSeconds: Number(option(args, '--valid-for-seconds', '300'))
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared ' + prepared.checkpoint.id + ' in state ' + prepared.checkpoint.state + '.\n'
          + 'Provider operation: ' + call.transport.server + '/'
          + (call.transport.operation || 'none') + '\n'
          + 'Native host tool: ' + (call.transport.tool || 'none') + '\n'
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Raw provider response persistence: disabled by Core\n'
      );
    }
    if (prepared.checkpoint.state !== 'requested') process.exitCode = 1;
    return;
  }

  if (command === 'probe-complete') {
    if (option(args, '--checkpoint-output') || option(args, '--probe-output')) {
      throw new Error(
        'Provider probe checkpoints and results are private runtime state and cannot be exported.'
      );
    }
    const response = readPrivateJsonInput(root, requiredOption(args, '--response'));
    const completed = await completeDurableProviderProbeExecution({
      root,
      checkpointId: requiredOption(args, '--checkpoint'),
      callId: requiredOption(args, '--call'),
      response,
      at: createdAt
    });
    if (json) {
      print(completed);
    } else {
      const nextCall = completed.currentCall;
      process.stdout.write(
        'Advanced ' + completed.checkpoint.id + ' to state '
          + completed.checkpoint.state + '.\n'
          + 'Raw provider response persisted by Core: no\n'
          + (nextCall
            ? 'Next provider operation: ' + nextCall.transport.server + '/'
              + nextCall.transport.operation + '\n'
              + 'Next native host tool: ' + nextCall.transport.tool + '\n'
              + 'Next call ID: ' + nextCall.id + '\n'
            : '')
          + (completed.checkpoint.result
            ? 'Probe: ' + completed.checkpoint.result.id + '; capability compatibility remains '
              + completed.checkpoint.result.capabilities.map((item) => item.state).join(', ') + '.\n'
            : '')
      );
    }
    if (completed.checkpoint.state === 'failed') process.exitCode = 1;
    return;
  }

  if (command === 'capability-complete') {
    if (option(args, '--checkpoint-output') || option(args, '--output')) {
      throw new Error(
        'Capability checkpoints and normalized results are private runtime state and cannot be exported.'
      );
    }
    const completed = await completeDurableCapabilityExecution({
      root,
      checkpointId: requiredOption(args, '--checkpoint'),
      callId: option(args, '--call'),
      response: readPrivateJsonInput(root, requiredOption(args, '--response')),
      at: createdAt
    });
    if (json) {
      print(completed);
    } else {
      process.stdout.write(
        'Advanced ' + completed.checkpoint.id + ' to state '
          + completed.checkpoint.state + '.\n'
          + 'Raw provider response persisted by Core: no\n'
          + (completed.checkpoint.state === 'requested'
            ? 'Next exact call ID: ' + completed.checkpoint.call.id + '\n'
              + 'Next provider operation: ' + completed.checkpoint.call.transport.server + '/'
              + completed.checkpoint.call.transport.operation + '\n'
            : '')
      );
    }
    if (!['requested', 'completed'].includes(completed.checkpoint.state)) process.exitCode = 1;
    return;
  }

  if (command === 'plan-complete') {
    if (option(args, '--output')) {
      throw new Error(
        'Operation plan checkpoints are private runtime state and cannot be exported into the repository.'
      );
    }
    const completed = await completeDurableOperationPlanExecution({
      root,
      checkpointId: requiredOption(args, '--checkpoint'),
      callId: requiredOption(args, '--call'),
      response: readPrivateJsonInput(root, requiredOption(args, '--response')),
      at: createdAt
    });
    if (json) {
      print(completed);
    } else {
      const call = completed.currentCall;
      process.stdout.write(
        'Advanced operation plan ' + completed.checkpoint.plan.id + ' to state '
          + completed.checkpoint.state + '.\n'
          + 'Current step: ' + (completed.checkpoint.currentStepId || 'none') + '\n'
          + (call
            ? 'Next provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Next native host tool: ' + call.transport.tool + '\n'
              + 'Next exact call ID: ' + call.id + '\n'
            : 'Next host request emitted: no\n')
          + 'Raw provider response persisted by Core: no\n'
      );
    }
    if (!['requested', 'completed'].includes(completed.checkpoint.state)) process.exitCode = 1;
    return;
  }

  if (command === 'connected-transaction-prepare') {
    if (option(args, '--output')) {
      throw new Error(
        'Connected transaction checkpoints are private runtime state and cannot be exported into the repository.'
      );
    }
    const prepared = await prepareDurableConnectedTransactionExecution({
      root,
      approvalId: requiredOption(args, '--approval-id'),
      at: createdAt
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared connected transaction ' + prepared.checkpoint.batch.id + ' in state '
          + prepared.checkpoint.state + '.\n'
          + 'Approval: ' + prepared.checkpoint.approval.id + ' (exact batch fingerprint matched)\n'
          + (call
            ? 'Provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Native host tool: ' + call.transport.tool + '\n'
              + 'Exact call ID: ' + call.id + '\n'
            : 'Host request emitted: no\n')
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Raw provider response persistence: disabled by Core\n'
      );
    }
    if (prepared.checkpoint.state !== 'requested') process.exitCode = 1;
    return;
  }

  if (command === 'connected-approval-request') {
    const batch = readDocumentInput(root, requiredOption(args, '--batch'));
    const changeSet = readDocumentInput(root, requiredOption(args, '--change-set'));
    const begun = await beginProposalConnectedApprovalRequest({
      root,
      configurationBasis: requiredOption(args, '--configuration-basis'),
      lockPath: requiredOption(args, '--lock'),
      runPath: requiredOption(args, '--run'),
      batch,
      changeSet,
      id: requiredOption(args, '--request-id'),
      reason: requiredOption(args, '--reason'),
      createdAt,
      expiresAt: requiredOption(args, '--expires-at')
    });
    const result = {
      request: {
        id: begun.request.id,
        fingerprint: begun.request.requestFingerprint,
        requestedAt: begun.request.createdAt,
        expiresAt: begun.request.expiresAt,
        batchId: begun.request.batch.id,
        changeSetId: begun.request.changeSet.id
      },
      requestPath: begun.requestPath
    };
    if (json) print(result);
    else process.stdout.write(
      'Prepared exact connected approval request ' + begun.request.id + '.\n'
        + 'Expires: ' + begun.request.expiresAt + '\n'
        + 'Writes executed: 0\n'
    );
    return;
  }

  if (command === 'connected-approval-confirm') {
    const requestId = requiredOption(args, '--request-id');
    const confirmed = await confirmProposalConnectedApprovalRequest({
      root,
      requestId,
      approvalId: requiredOption(args, '--approval-id'),
      actor: requiredOption(args, '--actor'),
      reason: requiredOption(args, '--reason'),
      confirmedAt: createdAt
    });
    const result = {
      approval: {
        id: confirmed.approval.id,
        requestId: confirmed.approval.request.id,
        confirmedAt: confirmed.approval.createdAt,
        expiresAt: confirmed.approval.expiresAt,
        actor: confirmed.approval.actor,
        scope: confirmed.approval.scope
      },
      approvalPath: confirmed.approvalPath
    };
    if (json) print(result);
    else process.stdout.write(
      'Confirmed exact connected approval request '
        + confirmed.approval.request.id + '.\n'
        + 'Approval: ' + confirmed.approval.id + '\n'
        + 'Expires: ' + confirmed.approval.expiresAt + '\n'
        + 'Writes executed: 0\n'
    );
    return;
  }

  if (command === 'operator-inspect') {
    const requestId = option(args, '--request-id');
    const approvalId = option(args, '--approval-id');
    const checkpointId = option(args, '--checkpoint');
    if (!requestId && !approvalId && !checkpointId) {
      throw new Error('operator-inspect requires --request-id, --approval-id, or --checkpoint.');
    }
    const inspection = inspectConnectedOperatorActivity({
      root,
      requestId,
      approvalId,
      checkpointId,
      observedAt: createdAt
    });
    print(inspection);
    return;
  }

  if (command === 'connected-acceptance-inspect') {
    assertExactCommandArguments(args, {
      valueOptions: ['--checkpoint', '--at'],
      repeatableValueOptions: ['--checkpoint']
    });
    print(inspectConnectedAcceptance({
      root,
      checkpointIds: options(args, '--checkpoint'),
      generatedAt: createdAt
    }));
    return;
  }

  if (command === 'operator-approval-review') {
    const material = inspectConnectedApprovalReviewMaterial({
      root,
      requestId: requiredOption(args, '--request-id')
    });
    print(material);
    return;
  }

  if (command === 'operator-prepare') {
    const work = await prepareAutomationRun({
      root,
      automationId: requiredOption(args, '--automation'),
      configurationName: requiredOption(args, '--configuration'),
      configurationBasis: requiredOption(args, '--configuration-basis'),
      preparationMode: option(args, '--preparation-mode', 'contained'),
      expectedHost: option(args, '--host'),
      input: readPrivateJsonInput(root, requiredOption(args, '--input')),
      createdAt
    });
    if (json) {
      print(work);
    } else {
      process.stdout.write(
        'Prepared private operator work ' + work.id + ' at state ' + work.state + '.\n'
          + 'Configuration basis: ' + work.configuration.configurationBasis + '\n'
          + 'Preparation mode: ' + (work.preparationMode || 'contained') + '\n'
          + 'Configuration applicability: ' + work.configuration.applicability + '\n'
          + 'External writes performed: no\n'
          + 'Approval requested: no\n'
      );
    }
    return;
  }

  if (command === 'operator-prepared-inspect') {
    const work = inspectPreparedAutomationWork({
      root,
      workId: requiredOption(args, '--work-id')
    });
    print(work);
    return;
  }

  if (command === 'operator-prepared-review') {
    const material = inspectPreparedAutomationReviewMaterial({
      root,
      workId: requiredOption(args, '--work-id')
    });
    print(material);
    return;
  }

  if (command === 'operator-prepared-derived-review') {
    const material = inspectPreparedAutomationDerivedReviewMaterial({
      root,
      workId: requiredOption(args, '--work-id')
    });
    print(material);
    return;
  }

  if (command === 'operator-review-batch-create') {
    const batch = createPreparedReviewBatch({
      root,
      workId: requiredOption(args, '--work-id'),
      actionIds: options(args, '--action-id'),
      createdAt
    });
    if (json) {
      print(batch);
    } else {
      process.stdout.write(
        'Created immutable prepared review batch ' + batch.id + '.\n'
          + 'Selected actions: ' + batch.scope.selectedActionCount + ' of '
          + batch.scope.availableActionCount + '\n'
          + 'Partial subset: ' + (batch.scope.partial ? 'yes' : 'no') + '\n'
          + 'Approval, continuation, and execution authority: none\n'
      );
    }
    return;
  }

  if (command === 'operator-review-batch') {
    const material = inspectPreparedReviewBatchMaterial({
      root,
      batchId: requiredOption(args, '--batch-id')
    });
    print(material);
    return;
  }

  if (command === 'operator-connected-plan-create') {
    const plan = await createPreparedConnectedPlan({
      root,
      batchId: requiredOption(args, '--batch-id'),
      createdAt
    });
    if (json) {
      print(plan);
    } else {
      process.stdout.write(
        'Compiled private connected candidate plan ' + plan.id + '.\n'
          + 'Operations: ' + plan.operations.length + '\n'
          + 'Executable: no\n'
          + 'Approval, continuation, execution, and retry authority: none\n'
          + 'Blockers:\n  - ' + plan.blockers.join('\n  - ') + '\n'
      );
    }
    return;
  }

  if (command === 'operator-connected-plan') {
    const plan = await inspectPreparedConnectedPlan({
      root,
      planId: requiredOption(args, '--plan-id')
    });
    print(plan);
    return;
  }

  if (command === 'connected-transaction-complete') {
    if (option(args, '--output')) {
      throw new Error(
        'Connected transaction checkpoints are private runtime state and cannot be exported into the repository.'
      );
    }
    const completed = await completeDurableConnectedTransactionExecution({
      root,
      checkpointId: requiredOption(args, '--checkpoint'),
      callId: requiredOption(args, '--call'),
      response: readPrivateJsonInput(root, requiredOption(args, '--response')),
      at: createdAt
    });
    if (json) {
      print(completed);
    } else {
      const call = completed.currentCall;
      process.stdout.write(
        'Advanced connected transaction ' + completed.checkpoint.batch.id + ' to state '
          + completed.checkpoint.state + '.\n'
          + (call
            ? 'Next stage: ' + completed.checkpoint.current.stage + '\n'
              + 'Next provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Next native host tool: ' + call.transport.tool + '\n'
              + 'Next exact call ID: ' + call.id + '\n'
            : 'Next host request emitted: no\n')
          + 'Raw provider response persisted by Core: no\n'
      );
    }
    if (!['requested', 'completed'].includes(completed.checkpoint.state)) process.exitCode = 1;
    return;
  }

  if (command === 'connected-transaction-reconcile') {
    if (option(args, '--output')) {
      throw new Error(
        'Connected transaction checkpoints are private runtime state and cannot be exported into the repository.'
      );
    }
    const prepared = await prepareDurableConnectedTransactionReconciliation({
      root,
      checkpointId: requiredOption(args, '--checkpoint'),
      at: createdAt
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared read-only reconciliation for ' + prepared.checkpoint.batch.id + '.\n'
          + (call
            ? 'Provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Native host tool: ' + call.transport.tool + '\n'
              + 'Exact call ID: ' + call.id + '\n'
            : 'Host request emitted: no\n')
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Writes authorized or retried by reconciliation: 0\n'
      );
    }
    if (prepared.checkpoint.state !== 'requested') process.exitCode = 1;
    return;
  }

  if (command === 'context-connected-prepare') {
    assertExactCommandArguments(args, { valueOptions: ['--work', '--at'] });
    const prepared = await prepareMeetingIntakeConnectedContext({
      root,
      workId: requiredOption(args, '--work'),
      at: createdAt
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared connected meeting-intake context ' + prepared.checkpoint.plan.id
          + ' in state ' + prepared.checkpoint.state + '.\n'
          + 'Current source: ' + (prepared.checkpoint.currentStepId || 'none') + '\n'
          + (call
            ? 'Provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Native host tool: ' + call.transport.tool + '\n'
              + 'Exact call ID: ' + call.id + '\n'
            : 'Host request emitted: no\n')
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Connected write approval accepted by this command: no\n'
      );
    }
    if (!['requested', 'completed'].includes(prepared.checkpoint.state)) process.exitCode = 1;
    return;
  }

  if (command === 'context-connected-finalize') {
    const finalized = finalizeMeetingIntakeConnectedContext({
      root,
      checkpointId: requiredOption(args, '--checkpoint')
    });
    if (json) {
      print(finalized);
    } else {
      process.stdout.write(
        'Finalized connected context snapshot ' + finalized.snapshot.id + '.\n'
          + 'Entries: ' + finalized.snapshot.entries.length + '\n'
          + 'Containment: ' + finalized.snapshot.containment + '\n'
          + 'Run state: ' + finalized.run.lifecycleState + '\n'
          + 'Private snapshot: ' + finalized.snapshotPath + '\n'
          + 'External writes executed: 0\n'
      );
    }
    return;
  }

  if (command === 'email-context-connected-prepare') {
    assertExactCommandArguments(args, { valueOptions: ['--work', '--at'] });
    const prepared = await prepareEmailTriageConnectedAcquisition({
      root,
      workId: requiredOption(args, '--work'),
      at: createdAt
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared connected Email acquisition ' + prepared.checkpoint.plan.id
          + ' in state ' + prepared.checkpoint.state + '.\n'
          + 'Current source: ' + (prepared.checkpoint.currentStepId || 'none') + '\n'
          + (call
            ? 'Provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Native host tool: ' + call.transport.tool + '\n'
              + 'Exact call ID: ' + call.id + '\n'
            : 'Host request emitted: no\n')
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Triage judgment, approval, or write authority granted: no\n'
      );
    }
    if (!['requested', 'completed'].includes(prepared.checkpoint.state)) process.exitCode = 1;
    return;
  }

  if (command === 'slack-conversation-context-connected-prepare') {
    assertExactCommandArguments(args, { valueOptions: ['--work', '--at'] });
    const prepared = await prepareSlackConversationReviewConnectedAcquisition({
      root,
      workId: requiredOption(args, '--work'),
      at: createdAt
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared connected Slack conversation review ' + prepared.checkpoint.plan.id
          + ' in state ' + prepared.checkpoint.state + '.\n'
          + 'Current source: ' + (prepared.checkpoint.currentStepId || 'none') + '\n'
          + (call
            ? 'Provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Native host tool: ' + call.transport.tool + '\n'
              + 'Exact call ID: ' + call.id + '\n'
            : 'Host request emitted: no\n')
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Persistence proposal, approval, continuation, retry, or write authority granted: no\n'
      );
    }
    if (!['requested', 'completed'].includes(prepared.checkpoint.state)) process.exitCode = 1;
    return;
  }

  if (command === 'slack-conversation-context-connected-finalize') {
    const finalized = finalizeSlackConversationReviewConnectedAcquisition({
      root,
      checkpointId: requiredOption(args, '--checkpoint')
    });
    if (json) {
      print(finalized);
    } else {
      process.stdout.write(
        'Finalized sanitized connected Slack conversation review ' + finalized.snapshot.id + '.\n'
          + 'Selected conversations: ' + finalized.coverage.selectedConversationCount + '\n'
          + 'Complete message windows: ' + finalized.coverage.messageWindowCount + '\n'
          + 'Exact selected threads: ' + finalized.coverage.selectedThreadCount + '\n'
          + 'Unselected rooted threads expanded: 0\n'
          + 'Private values or external writes exposed: 0\n'
      );
    }
    return;
  }

  if (command === 'slack-conversation-connected-inspect') {
    const inspected = inspectSlackConversationReviewConnected({
      root,
      workId: requiredOption(args, '--work')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected sanitized connected Slack conversation review ' + inspected.snapshot.id + '.\n'
          + 'Coverage fingerprint: ' + inspected.coverage.coverageFingerprint + '\n'
          + 'Suspected injection count: ' + inspected.injection.count + '\n'
          + 'Private values included: no\n'
          + 'Authority created: no\n'
      );
    }
    return;
  }

  if (command === 'slack-conversation-connected-review') {
    print(inspectSlackConversationReviewConnectedPrivateReview({
      root,
      workId: requiredOption(args, '--work')
    }));
    return;
  }

  if (command === 'email-context-connected-finalize') {
    const finalized = finalizeEmailTriageConnectedAcquisition({
      root,
      checkpointId: requiredOption(args, '--checkpoint')
    });
    if (json) {
      print(finalized);
    } else {
      process.stdout.write(
        'Finalized connected Email acquisition snapshot ' + finalized.snapshot.id + '.\n'
          + 'Entries: ' + finalized.snapshot.entries.length + '\n'
          + 'Containment: ' + finalized.snapshot.containment + '\n'
          + 'Run state: ' + finalized.run.lifecycleState + '\n'
          + 'Private snapshot: ' + finalized.snapshotPath + '\n'
          + 'Triage judgments or external writes executed: 0\n'
      );
    }
    return;
  }

  if (command === 'task-context-connected-prepare') {
    assertExactCommandArguments(args, { valueOptions: ['--work', '--at'] });
    const prepared = await prepareTaskCaptureConnectedAcquisition({
      root,
      workId: requiredOption(args, '--work'),
      at: createdAt
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared connected Task acquisition ' + prepared.checkpoint.plan.id
          + ' in state ' + prepared.checkpoint.state + '.\n'
          + 'Current source: ' + (prepared.checkpoint.currentStepId || 'none') + '\n'
          + (call
            ? 'Provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Native host tool: ' + call.transport.tool + '\n'
              + 'Exact call ID: ' + call.id + '\n'
            : 'Host request emitted: no\n')
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Task proposal, approval, continuation, or write authority granted: no\n'
      );
    }
    if (!['requested', 'completed'].includes(prepared.checkpoint.state)) process.exitCode = 1;
    return;
  }

  if (command === 'task-context-connected-finalize') {
    const finalized = finalizeTaskCaptureConnectedAcquisition({
      root,
      checkpointId: requiredOption(args, '--checkpoint')
    });
    if (json) {
      print(finalized);
    } else {
      process.stdout.write(
        'Finalized connected Task acquisition snapshot ' + finalized.snapshot.id + '.\n'
          + 'Entries: ' + finalized.snapshot.entries.length + '\n'
          + 'Containment: ' + finalized.snapshot.containment + '\n'
          + 'Run state: ' + finalized.run.lifecycleState + '\n'
          + 'Private snapshot: ' + finalized.snapshotPath + '\n'
          + 'Task decisions, proposals, approvals, or external writes executed: 0\n'
      );
    }
    return;
  }

  if (command === 'task-capture-decision-inspect') {
    const inspected = inspectTaskCaptureDecisionContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      at: createdAt
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Task Capture decision basis ' + inspected.snapshot.id + '.\n'
          + 'Derived state: ' + inspected.outcome.state + '\n'
          + 'Duplicate candidates: ' + inspected.outcome.duplicateCandidateCount + '\n'
          + 'Task fingerprint: ' + inspected.outcome.taskAfterFingerprint + '\n'
          + 'Decision or write authority created: no\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'task-capture-decision-commit') {
    const committed = commitTaskCaptureDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      id: option(args, '--decision-id', 'decision.task-capture.' + idPart),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Task Capture decision ' + committed.decision.id + '.\n'
          + 'State: ' + committed.decision.state + '\n'
          + 'Decision fingerprint: ' + committed.decision.decisionFingerprint + '\n'
          + 'Private decision: ' + committed.decisionPath + '\n'
          + 'Proposal, approval, continuation, or provider writes created: no\n'
      );
    }
    if (committed.decision.state !== 'ready') process.exitCode = 1;
    return;
  }

  if (command === 'task-capture-proposal-inspect') {
    const inspected = inspectTaskCaptureProposalDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Task Capture proposal basis ' + inspected.decision.id + '.\n'
          + 'Task fingerprint: ' + inspected.decision.taskAfterFingerprint + '\n'
          + 'Proposal, approval, continuation, and provider writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'task-capture-proposal-commit') {
    const committed = commitTaskCaptureProposal({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(args, '--proposal-id', 'proposal.task-capture.' + idPart),
      input: {},
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Task Capture review proposal ' + committed.proposal.id + '.\n'
          + 'Proposal fingerprint: ' + committed.proposal.proposalFingerprint + '\n'
          + 'Private proposal: ' + committed.proposalPath + '\n'
          + 'Selected private material: ' + committed.materialPath + '\n'
          + 'Approval, continuation, provider calls, and writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'task-capture-proposal-material') {
    const material = inspectTaskCaptureProposalMaterial({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal')
    });
    print(material);
    return;
  }

  if (command === 'organization-context-connected-prepare') {
    assertExactCommandArguments(args, { valueOptions: ['--work', '--at'] });
    const prepared = await prepareOrganizationCaptureConnectedAcquisition({
      root,
      workId: requiredOption(args, '--work'),
      at: createdAt
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared connected Organization acquisition ' + prepared.checkpoint.plan.id
          + ' in state ' + prepared.checkpoint.state + '.\n'
          + 'Current source: ' + (prepared.checkpoint.currentStepId || 'none') + '\n'
          + (call
            ? 'Provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Native host tool: ' + call.transport.tool + '\n'
              + 'Exact call ID: ' + call.id + '\n'
            : 'Host request emitted: no\n')
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Organization proposal, approval, continuation, or write authority granted: no\n'
      );
    }
    if (!['requested', 'completed'].includes(prepared.checkpoint.state)) process.exitCode = 1;
    return;
  }

  if (command === 'organization-context-connected-finalize') {
    const finalized = finalizeOrganizationCaptureConnectedAcquisition({
      root,
      checkpointId: requiredOption(args, '--checkpoint')
    });
    if (json) {
      print(finalized);
    } else {
      process.stdout.write(
        'Finalized connected Organization acquisition snapshot ' + finalized.snapshot.id + '.\n'
          + 'Entries: ' + finalized.snapshot.entries.length + '\n'
          + 'Containment: ' + finalized.snapshot.containment + '\n'
          + 'Run state: ' + finalized.run.lifecycleState + '\n'
          + 'Private snapshot: ' + finalized.snapshotPath + '\n'
          + 'Organization decisions, proposals, approvals, or external writes executed: 0\n'
      );
    }
    return;
  }

  if (command === 'organization-capture-decision-inspect') {
    const inspected = inspectOrganizationCaptureDecisionContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Organization Capture decision basis '
          + inspected.snapshot.id + '.\n'
          + 'Derived state: ' + inspected.outcome.state + '\n'
          + 'Duplicate candidates: ' + inspected.outcome.duplicateCandidateCount + '\n'
          + 'Schema fingerprint: ' + inspected.outcome.schemaFingerprint + '\n'
          + 'Organization fingerprint: '
            + inspected.outcome.organizationAfterFingerprint + '\n'
          + 'Decision or write authority created: no\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'organization-capture-decision-commit') {
    const committed = commitOrganizationCaptureDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      id: option(
        args,
        '--decision-id',
        'decision.organization-capture.' + idPart
      ),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Organization Capture decision ' + committed.decision.id + '.\n'
          + 'State: ' + committed.decision.state + '\n'
          + 'Decision fingerprint: ' + committed.decision.decisionFingerprint + '\n'
          + 'Private decision: ' + committed.decisionPath + '\n'
          + 'Proposal, approval, continuation, or provider writes created: no\n'
      );
    }
    if (committed.decision.state !== 'ready') process.exitCode = 1;
    return;
  }

  if (command === 'organization-capture-proposal-inspect') {
    const inspected = inspectOrganizationCaptureProposalDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Organization Capture proposal basis '
          + inspected.decision.id + '.\n'
          + 'Organization fingerprint: '
            + inspected.decision.organizationAfterFingerprint + '\n'
          + 'Proposal, approval, continuation, and provider writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'organization-capture-proposal-commit') {
    const committed = commitOrganizationCaptureProposal({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(
        args,
        '--proposal-id',
        'proposal.organization-capture.' + idPart
      ),
      input: {},
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Organization Capture review proposal ' + committed.proposal.id + '.\n'
          + 'Proposal fingerprint: ' + committed.proposal.proposalFingerprint + '\n'
          + 'Private proposal: ' + committed.proposalPath + '\n'
          + 'Selected private material: ' + committed.materialPath + '\n'
          + 'Approval, continuation, provider calls, and writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'organization-capture-proposal-material') {
    const material = inspectOrganizationCaptureProposalMaterial({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal')
    });
    print(material);
    return;
  }

  if (command === 'project-capture-context-connected-prepare') {
    assertExactCommandArguments(args, { valueOptions: ['--work', '--at'] });
    const prepared = await prepareProjectCaptureConnectedAcquisition({
      root,
      workId: requiredOption(args, '--work'),
      at: createdAt
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared connected Project Capture acquisition ' + prepared.checkpoint.plan.id
          + ' in state ' + prepared.checkpoint.state + '.\n'
          + 'Current source: ' + (prepared.checkpoint.currentStepId || 'none') + '\n'
          + (call
            ? 'Provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Native host tool: ' + call.transport.tool + '\n'
              + 'Exact call ID: ' + call.id + '\n'
            : 'Host request emitted: no\n')
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Project proposal, approval, continuation, or write authority granted: no\n'
      );
    }
    if (!['requested', 'completed'].includes(prepared.checkpoint.state)) process.exitCode = 1;
    return;
  }

  if (command === 'project-capture-context-connected-finalize') {
    const finalized = finalizeProjectCaptureConnectedAcquisition({
      root,
      checkpointId: requiredOption(args, '--checkpoint')
    });
    if (json) {
      print(finalized);
    } else {
      process.stdout.write(
        'Finalized connected Project Capture snapshot ' + finalized.snapshot.id + '.\n'
          + 'Entries: ' + finalized.snapshot.entries.length + '\n'
          + 'Containment: ' + finalized.snapshot.containment + '\n'
          + 'Run state: ' + finalized.run.lifecycleState + '\n'
          + 'Private snapshot: ' + finalized.snapshotPath + '\n'
          + 'Project decisions, proposals, approvals, or external writes executed: 0\n'
      );
    }
    return;
  }

  if (command === 'project-capture-decision-inspect') {
    const inspected = inspectProjectCaptureDecisionContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Project Capture decision basis ' + inspected.snapshot.id + '.\n'
          + 'Derived state: ' + inspected.outcome.state + '\n'
          + 'Duplicate candidates: ' + inspected.outcome.duplicateCandidateCount + '\n'
          + 'Organization fingerprint: ' + inspected.outcome.organizationFingerprint + '\n'
          + 'Project fingerprint: ' + inspected.outcome.projectAfterFingerprint + '\n'
          + 'Decision or write authority created: no\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'project-capture-decision-commit') {
    const committed = commitProjectCaptureDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      id: option(args, '--decision-id', 'decision.project-capture.' + idPart),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Project Capture decision ' + committed.decision.id + '.\n'
          + 'State: ' + committed.decision.state + '\n'
          + 'Decision fingerprint: ' + committed.decision.decisionFingerprint + '\n'
          + 'Private decision: ' + committed.decisionPath + '\n'
          + 'Proposal, approval, continuation, or provider writes created: no\n'
      );
    }
    if (committed.decision.state !== 'ready') process.exitCode = 1;
    return;
  }

  if (command === 'project-capture-proposal-inspect') {
    const inspected = inspectProjectCaptureProposalDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Project Capture proposal basis ' + inspected.decision.id + '.\n'
          + 'Project fingerprint: ' + inspected.decision.projectAfterFingerprint + '\n'
          + 'Proposal, approval, continuation, and provider writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'project-capture-proposal-commit') {
    const committed = commitProjectCaptureProposal({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(args, '--proposal-id', 'proposal.project-capture.' + idPart),
      input: {},
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Project Capture review proposal ' + committed.proposal.id + '.\n'
          + 'Proposal fingerprint: ' + committed.proposal.proposalFingerprint + '\n'
          + 'Private proposal: ' + committed.proposalPath + '\n'
          + 'Selected private material: ' + committed.materialPath + '\n'
          + 'Approval, continuation, provider calls, and writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'project-capture-proposal-material') {
    const material = inspectProjectCaptureProposalMaterial({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal')
    });
    print(material);
    return;
  }

  if (command === 'contact-context-connected-prepare') {
    assertExactCommandArguments(args, { valueOptions: ['--work', '--at'] });
    const prepared = await prepareContactCaptureConnectedAcquisition({
      root,
      workId: requiredOption(args, '--work'),
      at: createdAt
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared connected Contact acquisition ' + prepared.checkpoint.plan.id
          + ' in state ' + prepared.checkpoint.state + '.\n'
          + 'Current source: ' + (prepared.checkpoint.currentStepId || 'none') + '\n'
          + (call
            ? 'Provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Native host tool: ' + call.transport.tool + '\n'
              + 'Exact call ID: ' + call.id + '\n'
            : 'Host request emitted: no\n')
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Contact proposal, approval, continuation, or write authority granted: no\n'
      );
    }
    if (!['requested', 'completed'].includes(prepared.checkpoint.state)) process.exitCode = 1;
    return;
  }

  if (command === 'contact-context-connected-finalize') {
    const finalized = finalizeContactCaptureConnectedAcquisition({
      root,
      checkpointId: requiredOption(args, '--checkpoint')
    });
    if (json) {
      print(finalized);
    } else {
      process.stdout.write(
        'Finalized connected Contact acquisition snapshot ' + finalized.snapshot.id + '.\n'
          + 'Entries: ' + finalized.snapshot.entries.length + '\n'
          + 'Containment: ' + finalized.snapshot.containment + '\n'
          + 'Run state: ' + finalized.run.lifecycleState + '\n'
          + 'Private snapshot: ' + finalized.snapshotPath + '\n'
          + 'Contact decisions, proposals, approvals, or external writes executed: 0\n'
      );
    }
    return;
  }

  if (command === 'contact-capture-decision-inspect') {
    const inspected = inspectContactCaptureDecisionContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Contact Capture decision basis '
          + inspected.snapshot.id + '.\n'
          + 'Derived state: ' + inspected.outcome.state + '\n'
          + 'Duplicate candidates: ' + inspected.outcome.duplicateCandidateCount + '\n'
          + 'Schema fingerprint: ' + inspected.outcome.schemaFingerprint + '\n'
          + 'Contact fingerprint: ' + inspected.outcome.contactAfterFingerprint + '\n'
          + 'Decision or write authority created: no\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'contact-capture-decision-commit') {
    const committed = commitContactCaptureDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      id: option(args, '--decision-id', 'decision.contact-capture.' + idPart),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Contact Capture decision ' + committed.decision.id + '.\n'
          + 'State: ' + committed.decision.state + '\n'
          + 'Decision fingerprint: ' + committed.decision.decisionFingerprint + '\n'
          + 'Private decision: ' + committed.decisionPath + '\n'
          + 'Proposal, approval, continuation, or provider writes created: no\n'
      );
    }
    if (committed.decision.state !== 'ready') process.exitCode = 1;
    return;
  }

  if (command === 'contact-capture-proposal-inspect') {
    const inspected = inspectContactCaptureProposalDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Contact Capture proposal basis '
          + inspected.decision.id + '.\n'
          + 'Contact fingerprint: ' + inspected.decision.contactAfterFingerprint + '\n'
          + 'Proposal, approval, continuation, and provider writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'contact-capture-proposal-commit') {
    const committed = commitContactCaptureProposal({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(args, '--proposal-id', 'proposal.contact-capture.' + idPart),
      input: {},
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Contact Capture review proposal ' + committed.proposal.id + '.\n'
          + 'Proposal fingerprint: ' + committed.proposal.proposalFingerprint + '\n'
          + 'Private proposal: ' + committed.proposalPath + '\n'
          + 'Selected private material: ' + committed.materialPath + '\n'
          + 'Approval, continuation, provider calls, and writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'contact-capture-proposal-material') {
    const material = inspectContactCaptureProposalMaterial({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal')
    });
    print(material);
    return;
  }

  if (command === 'project-context-connected-prepare') {
    assertExactCommandArguments(args, { valueOptions: ['--work', '--at'] });
    const prepared = await prepareProjectPulseConnectedAcquisition({
      root,
      workId: requiredOption(args, '--work'),
      at: createdAt
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared connected Project Pulse acquisition ' + prepared.checkpoint.plan.id
          + ' in state ' + prepared.checkpoint.state + '.\n'
          + 'Current source: ' + (prepared.checkpoint.currentStepId || 'none') + '\n'
          + (call
            ? 'Provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Native host tool: ' + call.transport.tool + '\n'
              + 'Exact call ID: ' + call.id + '\n'
            : 'Host request emitted: no\n')
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Project decision, proposal, approval, continuation, or write authority granted: no\n'
      );
    }
    if (!['requested', 'completed'].includes(prepared.checkpoint.state)) process.exitCode = 1;
    return;
  }

  if (command === 'project-context-connected-finalize') {
    const finalized = finalizeProjectPulseConnectedAcquisition({
      root,
      checkpointId: requiredOption(args, '--checkpoint')
    });
    if (json) {
      print(finalized);
    } else {
      process.stdout.write(
        'Finalized connected Project Pulse acquisition snapshot ' + finalized.snapshot.id + '.\n'
          + 'Entries: ' + finalized.snapshot.entries.length + '\n'
          + 'Containment: ' + finalized.snapshot.containment + '\n'
          + 'Run state: ' + finalized.run.lifecycleState + '\n'
          + 'Private snapshot: ' + finalized.snapshotPath + '\n'
          + 'Project decisions, proposals, approvals, or external writes executed: 0\n'
      );
    }
    return;
  }

  if (command === 'project-pulse-decision-inspect') {
    const inspected = inspectProjectPulseDecisionContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Project Pulse decision basis ' + inspected.snapshot.id + '.\n'
          + 'Derived state: ' + inspected.outcome.state + '\n'
          + 'Promoted tasks: ' + inspected.outcome.taskCount + '\n'
          + 'Milestones: ' + inspected.outcome.milestoneCount + '\n'
          + 'Health: ' + inspected.outcome.health + '\n'
          + 'Proposed milestone changes: ' + inspected.outcome.milestoneChangeCount + '\n'
          + 'Decision or write authority created: no\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'project-pulse-decision-commit') {
    const committed = commitProjectPulseDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      id: option(args, '--decision-id', 'decision.project-pulse.' + idPart),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Project Pulse decision ' + committed.decision.id + '.\n'
          + 'State: ' + committed.decision.state + '\n'
          + 'Decision fingerprint: ' + committed.decision.decisionFingerprint + '\n'
          + 'Private decision: ' + committed.decisionPath + '\n'
          + 'Proposal, approval, continuation, or provider writes created: no\n'
      );
    }
    if (committed.decision.state !== 'ready') process.exitCode = 1;
    return;
  }

  if (command === 'project-pulse-proposal-inspect') {
    const inspected = inspectProjectPulseProposalDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Project Pulse proposal basis ' + inspected.decision.id + '.\n'
          + 'Milestone changes: ' + inspected.decision.milestoneChangeCount + '\n'
          + 'Status fingerprint: ' + inspected.decision.statusAfterFingerprint + '\n'
          + 'Proposal, approval, continuation, and provider writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'project-pulse-proposal-commit') {
    const committed = commitProjectPulseProposal({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(args, '--proposal-id', 'proposal.project-pulse.' + idPart),
      input: {},
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Project Pulse review proposal ' + committed.proposal.id + '.\n'
          + 'Proposal fingerprint: ' + committed.proposal.proposalFingerprint + '\n'
          + 'Private proposal: ' + committed.proposalPath + '\n'
          + 'Selected private material: ' + committed.materialPath + '\n'
          + 'Approval, continuation, provider calls, and writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'project-pulse-proposal-material') {
    const material = inspectProjectPulseProposalMaterial({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal')
    });
    print(material);
    return;
  }

  if (command === 'meeting-intake-decision-inspect') {
    const inspected = inspectMeetingIntakeDecisionContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private meeting-intake decision context ' + inspected.snapshot.id + '.\n'
          + 'Transcript segments: ' + inspected.counts.transcriptSegments + '\n'
          + 'Task candidates: ' + inspected.counts.taskCandidates + '\n'
          + 'Applicable policies: ' + inspected.counts.applicablePolicies + '\n'
          + 'Template state: needs-input\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'email-triage-decision-inspect') {
    const inspected = inspectEmailTriageDecisionContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Email triage decision context ' + inspected.snapshot.id + '.\n'
          + 'Observed threads: ' + inspected.reduction.observedThreadCount + '\n'
          + 'Included candidates: ' + inspected.reduction.includedCount + '\n'
          + 'Excluded threads: ' + inspected.reduction.excludedCount + '\n'
          + 'Template state: needs-input\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'email-triage-decision-commit') {
    const committed = commitEmailTriageDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      id: option(
        args,
        '--decision-id',
        'decision.email-triage.' + idPart
      ),
      input: readDocumentInput(root, requiredOption(args, '--decision-input')),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Email triage decision ' + committed.decision.id + '.\n'
          + 'State: ' + committed.decision.state + '\n'
          + 'Decision fingerprint: ' + committed.decision.decisionFingerprint + '\n'
          + 'Private decision: ' + committed.decisionPath + '\n'
          + 'Drafts, proposed changes, or write approval created: no\nProvider calls executed: 0\n'
      );
    }
    if (committed.decision.state !== 'ready') process.exitCode = 1;
    return;
  }

  if (command === 'email-triage-proposal-inspect') {
    const inspected = inspectEmailTriageProposalDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Email proposal basis ' + inspected.decision.id + '.\n'
          + 'Candidates requiring exact proposal input: '
          + inspected.inputTemplate.candidates.length + '\n'
          + 'Proposal, approval, continuation, and provider writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'email-triage-proposal-commit') {
    const committed = commitEmailTriageProposal({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(args, '--proposal-id', 'proposal.email-triage.' + idPart),
      input: readPrivateJsonInput(root, requiredOption(args, '--proposal-input')),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Email review proposal ' + committed.proposal.id + '.\n'
          + 'Proposal fingerprint: ' + committed.proposal.proposalFingerprint + '\n'
          + 'Private proposal: ' + committed.proposalPath + '\n'
          + 'Selected private material: ' + committed.materialPath + '\n'
          + 'Approval, continuation, provider calls, writes, and sending created: 0\n'
      );
    }
    return;
  }

  if (command === 'email-triage-proposal-material') {
    const material = inspectEmailTriageProposalMaterial({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal')
    });
    print(material);
    return;
  }

  if (command === 'meeting-intake-decision-commit') {
    const committed = commitMeetingIntakeDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      id: option(
        args,
        '--decision-id',
        'decision.meeting-intake.' + idPart
      ),
      input: readDocumentInput(root, requiredOption(args, '--decision-input')),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed meeting-intake decision ' + committed.decision.id + '.\n'
          + 'State: ' + committed.decision.state + '\n'
          + 'Decision fingerprint: ' + committed.decision.decisionFingerprint + '\n'
          + 'Private decision: ' + committed.decisionPath + '\n'
          + 'Write approval created: no\nProvider calls executed: 0\n'
      );
    }
    if (committed.decision.state !== 'ready') process.exitCode = 1;
    return;
  }

  if (command === 'meeting-intake-proposal-inspect') {
    const inspected = inspectMeetingIntakeProposalDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Meeting Intake proposal basis ' + inspected.decision.id + '.\n'
          + 'Grounded summary segments: ' + inspected.decision.summarySegmentCount + '\n'
          + 'Existing task folds: ' + inspected.decision.foldedTaskCount + '\n'
          + 'Proposal, approval, continuation, provider calls, or writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'meeting-intake-proposal-commit') {
    const committed = commitMeetingIntakeProposal({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(args, '--proposal-id', 'proposal.meeting-intake.' + idPart),
      input: {},
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Meeting Intake review proposal ' + committed.proposal.id + '.\n'
          + 'Proposal fingerprint: ' + committed.proposal.proposalFingerprint + '\n'
          + 'Private proposal: ' + committed.proposalPath + '\n'
          + 'Selected private material: ' + committed.materialPath + '\n'
          + 'Approval, continuation, provider calls, and writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'meeting-intake-proposal-material') {
    const material = inspectMeetingIntakeProposalMaterial({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal')
    });
    print(material);
    return;
  }

  if (command === 'host-fail') {
    const checkpointId = requiredOption(args, '--checkpoint');
    if (option(args, '--output')) {
      throw new Error(
        'Host-call checkpoints are private runtime state and cannot be exported.'
      );
    }
    assertExactCommandArguments(args, {
      valueOptions: ['--checkpoint', '--call', '--kind', '--at']
    });
    const failed = await failDurableHostExecution({
      root,
      checkpointId,
      errorKind: requiredOption(args, '--kind'),
      callId: option(args, '--call'),
      at: createdAt
    });
    if (json) {
      print(failed);
    } else {
      const call = failed.currentCall;
      process.stdout.write(
        'Recorded ' + failed.checkpoint.id + ' in state '
          + failed.checkpoint.state + '.\n'
          + (call
            ? 'Next provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Next native host tool: ' + call.transport.tool + '\n'
              + 'Next exact call ID: ' + call.id + '\n'
            : '')
      );
    }
    return;
  }

  if (command === 'host-get') {
    const checkpoint = getDurableHostExecution({
      root,
      checkpointId: requiredOption(args, '--checkpoint')
    });
    print(checkpoint);
    return;
  }

  if (command === 'host-list') {
    const checkpoints = listDurableHostExecutions({
      root,
      state: option(args, '--state')
    });
    print(checkpoints);
    return;
  }

  if (command === 'proposal-connected-batch-preview') {
    const preview = await createProposalConnectedBatch({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal'),
      actionIds: options(args, '--action-id'),
      changeSetId: option(args, '--change-set-id', 'changeset.email-triage.' + idPart),
      batchId: option(args, '--batch-id', 'batch.email-triage.' + idPart),
      createdAt,
      expectedHost: option(args, '--host')
    });
    if (json) {
      print(preview);
    } else {
      process.stdout.write(
        'Compiled exact proposal batch ' + preview.batch.id + '.\n'
          + 'Selected actions: ' + preview.selection.selectedActionCount + ' of '
            + preview.selection.availableActionCount + '\n'
          + 'Partial subset: ' + (preview.selection.partial ? 'yes' : 'no') + '\n'
          + 'Approval authority created: no\n'
          + 'Provider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'development-candidate-lock') {
    const materialized = materializeDevelopmentCandidateLock({
      root,
      configPath: requiredOption(args, '--config'),
      workflowId: requiredOption(args, '--workflow'),
      host: requiredOption(args, '--host')
    });
    const inspection = {
      path: materialized.path,
      lockFingerprint: materialized.lockFingerprint,
      graphFingerprint: materialized.graphFingerprint,
      workflow: materialized.workflow,
      host: materialized.host,
      authority: materialized.authority
    };
    if (json) print(inspection);
    else {
      process.stdout.write(
        'Created exact private development candidate lock.\n'
          + 'Path: ' + inspection.path + '\n'
          + 'Workflow: ' + inspection.workflow.id + '@' + inspection.workflow.version + '\n'
          + 'Host: ' + inspection.host.id + '\n'
          + 'Lock fingerprint: ' + inspection.lockFingerprint + '\n'
          + 'Execution, migration, provider, merge, realization, or fallback-removal authority: none\n'
      );
    }
    return;
  }

  if (command === 'development-request-create') {
    const workflowId = requiredOption(args, '--workflow');
    const invocationPath = option(args, '--invocation');
    const exactEvaluationSuite = args.includes('--evaluation-suite');
    if ((invocationPath ? 1 : 0) + (exactEvaluationSuite ? 1 : 0) !== 1) {
      throw new Error('development-request-create requires exactly one of --invocation or --evaluation-suite.');
    }
    const invocation = exactEvaluationSuite
      ? buildDevelopmentEvaluationInvocation({ root, workflowId })
      : readPrivateJsonInput(root, invocationPath);
    const prepared = prepareDevelopmentRequest({
      root,
      lockPath: requiredOption(args, '--lock'),
      workflowId,
      requestId: requiredOption(args, '--request-id'),
      invocation,
      createdAt: args.includes('--at') ? createdAt : null
    });
    if (json) print(prepared.inspection);
    else {
      process.stdout.write(
        'Created exact private development request ' + prepared.inspection.request.id + '.\n'
          + 'Workflow: ' + prepared.inspection.workflow.id + '\n'
          + 'Host: ' + prepared.inspection.host.id + '\n'
          + 'Provider transaction authority: none\n'
      );
    }
    return;
  }

  if (command === 'development-result-record') {
    const outcome = readPrivateJsonInput(root, requiredOption(args, '--outcome'));
    const recorded = recordDevelopmentResult({
      root,
      lockPath: requiredOption(args, '--lock'),
      requestId: requiredOption(args, '--request-id'),
      outcome,
      completedAt: args.includes('--at') ? createdAt : null
    });
    if (json) print(recorded.inspection);
    else {
      process.stdout.write(
        'Recorded scoped development evidence for ' + recorded.inspection.request.id + '.\n'
          + 'State: ' + recorded.inspection.progress.state + '\n'
          + 'Fallback-removal authority: none\n'
      );
    }
    return;
  }

  if (command === 'development-host-evaluate') {
    const evaluated = runDevelopmentHostEvaluation({
      root,
      requestId: requiredOption(args, '--request-id'),
      executablePath: requiredOption(args, '--executable')
    });
    if (json) print(evaluated.summary);
    else {
      process.stdout.write(
        'Completed isolated ' + evaluated.summary.host + ' evaluation ' + evaluated.summary.id + '.\n'
          + 'Fresh worker processes: ' + evaluated.summary.runCount + '\n'
          + 'Independent judgment required: yes\n'
          + 'Raw prompts and transcripts returned or inspected: no\n'
          + 'Activation, migration, or fallback-removal authority: none\n'
      );
    }
    return;
  }

  if (command === 'development-host-judge') {
    const judged = runDevelopmentHostJudgment({
      root,
      requestId: requiredOption(args, '--request-id'),
      executablePath: requiredOption(args, '--executable')
    });
    if (json) print(judged.summary);
    else {
      process.stdout.write(
        'Completed isolated independent ' + judged.summary.host + ' judgment ' + judged.summary.id + '.\n'
          + 'Fresh judge processes: ' + judged.summary.reviewCount + '\n'
          + 'Guided cases passed: ' + (judged.summary.guidedPassed ? 'yes' : 'no') + '\n'
          + 'Worker self-report accepted as judgment: no\n'
          + 'Activation, migration, or fallback-removal authority: none\n'
      );
    }
    return;
  }

  if (command === 'development-host-finalize') {
    const judgmentPath = option(args, '--judgment');
    const finalized = finalizeDevelopmentHostEvaluation({
      root,
      requestId: requiredOption(args, '--request-id'),
      judgment: judgmentPath ? readPrivateJsonInput(root, judgmentPath) : null
    });
    if (json) print(finalized.observation);
    else {
      process.stdout.write(
        'Recorded independently judged host observation ' + finalized.observation.id + '.\n'
          + 'Host: ' + finalized.observation.host.id + '\n'
          + 'Guided runs: ' + finalized.observation.runs.filter((run) => run.arm === 'guided').length + '\n'
          + 'Worker self-report accepted as judgment: no\n'
          + 'Activation, migration, or fallback-removal authority: none\n'
      );
    }
    return;
  }

  if (command === 'development-host-evidence-historical') {
    assertExactCommandArguments(args, { valueOptions: ['--request-id'] });
    requiredOption(args, '--request-id');
    throw new Error(
      'DEVELOPMENT_MIGRATION_EVIDENCE_BATCH_REQUIRED: standalone historical evidence publication is retired; use development-historical-evidence-batch-request and the exact fourteen-chain batch.'
    );
  }

  if (command === 'development-historical-evidence-batch-request') {
    assertExactCommandArguments(args, {
      valueOptions: ['--id', '--created-at', '--valid-until', '--workflows']
    });
    print(buildDevelopmentHistoricalEvidenceBatchRequest({
      root,
      id: requiredOption(args, '--id'),
      createdAt: requiredOption(args, '--created-at'),
      validUntil: requiredOption(args, '--valid-until'),
      workflows: readPrivateJsonInput(root, requiredOption(args, '--workflows'))
    }));
    return;
  }

  if (command === 'development-historical-evidence-batch-execute'
    || command === 'development-historical-evidence-batch-recover') {
    assertExactCommandArguments(args, { valueOptions: ['--request', '--at'] });
    const input = {
      root,
      requestPath: requiredOption(args, '--request'),
      at: requiredOption(args, '--at')
    };
    print(command === 'development-historical-evidence-batch-execute'
      ? executeDevelopmentHistoricalEvidenceBatch(input)
      : recoverDevelopmentHistoricalEvidenceBatch(input));
    return;
  }

  if (command === 'development-historical-evidence-batch-inspect') {
    assertExactCommandArguments(args, { valueOptions: ['--request'] });
    print(inspectDevelopmentHistoricalEvidenceBatch({
      root,
      requestPath: requiredOption(args, '--request')
    }));
    return;
  }

  if (command === 'development-host-evidence-final') {
    assertExactCommandArguments(args, {
      valueOptions: ['--request-id', '--lock', '--at']
    });
    requiredOption(args, '--request-id');
    requiredOption(args, '--lock');
    requiredOption(args, '--at');
    throw new Error(
      'DEVELOPMENT_ACTIVATION_EVIDENCE_BATCH_REQUIRED: standalone final evidence publication is retired; use development-host-evidence-finalize-batch.'
    );
  }

  if (command === 'development-host-evidence-finalization-request-create') {
    assertExactCommandArguments(args, {
      valueOptions: [
        '--id',
        '--created-at',
        '--valid-until',
        '--legacy-finalization',
        '--workflows',
        '--output'
      ]
    });
    const request = buildDevelopmentHostEvidenceFinalizationRequest({
      root,
      legacyFinalizationPath: requiredOption(args, '--legacy-finalization'),
      id: requiredOption(args, '--id'),
      createdAt: requiredOption(args, '--created-at'),
      validUntil: requiredOption(args, '--valid-until'),
      workflows: readPrivateJsonInput(root, requiredOption(args, '--workflows'))
    });
    print(persistCanonicalPrivateRequest({
      root,
      outputPath: requiredOption(args, '--output'),
      request,
      kind: 'development-host-evidence-finalization-request'
    }));
    return;
  }

  if (command === 'development-host-evidence-finalize-batch') {
    assertExactCommandArguments(args, {
      valueOptions: ['--request', '--legacy-finalization', '--at']
    });
    const result = finalizeDevelopmentHostEvidenceBatch({
      root,
      requestPath: requiredOption(args, '--request'),
      legacyFinalizationPath: requiredOption(args, '--legacy-finalization'),
      at: requiredOption(args, '--at')
    });
    print(result);
    return;
  }

  if (command === 'development-host-evidence-finalization-verify') {
    assertExactCommandArguments(args, {
      valueOptions: ['--request', '--legacy-finalization', '--at']
    });
    const result = verifyDevelopmentHostEvidenceFinalization({
      root,
      requestPath: requiredOption(args, '--request'),
      legacyFinalizationPath: requiredOption(args, '--legacy-finalization'),
      at: requiredOption(args, '--at')
    });
    print(result);
    return;
  }

  if (command === 'development-host-evidence-finalization-rollback') {
    assertExactCommandArguments(args, {
      valueOptions: ['--request', '--at']
    });
    const result = rollbackCompletedDevelopmentHostEvidenceFinalization({
      root,
      requestPath: requiredOption(args, '--request'),
      at: requiredOption(args, '--at')
    });
    print(result);
    return;
  }

  if (command === 'development-workflow-lifecycle-request-create') {
    assertExactCommandArguments(args, {
      valueOptions: ['--id', '--created-at', '--output']
    });
    const request = buildDevelopmentWorkflowLifecycleFinalizationRequest({
      root,
      id: requiredOption(args, '--id'),
      createdAt: requiredOption(args, '--created-at')
    });
    print(persistCanonicalPrivateRequest({
      root,
      outputPath: requiredOption(args, '--output'),
      request,
      kind: 'development-workflow-lifecycle-finalization-request'
    }));
    return;
  }

  if (command === 'development-workflow-lifecycle-plan') {
    assertExactCommandArguments(args, { valueOptions: ['--request'] });
    const plan = planDevelopmentWorkflowLifecycleFinalization({
      root,
      requestPath: requiredOption(args, '--request')
    });
    print(plan);
    return;
  }

  if (command === 'legacy-finalization-transition-request-create') {
    assertExactCommandArguments(args, {
      valueOptions: [
        '--id',
        '--created-at',
        '--valid-until',
        '--at',
        '--lifecycle-request',
        '--checker-receipt',
        '--output',
        '--fixture-output'
      ]
    });
    const outputPath = requiredOption(args, '--output');
    const fixtureOutputPath = requiredOption(args, '--fixture-output');
    if (path.resolve(outputPath) === path.resolve(fixtureOutputPath)) {
      throw new Error(
        'legacy-finalization-transition-request-create requires distinct --output and --fixture-output paths.'
      );
    }
    const request = await buildLegacyFinalizationTransitionRequest({
      root,
      id: requiredOption(args, '--id'),
      createdAt: requiredOption(args, '--created-at'),
      validUntil: requiredOption(args, '--valid-until'),
      at: requiredOption(args, '--at'),
      lifecycleRequestPath: requiredOption(args, '--lifecycle-request'),
      checkerReceipt: readPrivateJsonInput(root, requiredOption(args, '--checker-receipt'))
    });
    const fixture = persistCanonicalPrivateRequest({
      root,
      outputPath: fixtureOutputPath,
      request: request.fixtureRequest,
      kind: 'legacy-finalization-fixture-request'
    });
    const transition = persistCanonicalPrivateRequest({
      root,
      outputPath,
      request,
      kind: 'legacy-finalization-transition-request'
    });
    print({ transition, fixture });
    return;
  }

  if (command === 'repository-cutover-request-create') {
    assertExactCommandArguments(args, {
      valueOptions: [
        '--id',
        '--created-at',
        '--lifecycle-request',
        '--transition-request',
        '--fixture-finalization-request',
        '--output'
      ]
    });
    const request = buildRepositoryCutoverRequest({
      root,
      id: requiredOption(args, '--id'),
      createdAt: requiredOption(args, '--created-at'),
      lifecycleRequestPath: requiredOption(args, '--lifecycle-request'),
      transitionRequestPath: requiredOption(args, '--transition-request'),
      fixtureFinalizationRequestPath: requiredOption(args, '--fixture-finalization-request')
    });
    print(persistCanonicalPrivateRequest({
      root,
      outputPath: requiredOption(args, '--output'),
      request,
      kind: 'repository-cutover-request'
    }));
    return;
  }

  if (command === 'repository-cutover-prepare') {
    assertExactCommandArguments(args, { valueOptions: ['--request', '--at'] });
    const inspection = await prepareRepositoryCutover({
      root,
      requestPath: requiredOption(args, '--request'),
      at: requiredOption(args, '--at')
    });
    print(inspection);
    return;
  }

  if (command === 'repository-cutover-execute'
    || command === 'repository-cutover-recover'
    || command === 'repository-cutover-rollback') {
    assertExactCommandArguments(args, { valueOptions: ['--checkpoint-id', '--at'] });
    const input = {
      root,
      checkpointId: requiredOption(args, '--checkpoint-id'),
      at: requiredOption(args, '--at')
    };
    const inspection = command === 'repository-cutover-execute'
      ? executeRepositoryCutover(input)
      : command === 'repository-cutover-recover'
        ? recoverRepositoryCutover(input)
        : rollbackRepositoryCutover(input);
    print(inspection);
    return;
  }

  if (command === 'repository-cutover-inspect') {
    assertExactCommandArguments(args, { valueOptions: ['--checkpoint-id'] });
    print(inspectRepositoryCutover({
      root,
      checkpointId: requiredOption(args, '--checkpoint-id')
    }));
    return;
  }

  if (command === 'development-run-inspect') {
    const inspection = inspectDevelopmentRun({
      root,
      requestId: requiredOption(args, '--request-id')
    });
    if (json) print(inspection);
    else {
      process.stdout.write(
        'Development run ' + inspection.request.id + ': ' + inspection.progress.state + '.\n'
          + 'Workflow: ' + inspection.workflow.id + '\n'
          + 'Host: ' + inspection.host.id + '\n'
          + 'Private paths, outcomes, diffs, transcripts, and provider responses included: no\n'
      );
    }
    return;
  }

  if (command === 'selftest') {
    const { selftest } = await import('./selftest.mjs');
    const { selftestPrivateJsonInput } = await import('./lib/canonical-json.selftest.mjs');
    const { selftestPreparedWork } = await import('./prepared-work.selftest.mjs');
    const { selftestConnectedAcceptanceInspection } = await import(
      './connected-acceptance-inspection.selftest.mjs'
    );
    const { selftestPreparedReviewBatches } = await import('./prepared-review-batches.selftest.mjs');
    const { selftestPreparedConnectedPlans } = await import('./prepared-connected-plans.selftest.mjs');
    const { selftestAutomationProposals } = await import('./automation-proposals.selftest.mjs');
    const { selftestConfigurationTransactions } = await import('./configuration-transactions.selftest.mjs');
    const { selftestHostRealizations } = await import('./host-realizations.selftest.mjs');
    const { selftestPackInstalls } = await import('./pack-installs.selftest.mjs');
    const { selftestDevelopmentCandidateLocks } = await import(
      './development-candidate-locks.selftest.mjs'
    );
    const { selftestDevelopmentRuns } = await import('./development-runs.selftest.mjs');
    const { selftestDevelopmentHostObservations } = await import(
      './development-host-observations.selftest.mjs'
    );
    const { selftestDevelopmentHostRunner } = await import(
      './development-host-runner.selftest.mjs'
    );
    const { selftestLegacyFinalization } = await import('./legacy-finalization.selftest.mjs');
    const { selftestLegacyTransitionFinalization } = await import(
      './legacy-transition-finalization.selftest.mjs'
    );
    const { selftestDevelopmentWorkflowLifecycleFinalization } = await import(
      './development-workflow-lifecycle-finalization.selftest.mjs'
    );
    const { selftestRepositoryCutover } = await import('./repository-cutover.selftest.mjs');
    const { selftestPrivateRequestFiles } = await import('./private-request-files.selftest.mjs');
    const { selftestEmailConnectedContext } = await import(
      '../automations/email-triage/connected-context.selftest.mjs'
    );
    const { selftestTaskCaptureConnectedContext } = await import(
      '../automations/task-capture/connected-context.selftest.mjs'
    );
    const { selftestProjectPulseConnectedContext } = await import(
      '../automations/project-pulse/connected-context.selftest.mjs'
    );
    const { selftestOrganizationCapture } = await import(
      '../automations/organization-capture/organization-capture.selftest.mjs'
    );
    const { selftestOrganizationCaptureConnectedContext } = await import(
      '../automations/organization-capture/connected-context.selftest.mjs'
    );
    const { selftestProjectCapture } = await import(
      '../automations/project-capture/project-capture.selftest.mjs'
    );
    const { selftestProjectCaptureConnectedContext } = await import(
      '../automations/project-capture/connected-context.selftest.mjs'
    );
    const { selftestContactCapture } = await import(
      '../automations/contact-capture/contact-capture.selftest.mjs'
    );
    const { selftestContactCaptureConnectedContext } = await import(
      '../automations/contact-capture/connected-context.selftest.mjs'
    );
    const { selftestDriveFiling } = await import(
      '../automations/filing-a-drive-artifact/filing-a-drive-artifact.selftest.mjs'
    );
    const { selftestFeatureCapture } = await import(
      '../automations/feature-capture/feature-capture.selftest.mjs'
    );
    const { selftestFeatureDefinition } = await import(
      '../automations/feature-definition/feature-definition.selftest.mjs'
    );
    const { selftestRepositoryReview } = await import(
      '../automations/repository-review/repository-review.selftest.mjs'
    );
    const { selftestSlackChannelIngestion } = await import(
      '../automations/slack-channel-ingestion/slack-channel-ingestion.selftest.mjs'
    );
    const { selftestSlackConversationReviewConnectedContext } = await import(
      '../automations/slack-conversation-review/connected-context.selftest.mjs'
    );
    const { selftestProcessCapture } = await import(
      '../automations/process-capture/process-capture.selftest.mjs'
    );
    const { selftestProcessRedTeam } = await import(
      '../automations/process-red-team/process-red-team.selftest.mjs'
    );
    const { selftestProjectDecisionResolution } = await import(
      '../automations/project-decision-resolution/project-decision-resolution.selftest.mjs'
    );
    const { selftestProjectWorkPromotion } = await import(
      '../automations/project-work-promotion/project-work-promotion.selftest.mjs'
    );
    const { selftestNotionRecordMappings } = await import(
      '../integrations/notion/notion.selftest.mjs'
    );
    const suites = [
      ['core', () => selftest(root)],
      ['private-json-input', () => selftestPrivateJsonInput()],
      ['connected-acceptance-inspection', () => selftestConnectedAcceptanceInspection(root)],
      ['prepared-work', () => selftestPreparedWork(root)],
      ['prepared-review-batches', () => selftestPreparedReviewBatches(root)],
      ['prepared-connected-plans', () => selftestPreparedConnectedPlans(root)],
      ['automation-proposals', () => selftestAutomationProposals(root)],
      ['configuration-transactions', () => selftestConfigurationTransactions(root)],
      ['host-realizations', () => selftestHostRealizations(root)],
      ['pack-installs', () => selftestPackInstalls(root)],
      ['development-candidate-locks', () => selftestDevelopmentCandidateLocks(root)],
      ['development-runs', () => selftestDevelopmentRuns(root)],
      ['development-host-observations', () => selftestDevelopmentHostObservations(root)],
      ['development-host-runner', () => selftestDevelopmentHostRunner(root)],
      ['legacy-finalization', () => selftestLegacyFinalization(root)],
      ['legacy-transition-finalization', () => selftestLegacyTransitionFinalization(root)],
      [
        'development-workflow-lifecycle-finalization',
        () => selftestDevelopmentWorkflowLifecycleFinalization(root)
      ],
      ['repository-cutover', () => selftestRepositoryCutover(root)],
      ['private-request-files', () => selftestPrivateRequestFiles()],
      ['email-connected-context', () => selftestEmailConnectedContext(root)],
      ['task-capture-connected-context', () => selftestTaskCaptureConnectedContext(root)],
      ['project-pulse-connected-context', () => selftestProjectPulseConnectedContext(root)],
      ['organization-capture', () => selftestOrganizationCapture(root)],
      [
        'organization-capture-connected-context',
        () => selftestOrganizationCaptureConnectedContext(root)
      ],
      ['project-capture', () => selftestProjectCapture(root)],
      ['project-capture-connected-context', () => selftestProjectCaptureConnectedContext(root)],
      ['contact-capture', () => selftestContactCapture(root)],
      ['contact-capture-connected-context', () => selftestContactCaptureConnectedContext(root)],
      ['drive-filing', () => selftestDriveFiling(root)],
      ['feature-capture', () => selftestFeatureCapture(root)],
      ['feature-definition', () => selftestFeatureDefinition(root)],
      ['repository-review', () => selftestRepositoryReview(root)],
      ['slack-channel-ingestion', () => selftestSlackChannelIngestion(root)],
      [
        'slack-conversation-review-connected-context',
        () => selftestSlackConversationReviewConnectedContext(root)
      ],
      ['process-capture', () => selftestProcessCapture(root)],
      ['process-red-team', () => selftestProcessRedTeam(root)],
      ['project-decision-resolution', () => selftestProjectDecisionResolution(root)],
      ['project-work-promotion', () => selftestProjectWorkPromotion(root)],
      ['notion-record-mappings', () => selftestNotionRecordMappings(root)]
    ];
    const failedSuites = [];
    for (const [name, run] of suites) {
      try {
        const result = await run();
        if (!result) {
          failedSuites.push(name);
          process.stderr.write('CORE SELFTEST SUITE FAIL: ' + name + ' returned no passing result.\n');
        }
      } catch (error) {
        failedSuites.push(name);
        process.stderr.write(
          'CORE SELFTEST SUITE FAIL: ' + name + ': '
            + (error?.stack || error?.message || String(error)) + '\n'
        );
      }
    }
    if (failedSuites.length) {
      process.stderr.write(
        'CORE SELFTEST SUMMARY: ' + failedSuites.length + ' of ' + suites.length
          + ' suites failed: ' + failedSuites.join(', ') + '.\n'
      );
    } else {
      process.stdout.write(
        'CORE SELFTEST SUMMARY: all ' + suites.length + ' suites passed.\n'
      );
    }
    process.exitCode = failedSuites.length ? 1 : 0;
    return;
  }

  if (command === 'fixtures') {
    const fixtureModes = args.filter((argument) => {
      return ['--check', '--update', '--finalize'].includes(argument);
    });
    if (fixtureModes.length !== 1) {
      throw new Error('fixtures requires exactly one of --check, --update, or --finalize.');
    }
    if (fixtureModes[0] === '--finalize') {
      const finalization = readLegacyFinalizationFixtureRequest(
        root,
        requiredOption(args, '--finalize')
      );
      const fixtures = await writeLegacyFinalizationFixtures(root, finalization);
      process.stdout.write(
        'Updated ' + fixtures.size
          + ' generated Core fixtures through the exact legacy-finalization boundary.\n'
      );
      return;
    }
    if (fixtureModes[0] === '--update') {
      const fixtures = await writeSoterFixtures(root);
      process.stdout.write('Updated ' + fixtures.size + ' generated Core fixtures.\n');
      return;
    }
    if (fixtureModes[0] === '--check') {
      const result = await checkSoterFixtures(root);
      if (json) {
        print({ matches: result.matches, mismatches: result.mismatches });
      } else if (result.matches) {
        process.stdout.write('Core fixtures: current.\n');
      } else {
        for (const mismatch of result.mismatches) {
          process.stderr.write('STALE ' + mismatch.path + ': ' + mismatch.reason + '\n');
        }
      }
      process.exitCode = result.matches ? 0 : 1;
      return;
    }
    throw new Error('fixtures requires --check, --update, or --finalize ABSOLUTE_PRIVATE_PATH.');
  }

  throw new Error(
    'Usage: node soter/core/cli.mjs <legacy-checker-receipt-inspect|legacy-checker-projection-inspect|resolve|config-inspect|development-candidate-lock|development-request-create|development-result-record|development-host-evaluate|development-host-judge|development-host-finalize|development-host-evidence-historical|development-historical-evidence-batch-request|development-historical-evidence-batch-execute|development-historical-evidence-batch-recover|development-historical-evidence-batch-inspect|development-host-evidence-final|development-host-evidence-finalization-request-create|development-host-evidence-finalize-batch|development-host-evidence-finalization-rollback|development-host-evidence-finalization-verify|development-workflow-lifecycle-request-create|development-workflow-lifecycle-plan|legacy-finalization-transition-request-create|repository-cutover-request-create|repository-cutover-prepare|repository-cutover-execute|repository-cutover-recover|repository-cutover-rollback|repository-cutover-inspect|development-run-inspect|configuration-change-plan|configuration-change-request|configuration-change-confirm|configuration-change-start|configuration-change-execute|configuration-change-recover|configuration-change-inspect|host-realization-plan|host-realization-request|host-realization-confirm|host-realization-start|host-realization-execute|host-realization-recover|host-realization-inspect|pack-install-plan|pack-install-request|pack-install-confirm|pack-install-start|pack-install-execute|pack-install-recover|pack-install-inspect|operator-prepare|operator-prepared-inspect|operator-prepared-review|operator-prepared-derived-review|operator-review-batch-create|operator-review-batch|operator-connected-plan-create|operator-connected-plan|operator-inspect|connected-acceptance-inspect|operator-approval-review|prepare|context-connected-prepare|context-connected-finalize|slack-conversation-context-connected-prepare|slack-conversation-context-connected-finalize|slack-conversation-connected-inspect|slack-conversation-connected-review|meeting-intake-decision-inspect|meeting-intake-decision-commit|meeting-intake-proposal-inspect|meeting-intake-proposal-commit|meeting-intake-proposal-material|email-context-connected-prepare|email-context-connected-finalize|email-triage-decision-inspect|email-triage-decision-commit|email-triage-proposal-inspect|email-triage-proposal-commit|email-triage-proposal-material|task-context-connected-prepare|task-context-connected-finalize|task-capture-decision-inspect|task-capture-decision-commit|task-capture-proposal-inspect|task-capture-proposal-commit|task-capture-proposal-material|organization-context-connected-prepare|organization-context-connected-finalize|organization-capture-decision-inspect|organization-capture-decision-commit|organization-capture-proposal-inspect|organization-capture-proposal-commit|organization-capture-proposal-material|project-capture-context-connected-prepare|project-capture-context-connected-finalize|project-capture-decision-inspect|project-capture-decision-commit|project-capture-proposal-inspect|project-capture-proposal-commit|project-capture-proposal-material|contact-context-connected-prepare|contact-context-connected-finalize|contact-capture-decision-inspect|contact-capture-decision-commit|contact-capture-proposal-inspect|contact-capture-proposal-commit|contact-capture-proposal-material|project-context-connected-prepare|project-context-connected-finalize|project-pulse-decision-inspect|project-pulse-decision-commit|project-pulse-proposal-inspect|project-pulse-proposal-commit|project-pulse-proposal-material|proposal-connected-batch-preview|connected-approval-request|connected-approval-confirm|connected-transaction-prepare|connected-transaction-complete|connected-transaction-reconcile|doctor|probe-prepare|probe-complete|capability-complete|plan-complete|host-fail|host-get|host-list|fixtures|selftest> [options]\n'
      + '  legacy-checker-receipt-inspect --receipt-id ID [--root PATH] [--json]\n'
      + '  legacy-checker-projection-inspect [--root PATH] [--json]\n'
      + '  resolve [--config PATH] [--host ID] [--output PATH] [--json]\n'
      + '  config-inspect [--config PATH] [--host ID | --lock PATH] [--output PATH] [--json]\n'
      + '  development-candidate-lock --config PATH --workflow ID --host <codex|claude> [--json]\n'
      + '  development-request-create --lock PATH --workflow ID --request-id ID (--evaluation-suite | --invocation ABSOLUTE_PRIVATE_PATH) [--at TIME] [--json]\n'
      + '  development-result-record --lock PATH --request-id ID --outcome ABSOLUTE_PRIVATE_PATH [--at TIME] [--json]\n'
      + '  development-host-evaluate --request-id ID --executable ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  development-host-judge --request-id ID --executable ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  development-host-finalize --request-id ID [--judgment ABSOLUTE_PRIVATE_HUMAN_ATTESTATION_PATH] [--json]\n'
      + '  development-host-evidence-historical --request-id ID [--json]\n'
      + '  development-historical-evidence-batch-request --id ID --created-at TIME --valid-until TIME --workflows ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  development-historical-evidence-batch-execute --request ABSOLUTE_PRIVATE_PATH --at TIME [--json]\n'
      + '  development-historical-evidence-batch-recover --request ABSOLUTE_PRIVATE_PATH --at TIME [--json]\n'
      + '  development-historical-evidence-batch-inspect --request ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  development-host-evidence-final --request-id ID --lock GOVERNED_FIXTURE_LOCK_PATH --at TIME [--json]\n'
      + '  development-host-evidence-finalization-request-create --id ID --created-at TIME --valid-until TIME --legacy-finalization ABSOLUTE_PRIVATE_PATH --workflows ABSOLUTE_PRIVATE_PATH --output ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  development-host-evidence-finalize-batch --request ABSOLUTE_PRIVATE_PATH --legacy-finalization ABSOLUTE_PRIVATE_PATH --at TIME [--json]\n'
      + '  development-host-evidence-finalization-rollback --request ABSOLUTE_PRIVATE_PATH --at TIME [--json]\n'
      + '  development-host-evidence-finalization-verify --request ABSOLUTE_PRIVATE_PATH --legacy-finalization ABSOLUTE_PRIVATE_PATH --at TIME [--json]\n'
      + '  development-workflow-lifecycle-request-create --id ID --created-at TIME --output ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  development-workflow-lifecycle-plan --request ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  legacy-finalization-transition-request-create --id ID --created-at TIME --valid-until TIME --at TIME --lifecycle-request ABSOLUTE_PRIVATE_PATH --checker-receipt ABSOLUTE_PRIVATE_PATH --output ABSOLUTE_PRIVATE_PATH --fixture-output ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  repository-cutover-request-create --id ID --created-at TIME --lifecycle-request ABSOLUTE_PRIVATE_PATH --transition-request ABSOLUTE_PRIVATE_PATH --fixture-finalization-request ABSOLUTE_PRIVATE_PATH --output ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  repository-cutover-prepare --request ABSOLUTE_PRIVATE_PATH --at TIME [--json]\n'
      + '  repository-cutover-execute --checkpoint-id ID --at TIME [--json]\n'
      + '  repository-cutover-recover --checkpoint-id ID --at TIME [--json]\n'
      + '  repository-cutover-rollback --checkpoint-id ID --at TIME [--json]\n'
      + '  repository-cutover-inspect --checkpoint-id ID [--json]\n'
      + '  development-run-inspect --request-id ID [--json]\n'
      + '  configuration-change-plan --configuration NAME --candidate ABSOLUTE_PRIVATE_PATH [--plan-id ID] [--at TIME] [--json]\n'
      + '  configuration-change-request --plan-id ID --reason TEXT --expires-at TIME [--request-id ID] [--at TIME] [--json]\n'
      + '  configuration-change-confirm --request-id ID --actor ID --reason TEXT [--confirmation-id ID] [--at TIME] [--json]\n'
      + '  configuration-change-start --confirmation-id ID [--checkpoint-id ID] [--at TIME] [--json]\n'
      + '  configuration-change-execute --checkpoint-id ID [--at TIME] [--json]\n'
      + '  configuration-change-recover --checkpoint-id ID [--at TIME] [--json]\n'
      + '  configuration-change-inspect --plan-id ID [--request-id ID] [--confirmation-id ID] [--consumption-id ID] [--checkpoint-id ID] [--at TIME] [--json]\n'
      + '  host-realization-plan --configuration NAME --valid-until TIME [--plan-id ID] [--at TIME] [--json]\n'
      + '  host-realization-request --plan-id ID --reason TEXT --expires-at TIME [--request-id ID] [--at TIME] [--json]\n'
      + '  host-realization-confirm --request-id ID --actor ID --reason TEXT [--confirmation-id ID] [--at TIME] [--json]\n'
      + '  host-realization-start --confirmation-id ID [--checkpoint-id ID] [--at TIME] [--json]\n'
      + '  host-realization-execute --checkpoint-id ID [--at TIME] [--json]\n'
      + '  host-realization-recover --checkpoint-id ID [--at TIME] [--json]\n'
      + '  host-realization-inspect --plan-id ID [--request-id ID] [--confirmation-id ID] [--consumption-id ID] [--checkpoint-id ID] [--at TIME] [--json]\n'
      + '  pack-install-plan --target ABSOLUTE_PRIVATE_TARGET --capsule ABSOLUTE_LOCAL_CAPSULE [--capsule PATH ...] --valid-until TIME [--bundle PATH] [--base-contract VERSION] [--plan-id ID] [--at TIME] [--json]\n'
      + '  pack-install-request --target ABSOLUTE_PRIVATE_TARGET --plan-id ID --reason TEXT --expires-at TIME [--request-id ID] [--at TIME] [--json]\n'
      + '  pack-install-confirm --target ABSOLUTE_PRIVATE_TARGET --request-id ID --actor ID --reason TEXT [--confirmation-id ID] [--at TIME] [--json]\n'
      + '  pack-install-start --target ABSOLUTE_PRIVATE_TARGET --confirmation-id ID [--checkpoint-id ID] [--at TIME] [--json]\n'
      + '  pack-install-execute --target ABSOLUTE_PRIVATE_TARGET --checkpoint-id ID [--at TIME] [--json]\n'
      + '  pack-install-recover --target ABSOLUTE_PRIVATE_TARGET --checkpoint-id ID [--at TIME] [--json]\n'
      + '  pack-install-inspect --target ABSOLUTE_PRIVATE_TARGET [--plan-id ID] [--request-id ID] [--confirmation-id ID] [--consumption-id ID] [--checkpoint-id ID] [--at TIME] [--json]\n'
      + '  operator-prepare --configuration NAME --configuration-basis tracked-contained|private-active --automation ID --input ABSOLUTE_PRIVATE_PATH [--preparation-mode contained|connected-acquisition] [--host ID] [--at TIME] [--json]\n'
      + '  operator-prepared-inspect --work-id ID [--json]\n'
      + '  operator-prepared-review --work-id ID [--json]\n'
      + '  operator-prepared-derived-review --work-id ID [--json]\n'
      + '  operator-review-batch-create --work-id ID --action-id ID [--action-id ID ...] [--at TIME] [--json]\n'
      + '  operator-review-batch --batch-id ID [--json]\n'
      + '  operator-connected-plan-create --batch-id ID [--at TIME] [--json]\n'
      + '  operator-connected-plan --plan-id ID [--json]\n'
      + '  operator-inspect [--request-id ID | --approval-id ID | --checkpoint ID] [--at TIME] [--json]\n'
      + '  connected-acceptance-inspect [--checkpoint ID ...] [--at TIME] [--json]\n'
      + '  operator-approval-review --request-id ID [--json]\n'
      + '  prepare --lock PATH [--scenario PATH] [--output PATH] [--evidence-dir PATH] [--json]\n'
      + '  context-connected-prepare --work ID [--at TIME] [--json]\n'
      + '  context-connected-finalize --checkpoint ID [--json]\n'
      + '  slack-conversation-context-connected-prepare --work ID [--at TIME] [--json]\n'
      + '  slack-conversation-context-connected-finalize --checkpoint ID [--json]\n'
      + '  slack-conversation-connected-inspect --work ID [--json]\n'
      + '  slack-conversation-connected-review --work ID [--json]\n'
      + '  meeting-intake-decision-inspect --lock PATH --snapshot ID [--json]\n'
      + '  meeting-intake-decision-commit --lock PATH --snapshot ID --decision-input PATH [--decision-id ID] [--actor ID] [--json]\n'
      + '  email-context-connected-prepare --work ID [--at TIME] [--json]\n'
      + '  email-context-connected-finalize --checkpoint ID [--json]\n'
      + '  email-triage-decision-inspect --lock PATH --snapshot ID [--json]\n'
      + '  email-triage-decision-commit --lock PATH --snapshot ID --decision-input PATH [--decision-id ID] [--actor ID] [--json]\n'
      + '  email-triage-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  email-triage-proposal-commit --lock PATH --decision ID --proposal-input ABSOLUTE_PATH [--proposal-id ID] [--actor ID] [--json]\n'
      + '  email-triage-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  task-context-connected-prepare --work ID [--at TIME] [--json]\n'
      + '  task-context-connected-finalize --checkpoint ID [--json]\n'
      + '  task-capture-decision-inspect --lock PATH --snapshot ID [--at ISO] [--json]\n'
      + '  task-capture-decision-commit --lock PATH --snapshot ID [--decision-id ID] [--actor ID] [--json]\n'
      + '  task-capture-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  task-capture-proposal-commit --lock PATH --decision ID [--proposal-id ID] [--actor ID] [--json]\n'
      + '  task-capture-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  organization-context-connected-prepare --work ID [--at TIME] [--json]\n'
      + '  organization-context-connected-finalize --checkpoint ID [--json]\n'
      + '  organization-capture-decision-inspect --lock PATH --snapshot ID [--json]\n'
      + '  organization-capture-decision-commit --lock PATH --snapshot ID [--decision-id ID] [--actor ID] [--json]\n'
      + '  organization-capture-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  organization-capture-proposal-commit --lock PATH --decision ID [--proposal-id ID] [--actor ID] [--json]\n'
      + '  organization-capture-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  project-capture-context-connected-prepare --work ID [--at TIME] [--json]\n'
      + '  project-capture-context-connected-finalize --checkpoint ID [--json]\n'
      + '  project-capture-decision-inspect --lock PATH --snapshot ID [--json]\n'
      + '  project-capture-decision-commit --lock PATH --snapshot ID [--decision-id ID] [--actor ID] [--json]\n'
      + '  project-capture-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  project-capture-proposal-commit --lock PATH --decision ID [--proposal-id ID] [--actor ID] [--json]\n'
      + '  project-capture-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  contact-context-connected-prepare --work ID [--at TIME] [--json]\n'
      + '  contact-context-connected-finalize --checkpoint ID [--json]\n'
      + '  contact-capture-decision-inspect --lock PATH --snapshot ID [--json]\n'
      + '  contact-capture-decision-commit --lock PATH --snapshot ID [--decision-id ID] [--actor ID] [--json]\n'
      + '  contact-capture-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  contact-capture-proposal-commit --lock PATH --decision ID [--proposal-id ID] [--actor ID] [--json]\n'
      + '  contact-capture-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  project-context-connected-prepare --work ID [--at TIME] [--json]\n'
      + '  project-context-connected-finalize --checkpoint ID [--json]\n'
      + '  project-pulse-decision-inspect --lock PATH --snapshot ID [--json]\n'
      + '  project-pulse-decision-commit --lock PATH --snapshot ID [--decision-id ID] [--actor ID] [--json]\n'
      + '  project-pulse-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  project-pulse-proposal-commit --lock PATH --decision ID [--proposal-id ID] [--actor ID] [--json]\n'
      + '  project-pulse-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  meeting-intake-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  meeting-intake-proposal-commit --lock PATH --decision ID [--proposal-id ID] [--actor ID] [--json]\n'
      + '  meeting-intake-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  proposal-connected-batch-preview --lock PATH --proposal ID --action-id ID [--action-id ID] [--change-set-id ID] [--batch-id ID] [--json]\n'
      + '  connected-approval-request --configuration-basis private-active --lock PATH --run PATH --batch PATH --change-set PATH --request-id ID --reason TEXT --expires-at TIME [--json]\n'
      + '  connected-approval-confirm --request-id ID --approval-id ID --actor ACTOR --reason TEXT [--json]\n'
      + '  connected-transaction-prepare --approval-id ID [--json]\n'
      + '  connected-transaction-complete --checkpoint ID --call ID --response ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  connected-transaction-reconcile --checkpoint ID [--json]\n'
      + '  doctor --lock PATH [--level offline|connected] [--probe PATH ...] [--probe-checkpoint ID ...] [--config PATH] [--json]\n'
      + '  probe-prepare --configuration-basis private-active --lock PATH --provider ID [--json]\n'
      + '  probe-complete --checkpoint ID --call ID --response ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  capability-complete --checkpoint ID --response ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  plan-complete --checkpoint ID --call ID --response ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  host-fail --checkpoint ID [--call ID] --kind KIND [--at TIME] [--json]\n'
      + '  host-get --checkpoint ID\n'
      + '  host-list [--state requested|completed|failed|needs-attention|blocked]\n'
      + '  fixtures <--check|--update> [--json]'
  );
}

main().catch((error) => {
  process.stderr.write('Soter Core: ' + error.message + '\n');
  process.exitCode = 1;
});
