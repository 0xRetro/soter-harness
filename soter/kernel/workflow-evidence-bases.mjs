const WORKFLOW_EVIDENCE_BASES = Object.freeze([
  Object.freeze({
    path: 'soter/fixtures/harness-development-catalog-final/claude.lock.json',
    configuration: 'harness-development-catalog-claude',
    host: 'claude',
    adapter: 'host.claude'
  }),
  Object.freeze({
    path: 'soter/fixtures/harness-development-catalog-final/codex.lock.json',
    configuration: 'harness-development-catalog',
    host: 'codex',
    adapter: 'host.codex'
  })
]);

function clone(row) {
  return row ? structuredClone(row) : null;
}

export function workflowEvidenceBases() {
  return WORKFLOW_EVIDENCE_BASES.map(clone);
}

export function workflowEvidenceBasisForHost(host) {
  return clone(WORKFLOW_EVIDENCE_BASES.find((row) => row.host === host));
}

export function workflowEvidenceBasisForPath(relativePath) {
  return clone(WORKFLOW_EVIDENCE_BASES.find((row) => row.path === relativePath));
}

export function workflowEvidenceBasisLockPaths() {
  return WORKFLOW_EVIDENCE_BASES.map((row) => row.path);
}
