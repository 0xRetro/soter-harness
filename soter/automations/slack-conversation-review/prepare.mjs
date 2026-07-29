import path from 'node:path';

import { invokeCapability } from '../../core/capabilities.mjs';
import { exactRequestedContextRecord } from '../../core/context-records.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import {
  derivedReviewContentFingerprint,
  derivedReviewItemFingerprint
} from '../../core/review-projections.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';

const AUTOMATION_ID = 'automation.slack-conversation-review';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';
const POLICY_CONTRACT = 'soter://contracts/conversation-review-policy/v1';
const THREAD_REFERENCE = /^conversation:([A-Za-z0-9._-]+)\/thread:([A-Za-z0-9._:-]+)$/;

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareCodepoint);
}

function inputInvalid(message) {
  const error = new Error(message);
  error.code = 'PREPARATION_INPUT_INVALID';
  return error;
}

function exactInstant(value, label) {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw inputInvalid(label + ' must be a valid instant.');
  }
  return new Date(value).toISOString();
}

function exactAuthority(lock, role, subject) {
  const matches = lock.authorities.filter((authority) => {
    return authority.role === role && authority.subject === subject;
  });
  if (matches.length !== 1) {
    throw new Error(
      'Slack Conversation Review requires one exact ' + role + ' authority for ' + subject + '.'
    );
  }
  return matches[0].id;
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
  if (policy.$contract !== POLICY_CONTRACT
    || policy.id !== 'policy.context.communications.collaboration.conversation-review'
    || typeof policy.name !== 'string'
    || !policy.name
    || fingerprintJson(policy.windows) !== fingerprintJson([
      { id: 'last-24-hours', durationHours: 24 },
      { id: 'last-7-days', durationHours: 168 }
    ])
    || policy.maximumSelectedConversations !== 20
    || policy.maximumConversationObservations !== 2000
    || policy.maximumMessagesPerConversation !== 100
    || policy.maximumThreadsPerReview !== 20
    || policy.maximumMessagesPerThread !== 1000
    || fingerprintJson(policy.allowedConversationKinds)
      !== fingerprintJson(['public-channel', 'private-channel'])
    || policy.directMessagesIncluded !== false
    || policy.threadReadsRequireWindowRootOrExplicitSelection !== true
    || policy.threadExpansionMode !== 'explicit-selection-only'
    || policy.completeCoverageRequired !== true
    || policy.contentClassification !== 'private-untrusted'
    || policy.suspectedInjectionSurfaced !== true
    || policy.persistenceProposalsAllowed !== false
    || policy.writesAllowed !== false) {
    throw new Error('Slack Conversation Review Context policy drifted from its exact read-only boundary.');
  }
  return policy;
}

function policySource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID
      && consumer.purpose === 'conversation-review-policy';
  }));
  if (matches.length !== 1) {
    throw new Error('Slack Conversation Review requires exactly one configured policy source.');
  }
  const source = matches[0];
  if (source.capability !== 'communications.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || fingerprintJson(source.input.recordTypes)
      !== fingerprintJson(['conversation-review-policy'])
    || !Array.isArray(source.input.ids)
    || source.input.ids.length !== 1
    || typeof source.input.ids[0] !== 'string'
    || !source.input.ids[0]
    || source.input.limit !== 2) {
    throw new Error('Slack Conversation Review policy source is not exact.');
  }
  return source;
}

function derivedReviewDefinition(root) {
  const definition = readJson(path.join(
    root,
    'soter',
    'automations',
    'slack-conversation-review',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'slack-conversation-review-derived-review') {
    throw new Error('Slack Conversation Review derived-review declaration drifted.');
  }
  return definition;
}

function exactInput(input, policy, createdAt) {
  if (!input || typeof input.workspaceId !== 'string' || !input.workspaceId
    || !Array.isArray(input.selectedConversationIds)
    || input.selectedConversationIds.length < 1
    || input.selectedConversationIds.length > policy.maximumSelectedConversations
    || new Set(input.selectedConversationIds).size !== input.selectedConversationIds.length) {
    throw inputInvalid(
      'Slack Conversation Review requires one workspace and a bounded unique exact channel selection.'
    );
  }
  const window = policy.windows.find((candidate) => candidate.id === input.window);
  if (!window) {
    throw inputInvalid('Slack Conversation Review requires one declared policy window.');
  }
  const selectedIds = uniqueSorted(input.selectedConversationIds);
  const selected = new Set(selectedIds);
  const explicitReferences = [];
  for (const reference of input.selectedThreadReferences || []) {
    const match = reference.match(THREAD_REFERENCE);
    if (!match || !selected.has(match[1])) {
      throw inputInvalid(
        'Every explicit thread reference must be exact and belong to an exact selected conversation.'
      );
    }
    explicitReferences.push({
      conversationId: match[1],
      rootMessageId: match[2],
      key: match[1] + '\u0000' + match[2]
    });
  }
  if (new Set(explicitReferences.map((reference) => reference.key)).size
      !== explicitReferences.length
    || explicitReferences.length > policy.maximumThreadsPerReview) {
    throw inputInvalid('Explicit thread references must be unique and inside the policy thread bound.');
  }
  const latestExclusive = exactInstant(createdAt, 'Preparation createdAt');
  const oldestInclusive = new Date(
    Date.parse(latestExclusive) - (window.durationHours * 60 * 60 * 1000)
  ).toISOString();
  return {
    selectedIds,
    explicitReferences: explicitReferences.sort((left, right) => compareCodepoint(left.key, right.key)),
    window: {
      id: window.id,
      durationHours: window.durationHours,
      oldestInclusive,
      latestExclusive,
      fingerprint: fingerprintJson({ oldestInclusive, latestExclusive })
    }
  };
}

async function readFixture({ root, lock, capability, authority, input, effectId, at }) {
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
    throw new Error('Slack Conversation Review contained read did not pass: ' + effectId + '.');
  }
  return result;
}

export function assertSlackConversationSelection(output, input, policy) {
  const observedIds = output?.conversations?.map((conversation) => {
    return conversation.providerConversationId;
  });
  if (output?.workspace?.providerWorkspaceId !== input.workspaceId
    || !Array.isArray(observedIds)
    || fingerprintJson(uniqueSorted(observedIds))
      !== fingerprintJson(uniqueSorted(input.conversationIds))
    || output.coverage?.complete !== true
    || output.coverage.cursorExhausted !== true
    || output.coverage.pagesRead < 1
    || output.coverage.includedCount !== output.conversations.length
    || output.coverage.observedCount
      !== output.coverage.includedCount + output.coverage.excludedCount) {
    throw new Error('Slack Conversation Review selected-channel coverage is incomplete or inconsistent.');
  }
  const ids = new Set();
  for (const conversation of output.conversations) {
    const unsigned = structuredClone(conversation);
    delete unsigned.fingerprint;
    if (['direct-message', 'group-direct-message'].includes(conversation.kind)) {
      throw inputInvalid(
        'Direct messages are modeled but unavailable in Slack Conversation Review milestone one.'
      );
    }
    if (ids.has(conversation.providerConversationId)
      || !policy.allowedConversationKinds.includes(conversation.kind)
      || conversation.fingerprint !== fingerprintJson(unsigned)) {
      throw new Error('Slack Conversation Review received an invalid or unsupported conversation.');
    }
    ids.add(conversation.providerConversationId);
  }
  return [...output.conversations].sort((left, right) => {
    return compareCodepoint(left.providerConversationId, right.providerConversationId);
  });
}

function inWindow(sentAt, window) {
  const instant = Date.parse(exactInstant(sentAt, 'Normalized Slack sentAt'));
  return instant >= Date.parse(window.oldestInclusive)
    && instant < Date.parse(window.latestExclusive);
}

function assertMessageOutput(output, expected, policy) {
  if (output?.workspaceId !== expected.workspaceId
    || output.conversationId !== expected.conversationId
    || output.window?.oldestInclusive !== expected.oldestInclusive
    || output.window.latestExclusive !== expected.latestExclusive
    || output.coverage?.complete !== true
    || output.coverage.cursorExhausted !== true
    || output.coverage.pagesRead < 1
    || output.coverage.observedCount !== output.coverage.includedCount
    || output.coverage.includedCount !== output.messages?.length
    || output.messages.length > policy.maximumMessagesPerConversation) {
    throw new Error('Slack Conversation Review message-window coverage is incomplete or inconsistent.');
  }
  const ids = new Set();
  for (const message of output.messages) {
    const unsigned = structuredClone(message);
    delete unsigned.fingerprint;
    if (ids.has(message.providerMessageId)
      || message.threadRootMessageId !== null
      || !inWindow(message.sentAt, expected)
      || message.contentFingerprint !== fingerprintJson(message.content)
      || message.fingerprint !== fingerprintJson(unsigned)) {
      throw new Error('Slack Conversation Review normalized message identity or content is invalid.');
    }
    ids.add(message.providerMessageId);
  }
  return output.messages;
}

function assertThreadOutput(output, expected, policy) {
  if (output?.workspaceId !== expected.workspaceId
    || output.conversationId !== expected.conversationId
    || output.rootMessageId !== expected.rootMessageId
    || output.coverage?.complete !== true
    || output.coverage.cursorExhausted !== true
    || output.coverage.pagesRead < 1
    || output.coverage.observedCount !== output.coverage.includedCount
    || output.coverage.includedCount !== output.messages?.length
    || output.messages.length < 1
    || output.messages.length > policy.maximumMessagesPerThread
    || output.messages.filter((message) => message.isRoot).length !== 1) {
    throw new Error('Slack Conversation Review thread coverage is incomplete or inconsistent.');
  }
  const ids = new Set();
  for (const message of output.messages) {
    const unsigned = structuredClone(message);
    delete unsigned.fingerprint;
    if (ids.has(message.providerMessageId)
      || message.contentFingerprint !== fingerprintJson(message.content)
      || message.fingerprint !== fingerprintJson(unsigned)
      || (message.isRoot && message.providerMessageId !== expected.rootMessageId)) {
      throw new Error('Slack Conversation Review normalized thread message is invalid.');
    }
    ids.add(message.providerMessageId);
  }
  return output.messages;
}

export function slackConversationReviewSuspectedInjection(content) {
  const value = String(content || '').toLowerCase();
  const instructionOverride = /\b(ignore|bypass|override|disregard)\b[\s\S]{0,120}\b(polic(?:y|ies)|instructions?|guardrails?|operators?|systems?)\b/;
  const concealment = /\b(hide|silence|suppress|omit)\b[\s\S]{0,100}\b(message|thread|conversation|instruction|evidence)\b/;
  const externalAction = /\b(send|publish|forward|approve|pay|delete|archive)\b[\s\S]{0,120}\b(private|secret|invoice|payment|transcript|message|channel)\b/;
  return instructionOverride.test(value) || concealment.test(value) || externalAction.test(value);
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

function contextStep(entry, invocation, sequence) {
  const base = entry.id
    .replace(/\.conversation-[0-9]+$/, '')
    .replace(/\.thread-[0-9]+$/, '');
  const labels = {
    'context.slack-conversation-review.policy': 'Load exact conversation-review policy selection',
    'context.slack-conversation-review.conversations': 'Validate exact selected public or private channels',
    'context.slack-conversation-review.messages': 'Read one complete bounded top-level message window',
    'context.slack-conversation-review.threads': 'Read one exact eligible complete thread'
  };
  return {
    id: 'preparation.context.' + String(sequence),
    sequence,
    label: labels[base],
    capability: entry.capability,
    authority: entry.authority,
    containment: 'fixture',
    state: 'completed',
    inputFingerprint: invocation.inputFingerprint,
    outputFingerprint: entry.valueFingerprint,
    limitation: 'This typed fixture read does not establish connected Slack access, authentication, current provider state, readiness, verification, or health.'
  };
}

function privateField(id, label, type, reviewValue) {
  return { id, label, type, fingerprint: fingerprintJson(reviewValue), reviewValue };
}

function privateItem(id, kind, source, fields) {
  const value = {
    id,
    kind,
    sources: [source],
    fields,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  value.fingerprint = derivedReviewItemFingerprint(value);
  return value;
}

function rowFingerprint(row) {
  const unsigned = structuredClone(row);
  delete unsigned.fingerprint;
  delete unsigned.privateDetailFingerprint;
  for (const action of unsigned.actions) delete action.changeFingerprint;
  return fingerprintJson(unsigned);
}

function collectionFingerprint(collection) {
  const unsigned = structuredClone(collection);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
}

function collection(id, kind, labelKey, coverage, rows) {
  const value = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id,
    kind,
    labelKey,
    coverage,
    rows,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  value.fingerprint = collectionFingerprint(value);
  return value;
}

function row({ id, sequence, subjectKind, subjectFingerprint, group, reasonCode, flags }) {
  const value = {
    id,
    sequence,
    representedCount: 1,
    subject: { kind: subjectKind, fingerprint: subjectFingerprint },
    group,
    attention: 'operator',
    disposition: 'itemized',
    reasonCode,
    flags: uniqueSorted(flags),
    actions: [],
    privateDetailFingerprint: null,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  value.fingerprint = rowFingerprint(value);
  return value;
}

function bindPrivateItem(rowValue, collectionId, item) {
  rowValue.privateDetailFingerprint = item.fingerprint;
  return item;
}

function buildReview({ identityOutput, conversations, messageReads, threadReads, window, definition }) {
  const items = [];
  const injectionKeys = new Set();
  const conversationRows = conversations.map((conversation, index) => {
    const value = row({
      id: 'row.slack-conversation-review.conversation-' + String(index + 1).padStart(3, '0'),
      sequence: index + 1,
      subjectKind: conversation.kind,
      subjectFingerprint: conversation.fingerprint,
      group: conversation.kind,
      reasonCode: conversation.kind === 'private-channel'
        ? 'SLACK_PRIVATE_CHANNEL_SELECTED'
        : 'SLACK_PUBLIC_CHANNEL_SELECTED',
      flags: ['SLACK_CONVERSATION_SELECTED']
    });
    const source = {
      collectionId: 'collection.slack-conversation-review.conversations',
      rowId: value.id,
      rowFingerprint: value.fingerprint
    };
    const item = privateItem(
      'review-item.slack-conversation-review.conversation-' + String(index + 1).padStart(3, '0'),
      'conversation-detail',
      source,
      [
        privateField('conversationId', 'Conversation identity', 'text', conversation.providerConversationId),
        privateField('kind', 'Conversation kind', 'text', conversation.kind),
        privateField('name', 'Conversation name', 'string-list', conversation.name ? [conversation.name] : []),
        privateField('visibility', 'Visibility', 'text', conversation.visibility),
        privateField('shared', 'Shared conversation', 'boolean', conversation.shared),
        privateField('permalink', 'Conversation link', 'string-list', conversation.permalink ? [conversation.permalink] : []),
        privateField('identityFingerprint', 'Scope-bound identity fingerprint', 'text', conversation.identityFingerprint)
      ]
    );
    items.push(bindPrivateItem(value, source.collectionId, item));
    return value;
  });

  const messageRows = [];
  let messageSequence = 0;
  let injectionCount = 0;
  for (const read of messageReads) {
    for (const message of read.output.messages) {
      messageSequence += 1;
      const injection = slackConversationReviewSuspectedInjection(message.content);
      if (injection) {
        injectionKeys.add(read.output.conversationId + '\u0000' + message.providerMessageId);
      }
      const value = row({
        id: 'row.slack-conversation-review.message-' + String(messageSequence).padStart(3, '0'),
        sequence: messageSequence,
        subjectKind: 'channel-message',
        subjectFingerprint: message.fingerprint,
        group: 'channel-message',
        reasonCode: injection
          ? 'SLACK_CONTENT_SUSPECTED_INJECTION'
          : 'SLACK_MESSAGE_OBSERVED',
        flags: injection
          ? ['SLACK_CONTENT_PRIVATE', 'SLACK_CONTENT_UNTRUSTED', 'SLACK_CONTENT_SUSPECTED_INJECTION']
          : ['SLACK_CONTENT_PRIVATE', 'SLACK_CONTENT_UNTRUSTED']
      });
      const source = {
        collectionId: 'collection.slack-conversation-review.messages',
        rowId: value.id,
        rowFingerprint: value.fingerprint
      };
      const item = privateItem(
        'review-item.slack-conversation-review.message-' + String(messageSequence).padStart(3, '0'),
        'message-detail',
        source,
        [
          privateField('conversationId', 'Conversation identity', 'text', read.output.conversationId),
          privateField('messageId', 'Message identity', 'text', message.providerMessageId),
          privateField('authorParticipantIds', 'Observed author identities', 'string-list', message.authorParticipantId ? [message.authorParticipantId] : []),
          privateField('sentAt', 'Sent at', 'text', message.sentAt),
          privateField('content', 'Complete private message content', 'string-list', message.content ? [message.content] : []),
          privateField('contentFingerprint', 'Content fingerprint', 'text', message.contentFingerprint),
          privateField('suspectedInjection', 'Suspected instruction injection', 'boolean', injection)
        ]
      );
      items.push(bindPrivateItem(value, source.collectionId, item));
      messageRows.push(value);
    }
  }

  const threadRows = [];
  let threadMessageSequence = 0;
  for (const read of threadReads) {
    for (const message of read.output.messages) {
      threadMessageSequence += 1;
      const injection = slackConversationReviewSuspectedInjection(message.content);
      if (injection) {
        injectionKeys.add(read.output.conversationId + '\u0000' + message.providerMessageId);
      }
      const value = row({
        id: 'row.slack-conversation-review.thread-message-'
          + String(threadMessageSequence).padStart(3, '0'),
        sequence: threadMessageSequence,
        subjectKind: 'channel-thread-message',
        subjectFingerprint: message.fingerprint,
        group: 'channel-thread',
        reasonCode: injection
          ? 'SLACK_CONTENT_SUSPECTED_INJECTION'
          : 'SLACK_THREAD_MESSAGE_OBSERVED',
        flags: injection
          ? ['SLACK_CONTENT_PRIVATE', 'SLACK_CONTENT_UNTRUSTED', 'SLACK_CONTENT_SUSPECTED_INJECTION']
          : ['SLACK_CONTENT_PRIVATE', 'SLACK_CONTENT_UNTRUSTED']
      });
      const source = {
        collectionId: 'collection.slack-conversation-review.threads',
        rowId: value.id,
        rowFingerprint: value.fingerprint
      };
      const item = privateItem(
        'review-item.slack-conversation-review.thread-message-'
          + String(threadMessageSequence).padStart(3, '0'),
        'thread-message-detail',
        source,
        [
          privateField('conversationId', 'Conversation identity', 'text', read.output.conversationId),
          privateField('rootMessageId', 'Thread root identity', 'text', read.output.rootMessageId),
          privateField('eligibility', 'Thread eligibility basis', 'text', read.reviewEligibility),
          privateField('messageId', 'Message identity', 'text', message.providerMessageId),
          privateField('authorParticipantIds', 'Observed author identities', 'string-list', message.authorParticipantId ? [message.authorParticipantId] : []),
          privateField('sentAt', 'Sent at', 'text', message.sentAt),
          privateField('isRoot', 'Root message', 'boolean', message.isRoot),
          privateField('content', 'Complete private thread-message content', 'string-list', message.content ? [message.content] : []),
          privateField('contentFingerprint', 'Content fingerprint', 'text', message.contentFingerprint),
          privateField('suspectedInjection', 'Suspected instruction injection', 'boolean', injection)
        ]
      );
      items.push(bindPrivateItem(value, source.collectionId, item));
      threadRows.push(value);
    }
  }

  const conversationExclusions = identityOutput.coverage.excludedCount
    ? [{ reasonCode: 'SLACK_CONVERSATION_NOT_SELECTED', count: identityOutput.coverage.excludedCount }]
    : [];
  const collections = [
    collection(
      'collection.slack-conversation-review.conversations',
      'slack-selected-conversations',
      'slack-selected-conversations',
      {
        complete: true,
        observedCount: identityOutput.coverage.observedCount,
        includedCount: conversationRows.length,
        excludedCount: identityOutput.coverage.excludedCount,
        exclusions: conversationExclusions
      },
      conversationRows
    ),
    collection(
      'collection.slack-conversation-review.messages',
      'slack-message-window',
      'slack-message-window',
      {
        complete: true,
        observedCount: messageRows.length,
        includedCount: messageRows.length,
        excludedCount: 0,
        exclusions: []
      },
      messageRows
    ),
    collection(
      'collection.slack-conversation-review.threads',
      'slack-thread-expansion',
      'slack-thread-expansion',
      {
        complete: true,
        observedCount: threadRows.length,
        includedCount: threadRows.length,
        excludedCount: 0,
        exclusions: []
      },
      threadRows
    )
  ];
  const derivedReview = { kind: definition.kind, items };
  injectionCount = injectionKeys.size;
  const injectionBasisIds = [
    ...messageReads.map((_, index) => {
      return 'context.slack-conversation-review.messages.conversation-' + String(index + 1);
    }),
    ...threadReads.map((_, index) => {
      return 'context.slack-conversation-review.threads.thread-' + String(index + 1);
    })
  ];
  const facts = [
    { id: 'selected-conversation-count', label: 'Exact selected conversations', value: conversations.length, state: 'supported', basisIds: ['context.slack-conversation-review.conversations'] },
    { id: 'public-channel-count', label: 'Selected public channels', value: conversations.filter((item) => item.kind === 'public-channel').length, state: 'supported', basisIds: ['context.slack-conversation-review.conversations'] },
    { id: 'private-channel-count', label: 'Selected private channels', value: conversations.filter((item) => item.kind === 'private-channel').length, state: 'supported', basisIds: ['context.slack-conversation-review.conversations'] },
    { id: 'window-kind', label: 'Governed review window', value: window.id, state: 'supported', basisIds: ['context.slack-conversation-review.policy'] },
    { id: 'window-fingerprint', label: 'Exact pinned window fingerprint', value: window.fingerprint, state: 'supported', basisIds: ['context.slack-conversation-review.messages.conversation-1'] },
    { id: 'top-level-message-count', label: 'Top-level messages reviewed', value: messageRows.length, state: 'supported', basisIds: messageReads.map((_, index) => 'context.slack-conversation-review.messages.conversation-' + String(index + 1)) },
    { id: 'message-page-count', label: 'Message pages exhausted', value: messageReads.reduce((sum, read) => sum + read.output.coverage.pagesRead, 0), state: 'supported', basisIds: messageReads.map((_, index) => 'context.slack-conversation-review.messages.conversation-' + String(index + 1)) },
    { id: 'expanded-thread-count', label: 'Exact explicitly selected threads expanded', value: threadReads.length, state: 'supported', basisIds: threadReads.map((_, index) => 'context.slack-conversation-review.threads.thread-' + String(index + 1)) },
    { id: 'expanded-thread-message-count', label: 'Thread messages reviewed', value: threadRows.length, state: 'supported', basisIds: threadReads.map((_, index) => 'context.slack-conversation-review.threads.thread-' + String(index + 1)) },
    { id: 'coverage-complete', label: 'Every selected window and thread is complete', value: true, state: 'supported', basisIds: ['context.slack-conversation-review.conversations'] },
    { id: 'suspected-injection-count', label: 'Suspected instruction-injection observations', value: injectionCount, state: injectionCount ? 'contradicted' : 'supported', basisIds: injectionBasisIds },
    { id: 'proposed-persistence-count', label: 'Persistence or Slack writes proposed', value: 0, state: 'supported', basisIds: ['context.slack-conversation-review.policy'] }
  ];
  const contradictions = injectionCount ? [{
    id: 'slack-suspected-instruction-injection-observed',
    claim: 'Private untrusted message content contains a suspected attempt to redirect, conceal, or authorize work and remains visible without action authority.',
    state: 'observed',
    basisIds: injectionBasisIds
  }] : [];
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: definition.$contract,
    contractFingerprint: fingerprintJson(definition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const preview = {
    kind: 'slack-conversation-review-preview',
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
  return { preview, derivedReview, injectionCount };
}

export async function prepareSlackConversationReviewRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  const policy = loadPolicy(root);
  const exact = exactInput(input, policy, createdAt);
  const definition = derivedReviewDefinition(root);
  const definitionAuthority = exactAuthority(lock, 'definition', 'communications.records');
  const workspaceAuthority = exactAuthority(lock, 'instance', 'communications.workspace');
  const source = policySource(lock, definitionAuthority);
  const runId = 'run.' + workId.slice('work.'.length);
  const snapshotId = 'context.' + workId.slice('work.'.length);
  const envelope = prepareRunEnvelope({
    root,
    lock,
    lockPath,
    scenarioPath,
    automationId: AUTOMATION_ID,
    runId,
    createdAt,
    requestedOutcome: 'Prepare one exact policy-bounded selected-channel conversation review with complete explicitly selected eligible threads, then stop without approval, persistence, or Slack writes.',
    evidenceIds: []
  });
  const acquired = [];
  const policyResult = await readFixture({
    root,
    lock,
    capability: source.capability,
    authority: definitionAuthority,
    input: source.input,
    effectId: 'effect.slack-conversation-review.policy.fixture',
    at: createdAt
  });
  const policyRecord = exactRequestedContextRecord(policyResult.output, {
    recordType: 'conversation-review-policy',
    requestedId: source.input.ids[0]
  });
  if (policyRecord.fields?.name !== policy.name) {
    throw new Error('Slack Conversation Review external policy selection does not match Context.');
  }
  acquired.push({
    result: policyResult,
    entry: snapshotEntry({
      id: 'context.slack-conversation-review.policy',
      subject: 'communications.records.conversation-review-policy',
      authority: definitionAuthority,
      role: 'definition',
      result: policyResult
    })
  });
  const identityInput = {
    mode: 'exact',
    workspaceId: input.workspaceId,
    conversationIds: exact.selectedIds,
    maximumConversations: exact.selectedIds.length,
    maximumObservedConversations: policy.maximumConversationObservations
  };
  const identityResult = await readFixture({
    root,
    lock,
    capability: 'communications.conversations.list',
    authority: workspaceAuthority,
    input: identityInput,
    effectId: 'effect.slack-conversation-review.conversations.fixture',
    at: createdAt
  });
  const conversations = assertSlackConversationSelection(identityResult.output, identityInput, policy);
  acquired.push({
    result: identityResult,
    entry: snapshotEntry({
      id: 'context.slack-conversation-review.conversations',
      subject: 'communications.workspace.selected-channels',
      authority: workspaceAuthority,
      role: 'instance',
      result: identityResult
    })
  });

  const messageReads = [];
  const windowRoots = new Map();
  for (const [index, conversation] of conversations.entries()) {
    const messageInput = {
      workspaceId: input.workspaceId,
      conversationId: conversation.providerConversationId,
      oldestInclusive: exact.window.oldestInclusive,
      latestExclusive: exact.window.latestExclusive,
      maximumMessages: policy.maximumMessagesPerConversation,
      includeThreadReplies: false
    };
    const result = await readFixture({
      root,
      lock,
      capability: 'communications.messages.read',
      authority: workspaceAuthority,
      input: messageInput,
      effectId: 'effect.slack-conversation-review.messages.' + String(index + 1) + '.fixture',
      at: createdAt
    });
    const messages = assertMessageOutput(result.output, messageInput, policy);
    for (const message of messages.filter((candidate) => candidate.replyCount > 0)) {
      const key = conversation.providerConversationId + '\u0000' + message.providerMessageId;
      windowRoots.set(key, {
        key,
        conversationId: conversation.providerConversationId,
        rootMessageId: message.providerMessageId,
        eligibility: 'window-root'
      });
    }
    messageReads.push(result);
    acquired.push({
      result,
      entry: snapshotEntry({
        id: 'context.slack-conversation-review.messages.conversation-' + String(index + 1),
        subject: 'communications.workspace.selected-channel-message-window',
        authority: workspaceAuthority,
        role: 'instance',
        result
      })
    });
  }
  const roots = exact.explicitReferences.map((reference) => ({
    ...reference,
    eligibility: windowRoots.has(reference.key) ? 'window-root' : 'explicit-selection'
  })).sort((left, right) => compareCodepoint(left.key, right.key));
  if (roots.length > policy.maximumThreadsPerReview) {
    throw inputInvalid('Eligible thread roots exceed the exact conversation-review policy bound.');
  }
  const threadReads = [];
  for (const [index, threadRoot] of roots.entries()) {
    const threadInput = {
      workspaceId: input.workspaceId,
      conversationId: threadRoot.conversationId,
      rootMessageId: threadRoot.rootMessageId,
      selectionMode: 'explicit-root',
      maximumMessages: policy.maximumMessagesPerThread
    };
    const result = await readFixture({
      root,
      lock,
      capability: 'communications.thread.read',
      authority: workspaceAuthority,
      input: threadInput,
      effectId: 'effect.slack-conversation-review.threads.' + String(index + 1) + '.fixture',
      at: createdAt
    });
    assertThreadOutput(result.output, threadInput, policy);
    result.reviewEligibility = threadRoot.eligibility;
    threadReads.push(result);
    acquired.push({
      result,
      entry: snapshotEntry({
        id: 'context.slack-conversation-review.threads.thread-' + String(index + 1),
        subject: 'communications.workspace.selected-channel-thread',
        authority: workspaceAuthority,
        role: 'instance',
        result
      })
    });
  }

  const review = buildReview({
    identityOutput: identityResult.output,
    conversations,
    messageReads,
    threadReads,
    window: exact.window,
    definition
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
      redactions: [
        'Workspace, conversation, message, thread, participant, name, link, body, provider-response, and credential values are excluded from general inspection.'
      ]
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
    return fingerprints ? {
      ...item,
      status: 'loaded',
      provenance: 'fixture:' + fingerprintJson(fingerprints),
      freshness: 'passed'
    } : item;
  });
  envelope.lifecycleState = 'paused';
  envelope.checkpoints = [
    { id: 'effects-established', state: 'passed', details: 'Read and disclosure policies were evaluated before every contained context invocation.' },
    { id: 'selected-channel-windows-complete', state: 'passed', details: 'Every exact selected public or private channel message window was exhausted inside the governed bound.' },
    { id: 'eligible-threads-complete', state: 'passed', details: 'Only window-rooted or explicit selected thread roots were read, and every resulting bounded thread was exhausted.' },
    { id: 'untrusted-content-defanged', state: 'passed', details: 'Private message content was treated as untrusted data; suspected instruction injection remained visible and granted no authority.' },
    { id: 'write-boundary-held', state: 'passed', details: 'No Slack write, persistence proposal, approval, continuation request, provider mutation, or canonical write was issued.' }
  ];
  envelope.outputs = [{ id: snapshot.id, type: 'context-snapshot', fingerprint: fingerprintJson(snapshot) }];
  envelope.effects = effects;
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      { id: 'selected-channel-review-grounded', label: 'Exact selected public and private channels grounded', state: 'supported', basis: ['context.slack-conversation-review.conversations'], limitation: 'The contained identities do not establish connected Slack state, visibility, or access.' },
      { id: 'complete-message-window-prepared', label: 'Complete policy-bounded message review prepared', state: 'proposed', basis: messageReads.map((_, index) => 'context.slack-conversation-review.messages.conversation-' + String(index + 1)), limitation: 'Message content remains private selected-work review data and never instruction authority.' },
      { id: 'eligible-threads-prepared', label: 'Eligible exact thread reviews prepared', state: 'proposed', basis: threadReads.map((_, index) => 'context.slack-conversation-review.threads.thread-' + String(index + 1)), limitation: 'Only window-rooted or explicitly selected exact thread roots are eligible.' },
      { id: 'suspected-injection-surfaced', label: 'Suspected instruction injection remains visible', state: review.injectionCount ? 'supported' : 'blocked', basis: messageReads.map((_, index) => 'context.slack-conversation-review.messages.conversation-' + String(index + 1)), limitation: 'Detection is a review flag, not a classification, suppression, action, or persistence authority.' },
      { id: 'external-effect-boundary', label: 'All Slack writes and persistence proposals absent', state: 'supported', basis: ['context.slack-conversation-review.policy'], limitation: 'This Automation declares only read and disclosure effects and creates no approval or continuation request.' }
    ],
    preview: review.preview,
    derivedReview: review.derivedReview
  };
}
