import fs from 'node:fs';
import path from 'node:path';

import { invokeCapability } from './capabilities.mjs';
import { fingerprintJson } from './lib/canonical-json.mjs';
import { fingerprintLock } from './resolve.mjs';
import { prepareRunEnvelope } from './run.mjs';

function freshnessState(root, capability, observedAt, at) {
  const contract = JSON.parse(
    fs.readFileSync(path.join(root, 'soter', 'capabilities', capability + '.json'), 'utf8')
  );
  const maxAge = contract.freshness.maxAgeSeconds;
  if (maxAge === null) return 'unknown';
  const age = (Date.parse(at) - Date.parse(observedAt)) / 1000;
  if (!Number.isFinite(age) || age < 0) return 'unknown';
  return age <= maxAge ? 'passed' : 'stale';
}

function requirePassed(result) {
  if (result.invocation.state !== 'passed') {
    throw new Error(
      result.invocation.capability + ' failed during context assembly: '
        + result.invocation.error.kind + ' ' + result.invocation.error.message
    );
  }
  return result;
}

function snapshotEntry({ id, subject, authority, role, invocation, output, freshness }) {
  return {
    id,
    subject,
    authority,
    role,
    capability: invocation.capability,
    providerPack: invocation.providerPack,
    providerImplementation: invocation.providerImplementation,
    providerVersion: invocation.providerVersion,
    observedAt: output.observedAt,
    freshness,
    provenance: output.provenance,
    valueFingerprint: fingerprintJson(output),
    value: output
  };
}

export async function assembleMeetingIntakeContext({
  root,
  lock,
  lockPath,
  scenarioPath,
  runId,
  snapshotId,
  createdAt,
  meetingId,
  recordingUri,
  evidenceIds
}) {
  const resolvedRoot = path.resolve(root);
  const envelope = prepareRunEnvelope({
    root: resolvedRoot,
    lock,
    lockPath,
    scenarioPath,
    automationId: 'automation.meeting-intake',
    runId,
    createdAt,
    requestedOutcome: 'Assemble grounded meeting-intake context from contained fixtures and stop before automation writes.',
    evidenceIds
  });

  const definition = requirePassed(await invokeCapability({
    root: resolvedRoot,
    lock,
    capability: 'crm.records.read',
    authority: 'authority.crm.definition',
    containment: 'fixture',
    input: { recordTypes: ['policy'], ids: ['policy.meeting-intake'] },
    effectId: 'effect.meeting-intake.crm-definition.fixture',
    at: createdAt
  }));
  const instances = requirePassed(await invokeCapability({
    root: resolvedRoot,
    lock,
    capability: 'crm.records.read',
    authority: 'authority.crm.instance',
    containment: 'fixture',
    input: {
      recordTypes: ['organization', 'person', 'project', 'task', 'meeting'],
      ids: [
        'soter-fixture://crm/organization/acme',
        'soter-fixture://crm/person/maya',
        'soter-fixture://crm/project/launch',
        'soter-fixture://crm/task/existing-deck',
        'soter-fixture://crm/meeting/fixture-001'
      ]
    },
    effectId: 'effect.meeting-intake.crm-instances.fixture',
    at: createdAt
  }));
  const transcript = requirePassed(await invokeCapability({
    root: resolvedRoot,
    lock,
    capability: 'meeting.transcript.read',
    authority: 'authority.otter.provider',
    containment: 'fixture',
    input: { meetingId, recordingUri },
    effectId: 'effect.meeting-intake.transcript.fixture',
    at: createdAt
  }));

  const results = [definition, instances, transcript];
  const entries = [
    snapshotEntry({
      id: 'context.crm.definition',
      subject: 'crm.records',
      authority: 'authority.crm.definition',
      role: 'definition',
      invocation: definition.invocation,
      output: definition.output,
      freshness: freshnessState(resolvedRoot, definition.invocation.capability, definition.output.observedAt, createdAt)
    }),
    snapshotEntry({
      id: 'context.crm.instances',
      subject: 'crm.records',
      authority: 'authority.crm.instance',
      role: 'instance',
      invocation: instances.invocation,
      output: instances.output,
      freshness: freshnessState(resolvedRoot, instances.invocation.capability, instances.output.observedAt, createdAt)
    }),
    snapshotEntry({
      id: 'context.meeting.transcript',
      subject: 'meeting.transcript',
      authority: 'authority.otter.provider',
      role: 'provider',
      invocation: transcript.invocation,
      output: transcript.output,
      freshness: freshnessState(resolvedRoot, transcript.invocation.capability, transcript.output.observedAt, createdAt)
    })
  ];
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
    effectIds: results.map((result) => result.invocation.id),
    privacy: {
      scope: 'private',
      redactions: ['Provider credentials and secret references are excluded.']
    }
  };

  const loaded = new Map(entries.map((entry) => [entry.authority, entry]));
  envelope.context = envelope.context.map((item) => {
    const source = loaded.get(item.authority);
    if (!source) return item;
    return {
      ...item,
      status: source.freshness === 'stale' ? 'stale' : 'loaded',
      provenance: source.providerImplementation + ':' + source.valueFingerprint,
      freshness: source.freshness
    };
  });
  envelope.lifecycleState = 'paused';
  envelope.checkpoints = [
    {
      id: 'effects-established',
      state: 'passed',
      details: 'Read and disclosure policies were evaluated before every fixture provider invocation.'
    },
    {
      id: 'context-assembled',
      state: 'passed',
      details: 'CRM definitions, CRM instances, and the meeting transcript were loaded from typed fixture providers.'
    },
    {
      id: 'contained-boundary',
      state: 'passed',
      details: 'The run paused before automation execution, provider writes, or external effects.'
    }
  ];
  envelope.outputs = [
    {
      id: snapshot.id,
      type: 'context-snapshot',
      fingerprint: fingerprintJson(snapshot)
    }
  ];
  envelope.effects = results.map((result) => result.invocation);
  return { envelope, snapshot };
}
