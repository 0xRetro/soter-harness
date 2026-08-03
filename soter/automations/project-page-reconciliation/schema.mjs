import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

function exactField(schema, id, options) {
  const matches = schema.fields.filter((field) => field.id === id);
  if (matches.length !== 1
    || matches[0].writable !== true
    || !Array.isArray(matches[0].options)
    || new Set(matches[0].options).size !== matches[0].options.length
    || fingerprintJson([...matches[0].options].sort())
      !== fingerprintJson([...options].sort())) {
    throw new Error(
      'Project page reconciliation requires one exact writable ' + id
        + ' field with the governed portable choices.'
    );
  }
  return matches[0];
}

export function assertProjectPageReconciliationSchema(output, policy) {
  const schema = output?.schema;
  if (!schema || schema.recordType !== 'project' || !Array.isArray(schema.fields)) {
    throw new Error(
      'Project page reconciliation requires one normalized Project schema observation.'
    );
  }
  exactField(schema, 'projectType', policy.allowedTypes);
  exactField(schema, 'status', policy.allowedStatuses);
  return { schema, schemaFingerprint: fingerprintJson(schema) };
}
