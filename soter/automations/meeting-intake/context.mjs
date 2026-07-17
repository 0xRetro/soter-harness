import path from 'node:path';

import { listProviderDeclarations } from '../../core/capabilities.mjs';
import { fingerprintJson, readJson, resolveRepoPath } from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import {
  commitDurableContextSnapshot,
  getExactDurableHostExecution,
  prepareDurableOperationPlanExecution
} from '../../core/service.mjs';

const PLAN_PREFIX = 'plan.meeting-intake.connected-context.';
const SNAPSHOT_PREFIX = 'context.meeting-intake.connected.';
const AUTOMATION_ID = 'automation.meeting-intake';
const DEFINITION_STEP_ID = 'step.context-definition-index';
const POLICY_STEP_PREFIX = 'step.context-policy.';
const TRANSCRIPT_STEP_ID = 'step.context-transcript';
const MEETING_STEP_ID = 'step.context-meeting-record';
const ORGANIZATIONS_STEP_ID = 'step.context-organizations';
const PROJECTS_STEP_ID = 'step.context-projects';
const TASKS_STEP_ID = 'step.context-tasks';

function snapshotSuffix(snapshotId) {
  if (typeof snapshotId !== 'string'
    || !snapshotId.startsWith(SNAPSHOT_PREFIX)
    || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(snapshotId.slice(SNAPSHOT_PREFIX.length))) {
    throw new Error(
      'Connected meeting-intake snapshot ID must start with ' + SNAPSHOT_PREFIX
        + ' and end in a safe unique suffix.'
    );
  }
  return snapshotId.slice(SNAPSHOT_PREFIX.length);
}

function snapshotIdFromPlan(planId) {
  if (typeof planId !== 'string' || !planId.startsWith(PLAN_PREFIX)) {
    throw new Error('Checkpoint is not a connected meeting-intake context plan.');
  }
  const suffix = planId.slice(PLAN_PREFIX.length);
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(suffix)) {
    throw new Error('Connected meeting-intake context plan has an unsafe suffix.');
  }
  return SNAPSHOT_PREFIX + suffix;
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
  const definitionAuthority = selectedAuthority(lock, 'definition', 'crm.records');
  const bindings = (lock.sources || []).flatMap((source) => {
    const consumers = (source.consumers || []).filter((consumer) => {
      return consumer.pack === AUTOMATION_ID && consumer.purpose === 'applicable-policy';
    });
    if (!consumers.length) return [];
    if (consumers.length !== 1
      || typeof source.id !== 'string'
      || !source.id.startsWith('source.policy.')
      || source.capability !== 'documents.content.read'
      || source.authority !== definitionAuthority
      || source.inputFingerprint !== fingerprintJson(source.input)
      || !sameJson(Object.keys(source.input).sort(), ['expectedTitle', 'uri'])) {
      throw new Error(
        'Meeting-intake applicable-policy sources require one exact document source consumer under the selected definition authority.'
      );
    }
    const consumer = consumers[0];
    return [{
      id: source.id.slice('source.'.length),
      sourceId: source.id,
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
  snapshotId,
  meetingId,
  recordingUri,
  createdAt
}) {
  const resolvedRoot = path.resolve(root);
  const suffix = snapshotSuffix(snapshotId);
  const definitionAuthority = selectedAuthority(lock, 'definition', 'crm.records');
  const instanceAuthority = selectedAuthority(lock, 'instance', 'crm.records');
  const transcriptAuthority = selectedAuthority(lock, 'provider', 'meeting.transcript');
  const policySources = configuredPolicySources(lock);
  const crmProvider = connectedProvider(resolvedRoot, lock, 'crm.records.read');
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
    reason: 'Load the bounded definition index, every explicitly applicable policy body, exact transcript, matching CRM meeting, and only records referenced by prior normalized outputs.',
    steps: [
      {
        id: DEFINITION_STEP_ID,
        capability: 'crm.records.read',
        authority: definitionAuthority,
        providerImplementation: crmProvider,
        input: { recordTypes: ['policy'], limit: 25 },
        inputBindings: [],
        reason: 'Load the bounded configured policy index so exact applicable document identities can be cross-checked.'
      },
      ...policySources.map((binding) => ({
        id: policyStepId(binding),
        capability: 'documents.content.read',
        authority: definitionAuthority,
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
        input: { meetingId, recordingUri },
        inputBindings: [],
        reason: 'Load the exact user-selected transcript through its canonical recording URI.'
      },
      {
        id: MEETING_STEP_ID,
        capability: 'crm.records.read',
        authority: instanceAuthority,
        providerImplementation: crmProvider,
        input: {
          recordTypes: ['meeting'],
          filters: { recordingUri },
          limit: 2
        },
        inputBindings: [],
        reason: 'Resolve exactly one CRM meeting record by the same canonical recording URI.'
      },
      {
        id: ORGANIZATIONS_STEP_ID,
        capability: 'crm.records.read',
        authority: instanceAuthority,
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
        capability: 'crm.records.read',
        authority: instanceAuthority,
        providerImplementation: crmProvider,
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
        capability: 'crm.records.read',
        authority: instanceAuthority,
        providerImplementation: crmProvider,
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
  const snapshotId = snapshotIdFromPlan(plan.id);
  if (plan.$contract !== 'soter://contracts/operation-plan/v2'
    || plan.contractVersion !== '2.0.0'
    || !Array.isArray(plan.steps)) {
    throw new Error('Connected meeting-intake context plan does not preserve its required source order.');
  }
  const transcriptIndex = plan.steps.findIndex((step) => step.id === TRANSCRIPT_STEP_ID);
  const definition = plan.steps[0];
  const policies = plan.steps.slice(1, transcriptIndex).map((step) => ({
    id: 'policy.' + step.id.slice(POLICY_STEP_PREFIX.length),
    step
  }));
  const [transcript, meeting, organizations, projects, tasks] = plan.steps.slice(transcriptIndex);
  const orderedPolicyIds = policies.map((item) => item.id);
  if (transcriptIndex < 2
    || plan.steps.length !== transcriptIndex + 5
    || definition?.id !== DEFINITION_STEP_ID
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
  if (definition.capability !== 'crm.records.read'
    || !sameJson(definition.input, { recordTypes: ['policy'], limit: 25 })
    || !sameJson(definition.inputBindings, [])
    || transcript.capability !== 'meeting.transcript.read'
    || !sameJson(transcript.inputBindings, [])
    || meeting.capability !== 'crm.records.read'
    || !sameJson(meeting.input, {
      recordTypes: ['meeting'],
      filters: { recordingUri: transcript.input.recordingUri },
      limit: 2
    })
    || !sameJson(meeting.inputBindings, [])
    || !sameJson(organizations.input, { recordTypes: ['organization'], limit: 100 })
    || !sameJson(organizations.inputBindings, [{
      id: 'binding.context-organization-uris',
      sourceStepId: MEETING_STEP_ID,
      sourcePath: ['records', '*', 'fields', 'organizationUris'],
      targetPath: ['ids'],
      transform: 'unique-string-list',
      onEmpty: 'skip-step'
    }])
    || !sameJson(projects.input, { recordTypes: ['project'], limit: 100 })
    || !sameJson(projects.inputBindings, [{
      id: 'binding.context-project-uris',
      sourceStepId: ORGANIZATIONS_STEP_ID,
      sourcePath: ['records', '*', 'fields', 'projectUris'],
      targetPath: ['ids'],
      transform: 'unique-string-list',
      onEmpty: 'skip-step'
    }])
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
    snapshotId,
    definition,
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

function assertDefinitionOutput(step, policySources) {
  if (!Array.isArray(step.output.records)
    || step.output.records.length < 1
    || step.output.records.some((record) => record.type !== 'policy')) {
    throw new Error('Connected context requires at least one typed policy index record.');
  }
  for (const binding of policySources) {
    const matches = step.output.records.filter((record) => {
      return record.id === binding.documentUri && record.fields?.name === binding.title;
    });
    if (matches.length !== 1) {
      throw new Error(
        'Connected context policy index does not identify exact applicable policy '
          + binding.id + '.'
      );
    }
  }
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
  lockPath,
  runPath,
  snapshotId,
  meetingId,
  recordingUri,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const lock = readJson(resolveRepoPath(resolvedRoot, lockPath));
  const run = readJson(resolveRepoPath(resolvedRoot, runPath));
  assertSelectedAutomation(lock, run);
  const createdAt = at || new Date().toISOString();
  const plan = createMeetingIntakeConnectedContextPlan({
    root: resolvedRoot,
    lock,
    runId: run.id,
    snapshotId,
    meetingId,
    recordingUri,
    createdAt
  });
  return prepareDurableOperationPlanExecution({
    root: resolvedRoot,
    lockPath,
    runPath,
    plan,
    at: createdAt,
    expectedHost
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
  const definition = completedStep(checkpoint, DEFINITION_STEP_ID);
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

  const lock = readJson(resolveRepoPath(resolvedRoot, checkpoint.configurationLock.path));
  if (checkpoint.configurationLock.fingerprint !== fingerprintLock(lock)
    || checkpoint.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Connected context checkpoint no longer matches its exact lock and graph.');
  }
  assertSelectedAutomation(lock, execution.run);
  const policySources = configuredPolicySources(lock);
  if (!sameJson(policies.map(({ id, planStep }) => ({
    id,
    sourceId: 'source.' + id,
    uri: planStep.input.uri,
    title: planStep.input.expectedTitle
  })), policySources.map((binding) => ({
    id: binding.id,
    sourceId: binding.sourceId,
    uri: binding.documentUri,
    title: binding.title
  })))) {
    throw new Error('Connected context plan does not match configured policy applicability.');
  }
  assertDefinitionOutput(definition, policySources);
  policies.forEach(({ id, runtimeStep }) => {
    const binding = policySources.find((item) => item.id === id);
    assertPolicyOutput(runtimeStep, binding);
  });
  assertTranscriptOutput(transcript, planShape.transcript);
  assertMeetingOutput(meeting, planShape.meeting);
  const expectedBindings = {
    definitionAuthority: selectedAuthority(lock, 'definition', 'crm.records'),
    instanceAuthority: selectedAuthority(lock, 'instance', 'crm.records'),
    transcriptAuthority: selectedAuthority(lock, 'provider', 'meeting.transcript'),
    crmProvider: connectedProvider(resolvedRoot, lock, 'crm.records.read'),
    documentProvider: connectedProvider(resolvedRoot, lock, 'documents.content.read'),
    transcriptProvider: connectedProvider(
      resolvedRoot,
      lock,
      'meeting.transcript.read'
    )
  };
  if (definition.call.authority !== expectedBindings.definitionAuthority
    || definition.call.provider.implementation !== expectedBindings.crmProvider
    || policies.some(({ runtimeStep }) => {
      return runtimeStep.call.authority !== expectedBindings.definitionAuthority
        || runtimeStep.call.provider.implementation !== expectedBindings.documentProvider;
    })
    || transcript.call.authority !== expectedBindings.transcriptAuthority
    || transcript.call.provider.implementation !== expectedBindings.transcriptProvider
    || meeting.call.authority !== expectedBindings.instanceAuthority
    || meeting.call.provider.implementation !== expectedBindings.crmProvider
    || [planShape.organizations, planShape.projects, planShape.tasks].some((step) => {
      return step.authority !== expectedBindings.instanceAuthority
        || step.providerImplementation !== expectedBindings.crmProvider;
    })) {
    throw new Error('Connected context plan does not match the resolved source bindings and authorities.');
  }
  const createdAt = checkpoint.updatedAt;
  const entries = [
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.crm.definition-index',
      subject: 'crm.records',
      role: 'definition',
      step: definition,
      at: createdAt
    }),
    ...policies.map(({ id, runtimeStep }) => {
      const binding = policySources.find((item) => item.id === id);
      return snapshotEntry({
        root: resolvedRoot,
        id: 'context.crm.' + binding.id,
        subject: 'crm.records',
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
      id: 'context.crm.meeting',
      subject: 'crm.records',
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
      id: 'context.crm.projects',
      subject: 'crm.records',
      role: 'instance',
      step: projects,
      at: createdAt
    })] : []),
    ...(tasks ? [snapshotEntry({
      root: resolvedRoot,
      id: 'context.crm.tasks',
      subject: 'crm.records',
      role: 'instance',
      step: tasks,
      at: createdAt
    })] : [])
  ];
  const completedSources = [
    definition,
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
        'Meeting participant identifiers remain references only and are not treated as CRM contact record URIs.'
      ]
    }
  };
  const contextUpdates = contextUpdatesForEntries(entries);
  return commitDurableContextSnapshot({
    root: resolvedRoot,
    checkpointId,
    snapshot,
    contextUpdates,
    checkpointDetails: 'Automation assembled the bounded definition index, every exact configured applicable policy body, exact transcript, exact CRM meeting, and reference-bound related records through Core, then paused before participant resolution, judgment, or writes.',
    expectedHost
  });
}
