import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fingerprintJson, fingerprintPath, readJson } from './lib/canonical-json.mjs';
import { validateJsonSchema } from '../kernel/verify.mjs';
import { createFixtureRuntimeState, invokeCapability } from './capabilities.mjs';
import { assertPreparedEmailTriage } from '../automations/email-triage/email-triage.selftest.mjs';
import {
  preparedWorkDerivedReviewMaterialStatePath,
  preparedWorkReviewMaterialStatePath,
  readContextSnapshotState
} from './runtime-state.mjs';
import {
  assertPreparedWorkDerivedReviewMaterial,
  assertPreparedWork,
  classifyPreparationFailure,
  inspectPreparedAutomationDerivedReviewMaterial,
  inspectPreparedAutomationReviewMaterial,
  inspectPreparedAutomationWork,
  prepareAutomationRun
} from './prepared-work.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function selftestPreparedWork(root = defaultRoot) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-prepared-work-selftest-'));
  try {
    fs.cpSync(path.join(root, 'soter'), path.join(temporaryRoot, 'soter'), { recursive: true });
    for (const directory of ['.claude', '.codex']) {
      fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
    }
    for (const file of ['package.json', 'package-lock.json', 'AGENTS.md', 'CLAUDE.md']) {
      fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
    }
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const missing = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-pulse',
      configurationName: 'project-pulse',
      input: {},
      createdAt: '2026-07-16T14:00:00.000Z'
    });
    assert.equal(missing.state, 'needs-input');
    assert.equal(missing.readiness.blockers[0].reasonCode, 'REQUIRED_INPUT_MISSING');
    assert.equal(missing.checkpoint.runId, null);
    assert.equal(missing.continuationRequest, null);

    const privateSentinel = 'PRIVATE_OPERATOR_GOAL_SENTINEL';
    const ready = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-pulse',
      configurationName: 'project-pulse',
      input: { project: 'project.pulse-risk', operatorGoal: privateSentinel },
      createdAt: '2026-07-16T14:01:00.000Z'
    });
    assert.equal(ready.state, 'ready-for-review');
    assert.deepEqual(ready.history.map((item) => item.state), ['draft', 'preparing', 'ready-for-review']);
    assert.equal(ready.inputSummary.fields.find((item) => item.id === 'project')?.value, 'project.pulse-risk');
    assert(!Object.hasOwn(ready.inputSummary.fields.find((item) => item.id === 'operatorGoal'), 'value'));
    assert(ready.contextPlan.length === 3 && ready.contextPlan.every((item) => item.state === 'completed'));
    assert(ready.preview.contradictions.some((item) => item.id === 'risk-prevents-on-track-claim'));
    assert(ready.preview.facts.length > 0);
    assert.equal(ready.preview.proposedChanges.length, 0,
      'Read-only Project Pulse must not propose undeclared create or update capabilities.');
    assert(ready.effects.filter((item) => ['read', 'disclosure'].includes(item.effect)).every((item) => item.state === 'completed-contained'));
    assert(ready.effects.filter((item) => ['write', 'dispatch', 'destructive'].includes(item.effect)).every((item) => item.state === 'not-executed'));
    assert.equal(ready.approval.state, 'not-requested');
    assert.equal(ready.privacy.externalWritesPerformed, false);
    const readyReview = inspectPreparedAutomationReviewMaterial({
      root: temporaryRoot,
      workId: ready.id
    });
    assert.equal(readyReview.$contract, 'soter://contracts/prepared-work-review-material/v1');
    assert.equal(readyReview.applicability, 'current');
    assert.equal(readyReview.preparedWorkFingerprint, ready.fingerprint);
    assert.equal(readyReview.checkpointFingerprint, ready.checkpoint.fingerprint);
    assert.deepEqual(readyReview.fields.map((field) => field.id), ['project', 'operatorGoal']);
    assert.equal(readyReview.fields.find((field) => field.id === 'project')?.reviewValue,
      'project.pulse-risk');
    assert.equal(readyReview.fields.find((field) => field.id === 'operatorGoal')?.reviewValue,
      privateSentinel);
    assert.equal(
      fs.statSync(preparedWorkReviewMaterialStatePath(temporaryRoot, ready.id)).mode & 0o777,
      0o600
    );
    assert.equal(
      fs.statSync(path.dirname(preparedWorkReviewMaterialStatePath(temporaryRoot, ready.id))).mode & 0o777,
      0o700
    );

    const meetingGoal = 'PRIVATE_MEETING_GOAL_SENTINEL';
    const meeting = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.meeting-intake',
      configurationName: 'meeting-intake',
      input: {
        meeting: 'meeting.fixture-001',
        recordingUri: 'otter://fixture/meeting.fixture-001',
        operatorGoal: meetingGoal
      },
      createdAt: '2026-07-16T14:01:15.000Z'
    });
    assert.equal(meeting.state, 'ready-for-review');
    assert.deepEqual(meeting.history.map((item) => item.state), ['draft', 'preparing', 'ready-for-review']);
    assert.equal(meeting.inputSummary.fields.find((item) => item.id === 'meeting')?.value, 'meeting.fixture-001');
    assert(!Object.hasOwn(meeting.inputSummary.fields.find((item) => item.id === 'recordingUri'), 'value'));
    assert(!Object.hasOwn(meeting.inputSummary.fields.find((item) => item.id === 'operatorGoal'), 'value'));
    assert.equal(meeting.contextPlan.length, 9);
    assert(meeting.contextPlan.every((item) => item.state === 'completed'));
    assert.equal(meeting.preview.kind, 'meeting-intake-review');
    assert(meeting.preview.facts.find((item) => item.id === 'transcript-segments')?.value > 0);
    assert.equal(meeting.preview.facts.find((item) => item.id === 'applicable-policies')?.value, 3);
    assert.equal(meeting.preview.facts.find((item) => item.id === 'participant-resolution')?.state, 'unavailable');
    assert.deepEqual(meeting.preview.contradictions, []);
    assert.deepEqual(meeting.preview.proposedChanges, []);
    assert.equal(meeting.approval.state, 'not-requested');
    assert.equal(meeting.continuationRequest, null);
    assert.equal(meeting.privacy.externalWritesPerformed, false);
    const meetingSnapshot = readContextSnapshotState(
      temporaryRoot,
      meeting.checkpoint.contextSnapshotId
    ).snapshot;
    const preparedProjects = meetingSnapshot.entries.find((entry) => {
      return entry.id === 'context.meeting-intake.projects';
    })?.value.records;
    const preparedTasks = meetingSnapshot.entries.find((entry) => {
      return entry.id === 'context.meeting-intake.tasks';
    })?.value.records;
    assert.deepEqual(preparedProjects?.map((record) => record.id), [
      'soter-fixture://crm/project/launch'
    ]);
    assert.deepEqual(preparedTasks?.map((record) => record.id), [
      'soter-fixture://crm/task/existing-deck'
    ]);
    assert(!JSON.stringify(meetingSnapshot).includes('project.pulse-healthy'),
      'Unrelated project records reached bounded Meeting Intake preparation state.');
    const meetingReceipt = fs.readdirSync(path.join(temporaryRoot, '.soter', 'state', 'prepared-work'))
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => fs.readFileSync(path.join(temporaryRoot, '.soter', 'state', 'prepared-work', entry), 'utf8'))
      .find((value) => value.includes(meeting.id));
    assert(meetingReceipt && !meetingReceipt.includes('otter://fixture/meeting.fixture-001'));
    assert(!meetingReceipt.includes(meetingGoal));
    const meetingReview = inspectPreparedAutomationReviewMaterial({
      root: temporaryRoot,
      workId: meeting.id
    });
    assert.equal(meetingReview.fields.find((field) => field.id === 'recordingUri')?.reviewValue,
      'otter://fixture/meeting.fixture-001');
    assert.equal(meetingReview.fields.find((field) => field.id === 'operatorGoal')?.reviewValue,
      meetingGoal);

    const taskTitle = 'PRIVATE_TASK_CAPTURE_TITLE_SENTINEL';
    const taskDate = '2026-07-24';
    const task = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.task-capture',
      configurationName: 'task-capture',
      input: {
        title: taskTitle,
        project: 'soter-fixture://crm/project/launch',
        assignee: 'provider-person.maya',
        nextActionOn: taskDate,
        context: 'Project'
      },
      createdAt: '2026-07-16T14:01:20.000Z'
    });
    assert.equal(task.state, 'ready-for-review');
    assert.equal(task.preview.kind, 'task-capture-preview');
    assert.equal(task.preview.proposedChanges.length, 1);
    assert.equal(task.preview.proposedChanges[0].effect, 'crm.records.create');
    assert.equal(task.preview.proposedChanges[0].beforeFingerprint, null);
    assert.match(task.preview.proposedChanges[0].afterFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(task.preview.facts.find((item) => item.id === 'task-context')?.value, 'Project');
    assert.equal(task.preview.facts.find((item) => item.id === 'duplicate-candidate-count')?.value, 0);
    assert.equal(task.approval.state, 'not-requested');
    assert.equal(task.continuationRequest, null);
    assert.equal(task.privacy.externalWritesPerformed, false);
    assert(!JSON.stringify(task).includes(taskTitle));
    assert(!JSON.stringify(task).includes(taskDate));
    const taskSnapshot = readContextSnapshotState(
      temporaryRoot,
      task.checkpoint.contextSnapshotId
    ).snapshot;
    assert(!JSON.stringify(taskSnapshot).includes(taskTitle));
    assert(!JSON.stringify(taskSnapshot).includes(taskDate));
    assert.deepEqual(
      taskSnapshot.entries.find((entry) => entry.id === 'context.task-capture.duplicates')?.value.candidateIds,
      []
    );
    const taskReview = inspectPreparedAutomationReviewMaterial({
      root: temporaryRoot,
      workId: task.id
    });
    assert.equal(taskReview.fields.find((field) => field.id === 'title')?.reviewValue, taskTitle);
    assert.equal(taskReview.fields.find((field) => field.id === 'nextActionOn')?.reviewValue, taskDate);

    const duplicateTask = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.task-capture',
      configurationName: 'task-capture',
      input: {
        title: 'Send launch deck',
        project: 'soter-fixture://crm/project/launch',
        context: 'Project'
      },
      createdAt: '2026-07-16T14:01:25.000Z'
    });
    assert.equal(duplicateTask.state, 'ready-for-review');
    assert.equal(duplicateTask.preview.proposedChanges.length, 0);
    assert(duplicateTask.preview.contradictions.some((item) => {
      return item.id === 'duplicate-candidates-observed';
    }));

    const invalidTaskDate = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.task-capture',
      configurationName: 'task-capture',
      input: {
        title: 'Invalid date is never prepared',
        project: 'soter-fixture://crm/project/launch',
        nextActionOn: '2026-02-30'
      },
      createdAt: '2026-07-16T14:01:27.000Z'
    });
    assert.equal(invalidTaskDate.state, 'needs-input');
    assert(invalidTaskDate.readiness.blockers.some((item) => {
      return item.reasonCode === 'INPUT_INVALID' && item.fieldId === 'nextActionOn';
    }));

    const emailFocus = 'PRIVATE_EMAIL_FOCUS_SENTINEL';
    const email = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.email-triage',
      configurationName: 'email-triage',
      input: {
        query: 'in:inbox newer_than:1d',
        scope: 'triage-drafts-handoffs-digest',
        focus: emailFocus
      },
      createdAt: '2026-07-16T14:01:28.000Z'
    });
    const emailDerivedReview = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: email.id
    });
    assertPreparedEmailTriage({ work: email, derivedReview: emailDerivedReview });
    assert(!JSON.stringify(email).includes('in:inbox newer_than:1d'));
    assert(!JSON.stringify(email).includes(emailFocus));
    assert(!JSON.stringify(email).includes('RAW_EMAIL_SUBJECT_SENTINEL'));
    assert(!JSON.stringify(email).includes('raw-email-sender-sentinel@bountyhub.example'));
    assert(!JSON.stringify(email).includes('HOSTILE_RAW_BODY_SENTINEL'));
    const hostileCollectionLabel = structuredClone(email);
    hostileCollectionLabel.preview.collections[0].labelKey = 'RAW_BODY_SENTINEL';
    assert.throws(() => assertPreparedWork(temporaryRoot, hostileCollectionLabel),
      /does not satisfy its contract/);
    const hostileSubjectIdentity = structuredClone(email);
    hostileSubjectIdentity.preview.collections[0].rows[0].subject.id = 'private@example.com';
    assert.throws(() => assertPreparedWork(temporaryRoot, hostileSubjectIdentity),
      /does not satisfy its contract/);
    const invalidActionBranch = structuredClone(email);
    Object.assign(invalidActionBranch.preview.collections[0].rows[0].actions[0], {
      kind: 'none', capability: null, effect: 'dispatch', state: 'proposed'
    });
    assert.throws(() => assertPreparedWork(temporaryRoot, invalidActionBranch),
      /does not satisfy its contract/);
    const mailCapability = readJson(path.join(
      temporaryRoot,
      'soter',
      'capabilities',
      'mail.window.read.json'
    ));
    const mailFixture = readJson(path.join(
      temporaryRoot,
      'soter',
      'fixtures',
      'providers',
      'gmail',
      'inbox-window.json'
    ));
    const hostileProviderOutput = {
      queryFingerprint: fingerprintJson(mailFixture.data.query),
      returnedThreadCount: mailFixture.data.threads.length,
      threads: structuredClone(mailFixture.data.threads),
      provenance: {
        provider: 'gmail-fixture',
        authority: 'authority.mailbox.instance',
        sourceKind: 'fixture',
        sourceReferenceFingerprint: fingerprintJson({
          provider: 'gmail-fixture',
          fixture: 'soter/fixtures/providers/gmail/inbox-window.json'
        })
      },
      observedAt: mailFixture.observedAt,
    };
    assert.equal(validateJsonSchema(hostileProviderOutput, mailCapability.outputSchema).length, 0,
      'Fixture-normalized mail output did not satisfy the provider-neutral capability contract.');
    const connectedProviderOutput = structuredClone(hostileProviderOutput);
    connectedProviderOutput.provenance.provider = 'gmail';
    connectedProviderOutput.provenance.sourceKind = 'connected';
    connectedProviderOutput.provenance.sourceReferenceFingerprint = fingerprintJson({
      provider: 'gmail', authority: connectedProviderOutput.provenance.authority
    });
    assert.equal(validateJsonSchema(connectedProviderOutput, mailCapability.outputSchema).length, 0,
      'Connected-normalized mail output did not satisfy the portable capability contract.');
    const fixtureSpecificProvenance = structuredClone(hostileProviderOutput);
    fixtureSpecificProvenance.provenance.fixture =
      'soter/fixtures/providers/gmail/inbox-window.json';
    assert(validateJsonSchema(fixtureSpecificProvenance, mailCapability.outputSchema).length >= 1,
      'Portable mail provenance accepted a fixture-only path field.');
    hostileProviderOutput.rawProviderResponse = 'HOSTILE_RAW_PROVIDER_RESPONSE';
    hostileProviderOutput.threads[0].rawProviderResponse = 'HOSTILE_RAW_THREAD_RESPONSE';
    hostileProviderOutput.threads[0].messages[0].signals.rawSecret = 'HOSTILE_RAW_SIGNAL';
    assert(validateJsonSchema(hostileProviderOutput, mailCapability.outputSchema).length >= 3,
      'Normalized mail capability schema accepted raw provider escape properties.');
    const hostileProviderState = createFixtureRuntimeState(temporaryRoot);
    hostileProviderState['provider.integration.gmail.fixture'].data.threads[0]
      .rawProviderResponse = 'HOSTILE_RAW_THREAD_RESPONSE';
    hostileProviderState['provider.integration.gmail.fixture'].data.threads[0]
      .messages[0].signals.rawSecret = 'HOSTILE_RAW_SIGNAL';
    const hostileProviderResult = await invokeCapability({
      root: temporaryRoot,
      lock: readJson(path.join(temporaryRoot, email.configuration.lockPath)),
      capability: 'mail.window.read',
      authority: 'authority.mailbox.instance',
      containment: 'fixture',
      input: { query: 'in:inbox newer_than:1d', maximumThreads: 50 },
      effectId: 'effect.email-triage.hostile-normalized-output.fixture',
      at: '2026-07-16T15:00:30.000Z',
      runtimeState: hostileProviderState
    });
    assert.equal(hostileProviderResult.invocation.state, 'failed');
    assert.equal(hostileProviderResult.invocation.error.kind, 'validation');
    assert.equal(hostileProviderResult.output, null,
      'Invalid normalized provider output crossed the Integration-to-Automation boundary.');
    const missingInputBinding = structuredClone(emailDerivedReview);
    delete missingInputBinding.inputContractFingerprint;
    assert.throws(
      () => assertPreparedWorkDerivedReviewMaterial(temporaryRoot, missingInputBinding, email),
      (error) => error.code === 'PREPARED_DERIVED_REVIEW_MATERIAL_MALFORMED'
    );
    const missingReviewContractBinding = structuredClone(emailDerivedReview);
    delete missingReviewContractBinding.reviewContractFingerprint;
    assert.throws(
      () => assertPreparedWorkDerivedReviewMaterial(
        temporaryRoot,
        missingReviewContractBinding,
        email
      ),
      (error) => error.code === 'PREPARED_DERIVED_REVIEW_MATERIAL_MALFORMED'
    );
    const resignPrepared = (value) => {
      for (const collection of value.preview.collections) {
        const unsignedCollection = structuredClone(collection);
        delete unsignedCollection.fingerprint;
        collection.fingerprint = fingerprintJson(unsignedCollection);
      }
      const unsignedPreview = structuredClone(value.preview);
      delete unsignedPreview.fingerprint;
      value.preview.fingerprint = fingerprintJson(unsignedPreview);
      const unsigned = structuredClone(value);
      delete unsigned.fingerprint;
      value.fingerprint = fingerprintJson(unsigned);
      return value;
    };
    const duplicateCollection = structuredClone(email);
    duplicateCollection.preview.collections.push(structuredClone(duplicateCollection.preview.collections[0]));
    resignPrepared(duplicateCollection);
    assert.throws(() => assertPreparedWork(temporaryRoot, duplicateCollection),
      /collection identities must be globally unique/);
    const invalidCoverage = structuredClone(email);
    invalidCoverage.preview.collections[0].coverage.exclusions.push({
      reasonCode: 'SELF_SENT_ONLY_REMOVED', count: 0
    });
    resignPrepared(invalidCoverage);
    assert.throws(() => assertPreparedWork(temporaryRoot, invalidCoverage),
      /coverage or fingerprint is invalid/);
    const incompleteProposal = structuredClone(email);
    incompleteProposal.preview.collections[0].coverage.complete = false;
    resignPrepared(incompleteProposal);
    assert.throws(() => assertPreparedWork(temporaryRoot, incompleteProposal),
      /Incomplete review coverage cannot propose/);
    const incompleteSiblingCollection = structuredClone(email);
    incompleteSiblingCollection.preview.collections[1].coverage.complete = false;
    resignPrepared(incompleteSiblingCollection);
    assert.throws(() => assertPreparedWork(temporaryRoot, incompleteSiblingCollection),
      /Incomplete review coverage cannot propose any external write batch/);
    const changedPrivateDetail = structuredClone(email);
    changedPrivateDetail.preview.collections[0].rows[0].privateDetailFingerprint
      = 'sha256:' + 'e'.repeat(64);
    resignPrepared(changedPrivateDetail);
    const reboundDerivedReview = structuredClone(emailDerivedReview);
    reboundDerivedReview.preparedWorkFingerprint = changedPrivateDetail.fingerprint;
    const unsignedReboundDerivedReview = structuredClone(reboundDerivedReview);
    delete unsignedReboundDerivedReview.fingerprint;
    delete unsignedReboundDerivedReview.applicability;
    reboundDerivedReview.fingerprint = fingerprintJson(unsignedReboundDerivedReview);
    assert.throws(
      () => assertPreparedWorkDerivedReviewMaterial(
        temporaryRoot,
        reboundDerivedReview,
        changedPrivateDetail
      ),
      (error) => error.code === 'PREPARED_DERIVED_REVIEW_MATERIAL_BINDING_INVALID'
    );
    const changedProposedValue = structuredClone(email);
    changedProposedValue.preview.proposedChanges[0].afterFingerprint
      = 'sha256:' + 'f'.repeat(64);
    resignPrepared(changedProposedValue);
    assert.throws(() => assertPreparedWork(temporaryRoot, changedProposedValue),
      /proposed changes are not exactly bound/);
    assert.equal(
      fs.statSync(preparedWorkDerivedReviewMaterialStatePath(temporaryRoot, email.id)).mode & 0o777,
      0o600
    );
    assert.equal(
      fs.statSync(path.dirname(preparedWorkDerivedReviewMaterialStatePath(temporaryRoot, email.id))).mode & 0o777,
      0o700
    );
    const repeatedEmail = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.email-triage',
      configurationName: 'email-triage',
      input: {
        query: 'in:inbox newer_than:1d',
        scope: 'triage-drafts-handoffs-digest',
        focus: emailFocus
      },
      createdAt: '2026-07-16T15:00:00.000Z'
    });
    assert.deepEqual(repeatedEmail, email);
    assert.equal(
      inspectPreparedAutomationDerivedReviewMaterial({ root: temporaryRoot, workId: email.id }).fingerprint,
      emailDerivedReview.fingerprint
    );
    const derivedReviewPath = preparedWorkDerivedReviewMaterialStatePath(temporaryRoot, email.id);
    const tamperedDerivedReview = structuredClone(emailDerivedReview);
    tamperedDerivedReview.items.find((item) => item.kind === 'draft')
      .fields.find((field) => field.id === 'body').reviewValue = 'tampered';
    fs.writeFileSync(derivedReviewPath, JSON.stringify(tamperedDerivedReview, null, 2) + '\n');
    assert.throws(
      () => inspectPreparedAutomationDerivedReviewMaterial({ root: temporaryRoot, workId: email.id }),
      (error) => error.code === 'PREPARED_DERIVED_REVIEW_MATERIAL_TAMPERED'
    );
    fs.writeFileSync(derivedReviewPath, JSON.stringify(emailDerivedReview, null, 2) + '\n');
    fs.rmSync(derivedReviewPath);
    assert.equal(inspectPreparedAutomationWork({ root: temporaryRoot, workId: email.id }).id,
      email.id, 'Missing derived review must not hide sanitized queue work.');
    assert.throws(
      () => inspectPreparedAutomationDerivedReviewMaterial({ root: temporaryRoot, workId: email.id }),
      (error) => error.code === 'PREPARED_DERIVED_REVIEW_MATERIAL_MISSING'
    );
    await assert.rejects(
      prepareAutomationRun({
        root: temporaryRoot,
        automationId: 'automation.email-triage',
        configurationName: 'email-triage',
        input: {
          query: 'in:inbox newer_than:1d',
          scope: 'triage-drafts-handoffs-digest',
          focus: emailFocus
        },
        createdAt: '2026-07-16T15:01:00.000Z'
      }),
      (error) => error.code === 'PREPARED_DERIVED_REVIEW_MATERIAL_MISSING'
    );
    fs.writeFileSync(
      derivedReviewPath,
      JSON.stringify(emailDerivedReview, null, 2) + '\n',
      { mode: 0o600 }
    );

    assert.equal(
      classifyPreparationFailure({ code: 'PREPARED_DERIVED_REVIEW_MATERIAL_MALFORMED' }),
      'PREPARATION_ADAPTER_INVALID'
    );
    assert.equal(
      classifyPreparationFailure({ code: 'PROVIDER_UNAVAILABLE' }),
      'PREPARATION_CONTEXT_UNAVAILABLE'
    );

    const unavailable = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-pulse',
      configurationName: 'project-pulse',
      input: { project: 'project.does-not-exist', operatorGoal: 'PRIVATE_FAILURE_SENTINEL' },
      createdAt: '2026-07-16T14:01:30.000Z'
    });
    assert.equal(unavailable.state, 'needs-input');
    assert.deepEqual(unavailable.history.map((item) => item.state), ['draft', 'preparing', 'needs-input']);
    assert.equal(unavailable.readiness.blockers[0].reasonCode, 'PREPARATION_CONTEXT_UNAVAILABLE');
    assert.equal(unavailable.checkpoint.runId, null);

    assert.equal(fingerprintPath(path.join(temporaryRoot, 'soter')), canonicalBefore,
      'Prepared work may write private runtime state but must not mutate canonical artifacts.');
    const serializedSanitizedState = fs.readdirSync(path.join(temporaryRoot, '.soter', 'state'), { recursive: true })
      .filter((entry) => String(entry).endsWith('.json')
        && !String(entry).split(path.sep).includes('prepared-work-review')
        && !String(entry).split(path.sep).includes('prepared-work-derived-review'))
      .map((entry) => fs.readFileSync(path.join(temporaryRoot, '.soter', 'state', String(entry)), 'utf8'))
      .join('\n');
    assert(!serializedSanitizedState.includes(privateSentinel),
      'Raw private operator input escaped the private review-material directory.');
    assert(!serializedSanitizedState.includes('PRIVATE_FAILURE_SENTINEL'),
      'Failed private input escaped the private review-material directory.');
    assert(!serializedSanitizedState.includes(meetingGoal),
      'Raw private Meeting Intake goal escaped the private review-material directory.');
    assert(!serializedSanitizedState.includes(taskTitle),
      'Raw private Task Capture title escaped the private review-material directory.');
    assert(!serializedSanitizedState.includes(taskDate),
      'Raw private Task Capture date escaped the private review-material directory.');
    assert(!serializedSanitizedState.includes(emailFocus),
      'Raw private Email focus escaped the private review-material directory.');
    assert(!serializedSanitizedState.includes('in:inbox newer_than:1d'),
      'Raw private Email query escaped the private review-material directory.');
    assert(!serializedSanitizedState.includes('RAW_EMAIL_SUBJECT_SENTINEL'));
    assert(!serializedSanitizedState.includes('raw-email-sender-sentinel@bountyhub.example'));
    assert(!serializedSanitizedState.includes('HOSTILE_RAW_BODY_SENTINEL'));
    assert(!serializedSanitizedState.includes('Thanks for the note. I will research'));

    const repeated = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-pulse',
      configurationName: 'project-pulse',
      input: { project: 'project.pulse-risk', operatorGoal: privateSentinel },
      createdAt: '2026-07-16T15:00:00.000Z'
    });
    assert.deepEqual(repeated, ready, 'Exact re-entry must return the same checkpoint instead of duplicating work.');
    assert.equal(
      inspectPreparedAutomationReviewMaterial({ root: temporaryRoot, workId: ready.id }).fingerprint,
      readyReview.fingerprint,
      'Exact re-entry must preserve the same private review material.'
    );

    const unavailableReviewPath = preparedWorkReviewMaterialStatePath(temporaryRoot, unavailable.id);
    fs.rmSync(unavailableReviewPath);
    assert.equal(inspectPreparedAutomationWork({ root: temporaryRoot, workId: unavailable.id }).id,
      unavailable.id, 'Missing review material must not hide unrelated sanitized queue work.');
    assert.throws(
      () => inspectPreparedAutomationReviewMaterial({ root: temporaryRoot, workId: unavailable.id }),
      (error) => error.code === 'PREPARED_REVIEW_MATERIAL_MISSING'
    );
    await assert.rejects(
      prepareAutomationRun({
        root: temporaryRoot,
        automationId: 'automation.project-pulse',
        configurationName: 'project-pulse',
        input: { project: 'project.does-not-exist', operatorGoal: 'PRIVATE_FAILURE_SENTINEL' },
        createdAt: '2026-07-16T15:01:00.000Z'
      }),
      (error) => error.code === 'PREPARED_REVIEW_MATERIAL_MISSING'
    );
    fs.writeFileSync(unavailableReviewPath, '{not-json\n', { mode: 0o600 });
    assert.throws(
      () => inspectPreparedAutomationReviewMaterial({ root: temporaryRoot, workId: unavailable.id }),
      (error) => error.code === 'PREPARED_REVIEW_MATERIAL_MALFORMED'
    );

    await assert.rejects(
      prepareAutomationRun({
        root: temporaryRoot,
        automationId: 'automation.project-pulse',
        configurationName: 'project-pulse',
        input: { project: 'project.pulse-risk', undeclared: 'hostile' },
        createdAt: '2026-07-16T14:02:00.000Z'
      }),
      /undeclared fields/
    );
    await assert.rejects(
      prepareAutomationRun({
        root: temporaryRoot,
        automationId: 'automation.project-pulse',
        input: { project: 'project.pulse-risk' },
        createdAt: '2026-07-16T14:03:00.000Z'
      }),
      /explicit configuration name/
    );
    await assert.rejects(
      prepareAutomationRun({
        root: temporaryRoot,
        automationId: 'automation.project-pulse',
        configurationName: 'project-pulse',
        input: { project: 'project.pulse-risk', operatorGoal: 'sk-' + 'abcdefghijklmnopqrstuvwxyz123456' },
        createdAt: '2026-07-16T14:04:00.000Z'
      }),
      (error) => error.code === 'PREPARED_REVIEW_MATERIAL_CREDENTIAL_REJECTED'
        && /credential material/.test(error.message)
    );
    const tampered = structuredClone(ready);
    tampered.inputSummary.fields.find((item) => item.id === 'operatorGoal').value = privateSentinel;
    assert.throws(() => assertPreparedWork(temporaryRoot, tampered), /does not satisfy its contract/);
    const evidencePath = path.join(temporaryRoot, '.soter', 'state', 'prepared-work-evidence', 'evidence.' + ready.id + '.json');
    const evidence = readJson(evidencePath);
    assert.equal(evidence.$contract, 'soter://contracts/evidence/v2');
    assert.equal(evidence.claimFamily, 'preparation');
    const configurationPath = path.join(
      temporaryRoot,
      'soter',
      'configurations',
      'project-pulse.config.json'
    );
    const driftedConfiguration = readJson(configurationPath);
    driftedConfiguration.host.reason += ' Planted prepared-work applicability drift.';
    fs.writeFileSync(configurationPath, JSON.stringify(driftedConfiguration, null, 2) + '\n');
    const stale = inspectPreparedAutomationWork({ root: temporaryRoot, workId: ready.id });
    assert.equal(stale.configuration.applicability, 'stale');
    assert.equal(stale.resume.classification, 'unavailable');
    assert.equal(stale.resume.reasonCode, 'CHECKPOINT_STALE');
    assert.equal(stale.continuationRequest, null);
    const staleReview = inspectPreparedAutomationReviewMaterial({
      root: temporaryRoot,
      workId: ready.id
    });
    assert.equal(staleReview.applicability, 'stale');
    assert.equal(staleReview.fingerprint, readyReview.fingerprint,
      'Derived applicability must not rewrite private review material.');
    const tamperedReview = structuredClone(staleReview);
    tamperedReview.fields.find((field) => field.id === 'operatorGoal').reviewValue = 'tampered';
    fs.writeFileSync(
      preparedWorkReviewMaterialStatePath(temporaryRoot, ready.id),
      JSON.stringify(tamperedReview, null, 2) + '\n'
    );
    assert.throws(
      () => inspectPreparedAutomationReviewMaterial({ root: temporaryRoot, workId: ready.id }),
      (error) => error.code === 'PREPARED_REVIEW_MATERIAL_TAMPERED'
    );
    fs.writeFileSync(
      preparedWorkReviewMaterialStatePath(temporaryRoot, ready.id),
      JSON.stringify(readyReview, null, 2) + '\n'
    );
    const bindingMismatch = structuredClone(readyReview);
    bindingMismatch.preparedWorkFingerprint = 'sha256:' + '0'.repeat(64);
    const unsignedBindingMismatch = structuredClone(bindingMismatch);
    delete unsignedBindingMismatch.fingerprint;
    delete unsignedBindingMismatch.applicability;
    bindingMismatch.fingerprint = fingerprintJson(unsignedBindingMismatch);
    fs.writeFileSync(
      preparedWorkReviewMaterialStatePath(temporaryRoot, ready.id),
      JSON.stringify(bindingMismatch, null, 2) + '\n'
    );
    assert.throws(
      () => inspectPreparedAutomationReviewMaterial({ root: temporaryRoot, workId: ready.id }),
      (error) => error.code === 'PREPARED_REVIEW_MATERIAL_BINDING_INVALID'
    );
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selftestPreparedWork();
  process.stdout.write('Prepared automation work self-test passed.\n');
}
