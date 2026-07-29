import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

const REQUIRED_WRITABLE_FIELDS = [
  'assigneeIds',
  'context',
  'nextActionOn',
  'projectUris',
  'status',
  'title'
];

function exactSchema(output) {
  const schema = output?.schema;
  if (!schema
    || schema.recordType !== 'task'
    || !Array.isArray(schema.fields)
    || schema.fields.length < REQUIRED_WRITABLE_FIELDS.length
    || new Set(schema.fields.map((field) => field?.id)).size !== schema.fields.length) {
    throw new Error('Task Capture requires one exact normalized Task schema observation.');
  }
  const unsigned = {
    recordType: schema.recordType,
    fields: structuredClone(schema.fields)
  };
  if (schema.fingerprint !== fingerprintJson(unsigned)) {
    throw new Error('Task Capture normalized Task schema fingerprint is stale.');
  }
  const byId = new Map(schema.fields.map((field) => [field.id, field]));
  if (REQUIRED_WRITABLE_FIELDS.some((id) => {
    const field = byId.get(id);
    return !field || field.writable !== true;
  })) {
    throw new Error('Task Capture normalized Task schema omits a required writable field.');
  }
  return { schema, byId };
}

function exactOptions(field, label) {
  if (!Array.isArray(field?.options)
    || field.options.length < 1
    || field.options.some((option) => typeof option !== 'string' || !option)
    || new Set(field.options).size !== field.options.length) {
    throw new Error('Task Capture requires exact normalized ' + label + ' options.');
  }
  return field.options;
}

export function evaluateTaskCaptureSchema(output, { status, context }) {
  const { schema, byId } = exactSchema(output);
  const statusOptions = exactOptions(byId.get('status'), 'status');
  const contextOptions = exactOptions(byId.get('context'), 'context');
  const issues = [
    ...(!statusOptions.includes(status) ? ['TASK_STATUS_VALUE_UNAVAILABLE'] : []),
    ...(!contextOptions.includes(context) ? ['TASK_CONTEXT_VALUE_UNAVAILABLE'] : [])
  ];
  return {
    schema,
    schemaFingerprint: schema.fingerprint,
    statusAvailable: statusOptions.includes(status),
    contextAvailable: contextOptions.includes(context),
    issues
  };
}
