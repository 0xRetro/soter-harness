import assert from 'node:assert/strict';
import {
  collaborationConversationIdentityBasis,
  collaborationConversationIdentityFingerprint
} from './identity.mjs';

const expectedBasis = {
  platform: 'slack',
  providerWorkspaceId: 'T01',
  providerConversationId: 'C01'
};

assert.deepEqual(collaborationConversationIdentityBasis({
  platform: ' Slack ',
  providerWorkspaceId: ' T01 ',
  providerConversationId: ' C01 '
}), expectedBasis);

const first = collaborationConversationIdentityFingerprint(expectedBasis);
assert.match(first, /^sha256:[a-f0-9]{64}$/);
assert.equal(first, collaborationConversationIdentityFingerprint({
  platform: 'SLACK',
  providerWorkspaceId: 'T01',
  providerConversationId: 'C01'
}));
assert.notEqual(first, collaborationConversationIdentityFingerprint({
  platform: 'slack',
  providerWorkspaceId: 'T02',
  providerConversationId: 'C01'
}));
assert.notEqual(first, collaborationConversationIdentityFingerprint({
  platform: 'slack',
  providerWorkspaceId: 'T01',
  providerConversationId: 'C02'
}));

assert.throws(() => collaborationConversationIdentityFingerprint({
  platform: 'slack',
  providerWorkspaceId: '',
  providerConversationId: 'C01'
}), /providerWorkspaceId/);

console.log('communications collaboration identity selftest passed');
