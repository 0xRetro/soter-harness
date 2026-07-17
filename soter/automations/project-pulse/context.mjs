import fs from 'node:fs';
import path from 'node:path';

import { invokeCapability } from '../../core/capabilities.mjs';
import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';

const AUTOMATION_ID = 'automation.project-pulse';

function projectStatusPolicySource(lock) {
  const sources = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID && consumer.purpose === 'project-status-policy';
  }));
  if (sources.length !== 1) {
    throw new Error('Project Pulse requires exactly one resolved project-status-policy source.');
  }
  const source = sources[0];
  if (source.capability !== 'crm.records.read' || source.authority !== 'authority.crm.definition') {
    throw new Error('Project Pulse policy source must use crm.records.read under definition authority.');
  }
  return source;
}

function freshnessState(root, capability, observedAt, at) {
  const contract = JSON.parse(fs.readFileSync(
    path.join(root, 'soter', 'capabilities', capability + '.json'),
    'utf8'
  ));
  const maxAge = contract.freshness.maxAgeSeconds;
  if (maxAge === null) return 'unknown';
  const age = (Date.parse(at) - Date.parse(observedAt)) / 1000;
  if (!Number.isFinite(age) || age < 0) return 'unknown';
  return age <= maxAge ? 'passed' : 'stale';
}

function requirePassed(result) {
  if (result.invocation.state !== 'passed') {
    throw new Error(
      result.invocation.capability + ' failed during Project Pulse grounding: '
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

export async function assembleProjectPulseContext({
  root,
  lock,
  lockPath,
  scenarioPath,
  runId,
  snapshotId,
  projectId,
  createdAt,
  evidenceIds = []
}) {
  const resolvedRoot = path.resolve(root);
  const envelope = prepareRunEnvelope({
    root: resolvedRoot,
    lock,
    lockPath,
    scenarioPath,
    automationId: AUTOMATION_ID,
    runId,
    createdAt,
    requestedOutcome: 'Ground a read-only project status brief in authoritative fixture records.',
    evidenceIds
  });
  const policySource = projectStatusPolicySource(lock);

  const definition = requirePassed(await invokeCapability({
    root: resolvedRoot,
    lock,
    capability: 'crm.records.read',
    authority: 'authority.crm.definition',
    containment: 'fixture',
    input: policySource.input,
    effectId: 'effect.project-pulse.policy.fixture',
    at: createdAt
  }));
  const project = requirePassed(await invokeCapability({
    root: resolvedRoot,
    lock,
    capability: 'crm.records.read',
    authority: 'authority.crm.instance',
    containment: 'fixture',
    input: { recordTypes: ['project'], ids: [projectId] },
    effectId: 'effect.project-pulse.project.fixture',
    at: createdAt
  }));
  const work = requirePassed(await invokeCapability({
    root: resolvedRoot,
    lock,
    capability: 'crm.records.read',
    authority: 'authority.crm.instance',
    containment: 'fixture',
    input: { recordTypes: ['milestone', 'task'], filters: { projectId }, limit: 100 },
    effectId: 'effect.project-pulse.work.fixture',
    at: createdAt
  }));
  const results = [definition, project, work];
  const entries = [
    snapshotEntry({
      id: 'context.project-pulse.policy',
      subject: 'crm.records.project-policy',
      authority: 'authority.crm.definition',
      role: 'definition',
      invocation: definition.invocation,
      output: definition.output,
      freshness: freshnessState(resolvedRoot, definition.invocation.capability, definition.output.observedAt, createdAt)
    }),
    snapshotEntry({
      id: 'context.project-pulse.project',
      subject: 'crm.records.project',
      authority: 'authority.crm.instance',
      role: 'instance',
      invocation: project.invocation,
      output: project.output,
      freshness: freshnessState(resolvedRoot, project.invocation.capability, project.output.observedAt, createdAt)
    }),
    snapshotEntry({
      id: 'context.project-pulse.work',
      subject: 'crm.records.project-work',
      authority: 'authority.crm.instance',
      role: 'instance',
      invocation: work.invocation,
      output: work.output,
      freshness: freshnessState(resolvedRoot, work.invocation.capability, work.output.observedAt, createdAt)
    })
  ];
  if (definition.output.records.length !== 1 || project.output.records.length !== 1) {
    throw new Error('Project Pulse requires exactly one policy and one selected project record.');
  }
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
  envelope.lifecycleState = 'context-assembled';
  envelope.checkpoints = [
    {
      id: 'effects-established',
      state: 'passed',
      details: 'Read and disclosure policies were evaluated before every fixture provider invocation.'
    },
    {
      id: 'project-context-grounded',
      state: 'passed',
      details: 'The exact policy, project, milestones, and promoted tasks were loaded through typed fixture reads.'
    },
    {
      id: 'read-only-boundary',
      state: 'passed',
      details: 'No create, update, dispatch, or destructive capability was invoked.'
    }
  ];
  envelope.outputs = [{
    id: snapshot.id,
    type: 'context-snapshot',
    fingerprint: fingerprintJson(snapshot)
  }];
  envelope.effects = results.map((result) => result.invocation);
  return { envelope, snapshot };
}
