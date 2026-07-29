import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

function exactField(schema, id, { writable, options = null }) {
  const matches = schema.fields.filter((field) => field.id === id);
  if (matches.length !== 1 || matches[0].writable !== writable) {
    throw new Error(
      'Project schema must expose exactly one ' + (writable ? 'writable ' : 'read-only ')
        + id + ' field.'
    );
  }
  const observedOptions = matches[0].options;
  const optionsMatch = options === null
    ? observedOptions === null
    : Array.isArray(observedOptions)
      && observedOptions.length === options.length
      && new Set(observedOptions).size === observedOptions.length
      && fingerprintJson([...observedOptions].sort()) === fingerprintJson([...options].sort());
  if (!optionsMatch) {
    throw new Error('Project schema field ' + id + ' does not match the governed option shape.');
  }
  return matches[0];
}

export function assertProjectCaptureSchema(output, policy) {
  const schema = output?.schema;
  if (!schema || schema.recordType !== 'project' || !Array.isArray(schema.fields)) {
    throw new Error('Project Capture requires one exact normalized project schema observation.');
  }
  exactField(schema, 'name', { writable: true });
  exactField(schema, 'projectType', { writable: true, options: policy.allowedTypes });
  exactField(schema, 'status', { writable: true, options: policy.allowedStatuses });
  exactField(schema, 'startDate', { writable: true });
  exactField(schema, 'targetEndDate', { writable: true });
  exactField(schema, 'organizationUris', { writable: true });
  return {
    schema,
    schemaFingerprint: fingerprintJson(schema)
  };
}
