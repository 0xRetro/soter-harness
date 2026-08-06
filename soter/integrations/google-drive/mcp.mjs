import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

export const GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE = 'google-drive.codex.connector.v1';
export const GOOGLE_DRIVE_PORTABLE_CAPABILITY_UNAVAILABLE =
  'GOOGLE_DRIVE_PORTABLE_CAPABILITY_UNAVAILABLE';

const CAPABILITY_UNAVAILABLE_MESSAGE =
  'Portable Google Drive storage capability execution is unavailable pending configured registry semantics and exact normalized response evidence.';

function providerError(kind, code, message) {
  const error = new Error(message);
  error.kind = kind;
  error.code = code;
  return error;
}

function unavailable() {
  throw providerError(
    'unavailable',
    GOOGLE_DRIVE_PORTABLE_CAPABILITY_UNAVAILABLE,
    CAPABILITY_UNAVAILABLE_MESSAGE
  );
}

function exactObject(value, label, { required = [], allowed = required } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw providerError(
      'validation',
      'GOOGLE_DRIVE_RESPONSE_PROFILE_INVALID',
      label + ' must be one structured object.'
    );
  }
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !allowed.includes(key))) {
    throw providerError(
      'validation',
      'GOOGLE_DRIVE_RESPONSE_PROFILE_INVALID',
      label + ' does not match the exact declared response profile.'
    );
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw providerError(
      'validation',
      'GOOGLE_DRIVE_RESPONSE_PROFILE_INVALID',
      label + ' must be a non-empty string.'
    );
  }
}

function profileAcknowledged(response, responseProfile) {
  if (responseProfile !== GOOGLE_DRIVE_CONNECTED_RESPONSE_PROFILE) {
    throw providerError(
      'validation',
      'GOOGLE_DRIVE_RESPONSE_PROFILE_INVALID',
      'Google Drive response profile is not declared by this adapter.'
    );
  }
  const envelope = exactObject(response, 'Google Drive profile envelope', {
    required: ['structuredContent', 'content', 'isError'],
    allowed: ['structuredContent', 'content', 'isError', '_meta']
  });
  if (envelope.isError !== false) {
    throw providerError(
      'unknown',
      'GOOGLE_DRIVE_PROFILE_PROBE_FAILED',
      'Google Drive profile returned an error result.'
    );
  }
  if (!Array.isArray(envelope.content) || envelope.content.length < 1) {
    throw providerError(
      'validation',
      'GOOGLE_DRIVE_RESPONSE_PROFILE_INVALID',
      'Google Drive profile envelope content must contain only text blocks.'
    );
  }
  for (const item of envelope.content) {
    const block = exactObject(item, 'Google Drive profile content block', {
      required: ['type', 'text']
    });
    if (block.type !== 'text' || typeof block.text !== 'string') {
      throw providerError(
        'validation',
        'GOOGLE_DRIVE_RESPONSE_PROFILE_INVALID',
        'Google Drive profile envelope content must contain only text blocks.'
      );
    }
  }
  if (Object.hasOwn(envelope, '_meta')
    && (!envelope._meta || typeof envelope._meta !== 'object' || Array.isArray(envelope._meta))) {
    throw providerError(
      'validation',
      'GOOGLE_DRIVE_RESPONSE_PROFILE_INVALID',
      'Google Drive profile envelope _meta must be an object when present.'
    );
  }
  const profile = exactObject(envelope.structuredContent, 'Google Drive profile result', {
    required: ['id', 'name', 'email', 'nickname', 'picture']
  });
  requiredString(profile.id, 'Google Drive profile id');
  requiredString(profile.name, 'Google Drive profile name');
  requiredString(profile.email, 'Google Drive profile email');
  if (profile.nickname !== null) {
    requiredString(profile.nickname, 'Google Drive profile nickname');
  }
  requiredString(profile.picture, 'Google Drive profile picture');
  return true;
}

// Portable storage capability execution remains unavailable: a profile response
// establishes neither configured registry meaning nor exact artifact normalization.
export function prepareMcp(_request = {}) {
  return unavailable();
}

export function completeMcp(_request = {}) {
  return unavailable();
}

export function prepareProbePlanMcp() {
  return {
    steps: [{
      id: 'step.identity',
      kind: 'identity',
      subject: 'provider.identity',
      scope: {
        expectation: {
          acknowledgedProfile: true
        }
      },
      tool: 'get_profile',
      arguments: {}
    }]
  };
}

export function completeProbePlanStepMcp({ step, responseProfile, response }) {
  if (step?.id !== 'step.identity' || step.kind !== 'identity') {
    throw providerError(
      'validation',
      'GOOGLE_DRIVE_PROFILE_PROBE_INVALID',
      'Google Drive provider probe received an unsupported step.'
    );
  }
  profileAcknowledged(response, responseProfile);
  return {
    profileAcknowledged: true,
    expectedFingerprint: fingerprintJson(step.scope.expectation),
    observedFingerprint: fingerprintJson({ acknowledgedProfile: true })
  };
}

export function finalizeProbePlanMcp({ plan, steps, results }) {
  const step = steps?.[0];
  const observed = results?.[0];
  if (steps?.length !== 1
    || results?.length !== 1
    || step?.id !== 'step.identity'
    || observed?.stepId !== step.id
    || !observed.result?.profileAcknowledged
    || observed.result.expectedFingerprint !== fingerprintJson(step.scope.expectation)
    || typeof observed.result.observedFingerprint !== 'string') {
    throw providerError(
      'validation',
      'GOOGLE_DRIVE_PROFILE_PROBE_INVALID',
      'Google Drive provider probe is missing its exact minimized identity result.'
    );
  }
  return {
    credentials: plan.credentialRefs.map((secretRefId) => ({
      secretRefId,
      state: 'passed',
      details: 'The host-authenticated Google Drive profile endpoint returned an acknowledged result.'
    })),
    reachability: {
      state: 'passed',
      details: 'The host reached the Google Drive profile endpoint and received an acknowledged result.'
    },
    authorities: plan.authorities.map((id) => ({
      id,
      state: 'unknown',
      details: 'Profile acknowledgment does not bind the returned identity to this exact configured Google Drive authority.'
    })),
    capabilities: plan.capabilities.map((id) => ({
      id,
      state: 'unknown',
      method: 'metadata',
      details: 'Profile metadata does not establish configured registry meaning, artifact access, exact response normalization, or write behavior.'
    })),
    checks: [{
      id: 'check.identity',
      stepId: step.id,
      kind: step.kind,
      subject: step.subject,
      scopeFingerprint: step.scopeFingerprint,
      state: 'passed',
      method: 'metadata',
      expectedFingerprint: observed.result.expectedFingerprint,
      observedFingerprint: observed.result.observedFingerprint,
      details: 'The host-authenticated Google Drive profile response matched the minimized identity contract.'
    }],
    limitations: [
      'This profile-only probe establishes authentication and endpoint reachability, not configured authority binding, storage capability readiness, verification, or health.',
      'The provider response and account identity values are excluded; only typed acknowledgments and fingerprints may persist.'
    ]
  };
}
