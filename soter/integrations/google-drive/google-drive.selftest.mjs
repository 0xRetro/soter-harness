import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE,
  GOOGLE_DRIVE_PORTABLE_CAPABILITY_UNAVAILABLE,
  completeMcp,
  completeProbePlanStepMcp,
  finalizeProbePlanMcp,
  prepareMcp,
  prepareProbePlanMcp
} from './mcp.mjs';

const provider = JSON.parse(fs.readFileSync(
  new URL('../../providers/provider.integration.google-drive.mcp.json', import.meta.url),
  'utf8'
));
const pack = JSON.parse(fs.readFileSync(
  new URL('../../packs/integration.google-drive/pack.json', import.meta.url),
  'utf8'
));
const codexAdapter = JSON.parse(fs.readFileSync(
  new URL('../../hosts/codex/adapter.json', import.meta.url),
  'utf8'
));
const claudeAdapter = JSON.parse(fs.readFileSync(
  new URL('../../hosts/claude/adapter.json', import.meta.url),
  'utf8'
));

function assertCapabilityUnavailable(operation, hostileSentinel) {
  assert.throws(operation, (error) => {
    assert.equal(error.kind, 'unavailable');
    assert.equal(error.code, GOOGLE_DRIVE_PORTABLE_CAPABILITY_UNAVAILABLE);
    assert.equal(
      error.message,
      'Portable Google Drive storage capability execution is unavailable pending configured registry semantics and exact normalized response evidence.'
    );
    assert.equal(error.message.includes(hostileSentinel), false);
    return true;
  });
}

function profileResponse(overrides = {}) {
  return {
    structuredContent: {
      id: 'drive-account-opaque',
      name: 'Private Person',
      email: 'private.person@example.invalid',
      nickname: null,
      picture: 'https://example.invalid/private-picture',
      ...overrides
    },
    content: [{ type: 'text', text: 'Private Google Drive profile text.' }],
    isError: false
  };
}

assert.equal(GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE, 'google-drive.codex.connector.v1');
assert.deepEqual(provider.runtime.responseProfiles, [GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE]);
assert.deepEqual(provider.capabilities, [
  { id: 'storage.registry.read', version: '1.0.0' },
  { id: 'storage.artifacts.read', version: '1.0.0' }
]);
assert.deepEqual(provider.effects, ['read', 'disclosure']);
assert.deepEqual(provider.runtime.tools, ['get_profile']);
assert.deepEqual(provider.runtime.probeTools, ['get_profile']);
assert.deepEqual(pack.compatibility.hosts, ['codex']);

const codexRoute = codexAdapter.mcpServers.find((server) => server.id === provider.runtime.server);
assert.ok(codexRoute);
assert.equal(codexRoute.delivery, 'connector');
assert.equal(codexRoute.state, 'declared');
assert.deepEqual(
  codexRoute.toolMappings.map(({ logical, native, responseProfile }) => ({
    logical,
    native,
    responseProfile
  })),
  [
    {
      logical: 'get_profile',
      native: 'mcp__codex_apps__google_drive_get_profile',
      responseProfile: GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE
    },
    {
      logical: 'get_file_metadata',
      native: 'mcp__codex_apps__google_drive_get_file_metadata',
      responseProfile: GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE
    },
    {
      logical: 'list_folder',
      native: 'mcp__codex_apps__google_drive_list_folder',
      responseProfile: GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE
    },
    {
      logical: 'search',
      native: 'mcp__codex_apps__google_drive_search',
      responseProfile: GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE
    }
  ]
);
assert.equal(
  claudeAdapter.mcpServers.some((server) => server.id === provider.runtime.server),
  false
);

const hostileSentinel = 'HOSTILE_RAW_DRIVE_RESPONSE_/private/user/credentials.json';
assertCapabilityUnavailable(() => prepareMcp({
  capability: 'storage.artifacts.read',
  input: { arbitraryOpenInput: hostileSentinel }
}), hostileSentinel);
assertCapabilityUnavailable(() => completeMcp({
  capability: 'storage.artifacts.read',
  input: {},
  authority: {},
  response: { rawProviderResponse: hostileSentinel },
  at: '2026-08-06T00:00:00.000Z'
}), hostileSentinel);

const prepared = prepareProbePlanMcp();
assert.deepEqual(prepared, {
  steps: [{
    id: 'step.identity',
    kind: 'identity',
    subject: 'provider.identity',
    scope: { expectation: { acknowledgedProfile: true } },
    tool: 'get_profile',
    arguments: {}
  }]
});
const step = {
  ...prepared.steps[0],
  scopeFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
};
const completed = completeProbePlanStepMcp({
  step,
  responseProfile: GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE,
  response: profileResponse()
});
assert.deepEqual(Object.keys(completed).sort(), [
  'expectedFingerprint',
  'observedFingerprint',
  'profileAcknowledged'
]);
assert.equal(completed.profileAcknowledged, true);
const serializedCompleted = JSON.stringify(completed);
for (const privateValue of [
  'drive-account-opaque',
  'Private Person',
  'private.person@example.invalid',
  'https://example.invalid/private-picture',
  'Private Google Drive profile text.'
]) {
  assert.equal(serializedCompleted.includes(privateValue), false);
}

const finalized = finalizeProbePlanMcp({
  plan: {
    credentialRefs: ['secret-ref.google-drive'],
    authorities: [
      'authority.google-drive.provider',
      'authority.google-drive.arbitrary-unbound'
    ],
    capabilities: ['storage.registry.read', 'storage.artifacts.read']
  },
  steps: [step],
  results: [{ stepId: step.id, result: completed }]
});
assert.equal(finalized.credentials[0].state, 'passed');
assert.equal(finalized.reachability.state, 'passed');
assert.deepEqual(finalized.authorities.map(({ id, state }) => ({ id, state })), [
  { id: 'authority.google-drive.provider', state: 'unknown' },
  { id: 'authority.google-drive.arbitrary-unbound', state: 'unknown' }
]);
assert.deepEqual(finalized.capabilities.map(({ id, state }) => ({ id, state })), [
  { id: 'storage.registry.read', state: 'unknown' },
  { id: 'storage.artifacts.read', state: 'unknown' }
]);
assert.equal(finalized.checks[0].state, 'passed');
assert.equal(finalized.limitations.length, 2);
const serializedFinalized = JSON.stringify(finalized);
assert.equal(serializedFinalized.includes('drive-account-opaque'), false);
assert.equal(serializedFinalized.includes('private.person@example.invalid'), false);

const invalidResponses = [
  { responseProfile: 'google-drive.claude.plugin.v1', response: profileResponse() },
  {
    responseProfile: GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE,
    response: {
      structuredContent: { result: profileResponse().structuredContent },
      content: [{ type: 'text', text: 'nested result is not accepted' }],
      isError: false
    }
  },
  {
    responseProfile: GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE,
    response: profileResponse({ rawProviderResponse: hostileSentinel })
  },
  {
    responseProfile: GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE,
    response: { ...profileResponse(), content: [{ type: 'image', data: hostileSentinel }] }
  },
  {
    responseProfile: GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE,
    response: {
      ...profileResponse(),
      content: [{
        type: 'text',
        text: 'ordinary text',
        rawProviderResponse: hostileSentinel
      }]
    }
  },
  {
    responseProfile: GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE,
    response: { ...profileResponse(), isError: true }
  },
  {
    responseProfile: GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE,
    response: profileResponse({ nickname: 7 })
  }
];
for (const invalid of invalidResponses) {
  assert.throws(() => completeProbePlanStepMcp({
    step,
    responseProfile: invalid.responseProfile,
    response: invalid.response
  }), (error) => {
    assert.ok([
      'GOOGLE_DRIVE_RESPONSE_PROFILE_INVALID',
      'GOOGLE_DRIVE_PROFILE_PROBE_FAILED'
    ].includes(error.code));
    assert.equal(error.message.includes(hostileSentinel), false);
    return true;
  });
}

assert.throws(() => finalizeProbePlanMcp({
  plan: { credentialRefs: [], authorities: [], capabilities: [] },
  steps: [step],
  results: []
}), (error) => error.code === 'GOOGLE_DRIVE_PROFILE_PROBE_INVALID');

console.log('Google Drive connected identity-probe selftest passed.');
