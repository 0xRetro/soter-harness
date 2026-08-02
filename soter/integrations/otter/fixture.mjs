import fs from 'node:fs';

import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

function providerError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function transcriptProjection(transcript) {
  return {
    speakers: Array.isArray(transcript.speakers)
      ? transcript.speakers.map((speaker) => ({
        id: speaker?.id,
        displayName: speaker?.displayName
      }))
      : transcript.speakers,
    segments: Array.isArray(transcript.segments)
      ? transcript.segments.map((segment) => ({
        speakerId: segment?.speakerId,
        text: segment?.text,
        startSeconds: segment?.startSeconds
      }))
      : transcript.segments
  };
}

export async function invoke({ capability, input, authority, fixtures, state }) {
  if (capability !== 'meeting.transcript.read') {
    throw providerError('validation', 'Otter fixture does not implement ' + capability + '.');
  }
  const fixture = state || JSON.parse(fs.readFileSync(fixtures[0], 'utf8'));
  const transcript = fixture.data.transcripts.find((item) => {
    return item.meetingId === input.meetingId && item.recordingUri === input.recordingUri;
  });
  if (!transcript) {
    throw providerError('not-found', 'Transcript fixture not found for ' + input.meetingId + '.');
  }
  const projected = transcriptProjection(transcript);
  return {
    meetingId: transcript.meetingId,
    recordingUri: transcript.recordingUri,
    speakers: projected.speakers,
    segments: projected.segments,
    provenance: {
      provider: 'otter-fixture',
      authority,
      sourceKind: 'fixture',
      sourceReferenceFingerprint: fingerprintJson({
        provider: 'otter-fixture',
        fixtureId: fixture.id,
        meetingId: transcript.meetingId
      })
    },
    observedAt: fixture.observedAt
  };
}
