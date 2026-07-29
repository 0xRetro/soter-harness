import path from 'node:path';

import { listProviderDeclarations } from '../../core/capabilities.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import {
  commitDurableContextSnapshot,
  getExactDurableHostExecution,
  prepareDurableOperationPlanExecution
} from '../../core/service.mjs';
import {
  loadExactPreparedAutomationAcquisition
} from '../../core/prepared-work.mjs';

const PLAN_PREFIX = 'plan.meeting-intake.connected-acquisition.';
const SNAPSHOT_PREFIX = 'context.meeting-intake.connected-acquisition.';
const AUTOMATION_ID = 'automation.meeting-intake';
const POLICY_STEP_PREFIX = 'step.context-policy.';
const TRANSCRIPT_STEP_ID = 'step.context-transcript';
const MEETING_STEP_ID = 'step.context-meeting-record';
const ORGANIZATIONS_STEP_ID = 'step.context-organizations';
const PROJECTS_STEP_ID = 'step.context-projects';
const TASKS_STEP_ID = 'step.context-tasks';

function safeWorkId(workId) {
  if (typeof workId !== 'string'
    || !/^work\.meeting-intake\.[a-f0-9]{24}$/.test(workId)) {
    throw new Error('Connected Meeting Intake acquisition requires one exact prepared-work ID.');
  }
  return workId;
}

function suffixForWork(workId) {
  return safeWorkId(workId).slice('work.meeting-intake.'.length);
}

function snapshotIdForWork(workId) {
  return SNAPSHOT_PREFIX + suffixForWork(workId);
}

function snapshotIdFromPlan(planId) {
  if (typeof planId !== 'string' || !planId.startsWith(PLAN_PREFIX)) {
    throw new Error('Checkpoint is not a connected meeting-intake context plan.');
  }
  const suffix = planId.slice(PLAN_PREFIX.length);
  safeWorkId('work.meeting-intake.' + suffix);
  return SNAPSHOT_PREFIX + suffix;
}

function workIdFromPlan(planId) {
  snapshotIdFromPlan(planId);
  return safeWorkId('work.meeting-intake.' + planId.slice(PLAN_PREFIX.length));
}

function reviewValue(fields, id, { required = false } = {}) {
  const matches = fields.filter((field) => field.id === id);
  if (matches.length !== 1) {
    throw new Error('Meeting Intake prepared review material must declare field ' + id + ' exactly once.');
  }
  const field = matches[0];
  if (field.state === 'omitted') {
    if (required) throw new Error('Meeting Intake prepared review material requires field ' + id + '.');
    return null;
  }
  if (field.state !== 'provided'
    || typeof field.reviewValue !== 'string'
    || field.fingerprint !== fingerprintJson(field.reviewValue)) {
    throw new Error('Meeting Intake prepared review field ' + id + ' is not exactly fingerprint-bound.');
  }
  return field.reviewValue;
}

export function loadExactMeetingIntakePreparedInput({
  root,
  workId,
  expectedHost = null
}) {
  const resolvedRoot = path.resolve(root);
  const exactWorkId = safeWorkId(workId);
  const prepared = loadExactPreparedAutomationAcquisition({
    root: resolvedRoot,
    workId: exactWorkId,
    automationId: AUTOMATION_ID,
    expectedHost
  });
  const { work, material, lock, run, runPath } = prepared;
  assertSelectedAutomation(lock, run);
  return {
    work,
    material,
    lock,
    lockPath: work.configuration.lockPath,
    run,
    runPath,
    input: {
      meeting: reviewValue(material.fields, 'meeting', { required: true }),
      recordingUri: reviewValue(material.fields, 'recordingUri', { required: true }),
      operatorGoal: reviewValue(material.fields, 'operatorGoal')
    }
  };
}

function selectedAuthority(lock, role, subject) {
  const matches = lock.authorities.filter((item) => {
    return item.role === role && item.subject === subject;
  });
  if (matches.length !== 1) {
    throw new Error(
      'Expected one ' + role + ' authority for ' + subject + '; found ' + matches.length + '.'
    );
  }
  return matches[0].id;
}

function connectedProvider(root, lock, capability) {
  const binding = lock.bindings.find((item) => item.capability === capability);
  if (!binding) throw new Error('No resolved binding for ' + capability + '.');
  const matches = listProviderDeclarations(root).filter((provider) => {
    return provider.pack === binding.providerPack
      && provider.containment === 'connected'
      && provider.capabilities.some((item) => {
        return item.id === capability && item.version === binding.capabilityVersion;
      });
  });
  if (matches.length !== 1) {
    throw new Error(
      'Expected one connected provider for ' + capability + '; found ' + matches.length + '.'
    );
  }
  return matches[0].id;
}

function assertSelectedAutomation(lock, run) {
  const matches = lock.packs.filter((pack) => pack.id === AUTOMATION_ID);
  if (matches.length !== 1
    || matches[0].layer !== 'automation'
    || run?.automation?.id !== AUTOMATION_ID
    || run.automation.version !== matches[0].version) {
    throw new Error(
      'Connected meeting-intake context requires an exact run selecting '
        + AUTOMATION_ID + '.'
    );
  }
}

function sameJson(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function configuredPolicySources(lock) {
  const authoritySubjects = new Map([
    [selectedAuthority(lock, 'definition', 'meetings.records'), 'meetings.records'],
    [selectedAuthority(lock, 'definition', 'tasks.records'), 'tasks.records']
  ]);
  const bindings = (lock.sources || []).flatMap((source) => {
    const consumers = (source.consumers || []).filter((consumer) => {
      return consumer.pack === AUTOMATION_ID && consumer.purpose === 'applicable-policy';
    });
    if (!consumers.length) return [];
    if (consumers.length !== 1
      || typeof source.id !== 'string'
      || !source.id.startsWith('source.policy.')
      || source.capability !== 'documents.content.read'
      || !authoritySubjects.has(source.authority)
      || source.inputFingerprint !== fingerprintJson(source.input)
      || !sameJson(Object.keys(source.input).sort(), ['expectedTitle', 'uri'])) {
      throw new Error(
        'Meeting-intake applicable-policy sources require one exact document source consumer under its selected Meetings or Tasks definition authority.'
      );
    }
    const consumer = consumers[0];
    return [{
      id: source.id.slice('source.'.length),
      sourceId: source.id,
      authority: source.authority,
      authoritySubject: authoritySubjects.get(source.authority),
      subjects: structuredClone(consumer.subjects),
      title: source.input.expectedTitle,
      documentUri: source.input.uri,
      reason: consumer.reason
    }];
  });
  if (bindings.length < 1 || bindings.length > 10) {
    throw new Error('Meeting intake requires one through ten explicit applicable-policy sources.');
  }
  const ids = bindings.map((binding) => binding.id);
  const uris = bindings.map((binding) => binding.documentUri);
  if (new Set(ids).size !== ids.length
    || new Set(uris).size !== uris.length
    || bindings.some((binding) => {
      return typeof binding.id !== 'string' || !/^policy\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(binding.id)
        || !Array.isArray(binding.subjects) || binding.subjects.length < 1
        || typeof binding.title !== 'string' || !binding.title.trim()
        || typeof binding.documentUri !== 'string' || !binding.documentUri.trim()
        || typeof binding.reason !== 'string' || !binding.reason.trim();
    })) {
    throw new Error(
      'Meeting-intake policy sources require unique IDs and document URIs with valid identities and governed subjects.'
    );
  }
  return bindings.sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

function policyStepId(binding) {
  return POLICY_STEP_PREFIX + binding.id.slice('policy.'.length);
}

export function createMeetingIntakeConnectedContextPlan({
  root,
  lock,
  runId,
  workId,
  createdAt,
  expectedHost = null
}) {
  const resolvedRoot = path.resolve(root);
  const suffix = suffixForWork(workId);
  const prepared = loadExactMeetingIntakePreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  if (fingerprintLock(prepared.lock) !== fingerprintLock(lock)
    || prepared.lock.graphFingerprint !== lock.graphFingerprint
    || prepared.run.id !== runId) {
    throw new Error(
      'Connected Meeting Intake plan does not match its exact prepared work, lock, graph, and run.'
    );
  }
  const crmAuthority = selectedAuthority(lock, 'instance', 'crm.records');
  const projectsAuthority = selectedAuthority(lock, 'instance', 'projects.records');
  const tasksAuthority = selectedAuthority(lock, 'instance', 'tasks.records');
  const meetingsAuthority = selectedAuthority(lock, 'instance', 'meetings.records');
  const transcriptAuthority = selectedAuthority(lock, 'provider', 'meeting.transcript');
  const policySources = configuredPolicySources(lock);
  const crmProvider = connectedProvider(resolvedRoot, lock, 'crm.records.read');
  const projectsProvider = connectedProvider(resolvedRoot, lock, 'projects.records.read');
  const tasksProvider = connectedProvider(resolvedRoot, lock, 'tasks.records.read');
  const meetingsProvider = connectedProvider(resolvedRoot, lock, 'meetings.records.read');
  const documentProvider = connectedProvider(
    resolvedRoot,
    lock,
    'documents.content.read'
  );
  const transcriptProvider = connectedProvider(
    resolvedRoot,
    lock,
    'meeting.transcript.read'
  );
  return {
    $contract: 'soter://contracts/operation-plan/v2',
    contractVersion: '2.0.0',
    id: PLAN_PREFIX + suffix,
    runId,
    createdAt,
    mode: 'sequential',
    failurePolicy: 'stop',
    reason: 'Load every explicitly applicable policy body, exact transcript, matching Meeting, and only Organizations, Projects, and Tasks referenced by prior normalized outputs.',
    configuration: {
      name: prepared.work.configuration.name,
      configurationBasis: 'private-active',
      path: prepared.work.configuration.path,
      lockPath: prepared.work.configuration.lockPath,
      lockFingerprint: prepared.work.configuration.lockFingerprint,
      graphFingerprint: prepared.work.configuration.graphFingerprint
    },
    steps: [
      ...policySources.map((binding) => ({
        id: policyStepId(binding),
        capability: 'documents.content.read',
        authority: binding.authority,
        providerImplementation: documentProvider,
        input: {
          uri: binding.documentUri,
          expectedTitle: binding.title
        },
        inputBindings: [],
        reason: binding.reason
      })),
      {
        id: TRANSCRIPT_STEP_ID,
        capability: 'meeting.transcript.read',
        authority: transcriptAuthority,
        providerImplementation: transcriptProvider,
        input: {
          meetingId: prepared.input.meeting,
          recordingUri: prepared.input.recordingUri
        },
        inputBindings: [],
        reason: 'Load the exact user-selected transcript through its canonical recording URI.'
      },
      {
        id: MEETING_STEP_ID,
        capability: 'meetings.records.read',
        authority: meetingsAuthority,
        providerImplementation: meetingsProvider,
        input: {
          recordTypes: ['meeting'],
          filters: { recordingUri: prepared.input.recordingUri },
          limit: 2
        },
        inputBindings: [],
        reason: 'Resolve exactly one Meeting record by the same canonical recording URI.'
      },
      {
        id: ORGANIZATIONS_STEP_ID,
        capability: 'crm.records.read',
        authority: crmAuthority,
        providerImplementation: crmProvider,
        input: { recordTypes: ['organization'], limit: 100 },
        inputBindings: [{
          id: 'binding.context-organization-uris',
          sourceStepId: MEETING_STEP_ID,
          sourcePath: ['records', '*', 'fields', 'organizationUris'],
          targetPath: ['ids'],
          transform: 'unique-string-list',
          onEmpty: 'skip-step'
        }],
        reason: 'Read only organizations referenced by the normalized selected meeting.'
      },
      {
        id: PROJECTS_STEP_ID,
        capability: 'projects.records.read',
        authority: projectsAuthority,
        providerImplementation: projectsProvider,
        input: { recordTypes: ['project'], limit: 100 },
        inputBindings: [{
          id: 'binding.context-project-uris',
          sourceStepId: ORGANIZATIONS_STEP_ID,
          sourcePath: ['records', '*', 'fields', 'projectUris'],
          targetPath: ['ids'],
          transform: 'unique-string-list',
          onEmpty: 'skip-step'
        }],
        reason: 'Read only projects referenced by the resolved organizations.'
      },
      {
        id: TASKS_STEP_ID,
        capability: 'tasks.records.read',
        authority: tasksAuthority,
        providerImplementation: tasksProvider,
        input: { recordTypes: ['task'], limit: 100 },
        inputBindings: [{
          id: 'binding.context-task-uris',
          sourceStepId: PROJECTS_STEP_ID,
          sourcePath: ['records', '*', 'fields', 'taskUris'],
          targetPath: ['ids'],
          transform: 'unique-string-list',
          onEmpty: 'skip-step'
        }],
        reason: 'Read only tasks referenced by the resolved projects.'
      }
    ]
  };
}

export function assertMeetingIntakeConnectedContextPlan(plan) {
  const workId = workIdFromPlan(plan.id);
  const snapshotId = snapshotIdForWork(workId);
  if (plan.$contract !== 'soter://contracts/operation-plan/v2'
    || plan.contractVersion !== '2.0.0'
    || !Array.isArray(plan.steps)) {
    throw new Error('Connected meeting-intake context plan does not preserve its required source order.');
  }
  const transcriptIndex = plan.steps.findIndex((step) => step.id === TRANSCRIPT_STEP_ID);
  const policies = plan.steps.slice(0, transcriptIndex).map((step) => ({
    id: 'policy.' + step.id.slice(POLICY_STEP_PREFIX.length),
    step
  }));
  const [transcript, meeting, organizations, projects, tasks] = plan.steps.slice(transcriptIndex);
  const orderedPolicyIds = policies.map((item) => item.id);
  if (transcriptIndex < 1
    || plan.steps.length !== transcriptIndex + 5
    || transcript?.id !== TRANSCRIPT_STEP_ID
    || meeting?.id !== MEETING_STEP_ID
    || organizations?.id !== ORGANIZATIONS_STEP_ID
    || projects?.id !== PROJECTS_STEP_ID
    || tasks?.id !== TASKS_STEP_ID
    || orderedPolicyIds.some((id, index) => {
      return id !== [...orderedPolicyIds].sort((left, right) => left.localeCompare(right, 'en'))[index];
    })
    || policies.some(({ id, step }) => {
      return !step.id.startsWith(POLICY_STEP_PREFIX)
        || id === 'policy.'
        || step.capability !== 'documents.content.read'
        || !sameJson(Object.keys(step.input).sort(), ['expectedTitle', 'uri'])
        || typeof step.input.uri !== 'string' || !step.input.uri.trim()
        || typeof step.input.expectedTitle !== 'string' || !step.input.expectedTitle.trim()
        || !sameJson(step.inputBindings, []);
    })) {
    throw new Error('Connected meeting-intake context plan does not preserve its required source order.');
  }
  if (transcript.capability !== 'meeting.transcript.read'
    || !sameJson(transcript.inputBindings, [])
    || meeting.capability !== 'meetings.records.read'
    || !sameJson(meeting.input, {
      recordTypes: ['meeting'],
      filters: { recordingUri: transcript.input.recordingUri },
      limit: 2
    })
    || !sameJson(meeting.inputBindings, [])
    || organizations.capability !== 'crm.records.read'
    || !sameJson(organizations.input, { recordTypes: ['organization'], limit: 100 })
    || !sameJson(organizations.inputBindings, [{
      id: 'binding.context-organization-uris',
      sourceStepId: MEETING_STEP_ID,
      sourcePath: ['records', '*', 'fields', 'organizationUris'],
      targetPath: ['ids'],
      transform: 'unique-string-list',
      onEmpty: 'skip-step'
    }])
    || projects.capability !== 'projects.records.read'
    || !sameJson(projects.input, { recordTypes: ['project'], limit: 100 })
    || !sameJson(projects.inputBindings, [{
      id: 'binding.context-project-uris',
      sourceStepId: ORGANIZATIONS_STEP_ID,
      sourcePath: ['records', '*', 'fields', 'projectUris'],
      targetPath: ['ids'],
      transform: 'unique-string-list',
      onEmpty: 'skip-step'
    }])
    || tasks.capability !== 'tasks.records.read'
    || !sameJson(tasks.input, { recordTypes: ['task'], limit: 100 })
    || !sameJson(tasks.inputBindings, [{
      id: 'binding.context-task-uris',
      sourceStepId: PROJECTS_STEP_ID,
      sourcePath: ['records', '*', 'fields', 'taskUris'],
      targetPath: ['ids'],
      transform: 'unique-string-list',
      onEmpty: 'skip-step'
    }])
    || transcript.input.meetingId === undefined) {
    throw new Error('Connected meeting-intake context plan inputs do not preserve exact source identity.');
  }
  return {
    workId,
    snapshotId,
    policies,
    transcript,
    meeting,
    organizations,
    projects,
    tasks
  };
}

function completedStep(checkpoint, id) {
  const step = checkpoint.steps.find((item) => item.id === id);
  if (!step || step.state !== 'completed' || !step.call || !step.output) {
    throw new Error('Connected context source ' + id + ' is not completed.');
  }
  return step;
}

function assertPolicyOutput(step, binding) {
  const document = step.output.document;
  if (!document
    || document.uri !== binding.documentUri
    || document.title !== binding.title
    || document.format !== 'markdown'
    || typeof document.body !== 'string'
    || !document.body.trim()
    || document.body.length > 250000
    || document.bodyFingerprint !== fingerprintJson(document.body)) {
    throw new Error(
      'Connected context policy body does not match exact applicable policy ' + binding.id + '.'
    );
  }
}

function assertTranscriptOutput(step, planStep) {
  const output = step.output;
  const speakerIds = new Set((output.speakers || []).map((speaker) => speaker.id));
  if (output.meetingId !== planStep.input.meetingId
    || !Array.isArray(output.speakers)
    || output.speakers.length < 1
    || !Array.isArray(output.segments)
    || output.segments.length < 1
    || output.segments.some((segment) => !speakerIds.has(segment.speakerId))) {
    throw new Error('Connected context transcript is empty, mismatched, or references unknown speakers.');
  }
}

function assertMeetingOutput(step, planStep) {
  const records = step.output.records;
  if (!Array.isArray(records)
    || records.length !== 1
    || records[0].type !== 'meeting'
    || records[0].fields?.recordingUri !== planStep.input.filters.recordingUri) {
    throw new Error(
      'Connected context requires exactly one CRM meeting record matching the selected recording URI.'
    );
  }
}

function terminalRelatedStep(checkpoint, id, recordType) {
  const step = checkpoint.steps.find((item) => item.id === id);
  if (!step) throw new Error('Connected related-context source is missing: ' + id + '.');
  if (step.state === 'skipped') {
    if (step.call !== null
      || step.output !== null
      || !Array.isArray(step.resolvedInput?.ids)
      || step.resolvedInput.ids.length !== 0
      || step.bindingResolutions.length !== 1
      || step.bindingResolutions[0].state !== 'empty') {
      throw new Error('Connected related-context source ' + id + ' has invalid empty state.');
    }
    return null;
  }
  if (step.state !== 'completed' || !step.call || !step.output) {
    throw new Error('Connected related-context source ' + id + ' is not terminal.');
  }
  const requestedIds = step.resolvedInput?.ids;
  const records = step.output.records;
  const recordIds = Array.isArray(records) ? records.map((record) => record.id) : [];
  if (!Array.isArray(requestedIds)
    || requestedIds.length < 1
    || !Array.isArray(records)
    || records.some((record) => record.type !== recordType)
    || new Set(recordIds).size !== recordIds.length
    || !sameJson([...recordIds].sort(), [...requestedIds].sort())) {
    throw new Error(
      'Connected related-context source ' + id
        + ' must return every and only the records referenced by its bound input.'
    );
  }
  return step;
}

function freshnessState(root, capability, observedAt, at) {
  const contract = readJson(path.join(root, 'soter', 'capabilities', capability + '.json'));
  const maxAge = contract.freshness.maxAgeSeconds;
  if (maxAge === null) return 'unknown';
  const age = (Date.parse(at) - Date.parse(observedAt)) / 1000;
  if (!Number.isFinite(age) || age < 0) return 'unknown';
  return age <= maxAge ? 'passed' : 'stale';
}

function snapshotEntry({ root, id, subject, role, step, at, applicability = null }) {
  return {
    id,
    subject,
    authority: step.call.authority,
    role,
    capability: step.call.capability.id,
    providerPack: step.call.provider.pack,
    providerImplementation: step.call.provider.implementation,
    providerVersion: step.call.provider.version,
    observedAt: step.output.observedAt,
    freshness: freshnessState(root, step.call.capability.id, step.output.observedAt, at),
    provenance: step.output.provenance,
    valueFingerprint: step.outputFingerprint,
    value: step.output,
    ...(applicability ? { applicability } : {})
  };
}

function effectId(call) {
  return 'effect.' + call.id.slice('toolcall.'.length);
}

function freshnessRollup(entries) {
  if (entries.some((entry) => entry.freshness === 'stale')) return 'stale';
  if (entries.some((entry) => entry.freshness === 'unknown')) return 'unknown';
  return 'passed';
}

function contextUpdatesForEntries(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const current = grouped.get(entry.authority) || [];
    current.push(entry);
    grouped.set(entry.authority, current);
  }
  return [...grouped.entries()].map(([authority, authorityEntries]) => {
    const definition = authorityEntries.every((entry) => entry.role === 'definition');
    const definitionBodiesLoaded = !definition || authorityEntries.some((entry) => {
      return entry.applicability?.state === 'applicable';
    });
    const freshness = freshnessRollup(authorityEntries);
    const providers = [...new Set(
      authorityEntries.map((entry) => entry.providerImplementation)
    )].sort();
    const values = authorityEntries.map((entry) => ({
      id: entry.id,
      fingerprint: entry.valueFingerprint
    })).sort((left, right) => left.id.localeCompare(right.id, 'en'));
    return {
      authority,
      status: definition && !definitionBodiesLoaded
        ? 'declared'
        : (freshness === 'stale' ? 'stale' : 'loaded'),
      provenance: (definition && !definitionBodiesLoaded ? 'index:' : '')
        + providers.join('+') + ':set:' + fingerprintJson(values),
      freshness
    };
  });
}

export async function prepareMeetingIntakeConnectedContext({
  root,
  workId,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactMeetingIntakePreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  const createdAt = at || new Date().toISOString();
  const plan = createMeetingIntakeConnectedContextPlan({
    root: resolvedRoot,
    lock: prepared.lock,
    runId: prepared.run.id,
    workId,
    createdAt,
    expectedHost
  });
  return prepareDurableOperationPlanExecution({
    root: resolvedRoot,
    lockPath: prepared.lockPath,
    runPath: prepared.runPath,
    plan,
    at: createdAt,
    expectedHost,
    configurationBasis: 'private-active'
  });
}

export function finalizeMeetingIntakeConnectedContext({
  root,
  checkpointId,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const execution = getExactDurableHostExecution({
    root: resolvedRoot,
    checkpointId,
    expectedHost
  });
  const checkpoint = execution.checkpoint;
  if (checkpoint.kind !== 'operation-plan' || checkpoint.state !== 'completed') {
    throw new Error('Connected context can finalize only from a completed operation plan.');
  }
  const planShape = assertMeetingIntakeConnectedContextPlan(checkpoint.plan);
  const prepared = loadExactMeetingIntakePreparedInput({
    root: resolvedRoot,
    workId: planShape.workId,
    expectedHost
  });
  const policies = planShape.policies.map(({ id, step }) => ({
    id,
    planStep: step,
    runtimeStep: completedStep(checkpoint, step.id)
  }));
  const transcript = completedStep(checkpoint, TRANSCRIPT_STEP_ID);
  const meeting = completedStep(checkpoint, MEETING_STEP_ID);
  const organizations = terminalRelatedStep(checkpoint, ORGANIZATIONS_STEP_ID, 'organization');
  const projects = terminalRelatedStep(checkpoint, PROJECTS_STEP_ID, 'project');
  const tasks = terminalRelatedStep(checkpoint, TASKS_STEP_ID, 'task');

  const lock = prepared.lock;
  if (checkpoint.configurationLock.path !== prepared.lockPath
    || checkpoint.configurationLock.fingerprint !== fingerprintLock(lock)
    || checkpoint.graphFingerprint !== lock.graphFingerprint
    || checkpoint.plan.runId !== prepared.run.id
    || execution.run.id !== prepared.run.id) {
    throw new Error('Connected context checkpoint no longer matches its exact lock and graph.');
  }
  assertSelectedAutomation(lock, execution.run);
  const expectedPlan = createMeetingIntakeConnectedContextPlan({
    root: resolvedRoot,
    lock,
    runId: checkpoint.plan.runId,
    workId: planShape.workId,
    createdAt: checkpoint.plan.createdAt,
    expectedHost
  });
  if (fingerprintJson(expectedPlan) !== fingerprintJson(checkpoint.plan)) {
    throw new Error('Connected Meeting Intake acquisition drifted from its exact prepared-input basis.');
  }
  const policySources = configuredPolicySources(lock);
  if (!sameJson(policies.map(({ id, planStep }) => ({
    id,
    sourceId: 'source.' + id,
    authority: planStep.authority,
    uri: planStep.input.uri,
    title: planStep.input.expectedTitle
  })), policySources.map((binding) => ({
    id: binding.id,
    sourceId: binding.sourceId,
    authority: binding.authority,
    uri: binding.documentUri,
    title: binding.title
  })))) {
    throw new Error('Connected context plan does not match configured policy applicability.');
  }
  policies.forEach(({ id, runtimeStep }) => {
    const binding = policySources.find((item) => item.id === id);
    assertPolicyOutput(runtimeStep, binding);
  });
  assertTranscriptOutput(transcript, planShape.transcript);
  assertMeetingOutput(meeting, planShape.meeting);
  const expectedBindings = {
    crmAuthority: selectedAuthority(lock, 'instance', 'crm.records'),
    projectsAuthority: selectedAuthority(lock, 'instance', 'projects.records'),
    tasksAuthority: selectedAuthority(lock, 'instance', 'tasks.records'),
    meetingsAuthority: selectedAuthority(lock, 'instance', 'meetings.records'),
    transcriptAuthority: selectedAuthority(lock, 'provider', 'meeting.transcript'),
    crmProvider: connectedProvider(resolvedRoot, lock, 'crm.records.read'),
    projectsProvider: connectedProvider(resolvedRoot, lock, 'projects.records.read'),
    tasksProvider: connectedProvider(resolvedRoot, lock, 'tasks.records.read'),
    meetingsProvider: connectedProvider(resolvedRoot, lock, 'meetings.records.read'),
    documentProvider: connectedProvider(resolvedRoot, lock, 'documents.content.read'),
    transcriptProvider: connectedProvider(
      resolvedRoot,
      lock,
      'meeting.transcript.read'
    )
  };
  if (policies.some(({ id, runtimeStep }) => {
      const binding = policySources.find((item) => item.id === id);
      return runtimeStep.call.authority !== binding.authority
        || runtimeStep.call.provider.implementation !== expectedBindings.documentProvider;
    })
    || transcript.call.authority !== expectedBindings.transcriptAuthority
    || transcript.call.provider.implementation !== expectedBindings.transcriptProvider
    || meeting.call.authority !== expectedBindings.meetingsAuthority
    || meeting.call.provider.implementation !== expectedBindings.meetingsProvider
    || planShape.organizations.authority !== expectedBindings.crmAuthority
    || planShape.organizations.providerImplementation !== expectedBindings.crmProvider
    || planShape.projects.authority !== expectedBindings.projectsAuthority
    || planShape.projects.providerImplementation !== expectedBindings.projectsProvider
    || planShape.tasks.authority !== expectedBindings.tasksAuthority
    || planShape.tasks.providerImplementation !== expectedBindings.tasksProvider) {
    throw new Error('Connected context plan does not match the resolved source bindings and authorities.');
  }
  const createdAt = checkpoint.updatedAt;
  const entries = [
    ...policies.map(({ id, runtimeStep }) => {
      const binding = policySources.find((item) => item.id === id);
      return snapshotEntry({
        root: resolvedRoot,
        id: 'context.' + binding.authoritySubject.split('.')[0] + '.' + binding.id,
        subject: binding.authoritySubject,
        role: 'definition',
        step: runtimeStep,
        at: createdAt,
        applicability: {
          state: 'applicable',
          sourceId: binding.sourceId,
          subjects: binding.subjects,
          reason: binding.reason
        }
      });
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.meeting.transcript',
      subject: 'meeting.transcript',
      role: 'provider',
      step: transcript,
      at: createdAt
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.meetings.meeting',
      subject: 'meetings.records',
      role: 'instance',
      step: meeting,
      at: createdAt
    }),
    ...(organizations ? [snapshotEntry({
      root: resolvedRoot,
      id: 'context.crm.organizations',
      subject: 'crm.records',
      role: 'instance',
      step: organizations,
      at: createdAt
    })] : []),
    ...(projects ? [snapshotEntry({
      root: resolvedRoot,
      id: 'context.projects.projects',
      subject: 'projects.records',
      role: 'instance',
      step: projects,
      at: createdAt
    })] : []),
    ...(tasks ? [snapshotEntry({
      root: resolvedRoot,
      id: 'context.tasks.tasks',
      subject: 'tasks.records',
      role: 'instance',
      step: tasks,
      at: createdAt
    })] : [])
  ];
  const completedSources = [
    ...policies.map((item) => item.runtimeStep),
    transcript,
    meeting,
    organizations,
    projects,
    tasks
  ].filter(Boolean);
  const snapshot = {
    $contract: 'soter://contracts/context-snapshot/v1',
    contractVersion: '1.0.0',
    id: planShape.snapshotId,
    runId: checkpoint.plan.runId,
    createdAt,
    configurationLockFingerprint: checkpoint.configurationLock.fingerprint,
    graphFingerprint: checkpoint.graphFingerprint,
    containment: 'connected',
    entries,
    effectIds: completedSources.map((step) => effectId(step.call)),
    privacy: {
      scope: 'private',
      redactions: [
        'Provider credentials, raw host responses, and secret references are excluded.',
        'Only explicitly configured applicable policy bodies are loaded; unselected registry documents are excluded.',
        'Policy content is authoritative context for host judgment, not an automatically executable rules program.',
        'Organization, project, and task reads follow only normalized relation URIs; absent relations emit no provider request.',
        'Meeting participant identities remain Meetings references only and are not treated as CRM People identities without an explicit normalized link.'
      ]
    }
  };
  const contextUpdates = contextUpdatesForEntries(entries);
  return commitDurableContextSnapshot({
    root: resolvedRoot,
    checkpointId,
    snapshot,
    contextUpdates,
    checkpointDetails: 'Automation assembled every exact configured applicable policy body, exact transcript, exact Meeting, and reference-bound CRM Organizations, Projects, and Tasks through Core, then paused before participant resolution, judgment, or writes.',
    expectedHost
  });
}

export function meetingIntakePreparedWorkIdFromSnapshot(snapshotId) {
  if (typeof snapshotId !== 'string' || !snapshotId.startsWith(SNAPSHOT_PREFIX)) {
    throw new Error('Context snapshot is not bound to connected Meeting Intake acquisition.');
  }
  return safeWorkId('work.meeting-intake.' + snapshotId.slice(SNAPSHOT_PREFIX.length));
}
