import crypto from 'node:crypto';
import fs from 'node:fs';

import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function providerError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function provenance(authority, fixture, subject) {
  return {
    provider: 'notion-docs-fixture',
    authority,
    sourceKind: 'fixture',
    sourceReferenceFingerprint: fingerprintJson({ fixtureId: fixture.id, subject })
  };
}

function normalizedSchema(source) {
  const unsigned = structuredClone(source);
  if (!Array.isArray(unsigned.fields)
    || unsigned.fields.length < 1
    || new Set(unsigned.fields.map((field) => field.id)).size !== unsigned.fields.length
    || unsigned.fields.some((field) => {
      return typeof field.id !== 'string'
        || typeof field.writable !== 'boolean'
        || (field.options !== null
          && (!Array.isArray(field.options)
            || field.options.length < 1
            || new Set(field.options).size !== field.options.length
            || field.options.some((option) => typeof option !== 'string' || !option)));
    })) {
    throw providerError('validation', 'Notion document schema fixture is malformed or ambiguous.');
  }
  unsigned.fields = unsigned.fields.map((field) => ({
    ...field,
    options: field.options === null ? null : [...field.options].sort(compareCodepoint)
  })).sort((left, right) => compareCodepoint(left.id, right.id));
  return { ...unsigned, fingerprint: fingerprintJson(unsigned) };
}

function recordId(key) {
  const suffix = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return 'soter-fixture://docs/record/' + suffix;
}

export async function invoke({ capability, input, authority, fixtures, state, at }) {
  const fixture = state || JSON.parse(fs.readFileSync(fixtures[0], 'utf8'));
  const observedAt = at || fixture.observedAt;
  if (capability === 'documents.schema.read') {
    const matches = fixture.data.schemas.filter((schema) => schema.recordType === input.recordType);
    if (matches.length !== 1) {
      throw providerError('not-found', 'Document schema did not resolve exactly once.');
    }
    const schema = normalizedSchema(matches[0]);
    return {
      schema,
      provenance: provenance(authority, fixture, {
        recordType: input.recordType,
        schemaFingerprint: schema.fingerprint
      }),
      observedAt
    };
  }
  if (capability === 'documents.records.read') {
    const requestedIds = input.ids ? new Set(input.ids) : null;
    const filters = Object.entries(input.filters || {});
    const records = fixture.data.records.filter((record) => {
      return record.type === input.recordType
        && (!requestedIds || requestedIds.has(record.id))
        && filters.every(([field, value]) => record.fields?.[field] === value);
    }).slice(0, input.limit || 100);
    return {
      records,
      provenance: provenance(authority, fixture, { input }),
      observedAt
    };
  }
  if (capability === 'documents.records.create') {
    const existing = fixture.data.records.find((record) => {
      return record.type === input.recordType
        && record.deduplicationKey === input.deduplicationKey;
    });
    if (existing) {
      return {
        record: existing,
        created: false,
        provenance: provenance(authority, fixture, { deduplicationKey: input.deduplicationKey }),
        observedAt
      };
    }
    const record = {
      type: input.recordType,
      id: recordId(input.deduplicationKey),
      version: '1',
      deduplicationKey: input.deduplicationKey,
      fields: { ...input.fields }
    };
    fixture.data.records.push(record);
    return {
      record,
      created: true,
      provenance: provenance(authority, fixture, { deduplicationKey: input.deduplicationKey }),
      observedAt
    };
  }
  throw providerError('validation', 'Notion Docs fixture does not implement ' + capability + '.');
}
