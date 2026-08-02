import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

function providerError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function otterMeetingId(recordingUri) {
  let parsed;
  try {
    parsed = new URL(recordingUri);
  } catch {
    throw providerError(
      'validation',
      'Otter transcript reads require a canonical https://otter.ai/u/MEETING_ID recording URI.'
    );
  }
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || !['otter.ai', 'www.otter.ai'].includes(host)
    || parts.length !== 2
    || parts[0] !== 'u') {
    throw providerError(
      'validation',
      'Otter transcript reads require a canonical https://otter.ai/u/MEETING_ID recording URI.'
    );
  }
  let id;
  try {
    id = decodeURIComponent(parts[1]);
  } catch {
    throw providerError('validation', 'The Otter meeting ID is not valid URI data.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw providerError('validation', 'The Otter meeting ID contains unsupported characters.');
  }
  return id;
}

function structuredResult(response) {
  const result = response?.structuredContent?.result ?? response?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw providerError(
      'validation',
      'Otter fetch did not return an object in structuredContent.result.'
    );
  }
  return result;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw providerError('validation', 'Otter transcript field ' + field + ' must be a non-empty string.');
  }
  return value;
}

function requiredNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw providerError('validation', 'Otter transcript field ' + field + ' must be a non-negative number.');
  }
  return value;
}

function transcriptProjection(result) {
  // Provider calendar_participants and action_items are untrusted annotations.
  // Only the exact speaker and segment fields below can cross the portable boundary.
  return {
    speakers: result.speakers,
    segments: result.segments
  };
}

export function prepareMcp({ capability, input }) {
  if (capability !== 'meeting.transcript.read') {
    throw providerError('validation', 'Otter MCP does not implement ' + capability + '.');
  }
  return {
    tool: 'fetch',
    arguments: {
      id: otterMeetingId(input.recordingUri)
    }
  };
}

export function completeMcp({ capability, input, authority, response, at }) {
  if (capability !== 'meeting.transcript.read') {
    throw providerError('validation', 'Otter MCP does not implement ' + capability + '.');
  }
  const result = transcriptProjection(structuredResult(response));
  if (!Array.isArray(result.speakers) || !Array.isArray(result.segments)) {
    throw providerError(
      'validation',
      'Otter fetch response normalization is unverified for this response shape; an authorized observed transcript fixture is required before expanding the adapter.'
    );
  }
  const providerMeetingId = otterMeetingId(input.recordingUri);
  return {
    meetingId: input.meetingId,
    recordingUri: input.recordingUri,
    speakers: result.speakers.map((speaker, index) => ({
      id: requiredString(speaker?.id, 'speakers[' + index + '].id'),
      displayName: requiredString(
        speaker?.displayName,
        'speakers[' + index + '].displayName'
      )
    })),
    segments: result.segments.map((segment, index) => ({
      speakerId: requiredString(
        segment?.speakerId,
        'segments[' + index + '].speakerId'
      ),
      text: requiredString(segment?.text, 'segments[' + index + '].text'),
      startSeconds: requiredNumber(
        segment?.startSeconds,
        'segments[' + index + '].startSeconds'
      )
    })),
    provenance: {
      provider: 'otter-mcp',
      authority,
      sourceKind: 'connected',
      sourceReferenceFingerprint: fingerprintJson({
        provider: 'otter-mcp',
        authority,
        providerMeetingId
      })
    },
    observedAt: at
  };
}

export function prepareProbePlanMcp() {
  return {
    steps: [{
      id: 'step.identity',
      kind: 'identity',
      subject: 'provider.identity',
      scope: {
        expectation: {
          identityType: 'non-empty-string'
        }
      },
      tool: 'get_user_info',
      arguments: {}
    }]
  };
}

export function completeProbePlanStepMcp({ step, response }) {
  if (step?.id !== 'step.identity' || step.kind !== 'identity') {
    throw providerError('validation', 'Otter provider probe received an unsupported step.');
  }
  const identity = response?.structuredContent?.result ?? response?.result;
  if (typeof identity !== 'string' || !identity.trim()) {
    throw providerError(
      'authentication',
      'Otter get_user_info did not return an authenticated identity result.'
    );
  }
  return {
    identityAuthenticated: true,
    expectedFingerprint: fingerprintJson(step.scope.expectation),
    observedFingerprint: fingerprintJson({ identityType: 'non-empty-string' })
  };
}

export function finalizeProbePlanMcp({ plan, steps, results }) {
  const step = steps?.[0];
  const observed = results?.[0];
  if (steps?.length !== 1
    || results?.length !== 1
    || step?.id !== 'step.identity'
    || observed?.stepId !== step.id
    || !observed.result?.identityAuthenticated
    || observed.result.expectedFingerprint !== fingerprintJson(step.scope.expectation)
    || typeof observed.result.observedFingerprint !== 'string') {
    throw providerError('validation', 'Otter provider probe is missing its exact minimized identity result.');
  }
  return {
    credentials: plan.credentialRefs.map((secretRefId) => ({
      secretRefId,
      state: 'passed',
      details: 'The host-authenticated Otter identity endpoint returned a non-empty result.'
    })),
    reachability: {
      state: 'passed',
      details: 'The host reached Otter get_user_info and received a structured response.'
    },
    authorities: plan.authorities.map((id) => ({
      id,
      state: 'passed',
      details: 'The configured Otter account identity was visible without reading meeting content.'
    })),
    capabilities: plan.capabilities.map((id) => ({
      id,
      state: 'unknown',
      method: 'metadata',
      details: 'Identity metadata does not establish access to or normalization of a specific transcript.'
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
      details: 'The host-authenticated Otter identity response matched the minimized identity contract.'
    }],
    limitations: [
      'This identity-only probe establishes authentication and endpoint reachability, not transcript access, response-shape compatibility, or end-to-end health.',
      'The provider response body and returned identity value are excluded; only typed observations and fingerprints may persist.'
    ]
  };
}
