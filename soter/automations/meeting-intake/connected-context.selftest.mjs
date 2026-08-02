import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWorkspace } from '../../core/inspection.mjs';
import { createContainedConnectedReviewEvidence } from '../../core/evidence.mjs';
import {
  fingerprintJson,
  fingerprintPath,
  readJson,
  repoRelativePath,
  resolveRepoPath,
  writeJson
} from '../../core/lib/canonical-json.mjs';
import { materializeContainedPrivateConfiguration } from '../../core/contained-private-configurations.mjs';
import { createProposalConnectedBatch } from '../../core/proposal-connected-batches.mjs';
import {
  inspectPreparedAutomationWork,
  prepareAutomationRun
} from '../../core/prepared-work.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';
import { runStatePath } from '../../core/runtime-state.mjs';
import { completeDurableOperationPlanExecution } from '../../core/service.mjs';
import {
  finalizeMeetingIntakeConnectedContext,
  prepareMeetingIntakeConnectedContext
} from './context.mjs';
import {
  commitMeetingIntakeDecision,
  inspectMeetingIntakeDecisionContext
} from './decision.mjs';
import {
  commitMeetingIntakeProposal,
  inspectMeetingIntakeProposalDecision,
  inspectMeetingIntakeProposalMaterial
} from './proposal.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-20T12:00:00.000Z';
const MEETING_ID = 'meeting.fixture-001';
const RECORDING_URI = 'https://otter.ai/u/meeting_fixture_001';
const PROJECT_ID = 'soter-fixture://projects/project/launch';
const FIXTURE_TASK_ID = 'soter-fixture://tasks/task/existing-deck';
const CONNECTED_MEETING_URI = 'https://www.notion.so/66666666666666666666666666666661';
const CONNECTED_ORGANIZATION_URI = 'https://www.notion.so/66666666666666666666666666666662';
const CONNECTED_PROJECT_URI = 'https://www.notion.so/66666666666666666666666666666663';
const TASK_ID = 'https://www.notion.so/66666666666666666666666666666664';
const PRIVATE_MEETING_OPTION_PREFIX = 'PRIVATE_PROVIDER_MEETING_OPTION_';

function providerOption(field, portable) {
  return PRIVATE_MEETING_OPTION_PREFIX
    + field.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
    + '_'
    + portable.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function optionMapping(mapping, recordType, field, values) {
  return {
    mapping,
    recordType,
    field,
    mode: 'exact-bijection',
    entries: values.map((portable) => ({
      portable,
      provider: providerOption(field, portable)
    }))
  };
}

function containedOptionMappings() {
  return [
    optionMapping(
      'mapping.integration.notion.meetings-records',
      'meeting',
      'meetingType',
      ['Review']
    ),
    optionMapping(
      'mapping.integration.notion.meetings-records',
      'meeting-summary',
      'documentType',
      ['Meeting Summary']
    ),
    optionMapping(
      'mapping.integration.notion.crm-records',
      'organization',
      'organizationType',
      ['Foundation']
    ),
    optionMapping(
      'mapping.integration.notion.crm-records',
      'organization',
      'tags',
      ['DeFi']
    ),
    optionMapping(
      'mapping.integration.notion.projects-records',
      'project',
      'projectType',
      ['Project']
    ),
    optionMapping(
      'mapping.integration.notion.projects-records',
      'project',
      'status',
      ['active']
    ),
    optionMapping(
      'mapping.integration.notion.tasks-records',
      'task',
      'status',
      ['To Do']
    ),
    optionMapping(
      'mapping.integration.notion.tasks-records',
      'task',
      'context',
      ['Project']
    )
  ];
}

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-meeting-context-selftest-'));
  for (const directory of ['soter', '.claude']) {
    if (!fs.existsSync(path.join(root, directory))) continue;
    fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

function providerFields(record) {
  const fields = structuredClone(record.fields);
  const choiceFields = {
    meeting: ['meetingType'],
    organization: ['organizationType', 'tags'],
    project: ['projectType', 'status'],
    task: ['status', 'context'],
    'meeting-summary': ['documentType']
  }[record.type] || [];
  for (const field of choiceFields) {
    if (fields[field] === undefined || fields[field] === null) continue;
    if (Array.isArray(fields[field])) {
      fields[field] = fields[field].map((value) => providerOption(field, value));
    } else {
      fields[field] = providerOption(field, fields[field]);
    }
  }
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    return [key, Array.isArray(value) ? JSON.stringify(value) : value];
  }));
}

function recordResponse(records, marker) {
  return {
    structuredContent: {
      result: {
        results: records.map((record) => ({
          __soterType: record.type,
          __soterId: record.id,
          __soterFields: JSON.stringify(providerFields(record))
        })),
        has_more: false,
        rawProviderResponse: marker
      }
    },
    isError: false
  };
}

function documentResponse({ uri, title, body }, marker) {
  return {
    structuredContent: {
      result: {
        metadata: { type: 'page' },
        title,
        url: uri,
        text: '<page url="' + uri + '"><properties>{"title":'
          + JSON.stringify(title) + '}</properties>\n' + body + '\n</page>',
        rawProviderResponse: marker
      }
    },
    isError: false
  };
}

function transcriptResponse(transcript, marker) {
  return {
    structuredContent: {
      result: {
        speakers: structuredClone(transcript.speakers),
        segments: structuredClone(transcript.segments),
        rawProviderResponse: marker
      }
    },
    isError: false
  };
}

function createRun(root, lock, workId) {
  const suffix = workId.slice('work.meeting-intake.'.length);
  const work = inspectPreparedAutomationWork({ root, workId });
  const lockPath = work.configuration.lockPath;
  const runPath = repoRelativePath(root, runStatePath(root, work.checkpoint.runId));
  const run = readJson(resolveRepoPath(root, runPath));
  assert.equal(run.id, work.checkpoint.runId);
  assert.equal(run.configurationLock.path, lockPath);
  assert.equal(run.configurationLock.fingerprint, work.configuration.lockFingerprint);
  const copiedLockPath = 'private/meeting-intake.' + suffix + '.copied.lock.json';
  const unrelatedRunPath = 'private/meeting-intake.' + suffix + '.unrelated.run.json';
  writeJson(path.join(root, copiedLockPath), lock);
  const unrelatedRun = prepareRunEnvelope({
    root,
    lock,
    lockPath: copiedLockPath,
    automationId: 'automation.meeting-intake',
    runId: 'run.meeting-intake.unrelated.' + suffix,
    createdAt: AT,
    requestedOutcome: 'Hostile unrelated matching-Automation run that must never be selected.',
    evidenceIds: []
  });
  writeJson(path.join(root, unrelatedRunPath), unrelatedRun);
  return { lockPath, runPath, run, copiedLockPath, unrelatedRunPath, unrelatedRun };
}

function applicablePolicySources(lock) {
  return lock.sources.filter((source) => {
    return source.consumers.some((consumer) => {
      return consumer.pack === 'automation.meeting-intake'
        && consumer.purpose === 'applicable-policy';
    });
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

export async function runContainedMeetingIntakeConnectedWorkflow(
  root = defaultRoot,
  { lock: preparedLock = null } = {}
) {
  const temporaryRoot = copyHarness(root);
  try {
    const {
      lock,
      privateContainedBasis
    } = materializeContainedPrivateConfiguration({
      root: temporaryRoot,
      configurationName: 'meeting-intake',
      expectedTemplateLock: preparedLock,
      notionOptionMappings: containedOptionMappings()
    });
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const crm = readJson(path.join(
      temporaryRoot,
      'soter/fixtures/providers/notion/workspace-records.json'
    )).data;
    const transcript = readJson(path.join(
      temporaryRoot,
      'soter/fixtures/providers/otter/transcripts.json'
    )).data.transcripts.find((item) => item.meetingId === MEETING_ID);
    const fixtureMeeting = crm.records.find((record) => record.type === 'meeting'
      && record.fields.recordingUri === RECORDING_URI);
    const fixtureOrganization = crm.records.find((record) => {
      return fixtureMeeting?.fields.organizationUris.includes(record.id);
    });
    const fixtureProject = crm.records.find((record) => record.id === PROJECT_ID);
    const fixtureTask = crm.records.find((record) => record.id === FIXTURE_TASK_ID);
    assert(transcript && fixtureMeeting && fixtureOrganization && fixtureProject && fixtureTask);
    const meeting = {
      ...structuredClone(fixtureMeeting),
      id: CONNECTED_MEETING_URI,
      fields: {
        ...structuredClone(fixtureMeeting.fields),
        organizationUris: [CONNECTED_ORGANIZATION_URI]
      }
    };
    const organization = {
      ...structuredClone(fixtureOrganization),
      id: CONNECTED_ORGANIZATION_URI,
      fields: {
        ...structuredClone(fixtureOrganization.fields),
        projectUris: [CONNECTED_PROJECT_URI]
      }
    };
    const project = {
      ...structuredClone(fixtureProject),
      id: CONNECTED_PROJECT_URI,
      fields: {
        ...structuredClone(fixtureProject.fields),
        organizationUris: [CONNECTED_ORGANIZATION_URI],
        taskUris: [TASK_ID]
      }
    };
    const task = {
      ...structuredClone(fixtureTask),
      id: TASK_ID,
      fields: {
        ...structuredClone(fixtureTask.fields),
        projectUris: [CONNECTED_PROJECT_URI]
      }
    };

    const privateGoal = 'CONNECTED_PRIVATE_MEETING_GOAL_SENTINEL';
    const prepared = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.meeting-intake',
      configurationName: 'meeting-intake',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        meeting: MEETING_ID,
        recordingUri: RECORDING_URI,
        operatorGoal: privateGoal
      },
      createdAt: '2026-07-20T11:59:00.000Z'
    });
    assert.equal(prepared.state, 'ready-for-acquisition');
    assert.equal(prepared.preparationMode, 'connected-acquisition');
    assert.equal(prepared.evidence.length, 0);
    assert.equal(prepared.approval.state, 'not-requested');
    assert.equal(prepared.continuationRequest, null);
    assert.equal(prepared.preview.proposedChanges.length, 0);

    const primary = createRun(temporaryRoot, lock, prepared.id);
    let execution = await prepareMeetingIntakeConnectedContext({
      root: temporaryRoot,
      workId: prepared.id,
      at: AT,
      expectedHost: 'codex'
    });
    assert.equal(execution.checkpoint.configurationLock.path, primary.lockPath);
    assert.notEqual(execution.checkpoint.configurationLock.path, primary.copiedLockPath);
    assert.equal(execution.checkpoint.configuration.configurationBasis, 'private-active');
    assert.equal(execution.run.id, primary.run.id);
    assert.notEqual(execution.run.id, primary.unrelatedRun.id);
    assert.equal(execution.currentCall.capability.id, 'documents.content.read');
    assert.equal(execution.checkpoint.steps.length, 8);
    assert.equal(execution.run.approvals.length, 0);

    const policySources = applicablePolicySources(lock);
    const policyDocuments = new Map(crm.documents.map((document) => [document.uri, document]));
    for (const [index, source] of policySources.entries()) {
      assert.equal(execution.currentCall.capability.id, 'documents.content.read');
      const document = policyDocuments.get(source.input.uri);
      assert(document);
      execution = await completeDurableOperationPlanExecution({
        root: temporaryRoot,
        checkpointId: execution.checkpoint.id,
        callId: execution.currentCall.id,
        response: documentResponse(
          document,
          'RAW_MEETING_POLICY_BODY_RESPONSE_SENTINEL_' + index
        ),
        at: '2026-07-20T12:00:0' + String(index + 2) + '.000Z',
        expectedHost: 'codex'
      });
    }
    assert.equal(execution.currentCall.capability.id, 'meeting.transcript.read');
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: transcriptResponse(transcript, 'RAW_MEETING_TRANSCRIPT_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:05.000Z',
      expectedHost: 'codex'
    });
    assert.equal(execution.currentCall.capability.id, 'meetings.records.read');
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: recordResponse([meeting], 'RAW_MEETING_RECORD_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:06.000Z',
      expectedHost: 'codex'
    });
    assert.deepEqual(
      execution.checkpoint.steps.find((step) => step.id === execution.checkpoint.currentStepId)
        .resolvedInput.ids,
      [organization.id]
    );
    assert.equal(execution.currentCall.capability.id, 'crm.records.read');
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: recordResponse([organization], 'RAW_MEETING_ORGANIZATION_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:07.000Z',
      expectedHost: 'codex'
    });
    assert.deepEqual(
      execution.checkpoint.steps.find((step) => step.id === execution.checkpoint.currentStepId)
        .resolvedInput.ids,
      [project.id]
    );
    assert.equal(execution.currentCall.capability.id, 'projects.records.read');
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: recordResponse([project], 'RAW_MEETING_PROJECT_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:08.000Z',
      expectedHost: 'codex'
    });
    assert.deepEqual(
      execution.checkpoint.steps.find((step) => step.id === execution.checkpoint.currentStepId)
        .resolvedInput.ids,
      [task.id]
    );
    assert.equal(execution.currentCall.capability.id, 'tasks.records.read');
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: recordResponse([task], 'RAW_MEETING_TASK_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:09.000Z',
      expectedHost: 'codex'
    });
    assert.equal(execution.checkpoint.state, 'completed');

    const finalized = finalizeMeetingIntakeConnectedContext({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      expectedHost: 'codex'
    });
    assert.equal(finalized.snapshot.containment, 'connected');
    assert.equal(finalized.snapshot.entries.length, 8);
    assert.equal(finalized.run.lifecycleState, 'paused');
    assert.equal(finalized.run.approvals.length, 0);
    const durableAcquisition = [
      finalized.snapshotPath,
      finalized.runPath,
      execution.checkpointPath
    ].map((file) => fs.readFileSync(path.join(temporaryRoot, file), 'utf8')).join('\n');
    for (const marker of [
      'RAW_MEETING_POLICY_BODY_RESPONSE_SENTINEL',
      'RAW_MEETING_TRANSCRIPT_RESPONSE_SENTINEL',
      'RAW_MEETING_RECORD_RESPONSE_SENTINEL',
      'RAW_MEETING_ORGANIZATION_RESPONSE_SENTINEL',
      'RAW_MEETING_PROJECT_RESPONSE_SENTINEL',
      'RAW_MEETING_TASK_RESPONSE_SENTINEL'
    ]) {
      assert(!durableAcquisition.includes(marker), marker + ' entered durable Meeting state.');
    }

    const inspectedDecision = inspectMeetingIntakeDecisionContext({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      expectedHost: 'codex'
    });
    assert.equal(inspectedDecision.counts.transcriptSegments, 3);
    assert.equal(inspectedDecision.counts.taskCandidates, 1);
    assert.equal(inspectedDecision.counts.projectCandidates, 1);
    assert.equal(inspectedDecision.counts.applicablePolicies, 3);
    assert(!JSON.stringify(inspectedDecision).includes(privateGoal));

    const policyEntries = finalized.snapshot.entries.filter((entry) => {
      return entry.applicability?.state === 'applicable';
    });
    const decisionInput = {
      state: 'ready',
      meetingRecordId: meeting.id,
      projectRecordId: project.id,
      ourSpeakerIds: ['speaker.retro'],
      summarySegmentIndexes: [0, 1, 2],
      tasks: [{
        recordId: task.id,
        disposition: 'fold',
        reason: 'The exact existing deck task overlaps the grounded internal commitment.',
        segmentIndexes: [0, 1]
      }],
      policies: policyEntries.map((entry) => ({
        contextEntryId: entry.id,
        outcome: 'allow',
        reason: 'The exact cited policy permits this bounded grounded proposal for review.',
        citations: [entry.value.document.body.split('\n\n').slice(1).join('\n\n')]
      })),
      issues: [],
      limitations: [
        'Participant identity resolution is outside this bounded connected workflow.',
        'Unsupported legacy effects remain explicitly held and create no authority.'
      ]
    };
    const committedDecision = commitMeetingIntakeDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.meeting-intake.connected-selftest',
      input: decisionInput,
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:00:10.000Z',
      expectedHost: 'codex'
    });
    const replayedDecision = commitMeetingIntakeDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.meeting-intake.connected-selftest',
      input: decisionInput,
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:00:11.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committedDecision.decision.state, 'ready');
    assert.equal(committedDecision.decision.payload.meeting.ageState, 'current');
    assert.equal(replayedDecision.decisionPath, committedDecision.decisionPath);
    assert.equal(committedDecision.run.approvals.length, 0);

    const inspectedProposal = inspectMeetingIntakeProposalDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      expectedHost: 'codex'
    });
    assert.equal(inspectedProposal.authority.state, 'none');
    assert.deepEqual(inspectedProposal.inputTemplate, {});
    const committedProposal = commitMeetingIntakeProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      id: 'proposal.meeting-intake.connected-selftest',
      input: {},
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:00:12.000Z',
      expectedHost: 'codex'
    });
    const replayedProposal = commitMeetingIntakeProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      id: 'proposal.meeting-intake.connected-selftest',
      input: {},
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:00:13.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committedProposal.proposal.authority.state, 'none');
    assert.equal(replayedProposal.proposalPath, committedProposal.proposalPath);
    assert.equal(replayedProposal.materialPath, committedProposal.materialPath);
    assert(!JSON.stringify(committedProposal).includes(transcript.segments[0].text));
    assert(!JSON.stringify(committedProposal).includes(privateGoal));
    const proposalMaterial = inspectMeetingIntakeProposalMaterial({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      expectedHost: 'codex'
    });
    assert(JSON.stringify(proposalMaterial).includes(transcript.segments[0].text));
    assert.equal(proposalMaterial.authority.state, 'none');

    const actions = committedProposal.proposal.review.collections[0].rows
      .flatMap((row) => row.actions);
    const heldGroupActions = actions.filter((action) => [
      'action.meeting-intake.summary-create',
      'action.meeting-intake.task-fold'
    ].includes(action.id));
    assert.deepEqual(
      heldGroupActions.map((action) => action.id),
      ['action.meeting-intake.summary-create', 'action.meeting-intake.task-fold']
    );
    for (const action of heldGroupActions) {
      assert.equal(action.state, 'held');
      assert.equal(action.reasonCode, 'COMPLETE_MEETING_READBACK_UNAVAILABLE');
      assert.equal(action.capability, null);
      assert.equal(action.effect, null);
      assert.equal(Object.hasOwn(action, 'changeFingerprint'), false);
    }
    assert.equal(actions.some((action) => action.state === 'proposed'), false);
    assert.equal(committedProposal.proposal.review.proposedChanges.length, 0);
    const taskReviewItem = proposalMaterial.items.find((item) => {
      return item.kind === 'meeting-task-fold';
    });
    assert.deepEqual(
      taskReviewItem.fields.find((field) => field.id === 'sourceMeetingUris').reviewValue,
      [CONNECTED_MEETING_URI]
    );
    assert.equal(
      JSON.stringify(taskReviewItem).includes(RECORDING_URI),
      false,
      'Meeting Intake must never substitute the Otter recording URL for a Meeting record relation.'
    );
    const heldSelections = [
      heldGroupActions.map((action) => action.id),
      ['action.meeting-intake.summary-create'],
      ['action.meeting-intake.task-fold']
    ];
    for (const [index, actionIds] of heldSelections.entries()) {
      await assert.rejects(
        () => createProposalConnectedBatch({
          root: temporaryRoot,
          lockPath: primary.lockPath,
          proposalId: committedProposal.proposal.id,
          actionIds,
          changeSetId: 'changeset.meeting-intake.held-selftest-' + index,
          batchId: 'batch.meeting-intake.held-selftest-' + index,
          createdAt: '2026-07-20T12:00:14.000Z',
          expectedHost: 'codex'
        }),
        (error) => {
          assert.equal(error.code, 'PROPOSAL_CONNECTED_BATCH_SELECTION_INVALID');
          return true;
        }
      );
    }
    for (const stateDirectory of [
      'approval-requests',
      'approvals',
      'approval-consumptions'
    ]) {
      assert.equal(
        fs.existsSync(path.join(temporaryRoot, '.soter/state', stateDirectory)),
        false,
        stateDirectory + ' must remain absent when every write action is held.'
      );
    }
    assert.equal(
      readJson(resolveRepoPath(temporaryRoot, primary.runPath)).approvals.length,
      0
    );

    const workspaceText = JSON.stringify(inspectWorkspace(temporaryRoot));
    for (const privateValue of [
      privateGoal,
      transcript.segments[0].text,
      PRIVATE_MEETING_OPTION_PREFIX
    ]) {
      assert(!workspaceText.includes(privateValue), privateValue + ' entered workspace inspection.');
    }
    assert.equal(
      fingerprintPath(path.join(temporaryRoot, 'soter')),
      canonicalBefore,
      'Connected Meeting Intake review must not mutate canonical Soter artifacts.'
    );
    return createContainedConnectedReviewEvidence({
      lock,
      privateContainedBasis,
      id: 'evidence.meeting-intake.connected-review.fixture',
      createdAt: AT,
      automationId: 'automation.meeting-intake',
      runId: committedProposal.proposal.runId,
      work: prepared,
      decision: committedDecision.decision,
      proposal: committedProposal.proposal,
      heldReasonCode: 'COMPLETE_MEETING_READBACK_UNAVAILABLE'
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function selftestMeetingIntakeConnectedContext(root = defaultRoot) {
  const evidence = await runContainedMeetingIntakeConnectedWorkflow(root);
  assert.equal(evidence.result, 'passed');
  process.stdout.write('Meeting Intake connected-context selftest passed.\n');
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestMeetingIntakeConnectedContext().catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}
