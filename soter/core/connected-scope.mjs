import { fingerprintJson } from './lib/canonical-json.mjs';

export function changeSetScopeFingerprint(changeSet) {
  return fingerprintJson({
    id: changeSet.id,
    runId: changeSet.runId,
    configurationLockFingerprint: changeSet.configurationLockFingerprint,
    basis: changeSet.basis || null,
    operations: changeSet.operations.map((operation) => ({
      id: operation.id,
      capability: operation.capability,
      authority: operation.authority,
      inputFingerprint: operation.inputFingerprint
    }))
  });
}
