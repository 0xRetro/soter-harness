import { invokeCapability } from '../../core/capabilities.mjs';
import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';

const AUTOMATION_ID = 'automation.meeting-intake';

function selectedAuthority(lock, role, subject) {
  const matches = lock.authorities.filter((item) => item.role === role && item.subject === subject);
  if (matches.length !== 1) {
    throw new Error('Meeting Intake preparation requires one exact ' + role + ' authority for ' + subject + '.');
  }
  return matches[0].id;
}

function policySources(lock, definitionAuthority) {
  const sources = lock.sources.flatMap((source) => {
    const consumers = source.consumers.filter((consumer) => {
      return consumer.pack === AUTOMATION_ID && consumer.purpose === 'applicable-policy';
    });
    if (!consumers.length) return [];
    if (consumers.length !== 1) {
      throw new Error('Meeting Intake preparation requires one exact consumer per applicable-policy source.');
    }
    return [{ ...source, meetingIntakeConsumer: consumers[0] }];
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
  if (sources.length < 1 || sources.length > 10 || sources.some((source) => {
    return typeof source.id !== 'string'
      || !/^source\.policy\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(source.id)
      || source.capability !== 'documents.content.read'
      || source.authority !== definitionAuthority
      || source.inputFingerprint !== fingerprintJson(source.input)
      || fingerprintJson(Object.keys(source.input).sort()) !== fingerprintJson(['expectedTitle', 'uri'])
      || typeof source.input?.uri !== 'string'
      || !source.input.uri.trim()
      || typeof source.input?.expectedTitle !== 'string'
      || !source.input.expectedTitle.trim()
      || !Array.isArray(source.meetingIntakeConsumer.subjects)
      || !source.meetingIntakeConsumer.subjects.length
      || source.meetingIntakeConsumer.subjects.some((subject) => {
        return typeof subject !== 'string' || !subject.trim();
      })
      || typeof source.meetingIntakeConsumer.reason !== 'string'
      || !source.meetingIntakeConsumer.reason.trim();
  }) || new Set(sources.map((source) => source.id)).size !== sources.length
    || new Set(sources.map((source) => source.input.uri)).size !== sources.length) {
    throw new Error('Meeting Intake preparation requires one through ten exact applicable-policy document sources.');
  }
  return sources;
}

async function fixtureRead({ root, lock, capability, authority, input, effectId, at }) {
  const result = await invokeCapability({
    root,
    lock,
    capability,
    authority,
    containment: 'fixture',
    input,
    effectId,
    at
  });
  if (result.invocation.state !== 'passed') {
    throw new Error('Meeting Intake contained context acquisition did not pass.');
  }
  return result;
}

function snapshotEntry({ id, subject, authority, role, result }) {
  return {
    id,
    subject,
    authority,
    role,
    capability: result.invocation.capability,
    providerPack: result.invocation.providerPack,
    providerImplementation: result.invocation.providerImplementation,
    providerVersion: result.invocation.providerVersion,
    observedAt: result.output.observedAt,
    freshness: 'passed',
    provenance: result.output.provenance,
    valueFingerprint: fingerprintJson(result.output),
    value: result.output
  };
}

function records(result, type) {
  return result.output.records.filter((record) => record.type === type);
}

function contextStep(entry, invocation, sequence) {
  const labels = {
    'context.meeting-intake.policy-index': 'Load meeting policy index',
    'context.meeting-intake.transcript': 'Load exact meeting transcript',
    'context.meeting-intake.meeting': 'Resolve matching meeting record',
    'context.meeting-intake.organizations': 'Load referenced organizations',
    'context.meeting-intake.projects': 'Load exact related project records',
    'context.meeting-intake.tasks': 'Load exact related task records'
  };
  return {
    id: 'preparation.context.' + String(sequence),
    sequence,
    label: labels[entry.id] || (entry.id.startsWith('context.meeting-intake.policy.')
      ? 'Load applicable policy · ' + entry.id.slice('context.meeting-intake.policy.'.length)
      : 'Load contained context'),
    capability: entry.capability,
    authority: entry.authority,
    containment: 'fixture',
    state: 'completed',
    inputFingerprint: invocation.inputFingerprint,
    outputFingerprint: entry.valueFingerprint,
    limitation: 'This is one typed fixture read; it does not establish connected reachability, permission, or provider health.'
  };
}

function previewFor({ input, meeting, transcript, policies, organizations, projects, tasks, projectReadComplete, taskReadComplete }) {
  const facts = [
    {
      id: 'meeting-reference',
      label: 'Meeting',
      value: input.meeting,
      state: 'supported',
      basisIds: ['context.meeting-intake.meeting', 'context.meeting-intake.transcript']
    },
    {
      id: 'transcript-segments',
      label: 'Transcript segments',
      value: transcript.segments.length,
      state: transcript.segments.length ? 'supported' : 'unavailable',
      basisIds: ['context.meeting-intake.transcript']
    },
    {
      id: 'applicable-policies',
      label: 'Applicable policies',
      value: policies.length,
      state: policies.length ? 'supported' : 'unavailable',
      basisIds: policies.map((item) => item.id)
    },
    {
      id: 'related-organizations',
      label: 'Related organizations',
      value: organizations.length,
      state: 'supported',
      basisIds: ['context.meeting-intake.organizations']
    },
    {
      id: 'related-projects',
      label: 'Related project candidates',
      value: projects.length,
      state: projectReadComplete ? 'supported' : 'unavailable',
      basisIds: ['context.meeting-intake.projects']
    },
    {
      id: 'task-candidates',
      label: 'Related task candidates',
      value: tasks.length,
      state: taskReadComplete ? 'supported' : 'unavailable',
      basisIds: ['context.meeting-intake.tasks']
    },
    {
      id: 'participant-resolution',
      label: 'Participant identity resolution',
      value: null,
      state: 'unavailable',
      basisIds: ['context.meeting-intake.meeting']
    }
  ];
  const contradictions = [];
  const collections = [];
  const privateReview = {
    state: 'unavailable', kind: null, contractId: null,
    contractFingerprint: null, contentFingerprint: null
  };
  const preview = {
    kind: 'meeting-intake-review',
    fingerprint: null,
    facts,
    contradictions,
    collections,
    privateReview,
    proposedChanges: []
  };
  preview.fingerprint = fingerprintJson({
    kind: preview.kind,
    facts,
    contradictions,
    collections,
    privateReview,
    proposedChanges: []
  });
  return preview;
}

export async function prepareMeetingIntakeRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt
}) {
  const runId = 'run.' + workId.slice('work.'.length);
  const snapshotId = 'context.' + workId.slice('work.'.length);
  const definitionAuthority = selectedAuthority(lock, 'definition', 'crm.records');
  const instanceAuthority = selectedAuthority(lock, 'instance', 'crm.records');
  const transcriptAuthority = selectedAuthority(lock, 'provider', 'meeting.transcript');
  const configuredPolicies = policySources(lock, definitionAuthority);
  const envelope = prepareRunEnvelope({
    root,
    lock,
    lockPath,
    scenarioPath: null,
    automationId: AUTOMATION_ID,
    runId,
    createdAt,
    requestedOutcome: 'Prepare a grounded Meeting Intake review packet and stop before judgment, approval, or writes.',
    evidenceIds: []
  });

  const acquired = [];
  const policyIndex = await fixtureRead({
    root, lock, capability: 'crm.records.read', authority: definitionAuthority,
    input: { recordTypes: ['policy'], limit: 25 },
    effectId: 'effect.meeting-intake.preparation.policy-index.fixture', at: createdAt
  });
  acquired.push({
    result: policyIndex,
    entry: snapshotEntry({
      id: 'context.meeting-intake.policy-index', subject: 'crm.records.policy-index',
      authority: definitionAuthority, role: 'definition', result: policyIndex
    })
  });
  for (const source of configuredPolicies) {
    const suffix = source.id.slice('source.'.length);
    const result = await fixtureRead({
      root, lock, capability: source.capability, authority: source.authority,
      input: source.input,
      effectId: 'effect.meeting-intake.preparation.' + suffix + '.fixture', at: createdAt
    });
    acquired.push({
      result,
      entry: snapshotEntry({
        id: 'context.meeting-intake.policy.' + suffix.slice('policy.'.length),
        subject: [...source.meetingIntakeConsumer.subjects].sort().join('+'),
        authority: source.authority, role: 'definition', result
      })
    });
  }

  const transcriptResult = await fixtureRead({
    root, lock, capability: 'meeting.transcript.read', authority: transcriptAuthority,
    input: { meetingId: input.meeting, recordingUri: input.recordingUri },
    effectId: 'effect.meeting-intake.preparation.transcript.fixture', at: createdAt
  });
  acquired.push({
    result: transcriptResult,
    entry: snapshotEntry({
      id: 'context.meeting-intake.transcript', subject: 'meeting.transcript',
      authority: transcriptAuthority, role: 'provider', result: transcriptResult
    })
  });

  const meetingResult = await fixtureRead({
    root, lock, capability: 'crm.records.read', authority: instanceAuthority,
    input: { recordTypes: ['meeting'], filters: { recordingUri: input.recordingUri }, limit: 2 },
    effectId: 'effect.meeting-intake.preparation.meeting.fixture', at: createdAt
  });
  const meetings = records(meetingResult, 'meeting');
  if (meetings.length !== 1
    || transcriptResult.output.meetingId !== input.meeting
    || transcriptResult.invocation.inputFingerprint !== fingerprintJson({
      meetingId: input.meeting,
      recordingUri: input.recordingUri
    })
    || meetings[0].fields.recordingUri !== input.recordingUri) {
    throw new Error('Meeting Intake preparation requires one exact matching meeting and transcript.');
  }
  acquired.push({
    result: meetingResult,
    entry: snapshotEntry({
      id: 'context.meeting-intake.meeting', subject: 'crm.records.meeting',
      authority: instanceAuthority, role: 'instance', result: meetingResult
    })
  });

  const organizationIds = [...new Set(meetings[0].fields.organizationUris || [])].sort();
  if (organizationIds.length > 100) {
    throw new Error('Meeting Intake preparation exceeds the bounded organization relationship limit.');
  }
  const organizationResult = await fixtureRead({
    root, lock, capability: 'crm.records.read', authority: instanceAuthority,
    input: { recordTypes: ['organization'], ids: organizationIds, limit: 100 },
    effectId: 'effect.meeting-intake.preparation.organizations.fixture', at: createdAt
  });
  const organizations = records(organizationResult, 'organization');
  if (fingerprintJson(organizations.map((record) => record.id).sort()) !== fingerprintJson(organizationIds)) {
    throw new Error('Meeting Intake preparation did not resolve every referenced organization exactly.');
  }
  acquired.push({
    result: organizationResult,
    entry: snapshotEntry({
      id: 'context.meeting-intake.organizations', subject: 'crm.records.organization',
      authority: instanceAuthority, role: 'instance', result: organizationResult
    })
  });

  const projectIds = [...new Set(organizations.flatMap((organization) => {
    return organization.fields.projectUris || [];
  }))].sort();
  if (projectIds.length > 100) {
    throw new Error('Meeting Intake preparation exceeds the bounded project relationship limit.');
  }
  const projectResult = await fixtureRead({
    root, lock, capability: 'crm.records.read', authority: instanceAuthority,
    input: { recordTypes: ['project'], ids: projectIds, limit: 100 },
    effectId: 'effect.meeting-intake.preparation.projects.fixture', at: createdAt
  });
  const projects = records(projectResult, 'project');
  if (fingerprintJson(projects.map((record) => record.id).sort()) !== fingerprintJson(projectIds)) {
    throw new Error('Meeting Intake preparation did not resolve every referenced project exactly.');
  }
  const projectReadComplete = true;
  acquired.push({
    result: projectResult,
    entry: snapshotEntry({
      id: 'context.meeting-intake.projects', subject: 'crm.records.project',
      authority: instanceAuthority, role: 'instance', result: projectResult
    })
  });

  const taskIds = [...new Set(projects.flatMap((project) => {
    return project.fields.taskUris || [];
  }))].sort();
  if (taskIds.length > 100) {
    throw new Error('Meeting Intake preparation exceeds the bounded task relationship limit.');
  }
  const taskResult = await fixtureRead({
    root, lock, capability: 'crm.records.read', authority: instanceAuthority,
    input: { recordTypes: ['task'], ids: taskIds, limit: 100 },
    effectId: 'effect.meeting-intake.preparation.tasks.fixture', at: createdAt
  });
  const tasks = records(taskResult, 'task');
  if (fingerprintJson(tasks.map((record) => record.id).sort()) !== fingerprintJson(taskIds)) {
    throw new Error('Meeting Intake preparation did not resolve every referenced task exactly.');
  }
  const taskReadComplete = true;
  acquired.push({
    result: taskResult,
    entry: snapshotEntry({
      id: 'context.meeting-intake.tasks', subject: 'crm.records.task',
      authority: instanceAuthority, role: 'instance', result: taskResult
    })
  });

  const entries = acquired.map((item) => item.entry);
  const effects = acquired.map((item) => item.result.invocation);
  const snapshot = {
    $contract: 'soter://contracts/context-snapshot/v1',
    contractVersion: '1.0.0',
    id: snapshotId,
    runId,
    createdAt,
    configurationLockFingerprint: fingerprintLock(lock),
    graphFingerprint: lock.graphFingerprint,
    containment: 'fixture',
    entries,
    effectIds: effects.map((effect) => effect.id),
    privacy: {
      scope: 'private',
      redactions: ['Provider credentials, secret references, and raw operator notes are excluded.']
    }
  };
  const grouped = new Map();
  for (const entry of entries) {
    const current = grouped.get(entry.authority) || [];
    current.push(entry.valueFingerprint);
    grouped.set(entry.authority, current);
  }
  envelope.context = envelope.context.map((item) => {
    const fingerprints = grouped.get(item.authority);
    if (!fingerprints) return item;
    return {
      ...item,
      status: 'loaded',
      provenance: 'fixture:' + fingerprintJson(fingerprints),
      freshness: 'passed'
    };
  });
  envelope.lifecycleState = 'paused';
  envelope.checkpoints = [
    { id: 'effects-established', state: 'passed', details: 'Read and disclosure policies were evaluated before each fixture invocation.' },
    { id: 'review-context-grounded', state: 'passed', details: 'Exact policy sources, transcript, meeting, organizations, projects, and tasks were loaded through their declared relationships for the private preview.' },
    { id: 'judgment-required', state: 'passed', details: 'The run stopped before interpreting summary segments, resolving participants, proposing tasks, or creating a write batch.' }
  ];
  envelope.outputs = [{ id: snapshot.id, type: 'context-snapshot', fingerprint: fingerprintJson(snapshot) }];
  envelope.effects = effects;

  const policyEntries = entries.filter((entry) => entry.id.startsWith('context.meeting-intake.policy.'));
  const preview = previewFor({
    input,
    meeting: meetings[0],
    transcript: transcriptResult.output,
    policies: policyEntries,
    organizations,
    projects,
    tasks,
    projectReadComplete,
    taskReadComplete
  });
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      {
        id: 'source-meeting-grounded',
        label: 'Exact source meeting and transcript grounded',
        state: 'supported',
        basis: ['context.meeting-intake.meeting', 'context.meeting-intake.transcript'],
        limitation: 'This is fixture-contained context, not a connected provider observation.'
      },
      {
        id: 'policy-sources-grounded',
        label: 'Every configured applicable policy source grounded',
        state: policyEntries.length === configuredPolicies.length ? 'supported' : 'blocked',
        basis: policyEntries.map((entry) => entry.id),
        limitation: 'Policy bodies are private context and are not projected into Studio.'
      },
      {
        id: 'relationship-and-followup-review',
        label: 'Relationships and follow-up candidates require cited judgment',
        state: 'blocked',
        basis: ['context.meeting-intake.meeting', 'context.meeting-intake.projects', 'context.meeting-intake.tasks'],
        limitation: 'Preparation does not attempt participant identity resolution, select transcript claims, choose task disposition, or propose a write batch. Project and task candidates are limited to exact relationship identifiers and fail closed above the configured bound.'
      }
    ],
    preview
  };
}
