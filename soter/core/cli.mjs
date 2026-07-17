#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatDoctorReport, runConnectedDoctor, runOfflineDoctor } from './doctor.mjs';
import { assembleMeetingIntakeContext } from './context.mjs';
import {
  finalizeMeetingIntakeConnectedContext,
  prepareMeetingIntakeConnectedContext
} from '../automations/meeting-intake/context.mjs';
import {
  finalizeEmailTriageConnectedAcquisition,
  prepareEmailTriageConnectedAcquisition
} from '../automations/email-triage/context.mjs';
import {
  commitMeetingIntakeDecision,
  inspectMeetingIntakeDecisionContext
} from '../automations/meeting-intake/decision.mjs';
import {
  commitEmailTriageDecision,
  inspectEmailTriageDecisionContext
} from '../automations/email-triage/decision.mjs';
import {
  commitEmailTriageProposal,
  inspectEmailTriageProposalDecision,
  inspectEmailTriageProposalMaterial
} from '../automations/email-triage/proposal.mjs';
import {
  createContextAssemblyEvidence,
  createContainedTransactionEvidence,
  createResolutionEvidence,
  createRunPreparationEvidence
} from './evidence.mjs';
import { checkSoterFixtures, writeSoterFixtures } from './fixtures.mjs';
import {
  buildConfigurationView,
  formatConfigurationView
} from './configuration-view.mjs';
import {
  readJson,
  readPrivateJsonInput,
  resolveRepoPath,
  writeJson
} from './lib/canonical-json.mjs';
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
  prepareDurableCapabilityExecution,
  prepareDurableConnectedTransactionExecution,
  prepareDurableConnectedTransactionReconciliation,
  prepareDurableOperationPlanExecution,
  prepareDurableProviderProbeExecution
} from './service.mjs';
import {
  proposeDurableMeetingIntakeChangeSet,
  runContainedMeetingIntakeTransaction
} from '../automations/meeting-intake/transaction.mjs';
import {
  compileConnectedOperationBatch
} from './connected-transactions.mjs';
import {
  beginConnectedApprovalRequest,
  beginProposalConnectedApprovalRequest,
  confirmConnectedApprovalRequest,
  confirmProposalConnectedApprovalRequest,
  readConnectedApprovalRequest
} from './operator-authority.mjs';
import { createProposalConnectedBatch } from './proposal-connected-batches.mjs';
import { inspectConnectedApprovalReviewMaterial } from './connected-approval-review.mjs';
import { inspectConnectedOperatorActivity } from './operator-inspection.mjs';
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
    const lock = readJson(resolveRepoPath(root, lockPath));
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
            return observation.$contract === 'soter://contracts/provider-probe/v1'
              || observation.$contract === 'soter://contracts/provider-probe/v2';
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
    const lockPath = requiredOption(args, '--lock');
    const providerImplementation = requiredOption(args, '--provider');
    const prepared = await prepareDurableProviderProbeExecution({
      root,
      lockPath,
      providerImplementation,
      callId: option(args, '--call-id'),
      probeId: option(args, '--probe-id'),
      at: createdAt,
      validForSeconds: Number(option(args, '--valid-for-seconds', '300'))
    });
    const output = option(args, '--output');
    if (output) writeJson(resolveRepoPath(root, output), prepared.checkpoint);
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall || prepared.checkpoint.call;
      process.stdout.write(
        'Prepared ' + prepared.checkpoint.id + ' in state ' + prepared.checkpoint.state + '.\n'
          + 'Provider operation: ' + call.transport.server + '/'
          + (call.transport.operation || 'none') + '\n'
          + 'Native host tool: ' + (call.transport.tool || 'none') + '\n'
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Raw provider response persistence: disabled by Core\n'
          + (output ? 'Wrote: ' + output + '\n' : '')
      );
    }
    if (prepared.checkpoint.state !== 'requested') process.exitCode = 1;
    return;
  }

  if (command === 'probe-complete') {
    const response = readPrivateJsonInput(root, requiredOption(args, '--response'));
    const completed = await completeDurableProviderProbeExecution({
      root,
      checkpointId: requiredOption(args, '--checkpoint'),
      callId: option(args, '--call'),
      response,
      at: createdAt
    });
    const checkpointOutput = option(args, '--checkpoint-output');
    const probeOutput = option(args, '--probe-output');
    if (checkpointOutput) {
      writeJson(resolveRepoPath(root, checkpointOutput), completed.checkpoint);
    }
    if (probeOutput && completed.checkpoint.result) {
      writeJson(resolveRepoPath(root, probeOutput), completed.checkpoint.result);
    }
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
          + (checkpointOutput ? 'Wrote checkpoint: ' + checkpointOutput + '\n' : '')
          + (probeOutput && completed.checkpoint.result ? 'Wrote probe: ' + probeOutput + '\n' : '')
      );
    }
    if (completed.checkpoint.state === 'failed') process.exitCode = 1;
    return;
  }

  if (command === 'capability-prepare') {
    const prepared = await prepareDurableCapabilityExecution({
      root,
      lockPath: requiredOption(args, '--lock'),
      runPath: requiredOption(args, '--run'),
      capability: requiredOption(args, '--capability'),
      authority: requiredOption(args, '--authority'),
      providerImplementation: requiredOption(args, '--provider'),
      input: readJson(resolveRepoPath(root, requiredOption(args, '--input'))),
      callId: option(args, '--call-id'),
      at: createdAt
    });
    const output = option(args, '--output');
    if (output) writeJson(resolveRepoPath(root, output), prepared.checkpoint);
    if (json) {
      print(prepared);
    } else {
      process.stdout.write(
        'Prepared ' + prepared.checkpoint.id + ' in state ' + prepared.checkpoint.state + '.\n'
          + (prepared.checkpoint.state === 'requested'
            ? 'Provider operation: ' + prepared.checkpoint.call.transport.server + '/'
              + prepared.checkpoint.call.transport.operation + '\n'
              + 'Native host tool: ' + prepared.checkpoint.call.transport.tool + '\n'
            : 'Host request emitted: no\n')
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Durable run: ' + prepared.runPath + '\n'
          + 'Connected write approval accepted by this command: no\n'
          + (output ? 'Wrote: ' + output + '\n' : '')
      );
    }
    if (prepared.checkpoint.state !== 'requested') process.exitCode = 1;
    return;
  }

  if (command === 'capability-complete') {
    const completed = await completeDurableCapabilityExecution({
      root,
      checkpointId: requiredOption(args, '--checkpoint'),
      response: readPrivateJsonInput(root, requiredOption(args, '--response')),
      at: createdAt
    });
    const checkpointOutput = option(args, '--checkpoint-output');
    const output = option(args, '--output');
    if (checkpointOutput) {
      writeJson(resolveRepoPath(root, checkpointOutput), completed.checkpoint);
    }
    if (output && completed.checkpoint.result) {
      writeJson(resolveRepoPath(root, output), completed.checkpoint.result);
    }
    if (json) {
      print(completed);
    } else {
      process.stdout.write(
        'Completed ' + completed.checkpoint.id + ' in state '
          + completed.checkpoint.state + '.\n'
          + 'Raw provider response persisted by Core: no\n'
          + (checkpointOutput ? 'Wrote checkpoint: ' + checkpointOutput + '\n' : '')
          + (output && completed.checkpoint.result ? 'Wrote output: ' + output + '\n' : '')
      );
    }
    if (completed.checkpoint.state !== 'completed') process.exitCode = 1;
    return;
  }

  if (command === 'plan-prepare') {
    if (option(args, '--output')) {
      throw new Error(
        'Operation plan checkpoints are private runtime state and cannot be exported into the repository.'
      );
    }
    const prepared = await prepareDurableOperationPlanExecution({
      root,
      lockPath: requiredOption(args, '--lock'),
      runPath: requiredOption(args, '--run'),
      plan: readPrivateJsonInput(root, requiredOption(args, '--plan')),
      at: createdAt
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared operation plan ' + prepared.checkpoint.plan.id + ' in state '
          + prepared.checkpoint.state + '.\n'
          + 'Current step: ' + (prepared.checkpoint.currentStepId || 'none') + '\n'
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
    const begin = batch.$contract === 'soter://contracts/connected-operation-batch/v2'
      ? beginProposalConnectedApprovalRequest
      : beginConnectedApprovalRequest;
    const begun = await begin({
      root,
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
    const request = readConnectedApprovalRequest({
      root,
      requestId,
      at: createdAt,
      allowExpired: true
    });
    const confirm = request.batch.$contract === 'soter://contracts/connected-operation-batch/v2'
      ? confirmProposalConnectedApprovalRequest
      : confirmConnectedApprovalRequest;
    const confirmed = await confirm({
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
      input: readPrivateJsonInput(root, requiredOption(args, '--input')),
      createdAt
    });
    if (json) {
      print(work);
    } else {
      process.stdout.write(
        'Prepared private operator work ' + work.id + ' at state ' + work.state + '.\n'
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
    const prepared = await prepareMeetingIntakeConnectedContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      runPath: requiredOption(args, '--run'),
      snapshotId: option(
        args,
        '--snapshot-id',
        'context.meeting-intake.connected.' + idPart
      ),
      meetingId: requiredOption(args, '--meeting-id'),
      recordingUri: requiredOption(args, '--recording-uri'),
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
    const prepared = await prepareEmailTriageConnectedAcquisition({
      root,
      lockPath: requiredOption(args, '--lock'),
      runPath: requiredOption(args, '--run'),
      snapshotId: option(
        args,
        '--snapshot-id',
        'context.email-triage.connected-acquisition.' + idPart
      ),
      query: requiredOption(args, '--query'),
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

  if (command === 'meeting-intake-proposal') {
    const proposal = proposeDurableMeetingIntakeChangeSet({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(
        args,
        '--change-set-id',
        'changeset.meeting-intake.' + idPart
      ),
      createdAt
    });
    const output = option(args, '--output');
    if (output) writeJson(resolveRepoPath(root, output), proposal);
    if (json) {
      print(proposal);
    } else {
      process.stdout.write(
        'Proposed meeting-intake change set ' + proposal.id + '.\n'
          + 'Decision: ' + proposal.basis.id + ' (' + proposal.basis.fingerprint + ')\n'
          + 'Operations: ' + proposal.operations.length + '\n'
          + (output ? 'Reviewable change set: ' + output + '\n' : '')
          + 'Approval created: no\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'host-fail') {
    const checkpointId = requiredOption(args, '--checkpoint');
    const output = option(args, '--output');
    if (output) {
      const current = getDurableHostExecution({ root, checkpointId });
      if (current.checkpoint.kind === 'connected-transaction') {
        throw new Error(
          'Connected transaction checkpoints are private runtime state and cannot be exported into the repository.'
        );
      }
    }
    const failed = await failDurableHostExecution({
      root,
      checkpointId,
      errorKind: requiredOption(args, '--kind'),
      message: requiredOption(args, '--message'),
      callId: option(args, '--call'),
      at: createdAt
    });
    if (output) writeJson(resolveRepoPath(root, output), failed.checkpoint);
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
          + (output ? 'Wrote: ' + output + '\n' : '')
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

  if (command === 'context') {
    const lockPath = requiredOption(args, '--lock');
    const lock = readJson(resolveRepoPath(root, lockPath));
    const runId = option(args, '--run-id', 'run.' + lock.configuration.name + '.context.' + idPart);
    const snapshotId = option(
      args,
      '--snapshot-id',
      'context.' + lock.configuration.name + '.' + idPart
    );
    const resolutionEvidenceId = option(
      args,
      '--resolution-evidence-id',
      'evidence.' + lock.configuration.name + '.resolution.' + idPart
    );
    const contextEvidenceId = option(
      args,
      '--context-evidence-id',
      'evidence.' + lock.configuration.name + '.context.' + idPart
    );
    const contained = await assembleMeetingIntakeContext({
      root,
      lock,
      lockPath,
      scenarioPath: option(args, '--scenario'),
      runId,
      snapshotId,
      createdAt,
      meetingId: requiredOption(args, '--meeting-id'),
      recordingUri: requiredOption(args, '--recording-uri'),
      evidenceIds: [resolutionEvidenceId, contextEvidenceId]
    });
    const evidence = [
      createResolutionEvidence({ lock, id: resolutionEvidenceId, createdAt }),
      createContextAssemblyEvidence({
        lock,
        envelope: contained.envelope,
        snapshot: contained.snapshot,
        id: contextEvidenceId,
        createdAt
      })
    ];
    const output = option(args, '--output');
    const snapshotOutput = option(args, '--snapshot-output');
    if (output) writeJson(resolveRepoPath(root, output), contained.envelope);
    if (snapshotOutput) writeJson(resolveRepoPath(root, snapshotOutput), contained.snapshot);
    writeEvidence(root, option(args, '--evidence-dir'), evidence);
    if (json) {
      print({ ...contained, evidence });
    } else {
      process.stdout.write(
        'Assembled ' + contained.snapshot.entries.length + ' context entries through '
          + contained.envelope.effects.length + ' typed fixture reads.\n'
          + 'Run state: ' + contained.envelope.lifecycleState + '; external writes executed: 0\n'
      );
    }
    return;
  }

  if (command === 'transaction') {
    const lockPath = requiredOption(args, '--lock');
    const lock = readJson(resolveRepoPath(root, lockPath));
    const approved = args.includes('--approve');
    const runId = option(args, '--run-id', 'run.' + lock.configuration.name + '.transaction.' + idPart);
    const transactionEvidenceId = 'evidence.' + lock.configuration.name + '.transaction.' + idPart;
    const resolutionEvidenceId = 'evidence.' + lock.configuration.name + '.resolution.' + idPart;
    const transaction = await runContainedMeetingIntakeTransaction({
      root,
      lock,
      lockPath,
      scenarioPath: option(args, '--scenario'),
      runId,
      snapshotId: option(args, '--snapshot-id', 'context.' + lock.configuration.name + '.transaction.' + idPart),
      decisionId: option(args, '--decision-id', 'decision.' + lock.configuration.name + '.' + idPart),
      changeSetId: option(args, '--change-set-id', 'changeset.' + lock.configuration.name + '.' + idPart),
      approvalId: option(args, '--approval-id', 'approval.' + lock.configuration.name + '.' + idPart),
      createdAt,
      actor: option(args, '--actor', 'user'),
      approved,
      evidenceIds: approved ? [resolutionEvidenceId, transactionEvidenceId] : []
    });
    const evidence = approved ? [
      createResolutionEvidence({ lock, id: resolutionEvidenceId, createdAt }),
      createContainedTransactionEvidence({
        lock,
        envelope: transaction.envelope,
        decision: transaction.decision,
        changeSet: transaction.changeSet,
        approval: transaction.approval,
        id: transactionEvidenceId,
        createdAt
      })
    ] : [];
    const output = option(args, '--output');
    const snapshotOutput = option(args, '--snapshot-output');
    const changeSetOutput = option(args, '--change-set-output');
    const approvalOutput = option(args, '--approval-output');
    if (output) writeJson(resolveRepoPath(root, output), transaction.envelope);
    if (snapshotOutput) writeJson(resolveRepoPath(root, snapshotOutput), transaction.snapshot);
    if (changeSetOutput) writeJson(resolveRepoPath(root, changeSetOutput), transaction.changeSet);
    if (approvalOutput && transaction.approval) {
      writeJson(resolveRepoPath(root, approvalOutput), transaction.approval);
    }
    writeEvidence(root, option(args, '--evidence-dir'), evidence);
    if (json) {
      print({ ...transaction, evidence });
    } else if (!approved) {
      process.stdout.write(
        'Previewed ' + transaction.changeSet.operations.length + ' write operations.\n'
          + 'State: proposed; writes executed: 0. Re-run with --approve to authorize this generated scope.\n'
      );
    } else {
      process.stdout.write(
        'Transaction ' + transaction.changeSet.state + ' with '
          + transaction.changeSet.operations.length + ' approved writes.\n'
          + 'Read-after-write verification: ' + transaction.changeSet.verification.state + '\n'
      );
    }
    return;
  }

  if (command === 'connected-batch-preview') {
    const lock = readJson(resolveRepoPath(root, requiredOption(args, '--lock')));
    const changeSet = readJson(resolveRepoPath(root, requiredOption(args, '--change-set')));
    const batch = compileConnectedOperationBatch({
      root,
      lock,
      changeSet,
      id: option(
        args,
        '--batch-id',
        'batch.' + lock.configuration.name + '.' + idPart
      ),
      createdAt
    });
    if (json) {
      print(batch);
    } else {
      process.stdout.write(
        'Compiled connected operation batch ' + batch.id + '.\n'
          + 'Executable: ' + (batch.executable ? 'yes' : 'no') + '\n'
          + 'Operations: ' + batch.operations.length + '\n'
          + 'Batch fingerprint: ' + batch.batchFingerprint + '\n'
          + (batch.blockers.length
            ? 'Blockers:\n  - ' + batch.blockers.join('\n  - ') + '\n'
            : '')
          + 'Provider calls executed: 0\n'
      );
    }
    if (!batch.executable) process.exitCode = 1;
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

  if (command === 'selftest') {
    const { selftest } = await import('./selftest.mjs');
    const { selftestPreparedWork } = await import('./prepared-work.selftest.mjs');
    const { selftestPreparedReviewBatches } = await import('./prepared-review-batches.selftest.mjs');
    const { selftestPreparedConnectedPlans } = await import('./prepared-connected-plans.selftest.mjs');
    const { selftestAutomationProposals } = await import('./automation-proposals.selftest.mjs');
    const { selftestConfigurationTransactions } = await import('./configuration-transactions.selftest.mjs');
    const { selftestHostRealizations } = await import('./host-realizations.selftest.mjs');
    const { selftestEmailConnectedContext } = await import(
      '../automations/email-triage/connected-context.selftest.mjs'
    );
    process.exitCode = await selftest(root)
      && await selftestPreparedWork(root)
      && await selftestPreparedReviewBatches(root)
      && await selftestPreparedConnectedPlans(root)
      && await selftestAutomationProposals(root)
      && await selftestConfigurationTransactions(root)
      && await selftestHostRealizations(root)
      && await selftestEmailConnectedContext(root) ? 0 : 1;
    return;
  }

  if (command === 'fixtures') {
    if (args.includes('--update')) {
      const fixtures = await writeSoterFixtures(root);
      process.stdout.write('Updated ' + fixtures.size + ' generated Core fixtures.\n');
      return;
    }
    if (args.includes('--check')) {
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
    throw new Error('fixtures requires --check or --update.');
  }

  throw new Error(
    'Usage: node soter/core/cli.mjs <resolve|config-inspect|configuration-change-plan|configuration-change-request|configuration-change-confirm|configuration-change-start|configuration-change-execute|configuration-change-recover|configuration-change-inspect|host-realization-plan|host-realization-request|host-realization-confirm|host-realization-start|host-realization-execute|host-realization-recover|host-realization-inspect|operator-prepare|operator-prepared-inspect|operator-prepared-review|operator-prepared-derived-review|operator-review-batch-create|operator-review-batch|operator-connected-plan-create|operator-connected-plan|operator-inspect|operator-approval-review|prepare|context|context-connected-prepare|context-connected-finalize|meeting-intake-decision-inspect|meeting-intake-decision-commit|email-triage-decision-inspect|email-triage-decision-commit|email-triage-proposal-inspect|email-triage-proposal-commit|email-triage-proposal-material|meeting-intake-proposal|transaction|connected-batch-preview|proposal-connected-batch-preview|connected-approval-request|connected-approval-confirm|connected-transaction-prepare|connected-transaction-complete|connected-transaction-reconcile|doctor|probe-prepare|probe-complete|capability-prepare|capability-complete|plan-prepare|plan-complete|host-fail|host-get|host-list|fixtures|selftest> [options]\n'
      + '  resolve [--config PATH] [--host ID] [--output PATH] [--json]\n'
      + '  config-inspect [--config PATH] [--host ID | --lock PATH] [--output PATH] [--json]\n'
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
      + '  operator-prepare --configuration NAME --automation ID --input ABSOLUTE_PRIVATE_PATH [--at TIME] [--json]\n'
      + '  operator-prepared-inspect --work-id ID [--json]\n'
      + '  operator-prepared-review --work-id ID [--json]\n'
      + '  operator-prepared-derived-review --work-id ID [--json]\n'
      + '  operator-review-batch-create --work-id ID --action-id ID [--action-id ID ...] [--at TIME] [--json]\n'
      + '  operator-review-batch --batch-id ID [--json]\n'
      + '  operator-connected-plan-create --batch-id ID [--at TIME] [--json]\n'
      + '  operator-connected-plan --plan-id ID [--json]\n'
      + '  operator-inspect [--request-id ID | --approval-id ID | --checkpoint ID] [--at TIME] [--json]\n'
      + '  operator-approval-review --request-id ID [--json]\n'
      + '  prepare --lock PATH [--scenario PATH] [--output PATH] [--evidence-dir PATH] [--json]\n'
      + '  context --lock PATH --meeting-id ID --recording-uri URI [--scenario PATH] [--json]\n'
      + '  context-connected-prepare --lock PATH --run PATH --meeting-id ID --recording-uri URI [--snapshot-id ID] [--json]\n'
      + '  context-connected-finalize --checkpoint ID [--json]\n'
      + '  meeting-intake-decision-inspect --lock PATH --snapshot ID [--json]\n'
      + '  meeting-intake-decision-commit --lock PATH --snapshot ID --decision-input PATH [--decision-id ID] [--actor ID] [--json]\n'
      + '  email-triage-decision-inspect --lock PATH --snapshot ID [--json]\n'
      + '  email-triage-decision-commit --lock PATH --snapshot ID --decision-input PATH [--decision-id ID] [--actor ID] [--json]\n'
      + '  email-triage-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  email-triage-proposal-commit --lock PATH --decision ID --proposal-input ABSOLUTE_PATH [--proposal-id ID] [--actor ID] [--json]\n'
      + '  email-triage-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  meeting-intake-proposal --lock PATH --decision ID [--change-set-id ID] [--output PATH] [--json]\n'
      + '  transaction --lock PATH [--scenario PATH] [--approve] [--json]\n'
      + '  connected-batch-preview --lock PATH --change-set PATH [--batch-id ID] [--json]\n'
      + '  proposal-connected-batch-preview --lock PATH --proposal ID --action-id ID [--action-id ID] [--change-set-id ID] [--batch-id ID] [--json]\n'
      + '  connected-approval-request --lock PATH --run PATH --batch PATH --change-set PATH --request-id ID --reason TEXT --expires-at TIME [--json]\n'
      + '  connected-approval-confirm --request-id ID --approval-id ID --actor ACTOR --reason TEXT [--json]\n'
      + '  connected-transaction-prepare --approval-id ID [--json]\n'
      + '  connected-transaction-complete --checkpoint ID --call ID --response ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  connected-transaction-reconcile --checkpoint ID [--json]\n'
      + '  doctor --lock PATH [--level offline|connected] [--probe PATH ...] [--probe-checkpoint ID ...] [--config PATH] [--json]\n'
      + '  probe-prepare --lock PATH --provider ID [--output PATH] [--json]\n'
      + '  probe-complete --checkpoint ID [--call ID] --response ABSOLUTE_PRIVATE_PATH [--probe-output PATH] [--json]\n'
      + '  capability-prepare --lock PATH --run PATH --capability ID --authority ID --provider ID --input PATH [--output PATH] [--json]\n'
      + '  capability-complete --checkpoint ID --response ABSOLUTE_PRIVATE_PATH [--output PATH] [--json]\n'
      + '  plan-prepare --lock PATH --run PATH --plan ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  plan-complete --checkpoint ID --call ID --response ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  host-fail --checkpoint ID [--call ID] --kind KIND --message TEXT [--output PATH] [--json]\n'
      + '  host-get --checkpoint ID\n'
      + '  host-list [--state requested|completed|rolled-back|failed|needs-attention|blocked]\n'
      + '  fixtures <--check|--update> [--json]'
  );
}

main().catch((error) => {
  process.stderr.write('Soter Core: ' + error.message + '\n');
  process.exitCode = 1;
});
