import assert from 'node:assert/strict';
import fs from 'node:fs';

function readJson(relative) {
  return JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'));
}

const basePack = readJson('../../../packs/context.communications/pack.json');
const collaborationPack = readJson('../../../packs/context.communications.collaboration/pack.json');
const collaborationModel = readJson('./records.model.json');
const policy = readJson('./channel-ingestion.policy.json');
const policySchema = readJson('../../../contracts/channel-ingestion-policy.schema.json');
const reviewPolicy = readJson('./conversation-review.policy.json');
const reviewPolicySchema = readJson('../../../contracts/conversation-review-policy.schema.json');
const crmModel = readJson('../../crm/records.model.json');
const crmVocabulary = readJson('../../crm/vocabulary.json');
const emailPack = readJson('../../../packs/context.email/pack.json');
const emailModel = readJson('../../email/processing.model.json');
const projectsModel = readJson('../../projects/records.model.json');
const notionMapping = readJson('../../../integrations/notion/communications-records.mapping.json');
const notionFixture = readJson('../../../fixtures/providers/notion/workspace-records.json');

assert.deepEqual(basePack.effects, []);
assert.deepEqual(basePack.capabilities, { requires: [], provides: [] });
assert.deepEqual(collaborationPack.effects, []);
assert.ok(collaborationPack.dependencies.some((dependency) => {
  return dependency.pack === 'context.communications' && dependency.optional === false;
}));

assert.equal(collaborationModel.subject, 'communications.records');
assert.deepEqual(collaborationModel.recordTypes.map((record) => record.id), [
  'channel-ingestion-policy',
  'conversation-review-policy',
  'workspace',
  'channel',
  'direct-message',
  'thread',
  'message',
  'participant'
]);

const channel = collaborationModel.recordTypes.find((record) => record.id === 'channel');
const channelFields = new Map(channel.fields.map((field) => [field.id, field]));
const portableChannelFieldIds = [
  'conversationIdentityFingerprint',
  'hostWorkspaceName',
  'name',
  'organizationUris',
  'personUris',
  'platform',
  'shared',
  'visibility',
  'workspaceIdentityFingerprint',
  'workspaceUri'
];
assert.deepEqual([...channelFields.keys()].sort(), portableChannelFieldIds);
assert.ok(channelFields.has('workspaceIdentityFingerprint'));
assert.ok(channelFields.has('conversationIdentityFingerprint'));
assert.ok(channelFields.has('personUris'));
assert.ok(channelFields.has('organizationUris'));
assert.equal(channelFields.has('providerWorkspaceId'), false);
assert.equal(channelFields.has('providerConversationId'), false);
assert.equal(channelFields.has('providerIdentityFingerprint'), false);
assert.equal(channelFields.has('permalink'), false);
assert.equal(channelFields.has('memberUris'), false);
assert.equal(channelFields.get('personUris').reference.subject, 'crm.records.person');
assert.equal(channelFields.get('organizationUris').reference.subject, 'crm.records.organization');
assert.deepEqual(channel.deduplicationFields, ['conversationIdentityFingerprint']);
for (const record of collaborationModel.recordTypes) {
  for (const field of record.fields) {
    assert.equal(
      /^provider(?:Workspace|Conversation|Participant|Thread|Message|Identity)/.test(field.id),
      false,
      record.id + '.' + field.id + ' must not represent a raw provider identity.'
    );
  }
}

const notionChannelMapping = notionMapping.recordTypes.find((record) => record.id === 'channel');
assert.equal(notionMapping.contextModel, collaborationModel.id);
assert.deepEqual(
  notionChannelMapping.fields.map((field) => field.portable).sort(),
  portableChannelFieldIds
);
assert.equal(notionChannelMapping.fields.some((field) => {
  return /provider|permalink|memberUris/.test(field.portable);
}), false);
const notionChannelRecord = notionFixture.data.records.find((record) => {
  return record.type === 'channel';
});
assert.ok(notionChannelRecord);
assert.deepEqual(Object.keys(notionChannelRecord.fields).sort(), portableChannelFieldIds);
assert.equal(
  /workspace\.soter-fixture|\bC001\b|fixture\.slack\.test|provider(?:Workspace|Conversation|Participant|Thread|Message)Id/.test(
    JSON.stringify(notionChannelRecord)
  ),
  false,
  'The durable Communications/Notion channel fixture must not contain raw provider identities.'
);

assert.equal(policy.$contract, 'soter://contracts/channel-ingestion-policy/v1');
assert.equal(policySchema.$id, 'soter://contracts/channel-ingestion-policy/v1');
assert.equal(policy.providerParticipantsAreCrmPeople, false);
assert.deepEqual(policy.organizationMatchOrder, ['channel-name-explicit-exact']);
assert.equal(policy.identityFingerprintScope, 'platform-workspace-conversation');
assert.equal(policy.identityFingerprintAlgorithm, 'sha256-canonical-json-v1');
assert.equal(policy.portableProviderIdsStored, false);
assert.equal(policySchema.properties.platform.const, undefined);

assert.equal(reviewPolicy.$contract, 'soter://contracts/conversation-review-policy/v1');
assert.equal(reviewPolicySchema.$id, 'soter://contracts/conversation-review-policy/v1');
assert.deepEqual(reviewPolicy.allowedConversationKinds, ['public-channel', 'private-channel']);
assert.equal(reviewPolicy.directMessagesIncluded, false);
assert.equal(reviewPolicy.threadReadsRequireWindowRootOrExplicitSelection, true);
assert.equal(reviewPolicy.threadExpansionMode, 'explicit-selection-only');
assert.equal(reviewPolicy.completeCoverageRequired, true);
assert.equal(reviewPolicy.contentClassification, 'private-untrusted');
assert.equal(reviewPolicy.suspectedInjectionSurfaced, true);
assert.equal(reviewPolicy.persistenceProposalsAllowed, false);
assert.equal(reviewPolicy.writesAllowed, false);

assert.equal(crmModel.recordTypes.some((record) => {
  return ['channel', 'channel-ingestion-policy', 'slack-channel-ingestion-policy'].includes(record.id);
}), false);
assert.equal(crmVocabulary.entries.some((entry) => entry.id === 'channel'), false);

assert.ok(emailPack.dependencies.some((dependency) => {
  return dependency.pack === 'context.communications' && dependency.optional === false;
}));
assert.equal(emailPack.dependencies.some((dependency) => {
  return dependency.pack === 'context.communications.collaboration';
}), false);
assert.deepEqual(emailModel.specialization, {
  basePack: 'context.communications',
  baseSubject: 'communications.semantics.records',
  scopeKind: 'mailbox',
  containerKind: 'mail-thread',
  participantKind: 'mail-address',
  contentClassification: 'private-untrusted'
});

const project = projectsModel.recordTypes.find((record) => record.id === 'project');
const projectChannelUris = project.fields.find((field) => field.id === 'channelUris');
assert.equal(projectChannelUris.reference.subject, 'communications.records.channel');

console.log('communications Context ownership selftest passed');
