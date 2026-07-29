const RECORD_CAPABILITY_RE = /^([a-z0-9]+(?:[.-][a-z0-9]+)*)\.(records\.(read|create|update)|schema\.read)$/;

export function parseRecordCapability(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(RECORD_CAPABILITY_RE);
  if (!match) return null;
  const namespace = match[1];
  const operation = match[3] || 'schema-read';
  return {
    id: value,
    namespace,
    subject: namespace + '.records',
    family: operation === 'schema-read' ? 'schema' : 'records',
    operation,
    readCapability: namespace + '.records.read',
    schemaCapability: namespace + '.schema.read'
  };
}

export function isRecordCapability(value) {
  return parseRecordCapability(value) !== null;
}
