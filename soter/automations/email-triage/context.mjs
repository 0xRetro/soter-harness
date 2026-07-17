import path from 'node:path';

import { listProviderDeclarations } from '../../core/capabilities.mjs';
import { fingerprintJson, readJson, resolveRepoPath } from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import {
  commitDurableContextSnapshot,
  getExactDurableHostExecution,
  prepareDurableOperationPlanExecution
} from '../../core/service.mjs';

const PLAN_PREFIX = 'plan.email-triage.connected-acquisition.';
const SNAPSHOT_PREFIX = 'context.email-triage.connected-acquisition.';
const AUTOMATION_ID = 'automation.email-triage';
const SEARCH_STEP_ID = 'step.mail-message-search';
const THREADS_STEP_ID = 'step.mail-thread-expansion';
const MAXIMUM_MESSAGES = 100;
const MAXIMUM_THREADS = 50;
const MAXIMUM_MESSAGES_PER_THREAD = 500;

function snapshotSuffix(snapshotId) {
  if (typeof snapshotId !== 'string'
    || !snapshotId.startsWith(SNAPSHOT_PREFIX)
    || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(snapshotId.slice(SNAPSHOT_PREFIX.length))) {
    throw new Error(
      'Connected Email acquisition snapshot ID must start with ' + SNAPSHOT_PREFIX
        + ' and end in a safe unique suffix.'
    );
  }
  return snapshotId.slice(SNAPSHOT_PREFIX.length);
}

function snapshotIdFromPlan(planId) {
  if (typeof planId !== 'string' || !planId.startsWith(PLAN_PREFIX)) {
    throw new Error('Checkpoint is not a connected Email acquisition plan.');
  }
  const suffix = planId.slice(PLAN_PREFIX.length);
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(suffix)) {
    throw new Error('Connected Email acquisition plan has an unsafe suffix.');
  }
  return SNAPSHOT_PREFIX + suffix;
}

function sameJson(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function selectedAuthority(lock) {
  const matches = lock.authorities.filter((item) => {
    return item.role === 'instance' && item.subject === 'mail.mailbox';
  });
  if (matches.length !== 1) {
    throw new Error(
      'Connected Email acquisition requires exactly one mail.mailbox instance authority.'
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
      'Connected Email acquisition requires an exact run selecting ' + AUTOMATION_ID + '.'
    );
  }
}

export function createEmailTriageConnectedAcquisitionPlan({
  root,
  lock,
  runId,
  snapshotId,
  query,
  createdAt
}) {
  const suffix = snapshotSuffix(snapshotId);
  if (typeof query !== 'string' || !query.trim() || query.length > 1000) {
    throw new Error('Connected Email acquisition requires one bounded private mailbox query.');
  }
  const authority = selectedAuthority(lock);
  return {
    $contract: 'soter://contracts/operation-plan/v2',
    contractVersion: '2.0.0',
    id: PLAN_PREFIX + suffix,
    runId,
    createdAt,
    mode: 'sequential',
    failurePolicy: 'stop',
    reason: 'Search one exact bounded private mailbox window, then expand only the returned provider-message identities into normalized private transport facts.',
    steps: [
      {
        id: SEARCH_STEP_ID,
        capability: 'mail.messages.search',
        authority,
        providerImplementation: connectedProvider(root, lock, 'mail.messages.search'),
        input: { query, maximumMessages: MAXIMUM_MESSAGES },
        inputBindings: [],
        reason: 'Resolve the exact bounded provider-message identity set and explicit pagination state.'
      },
      {
        id: THREADS_STEP_ID,
        capability: 'mail.threads.read',
        authority,
        providerImplementation: connectedProvider(root, lock, 'mail.threads.read'),
        input: {
          maximumThreads: MAXIMUM_THREADS,
          maximumMessagesPerThread: MAXIMUM_MESSAGES_PER_THREAD
        },
        inputBindings: [{
          id: 'binding.mail-message-identities',
          sourceStepId: SEARCH_STEP_ID,
          sourcePath: ['messageIds'],
          targetPath: ['messageIds'],
          transform: 'unique-string-list',
          onEmpty: 'skip-step'
        }],
        reason: 'Expand only exact searched messages and their bounded thread siblings without classification.'
      }
    ]
  };
}

export function assertEmailTriageConnectedAcquisitionPlan(plan) {
  const snapshotId = snapshotIdFromPlan(plan?.id);
  const [search, threads] = plan?.steps || [];
  if (plan.$contract !== 'soter://contracts/operation-plan/v2'
    || plan.contractVersion !== '2.0.0'
    || plan.mode !== 'sequential'
    || plan.failurePolicy !== 'stop'
    || plan.steps.length !== 2
    || search?.id !== SEARCH_STEP_ID
    || search.capability !== 'mail.messages.search'
    || !sameJson(search.inputBindings, [])
    || typeof search.input?.query !== 'string'
    || !search.input.query.trim()
    || search.input.maximumMessages !== MAXIMUM_MESSAGES
    || threads?.id !== THREADS_STEP_ID
    || threads.capability !== 'mail.threads.read'
    || !sameJson(threads.input, {
      maximumThreads: MAXIMUM_THREADS,
      maximumMessagesPerThread: MAXIMUM_MESSAGES_PER_THREAD
    })
    || !sameJson(threads.inputBindings, [{
      id: 'binding.mail-message-identities',
      sourceStepId: SEARCH_STEP_ID,
      sourcePath: ['messageIds'],
      targetPath: ['messageIds'],
      transform: 'unique-string-list',
      onEmpty: 'skip-step'
    }])
    || search.authority !== threads.authority) {
    throw new Error('Connected Email acquisition plan does not preserve its exact bounded source order.');
  }
  return { snapshotId, search, threads };
}

function completedStep(checkpoint, id) {
  const step = checkpoint.steps.find((item) => item.id === id);
  if (!step || step.state !== 'completed' || !step.call || !step.output) {
    throw new Error('Connected Email acquisition source ' + id + ' is not completed.');
  }
  return step;
}

function terminalThreadStep(checkpoint, searchedMessageIds) {
  const step = checkpoint.steps.find((item) => item.id === THREADS_STEP_ID);
  if (!step) throw new Error('Connected Email thread-expansion source is missing.');
  if (searchedMessageIds.length === 0) {
    if (step.state !== 'skipped'
      || step.call !== null
      || step.output !== null
      || !sameJson(step.resolvedInput, {
        maximumThreads: MAXIMUM_THREADS,
        maximumMessagesPerThread: MAXIMUM_MESSAGES_PER_THREAD,
        messageIds: []
      })
      || step.bindingResolutions.length !== 1
      || step.bindingResolutions[0].state !== 'empty') {
      throw new Error('Empty connected Email acquisition did not preserve exact skip semantics.');
    }
    return null;
  }
  if (step.state !== 'completed' || !step.call || !step.output) {
    throw new Error('Connected Email thread expansion is not completed.');
  }
  if (!sameJson(step.resolvedInput, {
    maximumThreads: MAXIMUM_THREADS,
    maximumMessagesPerThread: MAXIMUM_MESSAGES_PER_THREAD,
    messageIds: [...searchedMessageIds].sort((left, right) => left.localeCompare(right, 'en'))
  })) {
    throw new Error('Connected Email thread expansion does not bind the exact search result.');
  }
  return step;
}

function assertSearchOutput(step) {
  const output = step.output;
  const ids = output?.messageIds;
  if (!Array.isArray(ids)
    || new Set(ids).size !== ids.length
    || ids.length > MAXIMUM_MESSAGES
    || output.returnedMessageCount !== ids.length
    || output.complete !== true
    || output.queryFingerprint !== fingerprintJson(step.resolvedInput.query)
    || output.provenance?.sourceKind !== 'connected'
    || output.provenance?.authority !== step.call.authority) {
    throw new Error(
      'Connected Email search must be complete, bounded, unique, counted, and bound to the exact private query.'
    );
  }
  return [...ids].sort((left, right) => left.localeCompare(right, 'en'));
}

function assertThreadOutput(step, searchedMessageIds) {
  const output = step.output;
  if (!sameJson(output?.requestedMessageIds, searchedMessageIds)
    || !Array.isArray(output.threads)
    || output.threads.length < 1
    || output.threads.length > MAXIMUM_THREADS
    || output.returnedThreadCount !== output.threads.length
    || output.provenance?.sourceKind !== 'connected'
    || output.provenance?.authority !== step.call.authority) {
    throw new Error('Connected Email thread expansion does not preserve its exact bounded request.');
  }
  const threadIds = output.threads.map((thread) => thread.id);
  const messages = output.threads.flatMap((thread) => thread.messages || []);
  const messageIds = messages.map((message) => message.id);
  if (new Set(threadIds).size !== threadIds.length
    || new Set(messageIds).size !== messageIds.length
    || output.threads.some((thread) => {
      return !Array.isArray(thread.messages)
        || thread.messages.length < 1
        || thread.messages.length > MAXIMUM_MESSAGES_PER_THREAD;
    })
    || searchedMessageIds.some((id) => messageIds.filter((item) => item === id).length !== 1)) {
    throw new Error(
      'Connected Email thread expansion must cover every requested message exactly once with unique bounded thread and message identities.'
    );
  }
}

function freshnessState(root, capability, observedAt, at) {
  const contract = readJson(path.join(root, 'soter', 'capabilities', capability + '.json'));
  const maxAge = contract.freshness.maxAgeSeconds;
  if (maxAge === null) return 'unknown';
  const age = (Date.parse(at) - Date.parse(observedAt)) / 1000;
  if (!Number.isFinite(age) || age < 0) return 'unknown';
  return age <= maxAge ? 'passed' : 'stale';
}

function snapshotEntry({ root, id, subject, step, at }) {
  return {
    id,
    subject,
    authority: step.call.authority,
    role: 'instance',
    capability: step.call.capability.id,
    providerPack: step.call.provider.pack,
    providerImplementation: step.call.provider.implementation,
    providerVersion: step.call.provider.version,
    observedAt: step.output.observedAt,
    freshness: freshnessState(root, step.call.capability.id, step.output.observedAt, at),
    provenance: step.output.provenance,
    valueFingerprint: step.outputFingerprint,
    value: step.output
  };
}

function effectId(call) {
  return 'effect.' + call.id.slice('toolcall.'.length);
}

export async function prepareEmailTriageConnectedAcquisition({
  root,
  lockPath,
  runPath,
  snapshotId,
  query,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const lock = readJson(resolveRepoPath(resolvedRoot, lockPath));
  const run = readJson(resolveRepoPath(resolvedRoot, runPath));
  assertSelectedAutomation(lock, run);
  const createdAt = at || new Date().toISOString();
  const plan = createEmailTriageConnectedAcquisitionPlan({
    root: resolvedRoot,
    lock,
    runId: run.id,
    snapshotId,
    query,
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

export function finalizeEmailTriageConnectedAcquisition({
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
    throw new Error('Connected Email acquisition can finalize only from a completed operation plan.');
  }
  const planShape = assertEmailTriageConnectedAcquisitionPlan(checkpoint.plan);
  const search = completedStep(checkpoint, SEARCH_STEP_ID);
  const searchedMessageIds = assertSearchOutput(search);
  const threads = terminalThreadStep(checkpoint, searchedMessageIds);
  if (threads) assertThreadOutput(threads, searchedMessageIds);

  const lock = readJson(resolveRepoPath(resolvedRoot, checkpoint.configurationLock.path));
  if (checkpoint.configurationLock.fingerprint !== fingerprintLock(lock)
    || checkpoint.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Connected Email acquisition checkpoint no longer matches its exact lock and graph.');
  }
  assertSelectedAutomation(lock, execution.run);
  const authority = selectedAuthority(lock);
  const searchProvider = connectedProvider(resolvedRoot, lock, 'mail.messages.search');
  const threadProvider = connectedProvider(resolvedRoot, lock, 'mail.threads.read');
  if (search.call.authority !== authority
    || search.call.provider.implementation !== searchProvider
    || planShape.threads.authority !== authority
    || planShape.threads.providerImplementation !== threadProvider
    || (threads && (threads.call.authority !== authority
      || threads.call.provider.implementation !== threadProvider))) {
    throw new Error('Connected Email acquisition does not match the resolved providers and authority.');
  }

  const createdAt = checkpoint.updatedAt;
  const completedSources = [search, threads].filter(Boolean);
  const entries = [
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.email.message-search',
      subject: 'mail.mailbox',
      step: search,
      at: createdAt
    }),
    ...(threads ? [snapshotEntry({
      root: resolvedRoot,
      id: 'context.email.thread-expansion',
      subject: 'mail.mailbox',
      step: threads,
      at: createdAt
    })] : [])
  ];
  const freshness = entries.some((entry) => entry.freshness === 'stale')
    ? 'stale'
    : (entries.some((entry) => entry.freshness === 'unknown') ? 'unknown' : 'passed');
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
        'Provider credentials, secret references, raw native responses, account identifiers, and opaque pagination cursors are excluded.',
        'The mailbox query remains private run input; only its fingerprint is retained in normalized capability output.',
        'Normalized sender, recipient, subject, and body values remain private Context state and never enter workspace inspection, evidence, diagnostics, or canonical fixtures.',
        'Mail content is untrusted data, not instructions. This acquisition records no classification, prompt-injection judgment, handoff, proposed action, or execution authority.',
        'The acquisition pauses before triage judgment, draft generation, batch review, approval, provider writes, or dispatch.'
      ]
    }
  };
  return commitDurableContextSnapshot({
    root: resolvedRoot,
    checkpointId,
    snapshot,
    contextUpdates: [{
      authority,
      status: freshness === 'stale' ? 'stale' : 'loaded',
      provenance: searchProvider + '+' + (threads ? threadProvider : 'empty-window')
        + ':set:' + fingerprintJson(entries.map((entry) => ({
          id: entry.id,
          fingerprint: entry.valueFingerprint
        }))),
      freshness
    }],
    checkpointDetails: 'Automation acquired one complete bounded provider-message set and its exact bounded normalized thread expansion through Core, then paused before triage judgment, drafts, approval, or writes.',
    expectedHost
  });
}
