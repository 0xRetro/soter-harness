import fs from 'node:fs';

function providerError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

export async function invoke({ capability, input, authority, fixtures }) {
  if (capability !== 'meeting.transcript.read') {
    throw providerError('validation', 'Otter fixture does not implement ' + capability + '.');
  }
  const fixture = JSON.parse(fs.readFileSync(fixtures[0], 'utf8'));
  const transcript = fixture.data.transcripts.find((item) => {
    return item.meetingId === input.meetingId && item.recordingUri === input.recordingUri;
  });
  if (!transcript) {
    throw providerError('not-found', 'Transcript fixture not found for ' + input.meetingId + '.');
  }
  return {
    meetingId: transcript.meetingId,
    speakers: transcript.speakers,
    segments: transcript.segments,
    provenance: {
      provider: 'otter-fixture',
      authority,
      fixture: 'soter/fixtures/providers/otter/transcripts.json'
    },
    observedAt: fixture.observedAt
  };
}
