import path from 'node:path';

import { listProviderDeclarations } from '../../core/capabilities.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import {
  loadExactPreparedAutomationAcquisition
} from '../../core/prepared-work.mjs';
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
const WORK_PATTERN = /^work\.email-triage\.([a-f0-9]{24})$/;

function connectedError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function safeWorkId(workId) {
  if (typeof workId !== 'string' || !WORK_PATTERN.test(workId)) {
    throw connectedError(
      'EMAIL_CONNECTED_WORK_INVALID',
      'Connected Email acquisition requires one exact prepared-work identifier.'
    );
  }
  return workId;
}

function workSuffix(workId) {
  return WORK_PATTERN.exec(safeWorkId(workId))[1];
}

function snapshotIdForWork(workId) {
  return SNAPSHOT_PREFIX + workSuffix(workId);
}

function planIdForWork(workId) {
  return PLAN_PREFIX + workSuffix(workId);
}

function workIdFromPlan(planId) {
  if (typeof planId !== 'string' || !planId.startsWith(PLAN_PREFIX)) {
    throw connectedError(
      'EMAIL_CONNECTED_PLAN_INVALID',
      'Connected Email checkpoint does not contain the expected plan family.'
    );
  }
  return safeWorkId('work.email-triage.' + planId.slice(PLAN_PREFIX.length));
}

function snapshotIdFromPlan(planId) {
  return snapshotIdForWork(workIdFromPlan(planId));
}

function sameJson(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function selectedAuthority(lock) {
  const matches = lock.authorities.filter((item) => {
    return item.role === 'instance' && item.subject === 'mail.mailbox';
  });
  if (matches.length !== 1) {
    throw connectedError(
      'EMAIL_CONNECTED_BINDING_INVALID',
      'Connected Email acquisition requires exactly one mail.mailbox instance authority.'
    );
  }
  return matches[0].id;
}

function connectedProvider(root, lock, capability) {
  const binding = lock.bindings.find((item) => item.capability === capability);
  if (!binding) {
    throw connectedError(
      'EMAIL_CONNECTED_BINDING_INVALID',
      'Connected Email acquisition is missing a required capability binding.'
    );
  }
  const matches = listProviderDeclarations(root).filter((provider) => {
    return provider.pack === binding.providerPack
      && provider.containment === 'connected'
      && provider.capabilities.some((item) => {
        return item.id === capability && item.version === binding.capabilityVersion;
      });
  });
  if (matches.length !== 1) {
    throw connectedError(
      'EMAIL_CONNECTED_BINDING_INVALID',
      'Connected Email acquisition requires one exact connected provider per capability.'
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
    throw connectedError(
      'EMAIL_CONNECTED_BINDING_INVALID',
      'Connected Email acquisition requires an exact run selecting ' + AUTOMATION_ID + '.'
    );
  }
}

function reviewValue(material, id, { required = false } = {}) {
  const matches = material.fields.filter((field) => field.id === id);
  if (matches.length !== 1) {
    throw connectedError(
      'EMAIL_CONNECTED_WORK_INVALID',
      'Connected Email private input does not match its declared fields.'
    );
  }
  const field = matches[0];
  if (field.state === 'omitted') {
    if (required) {
      throw connectedError(
        'EMAIL_CONNECTED_WORK_INVALID',
        'Connected Email prepared work is missing a required private input.'
      );
    }
    return null;
  }
  if (field.state !== 'provided'
    || field.fingerprint !== fingerprintJson(field.reviewValue)) {
    throw connectedError(
      'EMAIL_CONNECTED_WORK_INVALID',
      'Connected Email private input fingerprint is invalid.'
    );
  }
  return structuredClone(field.reviewValue);
}

export function loadExactEmailTriagePreparedInput({
  root,
  workId,
  expectedHost = null
}) {
  const resolvedRoot = path.resolve(root);
  const exactWorkId = safeWorkId(workId);
  let prepared;
  try {
    prepared = loadExactPreparedAutomationAcquisition({
      root: resolvedRoot,
      workId: exactWorkId,
      automationId: AUTOMATION_ID,
      expectedHost
    });
  } catch (error) {
    throw connectedError(
      'EMAIL_CONNECTED_WORK_INVALID',
      'Connected Email prepared work or private input is unavailable or invalid.',
      error
    );
  }
  const { work, material, lock, run, runPath } = prepared;
  try {
    assertSelectedAutomation(lock, run);
  } catch (error) {
    throw connectedError(
      'EMAIL_CONNECTED_BINDING_INVALID',
      'Connected Email durable run does not select the exact prepared Automation.',
      error
    );
  }
  const query = reviewValue(material, 'query', { required: true });
  const scope = reviewValue(material, 'scope', { required: true });
  const focus = reviewValue(material, 'focus');
  if (typeof query !== 'string'
    || !query.trim()
    || query.length > 1000
    || scope !== 'triage-drafts-handoffs-digest'
    || (focus !== null && (typeof focus !== 'string' || focus.length > 1000))) {
    throw connectedError(
      'EMAIL_CONNECTED_WORK_INVALID',
      'Connected Email private input does not satisfy its exact sealed mailbox bounds.'
    );
  }
  return {
    work,
    material,
    lock,
    lockPath: work.configuration.lockPath,
    run,
    runPath,
    input: { query, scope, focus },
    privateInputFingerprint: fingerprintJson({ query, scope, focus })
  };
}

export function createEmailTriageConnectedAcquisitionPlan({
  root,
  prepared,
  createdAt,
  expectedHost = null
}) {
  const { work, lock, run, input } = prepared;
  if (expectedHost && lock.host.id !== expectedHost) {
    throw connectedError(
      'EMAIL_CONNECTED_BINDING_INVALID',
      'Connected Email prepared work belongs to another host.'
    );
  }
  const query = input.query;
  if (typeof query !== 'string' || !query.trim() || query.length > 1000) {
    throw connectedError(
      'EMAIL_CONNECTED_WORK_INVALID',
      'Connected Email acquisition requires one bounded private mailbox query.'
    );
  }
  const authority = selectedAuthority(lock);
  return {
    $contract: 'soter://contracts/operation-plan/v2',
    contractVersion: '2.0.0',
    id: planIdForWork(work.id),
    runId: run.id,
    createdAt,
    mode: 'sequential',
    failurePolicy: 'stop',
    reason: 'Search one exact bounded private mailbox window, then expand only the returned provider-message identities into normalized private transport facts.',
    configuration: {
      name: work.configuration.name,
      configurationBasis: 'private-active',
      path: work.configuration.path,
      lockPath: work.configuration.lockPath,
      lockFingerprint: work.configuration.lockFingerprint,
      graphFingerprint: work.configuration.graphFingerprint
    },
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
  const workId = workIdFromPlan(plan?.id);
  const snapshotId = snapshotIdFromPlan(plan?.id);
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const [search, threads] = steps;
  if (plan.$contract !== 'soter://contracts/operation-plan/v2'
    || plan.contractVersion !== '2.0.0'
    || plan.mode !== 'sequential'
    || plan.failurePolicy !== 'stop'
    || steps.length !== 2
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
    throw connectedError(
      'EMAIL_CONNECTED_PLAN_INVALID',
      'Connected Email acquisition plan does not preserve its exact bounded source order.'
    );
  }
  return { workId, snapshotId, search, threads };
}

function completedStep(checkpoint, id) {
  const step = checkpoint.steps.find((item) => item.id === id);
  if (!step || step.state !== 'completed' || !step.call || !step.output) {
    throw connectedError(
      'EMAIL_CONNECTED_INCOMPLETE',
      'Connected Email acquisition source coverage is not complete.'
    );
  }
  return step;
}

function terminalThreadStep(checkpoint, searchedMessageIds) {
  const step = checkpoint.steps.find((item) => item.id === THREADS_STEP_ID);
  if (!step) {
    throw connectedError(
      'EMAIL_CONNECTED_INCOMPLETE',
      'Connected Email thread-expansion source is missing.'
    );
  }
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
      throw connectedError(
        'EMAIL_CONNECTED_OUTPUT_INVALID',
        'Empty connected Email acquisition did not preserve exact skip semantics.'
      );
    }
    return null;
  }
  if (step.state !== 'completed' || !step.call || !step.output) {
    throw connectedError(
      'EMAIL_CONNECTED_INCOMPLETE',
      'Connected Email thread expansion is not completed.'
    );
  }
  if (!sameJson(step.resolvedInput, {
    maximumThreads: MAXIMUM_THREADS,
    maximumMessagesPerThread: MAXIMUM_MESSAGES_PER_THREAD,
    messageIds: [...searchedMessageIds].sort((left, right) => left.localeCompare(right, 'en'))
  })) {
    throw connectedError(
      'EMAIL_CONNECTED_OUTPUT_INVALID',
      'Connected Email thread expansion does not bind the exact search result.'
    );
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
    throw connectedError(
      'EMAIL_CONNECTED_OUTPUT_INVALID',
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
    throw connectedError(
      'EMAIL_CONNECTED_OUTPUT_INVALID',
      'Connected Email thread expansion does not preserve its exact bounded request.'
    );
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
    throw connectedError(
      'EMAIL_CONNECTED_OUTPUT_INVALID',
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
  workId,
  at,
  expectedHost
}) {
  try {
    const resolvedRoot = path.resolve(root);
    const prepared = loadExactEmailTriagePreparedInput({
      root: resolvedRoot,
      workId,
      expectedHost
    });
    const createdAt = at || new Date().toISOString();
    const plan = createEmailTriageConnectedAcquisitionPlan({
      root: resolvedRoot,
      prepared,
      createdAt,
      expectedHost
    });
    return await prepareDurableOperationPlanExecution({
      root: resolvedRoot,
      lockPath: prepared.lockPath,
      runPath: prepared.runPath,
      plan,
      at: createdAt,
      expectedHost,
      configurationBasis: 'private-active'
    });
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('EMAIL_CONNECTED_')) {
      throw error;
    }
    throw connectedError(
      'EMAIL_CONNECTED_PLAN_INVALID',
      'Connected Email plan could not enter the durable host-tool boundary.',
      error
    );
  }
}

function finalizeEmailTriageConnectedAcquisitionInternal({
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
    throw connectedError(
      'EMAIL_CONNECTED_INCOMPLETE',
      'Connected Email acquisition can finalize only from a completed operation plan.'
    );
  }
  const planShape = assertEmailTriageConnectedAcquisitionPlan(checkpoint.plan);
  const prepared = loadExactEmailTriagePreparedInput({
    root: resolvedRoot,
    workId: planShape.workId,
    expectedHost
  });
  const expectedPlan = createEmailTriageConnectedAcquisitionPlan({
    root: resolvedRoot,
    prepared,
    createdAt: checkpoint.plan.createdAt,
    expectedHost
  });
  if (!sameJson(expectedPlan, checkpoint.plan)
    || checkpoint.configurationLock.path !== prepared.lockPath
    || checkpoint.configurationLock.fingerprint !== fingerprintLock(prepared.lock)
    || checkpoint.graphFingerprint !== prepared.lock.graphFingerprint
    || checkpoint.plan.runId !== prepared.run.id
    || execution.run.id !== prepared.run.id) {
    throw connectedError(
      'EMAIL_CONNECTED_STALE',
      'Connected Email acquisition drifted from its current exact prepared-work basis.'
    );
  }
  const search = completedStep(checkpoint, SEARCH_STEP_ID);
  const searchedMessageIds = assertSearchOutput(search);
  const threads = terminalThreadStep(checkpoint, searchedMessageIds);
  if (threads) assertThreadOutput(threads, searchedMessageIds);

  const lock = prepared.lock;
  if (checkpoint.configurationLock.fingerprint !== fingerprintLock(lock)
    || checkpoint.graphFingerprint !== lock.graphFingerprint) {
    throw connectedError(
      'EMAIL_CONNECTED_STALE',
      'Connected Email acquisition checkpoint no longer matches its exact lock and graph.'
    );
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
    throw connectedError(
      'EMAIL_CONNECTED_BINDING_INVALID',
      'Connected Email acquisition does not match the resolved providers and authority.'
    );
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

export function finalizeEmailTriageConnectedAcquisition(args) {
  try {
    return finalizeEmailTriageConnectedAcquisitionInternal(args);
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('EMAIL_CONNECTED_')) {
      throw error;
    }
    throw connectedError(
      'EMAIL_CONNECTED_SNAPSHOT_INVALID',
      'Connected Email context could not be finalized from its exact durable checkpoint.',
      error
    );
  }
}
