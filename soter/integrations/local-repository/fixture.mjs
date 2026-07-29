import fs from 'node:fs';

import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

function providerError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function exactCapability(candidate) {
  const evidence = candidate.evidence.map((item) => ({
    relativePath: item.relativePath,
    contentFingerprint: item.contentFingerprint
  }));
  const unsigned = {
    id: candidate.id,
    name: candidate.name,
    why: candidate.why,
    summary: candidate.summary,
    currentState: candidate.currentState,
    evidence
  };
  return { ...unsigned, fingerprint: fingerprintJson(unsigned) };
}

export async function invoke({ capability, input, authority, fixtures, state, at }) {
  if (capability !== 'repository.snapshot.read') {
    throw providerError('validation', 'Local repository fixture does not implement ' + capability + '.');
  }
  const fixture = state || JSON.parse(fs.readFileSync(fixtures[0], 'utf8'));
  const matches = (fixture.data?.repositories || []).filter((repository) => {
    return repository.uri === input?.uri;
  });
  if (matches.length !== 1) {
    throw providerError('not-found', 'Repository fixture did not resolve exactly once.');
  }
  const source = matches[0];
  const capabilities = source.capabilities.map(exactCapability);
  if (new Set(capabilities.map((candidate) => candidate.id)).size !== capabilities.length
    || capabilities.some((candidate) => candidate.evidence.some((item) => {
      return item.relativePath.startsWith('/')
        || item.relativePath.split('/').includes('..')
        || item.relativePath.includes('\\');
    }))) {
    throw providerError('validation', 'Repository fixture capability identities or evidence paths are invalid.');
  }
  return {
    repository: {
      identityFingerprint: fingerprintJson({ fixtureId: fixture.id, uri: source.uri }),
      revision: source.revision,
      state: source.state,
      remoteFingerprint: source.remote === null ? null : fingerprintJson(source.remote),
      sourceFileCount: source.sourceFileCount,
      readmeObserved: source.readmeObserved
    },
    capabilities,
    provenance: {
      provider: 'local-repository-fixture',
      authority,
      sourceKind: 'fixture',
      sourceReferenceFingerprint: fingerprintJson({
        fixtureId: fixture.id,
        repositoryIdentity: source.uri,
        revision: source.revision
      })
    },
    observedAt: at || fixture.observedAt
  };
}
