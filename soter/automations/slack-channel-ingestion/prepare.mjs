import path from 'node:path';

import { invokeCapability } from '../../core/capabilities.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import { collaborationConversationIdentityFingerprint } from '../../contexts/communications/collaboration/identity.mjs';
import {
  derivedReviewContentFingerprint,
  derivedReviewItemFingerprint
} from '../../core/review-projections.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';

const AUTOMATION_ID = 'automation.slack-channel-ingestion';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';
const POLICY_CONTRACT = 'soter://contracts/channel-ingestion-policy/v1';
const FILTER_CHUNK = 12;

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareCodepoint);
}

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function slug(value) {
  return normalized(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function workspaceUri(workspaceFingerprint) {
  return 'soter://communications/workspace/' + workspaceFingerprint.slice('sha256:'.length);
}

function containsPrivateProviderIdentity(value, identities) {
  return typeof value === 'string' && identities.some((identity) => {
    return typeof identity === 'string' && identity.length > 0 && value.includes(identity);
  });
}

function exactAuthority(lock, role, subject) {
  const matches = lock.authorities.filter((authority) => {
    return authority.role === role && authority.subject === subject;
  });
  if (matches.length !== 1) {
    throw new Error(
      'Slack channel ingestion requires one exact ' + role + ' authority for ' + subject + '.'
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
    'channel-ingestion.policy.json'
  ));
  if (policy.$contract !== POLICY_CONTRACT
    || policy.id !== 'policy.context.communications.collaboration.channel-ingestion'
    || typeof policy.name !== 'string'
    || !policy.name
    || typeof policy.platform !== 'string'
    || !policy.platform
    || policy.selectionRequiredForSweep !== true
    || policy.participantReadRequiresExplicitSelection !== true
    || policy.identityOnlyBeforeSelection !== true
    || policy.botsExcluded !== true
    || policy.providerParticipantsAreCrmPeople !== false
    || policy.writesRequireConfirmation !== true
    || policy.messagesIncluded !== false
    || policy.identityFingerprintScope !== 'platform-workspace-conversation'
    || policy.identityFingerprintAlgorithm !== 'sha256-canonical-json-v1'
    || policy.portableProviderIdsStored !== false
    || fingerprintJson(policy.allowedVisibilities) !== fingerprintJson(['public', 'private'])
    || fingerprintJson(policy.participantMatchOrder)
      !== fingerprintJson(['email-exact', 'name-exact-unique'])
    || fingerprintJson(policy.organizationMatchOrder)
      !== fingerprintJson(['channel-name-explicit-exact'])) {
    throw new Error('Slack channel-ingestion Context policy drifted from its staged privacy boundary.');
  }
  return policy;
}

function policySource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID
      && consumer.purpose === 'channel-ingestion-policy';
  }));
  if (matches.length !== 1) {
    throw new Error('Slack channel ingestion requires exactly one configured policy source.');
  }
  const source = matches[0];
  if (source.capability !== 'communications.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || fingerprintJson(source.input.recordTypes)
      !== fingerprintJson(['channel-ingestion-policy'])
    || fingerprintJson(source.input.ids)
      !== fingerprintJson(['policy.channel-ingestion'])
    || source.input.limit !== 2) {
    throw new Error('Slack channel-ingestion policy source is not exact.');
  }
  return source;
}

function derivedReviewDefinition(root) {
  const definition = readJson(path.join(
    root,
    'soter',
    'automations',
    'slack-channel-ingestion',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'slack-channel-ingestion-derived-review') {
    throw new Error('Slack channel-ingestion derived review declaration drifted.');
  }
  return definition;
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
    throw new Error('Slack channel-ingestion contained read did not pass: ' + effectId + '.');
  }
  return result;
}

function schemaField(schema, id, expectedOptions) {
  const matches = schema.fields.filter((field) => field.id === id);
  if (matches.length !== 1 || matches[0].writable !== true) {
    throw new Error('Slack channel ingestion requires one writable channel field ' + id + '.');
  }
  const field = matches[0];
  if (expectedOptions === null) {
    if (field.options !== null) {
      throw new Error('Slack channel field ' + id + ' must not invent choice options.');
    }
  } else if (fingerprintJson(field.options) !== fingerprintJson(expectedOptions)) {
    throw new Error('Slack channel field ' + id + ' does not expose the exact policy options.');
  }
  return field;
}

export function assertSlackChannelSchema(output, policy) {
  const schema = output?.schema;
  if (!schema || schema.recordType !== 'channel') {
    throw new Error('Slack channel ingestion requires one current channel schema observation.');
  }
  schemaField(schema, 'name', null);
  schemaField(schema, 'platform', ['Discord', 'Email', 'Forum', 'Other', 'Slack', 'Telegram']);
  schemaField(schema, 'workspaceUri', null);
  schemaField(schema, 'workspaceIdentityFingerprint', null);
  schemaField(schema, 'conversationIdentityFingerprint', null);
  schemaField(schema, 'hostWorkspaceName', null);
  schemaField(schema, 'visibility', uniqueSorted(policy.allowedVisibilities));
  schemaField(schema, 'shared', null);
  schemaField(schema, 'personUris', null);
  schemaField(schema, 'organizationUris', null);
  return schema;
}

function assertChannelOutput(output, input, policy) {
  if (!output?.workspace
    || output.workspace.providerWorkspaceId !== input.workspaceId
    || !Array.isArray(output.conversations)
    || output.conversations.length > policy.maxSweepChannels
    || new Set(output.conversations.map((conversation) => conversation.providerConversationId)).size
      !== output.conversations.length
    || output.coverage?.complete !== true
    || output.coverage.cursorExhausted !== true
    || output.coverage.pagesRead < 1
    || output.coverage.includedCount !== output.conversations.length
    || output.coverage.observedCount
      !== output.coverage.includedCount + output.coverage.excludedCount) {
    throw new Error('Slack channel identity coverage is incomplete or inconsistent.');
  }
  const publicCount = output.conversations.filter((conversation) => {
    return conversation.kind === 'public-channel';
  }).length;
  const privateCount = output.conversations.filter((conversation) => {
    return conversation.kind === 'private-channel';
  }).length;
  if (input.mode === 'visible'
    && (fingerprintJson(input.kinds)
      !== fingerprintJson(['public-channel', 'private-channel'])
      || publicCount < 1
      || privateCount < 1)) {
    throw new Error('Slack identity sweep must explicitly cover public and private channels.');
  }
  if (input.mode === 'exact'
    && fingerprintJson(uniqueSorted(output.conversations.map((conversation) => {
      return conversation.providerConversationId;
    }))) !== fingerprintJson(uniqueSorted(input.conversationIds))) {
    throw new Error('Slack exact identity read did not return precisely the selected channels.');
  }
  for (const channel of output.conversations) {
    const unsigned = structuredClone(channel);
    delete unsigned.fingerprint;
    if (channel.fingerprint !== fingerprintJson(unsigned)
      || !['public-channel', 'private-channel'].includes(channel.kind)
      || !policy.allowedVisibilities.includes(channel.visibility)
      || (channel.permalink !== null
        && (typeof channel.permalink !== 'string' || !channel.permalink))
      || channel.identityFingerprint !== collaborationConversationIdentityFingerprint({
        platform: policy.platform,
        providerWorkspaceId: output.workspace.providerWorkspaceId,
        providerConversationId: channel.providerConversationId
      })) {
      throw new Error('Slack channel identity fingerprint or portable fields are invalid.');
    }
    if (containsPrivateProviderIdentity(channel.name, [channel.providerConversationId])
      || containsPrivateProviderIdentity(output.workspace.displayName, [
        output.workspace.providerWorkspaceId
      ])) {
      throw new Error(
        'Slack display metadata cannot carry a raw provider identity into portable channel fields.'
      );
    }
  }
  const text = JSON.stringify(output);
  if (/"(?:members|participants|profiles|messages|body|text)"/.test(text)) {
    throw new Error('Slack channel identity read crossed the pre-selection people/content boundary.');
  }
  return output.conversations.map((conversation) => ({
    ...conversation,
    providerWorkspaceId: output.workspace.providerWorkspaceId,
    workspaceIdentityFingerprint: output.workspace.identityFingerprint,
    hostWorkspaceName: output.workspace.displayName || 'Collaboration workspace',
    workspaceUri: workspaceUri(output.workspace.identityFingerprint)
  })).sort((left, right) => {
    return compareCodepoint(left.providerConversationId, right.providerConversationId);
  });
}

function assertParticipantOutputs(outputs, workspaceId, selectedIds, policy) {
  const observedIds = outputs.map((output) => output?.conversationId);
  if (fingerprintJson(uniqueSorted(observedIds)) !== fingerprintJson(uniqueSorted(selectedIds))) {
    throw new Error('Slack selected participant reads did not bind the exact selected channel set.');
  }
  const result = new Map();
  for (const output of outputs) {
    if (output.workspaceId !== workspaceId
      || output.coverage?.complete !== true
      || output.coverage.cursorExhausted !== true
      || output.coverage.pagesRead < 1
      || output.coverage.observedCount
        !== output.coverage.includedHumanCount + output.coverage.excludedBotCount
      || output.participants.length !== output.coverage.includedHumanCount
      || output.participants.length > policy.maxParticipantsPerChannel
      || new Set(output.participants.map((participant) => {
        return participant.providerParticipantId;
      })).size !== output.participants.length) {
      throw new Error('Slack selected participant coverage is incomplete or inconsistent.');
    }
    for (const participant of output.participants) {
      const participantUnsigned = structuredClone(participant);
      delete participantUnsigned.fingerprint;
      if (participant.fingerprint !== fingerprintJson(participantUnsigned)) {
        throw new Error('Slack participant fingerprint is invalid.');
      }
    }
    if (/"(?:messages|body|text)"/.test(JSON.stringify(output))) {
      throw new Error('Slack participant read returned undeclared message content.');
    }
    result.set(output.conversationId, output);
  }
  return result;
}

function snapshotEntry({ id, subject, authority, role, result, value = result.output }) {
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
    valueFingerprint: fingerprintJson(value),
    value
  };
}

function contextStep(entry, invocation, sequence) {
  const labels = {
    'context.slack-channel-ingestion.policy': 'Load exact Slack channel-ingestion policy selection',
    'context.slack-channel-ingestion.identities': 'Read exact bounded public-and-private channel identities',
    'context.slack-channel-ingestion.schema': 'Observe current Communications channel schema',
    'context.slack-channel-ingestion.channels': 'Inspect current Communications channel candidates',
    'context.slack-channel-ingestion.participants': 'Read participants only for exact selected channels',
    'context.slack-channel-ingestion.contacts': 'Resolve selected-channel participants to bounded CRM contacts',
    'context.slack-channel-ingestion.organizations': 'Resolve selected channels to bounded CRM organizations'
  };
  const base = entry.id.replace(/\.part-[0-9]+$/, '');
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
    limitation: 'This typed fixture read does not establish connected Slack or CRM access, current permission, provider conformance, readiness, verification, or health.'
  };
}

function privateField(id, label, type, reviewValue) {
  return { id, label, type, fingerprint: fingerprintJson(reviewValue), reviewValue };
}

function privateItem(id, kind, sources, fields) {
  const value = {
    id,
    kind,
    sources,
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

function sourceFor(collectionId, row) {
  return { collectionId, rowId: row.id, rowFingerprint: row.fingerprint };
}

function currentChannelCandidates(records, channel) {
  return records.filter((record) => {
    return record.type === 'channel'
      && record.fields?.conversationIdentityFingerprint === channel.identityFingerprint;
  }).sort((left, right) => compareCodepoint(left.id, right.id));
}

function buildIdentityReview({ channelOutput, channels, records, definition }) {
  const collectionId = 'collection.slack-channel-ingestion.identities';
  const rows = [];
  const items = [];
  for (const [index, channel] of channels.entries()) {
    const candidates = currentChannelCandidates(records, channel);
    const status = candidates.length === 0
      ? 'CHANNEL_NEW_OBSERVED'
      : candidates.length === 1
        ? 'CHANNEL_EXISTING_OBSERVED'
        : 'CHANNEL_DUPLICATE_CANDIDATES_OBSERVED';
    const row = {
      id: 'row.slack-channel-ingestion.identity.' + String(index + 1).padStart(3, '0'),
      sequence: index + 1,
      representedCount: 1,
      subject: { kind: 'communication-channel', fingerprint: channel.fingerprint },
      group: 'channel-identity',
      attention: 'operator',
      disposition: 'itemized',
      reasonCode: status,
      flags: [status, 'CHANNEL_MEMBER_READ_NOT_AUTHORIZED'],
      actions: [{
        id: 'action.slack-channel-ingestion.identity.' + String(index + 1).padStart(3, '0') + '.held',
        kind: 'none',
        capability: null,
        effect: null,
        state: 'held',
        reasonCode: 'CHANNEL_SELECTION_REQUIRED'
      }],
      privateDetailFingerprint: null,
      fingerprint: 'sha256:' + '0'.repeat(64)
    };
    row.fingerprint = rowFingerprint(row);
    const item = privateItem(
      'review-item.slack-channel-ingestion.identity.' + String(index + 1).padStart(3, '0'),
      'channel-identity',
      [sourceFor(collectionId, row)],
      [
        privateField('providerConversationId', 'Provider conversation identity', 'text', channel.providerConversationId),
        privateField('name', 'Channel name', 'text', channel.name),
        privateField('hostWorkspaceName', 'Host workspace', 'text', channel.hostWorkspaceName),
        privateField('visibility', 'Visibility', 'text', channel.visibility),
        privateField('permalink', 'Permalink', 'string-list', channel.permalink ? [channel.permalink] : []),
        privateField('existingRecordIds', 'Existing Communications channel candidates', 'string-list', candidates.map((record) => record.id))
      ]
    );
    row.privateDetailFingerprint = item.fingerprint;
    rows.push(row);
    items.push(item);
  }
  const exclusions = channelOutput.coverage.excludedCount
    ? [{ reasonCode: 'CHANNEL_SCOPE_FILTERED', count: channelOutput.coverage.excludedCount }]
    : [];
  const collection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: collectionId,
    kind: 'slack-channel-identity-review',
    labelKey: 'slack-channel-identity-review',
    coverage: {
      complete: true,
      observedCount: channelOutput.coverage.observedCount,
      includedCount: rows.length,
      excludedCount: channelOutput.coverage.excludedCount,
      exclusions
    },
    rows,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  collection.fingerprint = collectionFingerprint(collection);
  const derivedReview = { kind: definition.kind, items };
  return reviewResult({
    kind: 'slack-channel-identity-preview',
    facts: [
      { id: 'channel-identity-count', label: 'Channel identities in review', value: rows.length, state: 'supported', basisIds: ['context.slack-channel-ingestion.identities'] },
      { id: 'channel-public-count', label: 'Public channels observed in exact window', value: channels.filter((channel) => channel.visibility === 'public').length, state: 'supported', basisIds: ['context.slack-channel-ingestion.identities'] },
      { id: 'channel-private-count', label: 'Private channels observed in exact window', value: channels.filter((channel) => channel.visibility === 'private').length, state: 'supported', basisIds: ['context.slack-channel-ingestion.identities'] },
      { id: 'channel-participant-read-count', label: 'Participant rosters read', value: 0, state: 'supported', basisIds: ['context.slack-channel-ingestion.identities'] },
      { id: 'channel-proposed-write-count', label: 'External writes proposed', value: 0, state: 'supported', basisIds: ['context.slack-channel-ingestion.identities'] }
    ],
    contradictions: [],
    collections: [collection],
    definition,
    derivedReview,
    proposedChanges: []
  });
}

function participantMatches(participant, contactRecords) {
  const emailMatches = participant.email
    ? contactRecords.filter((record) => normalized(record.fields?.email) === normalized(participant.email))
    : [];
  if (emailMatches.length === 1) {
    return { state: 'resolved', record: emailMatches[0], reason: 'email-exact' };
  }
  if (emailMatches.length > 1) {
    return { state: 'ambiguous', records: emailMatches, reason: 'email-exact-ambiguous' };
  }
  const nameMatches = contactRecords.filter((record) => {
    return normalized(record.fields?.name) === normalized(participant.displayName);
  });
  if (nameMatches.length === 1) {
    return { state: 'resolved', record: nameMatches[0], reason: 'name-exact-unique' };
  }
  if (nameMatches.length > 1) {
    return { state: 'ambiguous', records: nameMatches, reason: 'name-exact-ambiguous' };
  }
  return { state: 'unmatched', records: [], reason: 'no-exact-contact' };
}

function organizationMatches(channel, organizationRecords) {
  const resolved = [];
  const facts = [];
  const missing = [];
  const channelSlug = '-' + slug(channel.name) + '-';
  const explicitMatches = organizationRecords.filter((record) => {
    const candidate = slug(record.fields?.name);
    return candidate && channelSlug.includes('-' + candidate + '-');
  });
  const byName = new Map();
  for (const record of explicitMatches) {
    const key = normalized(record.fields?.name);
    byName.set(key, [...(byName.get(key) || []), record]);
  }
  for (const records of byName.values()) {
    if (records.length === 1 && !resolved.includes(records[0].id)) {
      resolved.push(records[0].id);
      facts.push(records[0].fields.name + '|channel-name-explicit-exact|' + records[0].id);
    }
  }
  return {
    organizationUris: uniqueSorted(resolved),
    facts: uniqueSorted(facts),
    missing: uniqueSorted(missing)
  };
}

function channelFields(channel, personUris, organizationUris) {
  return {
    name: channel.name,
    platform: 'Slack',
    workspaceUri: channel.workspaceUri,
    workspaceIdentityFingerprint: channel.workspaceIdentityFingerprint,
    conversationIdentityFingerprint: channel.identityFingerprint,
    hostWorkspaceName: channel.hostWorkspaceName,
    visibility: channel.visibility,
    shared: channel.shared,
    personUris: uniqueSorted(personUris),
    organizationUris: uniqueSorted(organizationUris)
  };
}

function normalizedPortableChannelFields(fields) {
  const relationSet = (value, label) => {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)
      || value.some((item) => typeof item !== 'string' || !item)
      || new Set(value).size !== value.length) {
      throw new Error(
        'Slack channel preparation requires a valid unique ' + label + ' relation set.'
      );
    }
    return uniqueSorted(value);
  };
  return {
    ...fields,
    personUris: relationSet(fields?.personUris, 'personUris'),
    organizationUris: relationSet(fields?.organizationUris, 'organizationUris')
  };
}

function proposedFields(kind, fields, existing) {
  const common = [
    privateField('name', 'Channel name', 'text', fields.name),
    privateField('platform', 'Platform', 'text', fields.platform),
    privateField('workspaceUri', 'Workspace resource', 'text', fields.workspaceUri),
    privateField('workspaceIdentityFingerprint', 'Workspace identity fingerprint', 'text', fields.workspaceIdentityFingerprint),
    privateField('conversationIdentityFingerprint', 'Conversation identity fingerprint', 'text', fields.conversationIdentityFingerprint),
    privateField('hostWorkspaceName', 'Host workspace', 'text', fields.hostWorkspaceName),
    privateField('visibility', 'Visibility', 'text', fields.visibility),
    privateField('shared', 'Shared channel', 'boolean', fields.shared),
    privateField('personUris', 'Resolved CRM people', 'string-list', fields.personUris),
    privateField('organizationUris', 'Resolved organizations', 'string-list', fields.organizationUris)
  ];
  if (kind === 'channel-create') {
    return [
      privateField('deduplicationKey', 'Deduplication key', 'text', fields.conversationIdentityFingerprint),
      ...common
    ];
  }
  const currentFields = normalizedPortableChannelFields(existing.fields);
  return [
    privateField('recordId', 'Existing channel record', 'text', existing.id),
    privateField('expectedVersion', 'Expected record version', 'text', existing.version),
    privateField('beforeFingerprint', 'Current record fingerprint', 'text', fingerprintJson({
      id: existing.id,
      version: existing.version,
      fields: currentFields
    })),
    privateField('beforeName', 'Current channel name', 'text', currentFields.name),
    privateField('beforePlatform', 'Current platform', 'text', currentFields.platform),
    privateField('beforeWorkspaceUri', 'Current workspace resource', 'text', currentFields.workspaceUri),
    privateField('beforeWorkspaceIdentityFingerprint', 'Current workspace identity fingerprint', 'text', currentFields.workspaceIdentityFingerprint),
    privateField('beforeConversationIdentityFingerprint', 'Current conversation identity fingerprint', 'text', currentFields.conversationIdentityFingerprint),
    privateField('beforeHostWorkspaceName', 'Current host workspace', 'text', currentFields.hostWorkspaceName),
    privateField('beforeVisibility', 'Current visibility', 'text', currentFields.visibility),
    privateField('beforeShared', 'Current shared-channel state', 'boolean', currentFields.shared),
    privateField('beforePersonUris', 'Current resolved CRM people', 'string-list', currentFields.personUris),
    privateField('beforeOrganizationUris', 'Current resolved organizations', 'string-list', currentFields.organizationUris),
    ...common
  ];
}

function samePortableFields(existing, after) {
  const normalizedFields = normalizedPortableChannelFields(existing.fields);
  const current = Object.fromEntries(
    Object.keys(after).map((key) => [key, normalizedFields[key]])
  );
  return fingerprintJson(current) === fingerprintJson(after);
}

function buildSelectedReview({ channels, currentRecords, participantMap, contactRecords, organizationRecords, definition }) {
  const collectionId = 'collection.slack-channel-ingestion.selected';
  const rows = [];
  const items = [];
  const proposedChanges = [];
  const contradictions = [];
  let resolvedParticipantCount = 0;
  let unmatchedParticipantCount = 0;
  let ambiguousParticipantCount = 0;
  for (const [index, channel] of channels.entries()) {
    const roster = participantMap.get(channel.providerConversationId);
    const matchFacts = [];
    const personUris = [];
    const unmatched = [];
    const ambiguous = [];
    for (const participant of roster.participants) {
      const match = participantMatches(participant, contactRecords);
      if (match.state === 'resolved') {
        personUris.push(match.record.id);
        matchFacts.push(participant.providerParticipantId + '|' + match.reason + '|' + match.record.id);
        resolvedParticipantCount += 1;
      } else if (match.state === 'ambiguous') {
        ambiguous.push(participant.providerParticipantId);
        matchFacts.push(participant.providerParticipantId + '|' + match.reason + '|' + match.records.map((record) => record.id).sort(compareCodepoint).join(','));
        ambiguousParticipantCount += 1;
      } else {
        unmatched.push(participant.providerParticipantId);
        matchFacts.push(participant.providerParticipantId + '|' + match.reason);
        unmatchedParticipantCount += 1;
      }
    }
    const organizations = organizationMatches(channel, organizationRecords);
    const fields = channelFields(channel, personUris, organizations.organizationUris);
    const current = currentChannelCandidates(currentRecords, channel);
    const actionStem = 'action.slack-channel-ingestion.selected.'
      + String(index + 1).padStart(3, '0');
    let primaryAction;
    let proposalKind = null;
    let existing = null;
    if (current.length > 1) {
      primaryAction = {
        id: actionStem + '.held', kind: 'none', capability: null, effect: null,
        state: 'held', reasonCode: 'CHANNEL_DUPLICATE_REVIEW_REQUIRED'
      };
    } else if (current.length === 1 && samePortableFields(current[0], fields)) {
      existing = current[0];
      primaryAction = {
        id: actionStem + '.current', kind: 'none', capability: null, effect: null,
        state: 'held', reasonCode: 'CHANNEL_ALREADY_CURRENT'
      };
    } else if (current.length === 1) {
      existing = current[0];
      proposalKind = 'channel-update';
      primaryAction = {
        id: actionStem + '.update', kind: proposalKind,
        capability: 'communications.records.update', effect: 'write', state: 'proposed',
        reasonCode: 'CHANNEL_UPDATE_READY_FOR_REVIEW', changeFingerprint: null
      };
    } else {
      proposalKind = 'channel-create';
      primaryAction = {
        id: actionStem + '.create', kind: proposalKind,
        capability: 'communications.records.create', effect: 'write', state: 'proposed',
        reasonCode: 'CHANNEL_CREATE_READY_FOR_REVIEW', changeFingerprint: null
      };
    }
    const handoffActions = [];
    for (const [memberIndex, memberId] of unmatched.entries()) {
      handoffActions.push({
        id: actionStem + '.contact-handoff-' + String(memberIndex + 1).padStart(2, '0'),
        kind: 'contact-capture-handoff', capability: null, effect: null,
        state: 'handoff', reasonCode: 'CHANNEL_MEMBER_CONTACT_HANDOFF'
      });
    }
    for (const [organizationIndex] of organizations.missing.entries()) {
      handoffActions.push({
        id: actionStem + '.organization-handoff-' + String(organizationIndex + 1).padStart(2, '0'),
        kind: 'organization-capture-handoff', capability: null, effect: null,
        state: 'handoff', reasonCode: 'CHANNEL_ORGANIZATION_HANDOFF'
      });
    }
    const flags = [
      ...(unmatched.length ? ['CHANNEL_MEMBERS_UNMATCHED'] : []),
      ...(ambiguous.length ? ['CHANNEL_MEMBER_MATCH_AMBIGUOUS'] : []),
      ...(organizations.missing.length ? ['CHANNEL_ORGANIZATION_UNRESOLVED'] : []),
      ...(roster.coverage.excludedBotCount ? ['CHANNEL_BOTS_EXCLUDED'] : []),
      ...(current.length > 1 ? ['CHANNEL_DUPLICATE_CANDIDATES_OBSERVED'] : [])
    ];
    const row = {
      id: 'row.slack-channel-ingestion.selected.' + String(index + 1).padStart(3, '0'),
      sequence: index + 1,
      representedCount: 1,
      subject: { kind: 'communication-channel', fingerprint: channel.fingerprint },
      group: 'selected-channel-enrichment',
      attention: 'operator',
      disposition: 'itemized',
      reasonCode: primaryAction.reasonCode,
      flags,
      actions: [primaryAction, ...handoffActions],
      privateDetailFingerprint: null,
      fingerprint: 'sha256:' + '0'.repeat(64)
    };
    row.fingerprint = rowFingerprint(row);
    const source = sourceFor(collectionId, row);
    const detail = privateItem(
      'review-item.slack-channel-ingestion.selected.' + String(index + 1).padStart(3, '0') + '.detail',
      'channel-enrichment',
      [source],
      [
        privateField('providerConversationId', 'Provider conversation identity', 'text', channel.providerConversationId),
        privateField('participantMatchFacts', 'Participant match facts', 'string-list', uniqueSorted(matchFacts)),
        privateField('unmatchedParticipantIds', 'Unmatched participants', 'string-list', uniqueSorted(unmatched)),
        privateField('ambiguousParticipantIds', 'Ambiguous participants', 'string-list', uniqueSorted(ambiguous)),
        privateField('organizationMatchFacts', 'Organization match facts', 'string-list', organizations.facts),
        privateField('missingOrganizationNames', 'Missing organizations', 'string-list', organizations.missing)
      ]
    );
    row.privateDetailFingerprint = detail.fingerprint;
    items.push(detail);
    if (proposalKind) {
      const proposed = privateItem(
        'review-item.slack-channel-ingestion.selected.' + String(index + 1).padStart(3, '0') + '.' + proposalKind,
        proposalKind,
        [source],
        proposedFields(proposalKind, fields, existing)
      );
      const change = {
        id: primaryAction.id,
        recordId: existing?.id || primaryAction.id,
        effect: primaryAction.capability,
        beforeFingerprint: existing
          ? fingerprintJson({
              id: existing.id,
              version: existing.version,
              fields: normalizedPortableChannelFields(existing.fields)
            })
          : null,
        afterFingerprint: proposed.fingerprint
      };
      primaryAction.changeFingerprint = fingerprintJson(change);
      proposedChanges.push(change);
      items.push(proposed);
    }
    for (const [memberIndex, memberId] of unmatched.entries()) {
      const member = roster.participants.find((candidate) => {
        return candidate.providerParticipantId === memberId;
      });
      items.push(privateItem(
        'review-item.slack-channel-ingestion.selected.' + String(index + 1).padStart(3, '0')
          + '.contact-handoff-' + String(memberIndex + 1).padStart(2, '0'),
        'contact-capture-handoff',
        [source],
        [
          privateField('providerParticipantId', 'Provider participant identity', 'text', member.providerParticipantId),
          privateField('name', 'Person name', 'text', member.displayName),
          privateField('email', 'Person email', 'string-list', member.email ? [member.email] : []),
          privateField('sourceConversationId', 'Source conversation identity', 'text', channel.providerConversationId),
          privateField('targetAutomation', 'Target Automation', 'text', 'automation.contact-capture')
        ]
      ));
    }
    for (const [organizationIndex, organizationName] of organizations.missing.entries()) {
      items.push(privateItem(
        'review-item.slack-channel-ingestion.selected.' + String(index + 1).padStart(3, '0')
          + '.organization-handoff-' + String(organizationIndex + 1).padStart(2, '0'),
        'organization-capture-handoff',
        [source],
        [
          privateField('organizationName', 'Organization name', 'text', organizationName),
          privateField('sourceConversationId', 'Source conversation identity', 'text', channel.providerConversationId),
          privateField('targetAutomation', 'Target Automation', 'text', 'automation.organization-capture')
        ]
      ));
    }
    if (ambiguous.length) {
      contradictions.push({
        id: 'slack-channel-participant-ambiguity-' + String(index + 1).padStart(3, '0'),
        claim: 'At least one selected-channel participant has multiple exact CRM Person candidates and remains unlinked.',
        state: 'observed',
        basisIds: ['context.slack-channel-ingestion.contacts']
      });
    }
    rows.push(row);
  }
  const collection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: collectionId,
    kind: 'slack-selected-channel-review',
    labelKey: 'slack-selected-channel-review',
    coverage: {
      complete: true,
      observedCount: channels.length,
      includedCount: rows.length,
      excludedCount: 0,
      exclusions: []
    },
    rows,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  collection.fingerprint = collectionFingerprint(collection);
  const derivedReview = { kind: definition.kind, items };
  return reviewResult({
    kind: 'slack-channel-enrichment-preview',
    facts: [
      { id: 'selected-channel-count', label: 'Exact selected channels', value: channels.length, state: 'supported', basisIds: ['context.slack-channel-ingestion.identities'] },
      { id: 'resolved-participant-count', label: 'Participants linked to exact CRM people', value: resolvedParticipantCount, state: 'supported', basisIds: ['context.slack-channel-ingestion.contacts'] },
      { id: 'unmatched-participant-count', label: 'Unmatched participants', value: unmatchedParticipantCount, state: unmatchedParticipantCount ? 'unavailable' : 'supported', basisIds: ['context.slack-channel-ingestion.contacts'] },
      { id: 'ambiguous-participant-count', label: 'Ambiguous CRM person matches', value: ambiguousParticipantCount, state: ambiguousParticipantCount ? 'contradicted' : 'supported', basisIds: ['context.slack-channel-ingestion.contacts'] },
      { id: 'channel-proposed-write-count', label: 'Exact Communications channel writes proposed', value: proposedChanges.length, state: proposedChanges.length ? 'supported' : 'unavailable', basisIds: ['context.slack-channel-ingestion.channels', 'context.slack-channel-ingestion.participants'] }
    ],
    contradictions,
    collections: [collection],
    definition,
    derivedReview,
    proposedChanges
  });
}

function reviewResult({ kind, facts, contradictions, collections, definition, derivedReview, proposedChanges }) {
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: definition.$contract,
    contractFingerprint: fingerprintJson(definition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const preview = {
    kind,
    fingerprint: null,
    facts,
    contradictions,
    collections,
    privateReview,
    proposedChanges
  };
  preview.fingerprint = fingerprintJson({
    kind,
    facts,
    contradictions,
    collections,
    privateReview,
    proposedChanges
  });
  return { preview, derivedReview };
}

function exactPhaseInput(input, policy) {
  if (!input || !['identity-review', 'selected-enrichment'].includes(input.phase)
    || typeof input.workspaceId !== 'string' || !input.workspaceId) {
    throw inputInvalid('Slack channel ingestion requires one exact phase and private provider workspace identity.');
  }
  if (input.phase === 'identity-review') {
    if (input.selectedConversationIds !== undefined) {
      throw inputInvalid('Identity review cannot include selected conversation IDs or authorize participant reads.');
    }
    return { phase: input.phase, selectedIds: [] };
  }
  if (input.nameFilter !== undefined
    || !Array.isArray(input.selectedConversationIds)
    || input.selectedConversationIds.length < 1
    || input.selectedConversationIds.length > policy.maxSelectedChannels
    || new Set(input.selectedConversationIds).size !== input.selectedConversationIds.length) {
    throw inputInvalid('Selected enrichment requires one bounded unique exact channel identity list and no sweep filter.');
  }
  return { phase: input.phase, selectedIds: [...input.selectedConversationIds] };
}

function inputInvalid(message) {
  const error = new Error(message);
  error.code = 'PREPARATION_INPUT_INVALID';
  return error;
}

function chunked(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function mergeExactRecords(results, recordType, maximum) {
  const records = new Map();
  for (const result of results) {
    for (const record of result.output.records) {
      if (record.type !== recordType) {
        throw new Error('Slack channel ingestion received an unexpected CRM record type.');
      }
      const current = records.get(record.id);
      if (current && fingerprintJson(current) !== fingerprintJson(record)) {
        throw new Error('Slack channel ingestion received conflicting duplicate CRM candidates.');
      }
      records.set(record.id, record);
    }
  }
  if (records.size > maximum) {
    throw new Error('Slack channel ingestion candidate records exceed the exact policy bound.');
  }
  return [...records.values()].sort((left, right) => compareCodepoint(left.id, right.id));
}

export async function prepareSlackChannelIngestionRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  const policy = loadPolicy(root);
  const phase = exactPhaseInput(input, policy);
  const definition = derivedReviewDefinition(root);
  const definitionAuthority = exactAuthority(lock, 'definition', 'communications.records');
  const workspaceAuthority = exactAuthority(lock, 'instance', 'communications.workspace');
  const communicationsAuthority = exactAuthority(lock, 'instance', 'communications.records');
  const crmAuthority = exactAuthority(lock, 'instance', 'crm.records');
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
    requestedOutcome: phase.phase === 'identity-review'
      ? 'Prepare one complete public-and-private channel identity review and stop before participant data or writes.'
      : 'Prepare exact selected-channel participant and optional CRM-link review, then stop before approval or writes.',
    evidenceIds: []
  });
  const acquired = [];
  const policyResult = await readFixture({
    root, lock, capability: source.capability, authority: definitionAuthority,
    input: source.input,
    effectId: 'effect.slack-channel-ingestion.policy.fixture', at: createdAt
  });
  if (policyResult.output.records.length !== 1
    || policyResult.output.records[0].id !== 'policy.channel-ingestion'
    || policyResult.output.records[0].fields?.name !== policy.name) {
    throw new Error('Slack channel-ingestion external policy selection does not match Context.');
  }
  acquired.push({
    result: policyResult,
    entry: snapshotEntry({
      id: 'context.slack-channel-ingestion.policy',
      subject: 'communications.records.channel-ingestion-policy',
      authority: definitionAuthority,
      role: 'definition',
      result: policyResult
    })
  });
  const channelInput = phase.phase === 'identity-review'
    ? {
        mode: 'visible',
        workspaceId: input.workspaceId,
        kinds: ['public-channel', 'private-channel'],
        maximumConversations: policy.maxSweepChannels,
        ...(input.nameFilter ? { nameContains: input.nameFilter } : {})
      }
    : {
        mode: 'exact',
        workspaceId: input.workspaceId,
        conversationIds: phase.selectedIds,
        maximumConversations: policy.maxSelectedChannels,
        maximumObservedConversations: policy.maxSweepChannels
      };
  const identityResult = await readFixture({
    root, lock, capability: 'communications.conversations.list', authority: workspaceAuthority,
    input: channelInput,
    effectId: 'effect.slack-channel-ingestion.identities.fixture', at: createdAt
  });
  const channels = assertChannelOutput(identityResult.output, channelInput, policy);
  acquired.push({
    result: identityResult,
    entry: snapshotEntry({
      id: 'context.slack-channel-ingestion.identities',
      subject: 'communications.workspace.channels',
      authority: workspaceAuthority,
      role: 'instance',
      result: identityResult
    })
  });
  const schemaResult = await readFixture({
    root, lock, capability: 'communications.schema.read', authority: communicationsAuthority,
    input: { recordType: 'channel' },
    effectId: 'effect.slack-channel-ingestion.schema.fixture', at: createdAt
  });
  assertSlackChannelSchema(schemaResult.output, policy);
  acquired.push({
    result: schemaResult,
    entry: snapshotEntry({
      id: 'context.slack-channel-ingestion.schema',
      subject: 'communications.records.channel-schema',
      authority: communicationsAuthority,
      role: 'instance',
      result: schemaResult
    })
  });
  const currentInput = phase.phase === 'identity-review'
    ? { recordTypes: ['channel'], limit: policy.maxSweepChannels }
    : {
        recordTypes: ['channel'],
        filtersAny: channels.map((channel) => ({
          conversationIdentityFingerprint: channel.identityFingerprint
        })),
        limit: Math.min(policy.maxSweepChannels, phase.selectedIds.length * 4)
      };
  const currentResult = await readFixture({
    root, lock, capability: 'communications.records.read', authority: communicationsAuthority,
    input: currentInput,
    effectId: 'effect.slack-channel-ingestion.channels.fixture', at: createdAt
  });
  if (currentResult.output.records.some((record) => record.type !== 'channel')) {
    throw new Error('Slack channel duplicate read returned a non-channel Communications record.');
  }
  acquired.push({
    result: currentResult,
    entry: snapshotEntry({
      id: 'context.slack-channel-ingestion.channels',
      subject: 'communications.records.channel-candidates',
      authority: communicationsAuthority,
      role: 'instance',
      result: currentResult
    })
  });
  let review;
  if (phase.phase === 'identity-review') {
    review = buildIdentityReview({
      channelOutput: identityResult.output,
      channels,
      records: currentResult.output.records,
      definition
    });
  } else {
    const participantResults = [];
    for (const [index, conversationId] of phase.selectedIds.entries()) {
      const result = await readFixture({
        root, lock, capability: 'communications.participants.read', authority: workspaceAuthority,
        input: {
          workspaceId: input.workspaceId,
          conversationId,
          excludeBots: true,
          maximumParticipants: Math.min(policy.maxParticipantsPerChannel, 30)
        },
        effectId: 'effect.slack-channel-ingestion.participants.' + String(index + 1) + '.fixture',
        at: createdAt
      });
      participantResults.push(result.output);
      acquired.push({
        result,
        entry: snapshotEntry({
          id: 'context.slack-channel-ingestion.participants.part-' + String(index + 1),
          subject: 'communications.workspace.selected-channel-participants',
          authority: workspaceAuthority,
          role: 'instance',
          result
        })
      });
    }
    const participantMap = assertParticipantOutputs(
      participantResults,
      input.workspaceId,
      phase.selectedIds,
      policy
    );
    const contactFilters = [];
    for (const roster of participantMap.values()) {
      for (const participant of roster.participants) {
        if (participant.email) contactFilters.push({ email: participant.email });
        if (participant.displayName) contactFilters.push({ name: participant.displayName });
      }
    }
    const exactContactFilters = [...new Map(contactFilters.map((filter) => {
      return [fingerprintJson(filter), filter];
    })).values()].sort((left, right) => compareCodepoint(fingerprintJson(left), fingerprintJson(right)));
    const contactResults = [];
    for (const [index, filtersAny] of chunked(exactContactFilters, FILTER_CHUNK).entries()) {
      const result = await readFixture({
        root, lock, capability: 'crm.records.read', authority: crmAuthority,
        input: {
          recordTypes: ['person'],
          filtersAny,
          limit: Math.min(policy.maxContactCandidates, filtersAny.length * 4)
        },
        effectId: 'effect.slack-channel-ingestion.contacts.' + String(index + 1) + '.fixture',
        at: createdAt
      });
      contactResults.push(result);
      acquired.push({
        result,
        entry: snapshotEntry({
          id: 'context.slack-channel-ingestion.contacts.part-' + String(index + 1),
          subject: 'crm.records.person-candidates',
          authority: crmAuthority,
          role: 'instance',
          result
        })
      });
    }
    const contactRecords = mergeExactRecords(
      contactResults,
      'person',
      policy.maxContactCandidates
    );
    const organizationResult = await readFixture({
      root, lock, capability: 'crm.records.read', authority: crmAuthority,
      input: { recordTypes: ['organization'], limit: policy.maxOrganizationCandidates },
      effectId: 'effect.slack-channel-ingestion.organizations.fixture', at: createdAt
    });
    const organizationRecords = mergeExactRecords(
      [organizationResult],
      'organization',
      policy.maxOrganizationCandidates
    );
    acquired.push({
      result: organizationResult,
      entry: snapshotEntry({
        id: 'context.slack-channel-ingestion.organizations',
        subject: 'crm.records.organization-candidates',
        authority: crmAuthority,
        role: 'instance',
        result: organizationResult
      })
    });
    review = buildSelectedReview({
      channels,
      currentRecords: currentResult.output.records,
      participantMap,
      contactRecords,
      organizationRecords,
      definition
    });
  }
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
        'Workspace reference, channel identities, names, hosts, permalinks, participant profiles, CRM candidates, provider responses, and credentials are excluded from general inspection.'
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
    { id: 'effects-established', state: 'passed', details: 'Read and disclosure policies were evaluated before each contained context invocation.' },
    {
      id: phase.phase === 'identity-review' ? 'identity-window-reviewed' : 'selected-channels-enriched',
      state: 'passed',
      details: phase.phase === 'identity-review'
        ? 'Public and private channel identities were reviewed without participants, profiles, messages, or writes.'
        : 'Only exact operator-selected channel participant profiles were read and optionally grounded to current CRM candidates.'
    },
    { id: 'write-boundary-held', state: 'passed', details: 'No approval, continuation, provider write, Slack mutation, Communications mutation, CRM mutation, or canonical write was issued during preparation.' }
  ];
  envelope.outputs = [{ id: snapshot.id, type: 'context-snapshot', fingerprint: fingerprintJson(snapshot) }];
  envelope.effects = effects;
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: phase.phase === 'identity-review' ? [
      { id: 'channel-identities-grounded', label: 'Complete bounded channel identity review prepared', state: 'supported', basis: ['context.slack-channel-ingestion.identities'], limitation: 'Identity review does not authorize participant reads or select channels.' },
      { id: 'channel-selection-required', label: 'Exact operator channel selection required', state: 'blocked', basis: ['context.slack-channel-ingestion.identities'], limitation: 'Start a separate selected-enrichment preparation with exact private channel IDs.' },
      { id: 'external-write-boundary', label: 'All Slack, Communications, and CRM writes held', state: 'supported', basis: ['context.slack-channel-ingestion.identities', 'context.slack-channel-ingestion.channels'], limitation: 'Identity review creates no proposed write, approval, or execution authority.' }
    ] : [
      { id: 'selected-channel-participants-grounded', label: 'Exact selected-channel participant review prepared', state: 'supported', basis: ['context.slack-channel-ingestion.participants.part-1'], limitation: 'The contained roster does not establish connected Slack state.' },
      { id: 'channel-relations-grounded', label: 'Contact and organization relations grounded or left absent', state: 'supported', basis: ['context.slack-channel-ingestion.contacts.part-1', 'context.slack-channel-ingestion.organizations'], limitation: 'Unmatched and ambiguous identities remain explicit review residue.' },
      { id: 'channel-writes-prepared', label: 'Exact Communications channel creates or updates prepared', state: review.preview.proposedChanges.length ? 'proposed' : 'blocked', basis: ['context.slack-channel-ingestion.channels', 'context.slack-channel-ingestion.participants.part-1'], limitation: 'Prepared changes grant no approval, one-time start, continuation, or execution authority.' }
    ],
    preview: review.preview,
    derivedReview: review.derivedReview
  };
}
