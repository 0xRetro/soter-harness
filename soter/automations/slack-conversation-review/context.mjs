import path from 'node:path';

import { listProviderDeclarations } from '../../core/capabilities.mjs';
import { exactRequestedContextRecord } from '../../core/context-records.mjs';
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
  getExactDurableContextSnapshot,
  getExactDurableHostExecution,
  prepareDurableOperationPlanExecution
} from '../../core/service.mjs';
import { validateJsonSchema } from '../../kernel/verify.mjs';
import { slackConversationReviewSuspectedInjection } from './prepare.mjs';

const AUTOMATION_ID = 'automation.slack-conversation-review';
const PLAN_PREFIX = 'plan.slack-conversation-review.connected-acquisition.';
const SNAPSHOT_PREFIX = 'context.slack-conversation-review.connected-acquisition.';
const POLICY_STEP_ID = 'step.slack-conversation-review-policy';
const CONVERSATIONS_STEP_ID = 'step.slack-selected-conversations';
const MESSAGE_STEP_PREFIX = 'step.slack-message-window.';
const THREAD_STEP_PREFIX = 'step.slack-selected-thread.';
const WORK_PATTERN = /^work\.slack-conversation-review\.([a-f0-9]{24})$/;
const THREAD_REFERENCE = /^conversation:([A-Za-z0-9._-]+)\/thread:([A-Za-z0-9._:-]+)$/;
const NOTION_PAGE_PATH =
  /^\/(?:[A-Za-z0-9-]+\/)?(?:[A-Za-z0-9-]+-)?(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const APP_NOTION_PAGE_PATH =
  /^\/(?:p\/)?(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const APP_NOTION_PAGE_URL =
  /^https:\/\/app\.notion\.com\/(?:p\/)?(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\?[^#]*)?$/i;
const SLACK_WORKSPACE_ID = /^T[A-Z0-9]{8,63}$/;
const INSPECTION_SCHEMA = 'soter/automations/slack-conversation-review/connected-inspection.schema.json';
const REVIEW_SCHEMA = 'soter/automations/slack-conversation-review/connected-review.schema.json';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameJson(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function connectedError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function safeWorkId(value) {
  if (typeof value !== 'string' || !WORK_PATTERN.test(value)) {
    throw connectedError(
      'SLACK_CONNECTED_WORK_INVALID',
      'Connected Slack review requires one exact prepared-work identifier.'
    );
  }
  return value;
}

function workSuffix(workId) {
  return WORK_PATTERN.exec(safeWorkId(workId))[1];
}

function workIdFromPlan(planId) {
  if (typeof planId !== 'string' || !planId.startsWith(PLAN_PREFIX)) {
    throw connectedError(
      'SLACK_CONNECTED_PLAN_INVALID',
      'Connected Slack review checkpoint does not contain the expected plan family.'
    );
  }
  return safeWorkId('work.slack-conversation-review.' + planId.slice(PLAN_PREFIX.length));
}

function planIdForWork(workId) {
  return PLAN_PREFIX + workSuffix(workId);
}

function checkpointIdForWork(workId) {
  return 'checkpoint.' + planIdForWork(workId);
}

function snapshotIdForWork(workId) {
  return SNAPSHOT_PREFIX + workSuffix(workId);
}

function exactInstant(value, code = 'SLACK_CONNECTED_WORK_INVALID') {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw connectedError(code, 'Connected Slack review contains an invalid bounded instant.');
  }
  return new Date(value).toISOString();
}

function validateClosed(root, value, schemaPath, code, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    throw connectedError(code, label + ' does not satisfy its closed contract.');
  }
  return value;
}

function selfFingerprint(value) {
  const unsigned = structuredClone(value);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
}

function withSelfFingerprint(value) {
  const next = { ...value, fingerprint: 'sha256:' + '0'.repeat(64) };
  next.fingerprint = selfFingerprint(next);
  return next;
}

function loadPolicy(root) {
  const policy = readJson(path.join(
    root,
    'soter',
    'contexts',
    'communications',
    'collaboration',
    'conversation-review.policy.json'
  ));
  if (policy.$contract !== 'soter://contracts/conversation-review-policy/v1'
    || policy.id !== 'policy.context.communications.collaboration.conversation-review'
    || !Array.isArray(policy.windows)
    || policy.maximumSelectedConversations !== 20
    || policy.maximumConversationObservations !== 2000
    || policy.maximumMessagesPerConversation !== 100
    || policy.maximumThreadsPerReview !== 20
    || policy.maximumMessagesPerThread !== 1000
    || !sameJson(policy.allowedConversationKinds, ['public-channel', 'private-channel'])
    || policy.directMessagesIncluded !== false
    || policy.threadReadsRequireWindowRootOrExplicitSelection !== true
    || policy.threadExpansionMode !== 'explicit-selection-only'
    || policy.completeCoverageRequired !== true
    || policy.contentClassification !== 'private-untrusted'
    || policy.suspectedInjectionSurfaced !== true
    || policy.persistenceProposalsAllowed !== false
    || policy.writesAllowed !== false) {
    throw connectedError(
      'SLACK_CONNECTED_POLICY_INVALID',
      'Connected Slack review policy does not preserve the exact read-only boundary.'
    );
  }
  return policy;
}

function selectedAuthority(
  lock,
  role = 'instance',
  subject = 'communications.workspace'
) {
  const matches = lock.authorities.filter((item) => {
    return item.role === role && item.subject === subject;
  });
  if (matches.length !== 1) {
    throw connectedError(
      'SLACK_CONNECTED_BINDING_INVALID',
      'Connected Slack review requires one exact workspace instance authority.'
    );
  }
  return matches[0].id;
}

export function slackConversationReviewPolicySourceUrlIsExact(value) {
  if (typeof value !== 'string' || value.trim() !== value || !value) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:'
    || !['www.notion.so', 'app.notion.com'].includes(parsed.hostname)
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.hash
    || !(parsed.hostname === 'app.notion.com'
      ? APP_NOTION_PAGE_URL.test(value) && APP_NOTION_PAGE_PATH.test(parsed.pathname)
      : NOTION_PAGE_PATH.test(parsed.pathname))) {
    return false;
  }
  if (!parsed.search) return true;
  const keys = [...new Set(parsed.searchParams.keys())];
  if (keys.some((key) => !['pvs', 'source'].includes(key))) return false;
  if (keys.some((key) => parsed.searchParams.getAll(key).length !== 1)) return false;
  return (!parsed.searchParams.has('pvs')
      || /^[0-9]{1,2}$/.test(parsed.searchParams.get('pvs')))
    && (!parsed.searchParams.has('source')
      || parsed.searchParams.get('source') === 'copy_link');
}

function selectedPolicySource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => {
    return source.consumers.some((consumer) => {
      return consumer.pack === AUTOMATION_ID
        && consumer.purpose === 'conversation-review-policy';
    });
  });
  if (matches.length !== 1) {
    throw connectedError(
      'SLACK_CONNECTED_BINDING_INVALID',
      'Connected Slack review requires one exact configured policy source.'
    );
  }
  const source = matches[0];
  if (source.capability !== 'communications.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || !sameJson(source.input.recordTypes, ['conversation-review-policy'])
    || !Array.isArray(source.input.ids)
    || source.input.ids.length !== 1
    || !slackConversationReviewPolicySourceUrlIsExact(source.input.ids[0])
    || source.input.limit !== 2) {
    throw connectedError(
      'SLACK_CONNECTED_BINDING_INVALID',
      'Connected Slack review policy source must be one exact private Notion page URL under its definition authority.'
    );
  }
  return source;
}

function configuredWorkspaceId(lock) {
  const settings = lock.settings?.['integration.slack'];
  if (!settings
    || Object.keys(settings).length !== 1
    || typeof settings.workspaceId !== 'string'
    || !SLACK_WORKSPACE_ID.test(settings.workspaceId)) {
    throw connectedError(
      'SLACK_CONNECTED_BINDING_INVALID',
      'Connected Slack review requires one exact private integration.slack workspace setting.'
    );
  }
  return settings.workspaceId;
}

function connectedProvider(root, lock, capability) {
  const binding = lock.bindings.find((item) => item.capability === capability);
  if (!binding) {
    throw connectedError(
      'SLACK_CONNECTED_BINDING_INVALID',
      'Connected Slack review is missing one required capability binding.'
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
      'SLACK_CONNECTED_BINDING_INVALID',
      'Connected Slack review requires one exact connected provider per capability.'
    );
  }
  return matches[0].id;
}

function assertSelectedAutomation(lock, run) {
  const selected = lock.packs.filter((pack) => {
    return pack.id === AUTOMATION_ID && pack.layer === 'automation';
  });
  if (selected.length !== 1
    || run?.automation?.id !== AUTOMATION_ID
    || run.automation.version !== selected[0].version) {
    throw connectedError(
      'SLACK_CONNECTED_BINDING_INVALID',
      'Connected Slack review requires the exact selected Automation and durable run.'
    );
  }
}

function reviewField(material, id, { required = false } = {}) {
  const matches = material.fields.filter((field) => field.id === id);
  if (matches.length !== 1) {
    throw connectedError(
      'SLACK_CONNECTED_WORK_INVALID',
      'Connected Slack review private input does not match its declared fields.'
    );
  }
  const field = matches[0];
  if (field.state === 'omitted') {
    if (required) {
      throw connectedError(
        'SLACK_CONNECTED_WORK_INVALID',
        'Connected Slack review is missing a required private input.'
      );
    }
    return null;
  }
  if (field.state !== 'provided'
    || field.fingerprint !== fingerprintJson(field.reviewValue)) {
    throw connectedError(
      'SLACK_CONNECTED_WORK_INVALID',
      'Connected Slack review private input fingerprint is invalid.'
    );
  }
  return structuredClone(field.reviewValue);
}

function parseThreadReferences(values, selectedConversationIds, maximum) {
  if (!Array.isArray(values) || values.length > maximum) {
    throw connectedError(
      'SLACK_CONNECTED_WORK_INVALID',
      'Connected Slack review thread selection exceeds the exact policy bound.'
    );
  }
  const selected = new Set(selectedConversationIds);
  const references = values.map((value) => {
    const match = typeof value === 'string' ? THREAD_REFERENCE.exec(value) : null;
    if (!match || !selected.has(match[1])) {
      throw connectedError(
        'SLACK_CONNECTED_WORK_INVALID',
        'Connected Slack review contains a thread outside the exact selected conversations.'
      );
    }
    return {
      value,
      conversationId: match[1],
      rootMessageId: match[2],
      key: match[1] + '\u0000' + match[2],
      fingerprint: fingerprintJson(value)
    };
  }).sort((left, right) => compareCodepoint(left.key, right.key));
  if (new Set(references.map((item) => item.key)).size !== references.length) {
    throw connectedError(
      'SLACK_CONNECTED_WORK_INVALID',
      'Connected Slack review thread selections must be unique.'
    );
  }
  return references;
}

function exactWindow(policy, kind, preparedAt) {
  const selected = policy.windows.filter((item) => item.id === kind);
  if (selected.length !== 1
    || !Number.isInteger(selected[0].durationHours)
    || selected[0].durationHours < 1) {
    throw connectedError(
      'SLACK_CONNECTED_WORK_INVALID',
      'Connected Slack review requires one exact declared policy window.'
    );
  }
  const latestExclusive = exactInstant(preparedAt);
  const oldestInclusive = new Date(
    Date.parse(latestExclusive) - selected[0].durationHours * 60 * 60 * 1000
  ).toISOString();
  return {
    kind,
    oldestInclusive,
    latestExclusive,
    fingerprint: fingerprintJson({ oldestInclusive, latestExclusive })
  };
}

export function loadExactSlackConversationReviewPreparedInput({
  root,
  workId,
  expectedHost = null
}) {
  const resolvedRoot = path.resolve(root);
  const safeId = safeWorkId(workId);
  let prepared;
  try {
    prepared = loadExactPreparedAutomationAcquisition({
      root: resolvedRoot,
      workId: safeId,
      automationId: AUTOMATION_ID,
      expectedHost
    });
  } catch (error) {
    throw connectedError(
      error?.code === 'PREPARED_ACQUISITION_STALE'
        ? 'SLACK_CONNECTED_STALE'
        : 'SLACK_CONNECTED_WORK_INVALID',
      'Connected Slack review prepared work or private input is unavailable or invalid.',
      error
    );
  }
  const { work, material, lock, run, runPath } = prepared;
  assertSelectedAutomation(lock, run);
  const policy = loadPolicy(resolvedRoot);
  const workspaceId = reviewField(material, 'workspaceId', { required: true });
  const configuredWorkspace = configuredWorkspaceId(lock);
  if (workspaceId !== configuredWorkspace) {
    throw connectedError(
      'SLACK_CONNECTED_WORKSPACE_MISMATCH',
      'Connected Slack review operator input does not match the exact configured Slack workspace.'
    );
  }
  const selectedConversationIds = reviewField(
    material,
    'selectedConversationIds',
    { required: true }
  );
  const windowKind = reviewField(material, 'window', { required: true });
  const selectedThreadReferences = reviewField(material, 'selectedThreadReferences') || [];
  if (typeof workspaceId !== 'string'
    || !workspaceId
    || !Array.isArray(selectedConversationIds)
    || selectedConversationIds.length < 1
    || selectedConversationIds.length > policy.maximumSelectedConversations
    || selectedConversationIds.some((item) => typeof item !== 'string' || !item)
    || new Set(selectedConversationIds).size !== selectedConversationIds.length
    || typeof windowKind !== 'string') {
    throw connectedError(
      'SLACK_CONNECTED_WORK_INVALID',
      'Connected Slack review private input does not satisfy its exact selection bounds.'
    );
  }
  const conversations = [...selectedConversationIds].sort(compareCodepoint);
  const threads = parseThreadReferences(
    selectedThreadReferences,
    conversations,
    policy.maximumThreadsPerReview
  );
  const window = exactWindow(policy, windowKind, work.createdAt);
  const input = {
    workspaceId,
    selectedConversationIds: conversations,
    selectedThreadReferences: threads.map((item) => item.value),
    threads,
    window
  };
  return {
    work,
    material,
    lock,
    lockPath: work.configuration.lockPath,
    run,
    runPath,
    policy,
    input,
    privateInputFingerprint: fingerprintJson({
      workspaceId,
      selectedConversationIds: conversations,
      selectedThreadReferences: threads.map((item) => item.value),
      window
    })
  };
}

export function createSlackConversationReviewConnectedPlan({
  root,
  lock,
  runId,
  workId,
  createdAt,
  expectedHost = null
}) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactSlackConversationReviewPreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  if (fingerprintLock(prepared.lock) !== fingerprintLock(lock)
    || prepared.lock.graphFingerprint !== lock.graphFingerprint
    || prepared.work.checkpoint.runId !== runId) {
    throw connectedError(
      'SLACK_CONNECTED_BINDING_INVALID',
      'Connected Slack review plan does not match its exact prepared work, lock, graph, and run.'
    );
  }
  const authority = selectedAuthority(lock);
  const definitionAuthority = selectedAuthority(
    lock,
    'definition',
    'communications.records'
  );
  const policySource = selectedPolicySource(lock, definitionAuthority);
  const policyProvider = connectedProvider(
    resolvedRoot,
    lock,
    'communications.records.read'
  );
  const conversationProvider = connectedProvider(
    resolvedRoot,
    lock,
    'communications.conversations.list'
  );
  const messageProvider = connectedProvider(
    resolvedRoot,
    lock,
    'communications.messages.read'
  );
  const threadProvider = connectedProvider(
    resolvedRoot,
    lock,
    'communications.thread.read'
  );
  const steps = [
    {
      id: POLICY_STEP_ID,
      capability: 'communications.records.read',
      authority: definitionAuthority,
      providerImplementation: policyProvider,
      input: structuredClone(policySource.input),
      inputBindings: [],
      reason: 'Confirm the exact external policy-selection identity bound to the governed Collaboration Context definition.'
    },
    {
      id: CONVERSATIONS_STEP_ID,
      capability: 'communications.conversations.list',
      authority,
      providerImplementation: conversationProvider,
      input: {
        mode: 'exact',
        workspaceId: prepared.input.workspaceId,
        conversationIds: prepared.input.selectedConversationIds,
        maximumConversations: prepared.input.selectedConversationIds.length,
        maximumObservedConversations: prepared.policy.maximumConversationObservations
      },
      inputBindings: [],
      reason: 'Validate the exact privately selected public or private conversations without broad discovery.'
    }
  ];
  for (const [index, conversationId] of prepared.input.selectedConversationIds.entries()) {
    steps.push({
      id: MESSAGE_STEP_PREFIX + String(index + 1).padStart(3, '0'),
      capability: 'communications.messages.read',
      authority,
      providerImplementation: messageProvider,
      input: {
        workspaceId: prepared.input.workspaceId,
        conversationId,
        oldestInclusive: prepared.input.window.oldestInclusive,
        latestExclusive: prepared.input.window.latestExclusive,
        maximumMessages: prepared.policy.maximumMessagesPerConversation,
        includeThreadReplies: false
      },
      inputBindings: [],
      reason: 'Read one exact complete bounded top-level message window for one selected conversation.'
    });
  }
  for (const [index, reference] of prepared.input.threads.entries()) {
    steps.push({
      id: THREAD_STEP_PREFIX + String(index + 1).padStart(3, '0'),
      capability: 'communications.thread.read',
      authority,
      providerImplementation: threadProvider,
      input: {
        workspaceId: prepared.input.workspaceId,
        conversationId: reference.conversationId,
        rootMessageId: reference.rootMessageId,
        selectionMode: 'explicit-root',
        maximumMessages: prepared.policy.maximumMessagesPerThread
      },
      inputBindings: [],
      reason: 'Read one exact explicitly supplied thread reference; no thread root is derived dynamically.'
    });
  }
  return {
    $contract: 'soter://contracts/operation-plan/v2',
    contractVersion: '2.0.0',
    id: planIdForWork(workId),
    runId,
    createdAt: exactInstant(createdAt, 'SLACK_CONNECTED_PLAN_INVALID'),
    mode: 'sequential',
    failurePolicy: 'stop',
    reason: 'Acquire the exact external conversation-review policy selection, exact selected Slack conversations, every complete bounded message window, and only exact explicitly selected threads from one current private prepared-work basis.',
    configuration: {
      name: prepared.work.configuration.name,
      configurationBasis: 'private-active',
      path: prepared.work.configuration.path,
      lockPath: prepared.work.configuration.lockPath,
      lockFingerprint: prepared.work.configuration.lockFingerprint,
      graphFingerprint: prepared.work.configuration.graphFingerprint
    },
    steps
  };
}

export function assertSlackConversationReviewConnectedPlan(plan) {
  const workId = workIdFromPlan(plan?.id);
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const policy = steps[0];
  const conversations = steps[1];
  const messageSteps = steps.filter((item) => item.id.startsWith(MESSAGE_STEP_PREFIX));
  const threadSteps = steps.filter((item) => item.id.startsWith(THREAD_STEP_PREFIX));
  const expectedIds = [
    POLICY_STEP_ID,
    CONVERSATIONS_STEP_ID,
    ...messageSteps.map((_, index) => MESSAGE_STEP_PREFIX + String(index + 1).padStart(3, '0')),
    ...threadSteps.map((_, index) => THREAD_STEP_PREFIX + String(index + 1).padStart(3, '0'))
  ];
  if (plan.$contract !== 'soter://contracts/operation-plan/v2'
    || plan.contractVersion !== '2.0.0'
    || plan.mode !== 'sequential'
    || plan.failurePolicy !== 'stop'
    || steps.length < 3
    || steps.length > 42
    || !sameJson(steps.map((item) => item.id), expectedIds)
    || policy?.capability !== 'communications.records.read'
    || conversations?.capability !== 'communications.conversations.list'
    || messageSteps.length < 1
    || messageSteps.some((item) => item.capability !== 'communications.messages.read')
    || threadSteps.some((item) => item.capability !== 'communications.thread.read')
    || steps.some((item) => !sameJson(item.inputBindings, []))
    || new Set(steps.slice(1).map((item) => item.authority)).size !== 1
    || policy.authority === conversations.authority) {
    throw connectedError(
      'SLACK_CONNECTED_PLAN_INVALID',
      'Connected Slack review plan does not preserve its exact fixed source sequence.'
    );
  }
  return {
    workId,
    snapshotId: snapshotIdForWork(workId),
    policy,
    conversations,
    messageSteps,
    threadSteps
  };
}

function completedStep(checkpoint, id) {
  const step = checkpoint.steps.find((item) => item.id === id);
  if (!step || step.state !== 'completed' || !step.call || !step.output) {
    throw connectedError(
      'SLACK_CONNECTED_INCOMPLETE',
      'Connected Slack review source coverage is not complete.'
    );
  }
  return step;
}

function exactCoverage(output, itemCount, { allowExcluded = false } = {}) {
  const coverage = output?.coverage;
  if (!coverage
    || coverage.complete !== true
    || coverage.cursorExhausted !== true
    || !Number.isInteger(coverage.pagesRead)
    || coverage.pagesRead < 1
    || !Number.isInteger(coverage.observedCount)
    || !Number.isInteger(coverage.includedCount)
    || coverage.includedCount !== itemCount
    || (!allowExcluded && coverage.observedCount !== coverage.includedCount)
    || (allowExcluded
      && coverage.observedCount !== coverage.includedCount + coverage.excludedCount)) {
    throw connectedError(
      'SLACK_CONNECTED_OUTPUT_INVALID',
      'Connected Slack review normalized coverage is incomplete or inconsistent.'
    );
  }
  return coverage;
}

function assertConnectedProvenance(output, step) {
  if (output?.provenance?.sourceKind !== 'connected'
    || output.provenance.authority !== step.call.authority
    || typeof output.provenance.sourceReferenceFingerprint !== 'string'
    || output.observedAt !== step.call.completedAt) {
    throw connectedError(
      'SLACK_CONNECTED_OUTPUT_INVALID',
      'Connected Slack review normalized provenance does not match the exact completed call.'
    );
  }
}

function assertPolicyOutput(step, prepared) {
  const output = step.output;
  const expectedId = step.resolvedInput?.ids?.[0];
  let record;
  try {
    record = exactRequestedContextRecord(output, {
      recordType: 'conversation-review-policy',
      requestedId: expectedId
    });
  } catch {
    throw connectedError(
      'SLACK_CONNECTED_OUTPUT_INVALID',
      'Connected Slack review external policy selection does not match the exact governed Context policy identity.'
    );
  }
  if (record.fields?.name !== prepared.policy.name) {
    throw connectedError(
      'SLACK_CONNECTED_OUTPUT_INVALID',
      'Connected Slack review external policy selection does not match the exact governed Context policy identity.'
    );
  }
  if (output.provenance?.provider !== 'notion-mcp'
    || output.provenance.authority !== step.call.authority
    || typeof output.provenance.mapping !== 'string'
    || typeof output.provenance.mappingVersion !== 'string'
    || output.observedAt !== step.call.completedAt) {
    throw connectedError(
      'SLACK_CONNECTED_OUTPUT_INVALID',
      'Connected Slack review policy provenance does not match its exact completed definition read.'
    );
  }
  return record;
}

function assertConversationOutput(step, prepared) {
  const output = step.output;
  const conversations = output?.conversations;
  if (output?.workspace?.providerWorkspaceId !== prepared.input.workspaceId
    || !Array.isArray(conversations)) {
    throw connectedError(
      'SLACK_CONNECTED_OUTPUT_INVALID',
      'Connected Slack review conversation selection does not match the private workspace input.'
    );
  }
  exactCoverage(output, conversations.length, { allowExcluded: true });
  assertConnectedProvenance(output, step);
  const observedIds = conversations.map((item) => item.providerConversationId);
  if (!sameJson(observedIds, prepared.input.selectedConversationIds)
    || new Set(observedIds).size !== observedIds.length
    || conversations.some((item) => {
      const unsigned = structuredClone(item);
      delete unsigned.fingerprint;
      return !prepared.policy.allowedConversationKinds.includes(item.kind)
        || (item.kind === 'public-channel' ? item.visibility !== 'public' : item.visibility !== 'private')
        || item.fingerprint !== fingerprintJson(unsigned);
    })) {
    throw connectedError(
      'SLACK_CONNECTED_OUTPUT_INVALID',
      'Connected Slack review did not resolve every exact selected public or private conversation once.'
    );
  }
  return conversations;
}

function inWindow(sentAt, window) {
  const instant = Date.parse(exactInstant(sentAt, 'SLACK_CONNECTED_OUTPUT_INVALID'));
  return instant >= Date.parse(window.oldestInclusive)
    && instant < Date.parse(window.latestExclusive);
}

function assertMessageOutput(step, prepared, expectedConversationId) {
  const output = step.output;
  const messages = output?.messages;
  if (output?.workspaceId !== prepared.input.workspaceId
    || output.conversationId !== expectedConversationId
    || !sameJson(output.window, {
      oldestInclusive: prepared.input.window.oldestInclusive,
      latestExclusive: prepared.input.window.latestExclusive
    })
    || !Array.isArray(messages)
    || messages.length > prepared.policy.maximumMessagesPerConversation) {
    throw connectedError(
      'SLACK_CONNECTED_OUTPUT_INVALID',
      'Connected Slack review message window does not match its exact fixed input.'
    );
  }
  exactCoverage(output, messages.length);
  assertConnectedProvenance(output, step);
  if (new Set(messages.map((item) => item.providerMessageId)).size !== messages.length
    || messages.some((item) => {
      const unsigned = structuredClone(item);
      delete unsigned.fingerprint;
      return item.threadRootMessageId !== null
        || !inWindow(item.sentAt, prepared.input.window)
        || item.contentFingerprint !== fingerprintJson(item.content)
        || item.fingerprint !== fingerprintJson(unsigned);
    })) {
    throw connectedError(
      'SLACK_CONNECTED_OUTPUT_INVALID',
      'Connected Slack review message identities or normalized private bodies are invalid.'
    );
  }
  return messages;
}

function assertThreadOutput(step, prepared, reference) {
  const output = step.output;
  const messages = output?.messages;
  if (output?.workspaceId !== prepared.input.workspaceId
    || output.conversationId !== reference.conversationId
    || output.rootMessageId !== reference.rootMessageId
    || !Array.isArray(messages)
    || messages.length < 1
    || messages.length > prepared.policy.maximumMessagesPerThread) {
    throw connectedError(
      'SLACK_CONNECTED_OUTPUT_INVALID',
      'Connected Slack review thread does not match its exact explicit selection.'
    );
  }
  exactCoverage(output, messages.length);
  assertConnectedProvenance(output, step);
  if (messages.filter((item) => item.isRoot).length !== 1
    || new Set(messages.map((item) => item.providerMessageId)).size !== messages.length
    || messages.some((item) => {
      const unsigned = structuredClone(item);
      delete unsigned.fingerprint;
      return (item.isRoot && item.providerMessageId !== reference.rootMessageId)
        || item.contentFingerprint !== fingerprintJson(item.content)
        || item.fingerprint !== fingerprintJson(unsigned);
    })) {
    throw connectedError(
      'SLACK_CONNECTED_OUTPUT_INVALID',
      'Connected Slack review thread coverage or normalized private bodies are invalid.'
    );
  }
  return messages;
}

function freshnessState(root, capability, observedAt, at) {
  const contract = readJson(path.join(root, 'soter', 'capabilities', capability + '.json'));
  const maximumAge = contract.freshness.maxAgeSeconds;
  if (maximumAge === null) return 'unknown';
  const age = (Date.parse(at) - Date.parse(observedAt)) / 1000;
  if (!Number.isFinite(age) || age < 0) return 'unknown';
  return age <= maximumAge ? 'passed' : 'stale';
}

function snapshotEntry({
  root,
  id,
  step,
  at,
  subject = 'communications.workspace',
  role = 'instance'
}) {
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
    value: step.output
  };
}

function effectId(call) {
  return 'effect.' + call.id.slice('toolcall.'.length);
}

export async function prepareSlackConversationReviewConnectedAcquisition({
  root,
  workId,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactSlackConversationReviewPreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  const run = readJson(resolveRepoPath(resolvedRoot, prepared.runPath));
  assertSelectedAutomation(prepared.lock, run);
  if (run.id !== prepared.work.checkpoint.runId) {
    throw connectedError(
      'SLACK_CONNECTED_BINDING_INVALID',
      'Connected Slack review prepared work does not match its durable run.'
    );
  }
  const createdAt = at || new Date().toISOString();
  const plan = createSlackConversationReviewConnectedPlan({
    root: resolvedRoot,
    lock: prepared.lock,
    runId: run.id,
    workId,
    createdAt,
    expectedHost
  });
  try {
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
    throw connectedError(
      'SLACK_CONNECTED_PLAN_INVALID',
      'Connected Slack review plan could not enter the durable host-tool boundary.',
      error
    );
  }
}

function exactConnectedBasis({ root, workId, expectedHost }) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactSlackConversationReviewPreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  let execution;
  try {
    execution = getExactDurableHostExecution({
      root: resolvedRoot,
      checkpointId: checkpointIdForWork(workId),
      expectedHost
    });
  } catch (error) {
    throw connectedError(
      'SLACK_CONNECTED_SNAPSHOT_INVALID',
      'Connected Slack review durable checkpoint is unavailable or invalid.',
      error
    );
  }
  const checkpoint = execution.checkpoint;
  if (checkpoint.kind !== 'operation-plan' || checkpoint.state !== 'completed') {
    throw connectedError(
      'SLACK_CONNECTED_INCOMPLETE',
      'Connected Slack review can be inspected only after complete durable acquisition.'
    );
  }
  const shape = assertSlackConversationReviewConnectedPlan(checkpoint.plan);
  if (shape.workId !== workId) {
    throw connectedError(
      'SLACK_CONNECTED_BINDING_INVALID',
      'Connected Slack review checkpoint does not match the exact selected work.'
    );
  }
  assertSelectedAutomation(prepared.lock, execution.run);
  const expectedPlan = createSlackConversationReviewConnectedPlan({
    root: resolvedRoot,
    lock: prepared.lock,
    runId: checkpoint.plan.runId,
    workId,
    createdAt: checkpoint.plan.createdAt,
    expectedHost
  });
  if (!sameJson(expectedPlan, checkpoint.plan)
    || checkpoint.configurationLock.fingerprint !== fingerprintLock(prepared.lock)
    || checkpoint.graphFingerprint !== prepared.lock.graphFingerprint) {
    throw connectedError(
      'SLACK_CONNECTED_STALE',
      'Connected Slack review plan drifted from its current private input or exact lock.'
    );
  }
  let snapshotState;
  try {
    snapshotState = getExactDurableContextSnapshot({
      root: resolvedRoot,
      lockPath: prepared.lockPath,
      snapshotId: shape.snapshotId,
      expectedHost
    });
  } catch (error) {
    throw connectedError(
      'SLACK_CONNECTED_SNAPSHOT_INVALID',
      'Connected Slack review private Context snapshot is unavailable or invalid.',
      error
    );
  }
  if (snapshotState.snapshot.runId !== prepared.work.checkpoint.runId
    || snapshotState.run.id !== prepared.work.checkpoint.runId) {
    throw connectedError(
      'SLACK_CONNECTED_BINDING_INVALID',
      'Connected Slack review private Context snapshot does not match the selected prepared work.'
    );
  }
  return {
    root: resolvedRoot,
    prepared,
    checkpoint,
    shape,
    snapshot: snapshotState.snapshot,
    run: snapshotState.run
  };
}

function reviewBasis(exact) {
  const { prepared, checkpoint, shape, snapshot } = exact;
  const policyStep = completedStep(checkpoint, POLICY_STEP_ID);
  assertPolicyOutput(policyStep, prepared);
  const conversationsStep = completedStep(checkpoint, CONVERSATIONS_STEP_ID);
  const conversations = assertConversationOutput(conversationsStep, prepared);
  const messageSteps = shape.messageSteps.map((step) => completedStep(checkpoint, step.id));
  const threadSteps = shape.threadSteps.map((step) => completedStep(checkpoint, step.id));
  const messageWindows = messageSteps.map((step, index) => ({
    step,
    conversationId: prepared.input.selectedConversationIds[index],
    messages: assertMessageOutput(
      step,
      prepared,
      prepared.input.selectedConversationIds[index]
    )
  }));
  const selectedThreads = threadSteps.map((step, index) => ({
    step,
    reference: prepared.input.threads[index],
    messages: assertThreadOutput(step, prepared, prepared.input.threads[index])
  }));
  const expectedEntryIds = [
    'context.slack-conversation-review.connected.policy',
    'context.slack-conversation-review.connected.conversations',
    ...messageSteps.map((_, index) => {
      return 'context.slack-conversation-review.connected.messages.'
        + String(index + 1).padStart(3, '0');
    }),
    ...threadSteps.map((_, index) => {
      return 'context.slack-conversation-review.connected.threads.'
        + String(index + 1).padStart(3, '0');
    })
  ];
  if (!sameJson(snapshot.entries.map((entry) => entry.id), expectedEntryIds)
    || snapshot.entries.length !== checkpoint.steps.length
    || snapshot.entries.some((entry, index) => {
      return entry.valueFingerprint !== checkpoint.steps[index].outputFingerprint
        || !sameJson(entry.value, checkpoint.steps[index].output);
    })) {
    throw connectedError(
      'SLACK_CONNECTED_SNAPSHOT_INVALID',
      'Connected Slack review private Context entries do not match every completed exact source.'
    );
  }
  const windowRootKeys = new Set(messageWindows.flatMap(({ conversationId, messages }) => {
    return messages.filter((message) => message.replyCount > 0).map((message) => {
      return conversationId + '\u0000' + message.providerMessageId;
    });
  }));
  const selectedKeys = new Set(prepared.input.threads.map((item) => item.key));
  const selectedWindowRootCount = prepared.input.threads.filter((item) => {
    return windowRootKeys.has(item.key);
  }).length;
  const selectedExplicitCount = prepared.input.threads.length - selectedWindowRootCount;
  const unselectedWindowRootCount = [...windowRootKeys].filter((key) => !selectedKeys.has(key)).length;
  const conversationCoverage = conversationsStep.output.coverage;
  const messageObservedCount = messageSteps.reduce((sum, step) => {
    return sum + step.output.coverage.observedCount;
  }, 0);
  const messageIncludedCount = messageSteps.reduce((sum, step) => {
    return sum + step.output.coverage.includedCount;
  }, 0);
  const messagePagesRead = messageSteps.reduce((sum, step) => {
    return sum + step.output.coverage.pagesRead;
  }, 0);
  const threadObservedCount = threadSteps.reduce((sum, step) => {
    return sum + step.output.coverage.observedCount;
  }, 0);
  const threadIncludedCount = threadSteps.reduce((sum, step) => {
    return sum + step.output.coverage.includedCount;
  }, 0);
  const threadPagesRead = threadSteps.reduce((sum, step) => {
    return sum + step.output.coverage.pagesRead;
  }, 0);
  const coverageWithoutFingerprint = {
    complete: true,
    selectedConversationCount: conversations.length,
    conversationObservedCount: conversationCoverage.observedCount,
    conversationIncludedCount: conversationCoverage.includedCount,
    conversationExcludedCount: conversationCoverage.excludedCount,
    conversationPagesRead: conversationCoverage.pagesRead,
    messageWindowCount: messageWindows.length,
    messageObservedCount,
    messageIncludedCount,
    messageExcludedCount: messageObservedCount - messageIncludedCount,
    messagePagesRead,
    windowThreadRootCount: windowRootKeys.size,
    selectedThreadCount: selectedThreads.length,
    selectedWindowRootCount,
    selectedExplicitCount,
    unselectedWindowRootCount,
    threadObservedCount,
    threadIncludedCount,
    threadExcludedCount: threadObservedCount - threadIncludedCount,
    threadMessageCount: selectedThreads.reduce((sum, item) => sum + item.messages.length, 0),
    threadPagesRead,
    conversationFingerprint: fingerprintJson(conversations.map((item) => item.fingerprint)),
    messageWindowFingerprint: fingerprintJson(messageSteps.map((item) => item.outputFingerprint)),
    threadFingerprint: fingerprintJson(threadSteps.map((item) => item.outputFingerprint))
  };
  const coverage = {
    ...coverageWithoutFingerprint,
    coverageFingerprint: fingerprintJson(coverageWithoutFingerprint)
  };
  const injectionKeys = new Map();
  for (const { conversationId, messages } of messageWindows) {
    for (const message of messages) {
      if (slackConversationReviewSuspectedInjection(message.content)) {
        injectionKeys.set(
          conversationId + '\u0000' + message.providerMessageId,
          message.contentFingerprint
        );
      }
    }
  }
  for (const { reference, messages } of selectedThreads) {
    for (const message of messages) {
      if (slackConversationReviewSuspectedInjection(message.content)) {
        injectionKeys.set(
          reference.conversationId + '\u0000' + message.providerMessageId,
          message.contentFingerprint
        );
      }
    }
  }
  const injectionFingerprints = [...injectionKeys.values()].sort(compareCodepoint);
  const injection = {
    suspected: injectionFingerprints.length > 0,
    count: injectionFingerprints.length,
    fingerprint: fingerprintJson(injectionFingerprints)
  };
  return {
    conversations,
    messageWindows,
    selectedThreads,
    windowRootKeys,
    coverage,
    injection
  };
}

function buildSanitizedInspection(exact, basis) {
  const { prepared, snapshot } = exact;
  const value = withSelfFingerprint({
    $contract: 'soter://contracts/slack-conversation-review-connected-inspection/v1',
    contractVersion: '1.0.0',
    work: {
      id: prepared.work.id,
      fingerprint: prepared.work.fingerprint,
      privateInputFingerprint: prepared.privateInputFingerprint
    },
    snapshot: {
      id: snapshot.id,
      fingerprint: fingerprintJson(snapshot)
    },
    configuration: {
      lockFingerprint: fingerprintLock(prepared.lock),
      graphFingerprint: prepared.lock.graphFingerprint,
      host: prepared.lock.host.id
    },
    window: {
      kind: prepared.input.window.kind,
      fingerprint: prepared.input.window.fingerprint
    },
    coverage: basis.coverage,
    injection: basis.injection,
    authority: {
      state: 'none',
      reasonCode: 'SLACK_CONNECTED_REVIEW_READ_ONLY',
      approvalIncluded: false,
      continuationIncluded: false,
      providerWriteIncluded: false,
      retryAuthorityIncluded: false
    },
    privacy: {
      privateValuesIncluded: false,
      conversationReferencesIncluded: false,
      threadReferencesIncluded: false,
      messageBodiesIncluded: false,
      participantValuesIncluded: false,
      rawProviderResponsesIncluded: false,
      paginationCursorsIncluded: false,
      workspaceInspectionIncluded: false
    }
  });
  validateClosed(
    exact.root,
    value,
    INSPECTION_SCHEMA,
    'SLACK_CONNECTED_INSPECTION_MALFORMED',
    'Connected Slack review sanitized inspection'
  );
  if (value.fingerprint !== selfFingerprint(value)) {
    throw connectedError(
      'SLACK_CONNECTED_INSPECTION_TAMPERED',
      'Connected Slack review sanitized inspection fingerprint is invalid.'
    );
  }
  return value;
}

function buildPrivateReview(exact, basis) {
  const { prepared, snapshot } = exact;
  const messages = basis.messageWindows.flatMap(({ conversationId, messages: values }) => {
    return values.map((message) => ({
      conversationId,
      messageId: message.providerMessageId,
      authorParticipantId: message.authorParticipantId,
      sentAt: message.sentAt,
      replyCount: message.replyCount,
      content: message.content,
      contentFingerprint: message.contentFingerprint,
      messageFingerprint: message.fingerprint,
      suspectedInjection: slackConversationReviewSuspectedInjection(message.content)
    }));
  });
  const threads = basis.selectedThreads.map(({ reference, step, messages: values }) => {
    const eligibility = basis.windowRootKeys.has(reference.key)
      ? 'window-root'
      : 'explicit-selection';
    const thread = {
      conversationId: reference.conversationId,
      rootMessageId: reference.rootMessageId,
      eligibility,
      selectedReferenceFingerprint: reference.fingerprint,
      coverage: {
        complete: true,
        observedCount: step.output.coverage.observedCount,
        includedCount: step.output.coverage.includedCount,
        excludedCount: step.output.coverage.observedCount - step.output.coverage.includedCount,
        pagesRead: step.output.coverage.pagesRead
      },
      messages: values.map((message) => ({
        messageId: message.providerMessageId,
        authorParticipantId: message.authorParticipantId,
        sentAt: message.sentAt,
        isRoot: message.isRoot,
        content: message.content,
        contentFingerprint: message.contentFingerprint,
        messageFingerprint: message.fingerprint,
        suspectedInjection: slackConversationReviewSuspectedInjection(message.content)
      })),
      fingerprint: 'sha256:' + '0'.repeat(64)
    };
    const unsigned = structuredClone(thread);
    delete unsigned.fingerprint;
    thread.fingerprint = fingerprintJson(unsigned);
    return thread;
  });
  const value = withSelfFingerprint({
    $contract: 'soter://contracts/slack-conversation-review-connected-review/v1',
    contractVersion: '1.0.0',
    createdAt: snapshot.createdAt,
    work: {
      id: prepared.work.id,
      fingerprint: prepared.work.fingerprint,
      checkpointFingerprint: prepared.work.checkpoint.fingerprint,
      privateInputFingerprint: prepared.privateInputFingerprint
    },
    snapshot: {
      id: snapshot.id,
      fingerprint: fingerprintJson(snapshot),
      runId: snapshot.runId
    },
    configuration: {
      name: prepared.work.configuration.name,
      lockFingerprint: fingerprintLock(prepared.lock),
      graphFingerprint: prepared.lock.graphFingerprint,
      host: prepared.lock.host.id
    },
    window: structuredClone(prepared.input.window),
    coverage: basis.coverage,
    conversations: basis.conversations.map((conversation) => ({
      conversationId: conversation.providerConversationId,
      kind: conversation.kind,
      name: conversation.name,
      visibility: conversation.visibility,
      shared: conversation.shared,
      permalink: conversation.permalink,
      identityFingerprint: conversation.identityFingerprint,
      fingerprint: conversation.fingerprint
    })),
    messages,
    threads,
    injection: basis.injection,
    authority: {
      state: 'none',
      reasonCode: 'SLACK_CONNECTED_REVIEW_SELECTED_WORK_ONLY',
      approvalIncluded: false,
      continuationIncluded: false,
      providerWriteIncluded: false,
      retryAuthorityIncluded: false
    },
    privacy: {
      scope: 'private-local-selected-work',
      projection: 'explicit-selected-work-only',
      normalizedPrivateBodiesIncluded: true,
      rawProviderResponsesIncluded: false,
      paginationCursorsIncluded: false,
      workspaceInspectionIncluded: false,
      evidenceIncluded: false,
      canonicalArtifactsIncluded: false
    }
  });
  validateClosed(
    exact.root,
    value,
    REVIEW_SCHEMA,
    'SLACK_CONNECTED_REVIEW_MALFORMED',
    'Connected Slack review selected-work material'
  );
  if (value.fingerprint !== selfFingerprint(value)) {
    throw connectedError(
      'SLACK_CONNECTED_REVIEW_TAMPERED',
      'Connected Slack review selected-work material fingerprint is invalid.'
    );
  }
  return value;
}

export function inspectSlackConversationReviewConnected({
  root,
  workId,
  expectedHost
}) {
  const exact = exactConnectedBasis({ root, workId: safeWorkId(workId), expectedHost });
  return buildSanitizedInspection(exact, reviewBasis(exact));
}

export function inspectSlackConversationReviewConnectedPrivateReview({
  root,
  workId,
  expectedHost
}) {
  const exact = exactConnectedBasis({ root, workId: safeWorkId(workId), expectedHost });
  return buildPrivateReview(exact, reviewBasis(exact));
}

export function finalizeSlackConversationReviewConnectedAcquisition({
  root,
  checkpointId,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  let execution;
  try {
    execution = getExactDurableHostExecution({
      root: resolvedRoot,
      checkpointId,
      expectedHost
    });
  } catch (error) {
    throw connectedError(
      'SLACK_CONNECTED_SNAPSHOT_INVALID',
      'Connected Slack review durable checkpoint is unavailable or invalid.',
      error
    );
  }
  const checkpoint = execution.checkpoint;
  if (checkpoint.kind !== 'operation-plan' || checkpoint.state !== 'completed') {
    throw connectedError(
      'SLACK_CONNECTED_INCOMPLETE',
      'Connected Slack review can finalize only after complete durable acquisition.'
    );
  }
  const shape = assertSlackConversationReviewConnectedPlan(checkpoint.plan);
  const prepared = loadExactSlackConversationReviewPreparedInput({
    root: resolvedRoot,
    workId: shape.workId,
    expectedHost
  });
  assertSelectedAutomation(prepared.lock, execution.run);
  const expectedPlan = createSlackConversationReviewConnectedPlan({
    root: resolvedRoot,
    lock: prepared.lock,
    runId: checkpoint.plan.runId,
    workId: shape.workId,
    createdAt: checkpoint.plan.createdAt,
    expectedHost
  });
  if (!sameJson(expectedPlan, checkpoint.plan)
    || checkpoint.configurationLock.fingerprint !== fingerprintLock(prepared.lock)
    || checkpoint.graphFingerprint !== prepared.lock.graphFingerprint) {
    throw connectedError(
      'SLACK_CONNECTED_STALE',
      'Connected Slack review plan drifted from its current private input or exact lock.'
    );
  }
  const policyStep = completedStep(checkpoint, POLICY_STEP_ID);
  assertPolicyOutput(policyStep, prepared);
  const conversationStep = completedStep(checkpoint, CONVERSATIONS_STEP_ID);
  assertConversationOutput(conversationStep, prepared);
  const messageSteps = shape.messageSteps.map((item) => completedStep(checkpoint, item.id));
  messageSteps.forEach((step, index) => {
    assertMessageOutput(step, prepared, prepared.input.selectedConversationIds[index]);
  });
  const threadSteps = shape.threadSteps.map((item) => completedStep(checkpoint, item.id));
  threadSteps.forEach((step, index) => {
    assertThreadOutput(step, prepared, prepared.input.threads[index]);
  });
  const completed = [policyStep, conversationStep, ...messageSteps, ...threadSteps];
  const createdAt = checkpoint.updatedAt;
  const entries = [
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.slack-conversation-review.connected.policy',
      step: policyStep,
      at: createdAt,
      subject: 'communications.records',
      role: 'definition'
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.slack-conversation-review.connected.conversations',
      step: conversationStep,
      at: createdAt
    }),
    ...messageSteps.map((step, index) => snapshotEntry({
      root: resolvedRoot,
      id: 'context.slack-conversation-review.connected.messages.'
        + String(index + 1).padStart(3, '0'),
      step,
      at: createdAt
    })),
    ...threadSteps.map((step, index) => snapshotEntry({
      root: resolvedRoot,
      id: 'context.slack-conversation-review.connected.threads.'
        + String(index + 1).padStart(3, '0'),
      step,
      at: createdAt
    }))
  ];
  const freshness = entries.some((entry) => entry.freshness === 'stale')
    ? 'stale'
    : (entries.some((entry) => entry.freshness === 'unknown') ? 'unknown' : 'passed');
  const instanceEntries = entries.slice(1);
  const instanceFreshness = instanceEntries.some((entry) => entry.freshness === 'stale')
    ? 'stale'
    : (instanceEntries.some((entry) => entry.freshness === 'unknown')
      ? 'unknown'
      : 'passed');
  const authority = selectedAuthority(prepared.lock);
  const definitionAuthority = selectedAuthority(
    prepared.lock,
    'definition',
    'communications.records'
  );
  const snapshot = {
    $contract: 'soter://contracts/context-snapshot/v1',
    contractVersion: '1.0.0',
    id: shape.snapshotId,
    runId: checkpoint.plan.runId,
    createdAt,
    configurationLockFingerprint: checkpoint.configurationLock.fingerprint,
    graphFingerprint: checkpoint.graphFingerprint,
    containment: 'connected',
    entries,
    effectIds: completed.map((step) => effectId(step.call)),
    privacy: {
      scope: 'private',
      redactions: [
        'Workspace, conversation, thread, participant, name, link, and normalized message-body values remain private selected-work Context state.',
        'Native provider envelopes and opaque pagination cursors are excluded; completed cursor sequences retain only fingerprints and exhausted coverage.',
        'Message content is private untrusted data. Suspected instruction injection is a visible review flag and never instruction or action authority.',
        'Only exact explicitly supplied thread references were read; unselected window-rooted threads were counted but not expanded or implied complete.',
        'This acquisition creates no persistence proposal, approval, continuation request, Slack mutation, provider retry authority, or write.'
      ]
    }
  };
  try {
    commitDurableContextSnapshot({
      root: resolvedRoot,
      checkpointId,
      snapshot,
      contextUpdates: [
        {
          authority: definitionAuthority,
          status: policyStep.output
            && freshnessState(
              resolvedRoot,
              policyStep.call.capability.id,
              policyStep.output.observedAt,
              createdAt
            ) === 'stale'
            ? 'stale'
            : 'loaded',
          provenance: 'connected-slack-conversation-review:policy:'
            + policyStep.outputFingerprint,
          freshness: freshnessState(
            resolvedRoot,
            policyStep.call.capability.id,
            policyStep.output.observedAt,
            createdAt
          )
        },
        {
          authority,
          status: instanceFreshness === 'stale' ? 'stale' : 'loaded',
          provenance: 'connected-slack-conversation-review:set:' + fingerprintJson(
            entries.slice(1).map((entry) => ({
              id: entry.id,
              fingerprint: entry.valueFingerprint
            }))
          ),
          freshness: instanceFreshness
        }
      ],
      checkpointDetails: 'Automation acquired the exact external conversation-review policy selection, exact selected conversations, every complete bounded message window, and only exact explicitly selected threads, then paused without persistence, approval, continuation, or writes.',
      expectedHost
    });
  } catch (error) {
    throw connectedError(
      'SLACK_CONNECTED_SNAPSHOT_INVALID',
      'Connected Slack review private Context snapshot could not be committed exactly.',
      error
    );
  }
  return inspectSlackConversationReviewConnected({
    root: resolvedRoot,
    workId: shape.workId,
    expectedHost
  });
}

export function slackConversationReviewConnectedSnapshotId(workId) {
  return snapshotIdForWork(workId);
}
