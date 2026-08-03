import { useState } from 'react';
import type { PackInstallInspection, PackInstallReferences, PackInstallResult } from '../types';
import { StateMark } from './StateMark';

const adapterError = {
  code: 'PACK_INSTALL_ADAPTER_UNAVAILABLE',
  message: 'The exact local pack install adapter is unavailable.'
};

function shortFingerprint(value: string | null) {
  return value ? `${value.slice(0, 18)}…${value.slice(-8)}` : 'unavailable';
}

function stageState(inspection: PackInstallInspection | null, stage: 'plan' | 'request' | 'confirmation' | 'consumption' | 'checkpoint') {
  if (!inspection) return stage === 'plan' ? 'available' : 'pending';
  if (stage === 'plan') return 'current';
  if (stage === 'request') return inspection.request?.state || 'pending';
  if (stage === 'confirmation') return inspection.confirmation ? 'confirmed' : 'pending';
  if (stage === 'consumption') return inspection.consumption?.state || 'pending';
  return inspection.checkpoint?.state || 'pending';
}

export function PackInstallDesk() {
  const [inspection, setInspection] = useState<PackInstallInspection | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [confirmAcknowledged, setConfirmAcknowledged] = useState(false);
  const [effectAcknowledged, setEffectAcknowledged] = useState(false);
  const [references, setReferences] = useState<PackInstallReferences>({ planId: '' });

  const settle = async (label: string, operation: () => Promise<PackInstallResult>) => {
    setBusy(label);
    setError(null);
    try {
      const result = await operation();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setInspection(result.inspection);
      setReferences({
        planId: result.inspection.plan?.id,
        requestId: result.inspection.request?.id,
        confirmationId: result.inspection.confirmation?.id,
        consumptionId: result.inspection.consumption?.id,
        checkpointId: result.inspection.checkpoint?.id
      });
    } catch {
      setError(adapterError);
    } finally {
      setBusy(null);
    }
  };

  const next = inspection?.resume.permittedNextAction;
  const canRequest = next === 'create-request' || next === 'renew-request';
  const canConfirm = next === 'confirm-request' && inspection?.request?.state === 'current';
  const canStart = next === 'start-install' && inspection?.confirmation !== null;
  const canExecute = next === 'execute-checkpoint' && inspection?.checkpoint?.state === 'prepared';
  const canRecover = next === 'recover-checkpoint' && inspection?.checkpoint !== null;
  const reset = () => {
    setInspection(null);
    setError(null);
    setConfirmAcknowledged(false);
    setEffectAcknowledged(false);
    setReferences({ planId: '' });
  };

  return (
    <section className="pack-install-desk" aria-labelledby="pack-install-title">
      <header className="pack-install-header">
        <div>
          <span className="eyebrow">Local materialization · separate exact transaction</span>
          <h2 id="pack-install-title">Manifest-last pack install</h2>
          <p>Select an existing private target and exact local capsules through operating-system pickers. Core owns dependency resolution, collision checks, single-use start, atomic effects, verification, rollback, and recovery.</p>
        </div>
        <div className="pack-install-boundaries" aria-label="Pack install boundaries">
          <span>Local capsules only</span>
          <span>No package manager</span>
          <span>No network</span>
          <span>No configuration</span>
        </div>
      </header>

      <ol className="pack-install-spine" aria-label="Pack install lifecycle">
        {([
          ['01', 'Plan', 'Exact local bytes'],
          ['02', 'Request', 'Expiring review'],
          ['03', 'Confirm', 'Exact decision'],
          ['04', 'Start', 'Single use'],
          ['05', 'Checkpoint', 'Apply or recover']
        ] as const).map(([number, label, note], index) => {
          const stage = (['plan', 'request', 'confirmation', 'consumption', 'checkpoint'] as const)[index];
          const state = stageState(inspection, stage);
          return <li key={stage} className={`pack-install-stage stage-${state}`}><span>{number}</span><strong>{label}</strong><small>{note}</small><code>{state}</code></li>;
        })}
      </ol>

      {!inspection?.plan ? (
        <div className="pack-install-entry">
          <div>
            <span className="eyebrow">Private selection · sanitized result</span>
            <h3>Prepare one exact local install plan</h3>
            <p>Target and capsule paths remain in Electron main and private Core state. The dossier receives only sealed identities, counts, constraints, effects, and fingerprints.</p>
            <button type="button" disabled={busy !== null} onClick={() => settle('plan', () => window.soterStudio.preparePackInstall())}>
              {busy === 'plan' ? 'Preparing exact plan…' : 'Select target and local releases'}
            </button>
          </div>
          <dl>
            <div><dt>Fetch</dt><dd>prohibited</dd></div>
            <div><dt>Downgrade</dt><dd>blocked</dd></div>
            <div><dt>Unmanaged collision</dt><dd>blocked</dd></div>
            <div><dt>Uninstall</dt><dd>prohibited</dd></div>
          </dl>
        </div>
      ) : (
        <>
          <section className="pack-install-identity" aria-label="Pack install identity">
            <div><span>Target identity</span><code>{inspection.plan.targetFingerprint}</code></div>
            <div><span>Scope</span><code>{inspection.plan.scopeFingerprint}</code></div>
            <div><span>Plan window</span><time>{inspection.plan.createdAt}</time><time>{inspection.plan.validUntil}</time></div>
            <StateMark state={inspection.resume.classification} compact />
          </section>

          <div className="pack-install-workbench">
            <section className="pack-install-scope" aria-label="Exact sanitized install plan">
              <header><div><span className="eyebrow">Exact release set</span><h3>{inspection.plan.releases.length} release{inspection.plan.releases.length === 1 ? '' : 's'} · {inspection.plan.effects.length} file effect{inspection.plan.effects.length === 1 ? '' : 's'}</h3></div><code>{inspection.plan.dependencyCheck.reasonCode}</code></header>
              <div className="pack-install-releases">
                {inspection.plan.releases.map((release) => (
                  <article key={release.pack}>
                    <span>{release.layer}</span><strong>{release.pack}</strong><small>v{release.version} · {release.releaseStage}</small>
                    <code title={release.capsuleDigest}>{shortFingerprint(release.capsuleDigest)}</code>
                    <em>{release.trust.state}</em>
                  </article>
                ))}
              </div>

              {inspection.plan.dependencyCheck.rows.length > 0 && (
                <div className="pack-install-dependencies" role="table" aria-label="Pack install dependencies">
                  {inspection.plan.dependencyCheck.rows.map((row) => (
                    <div role="row" key={`${row.consumer}:${row.dependency}`}>
                      <strong role="cell">{row.consumer}</strong><span role="cell">→ {row.dependency} {row.requiredRange}</span><StateMark state={row.state} compact />
                      <code role="cell">{row.reasonCode}</code>
                    </div>
                  ))}
                </div>
              )}

              <div className="pack-install-effects" role="table" aria-label="Fingerprint-only install effects">
                <div role="row" className="pack-install-effect-head"><span role="columnheader">Step</span><span role="columnheader">Pack / role</span><span role="columnheader">Action</span><span role="columnheader">Prior</span><span role="columnheader">Candidate</span></div>
                {inspection.plan.effects.map((effect) => {
                  const completed = inspection.checkpoint?.completedPrefix.includes(effect.id);
                  const current = inspection.checkpoint?.currentStep === effect.id;
                  return (
                    <div role="row" key={effect.id} className={current ? 'is-current' : completed ? 'is-complete' : ''}>
                      <code role="cell">{String(effect.sequence + 1).padStart(2, '0')}</code>
                      <span role="cell"><strong>{effect.pack}</strong><small>{effect.role}</small></span>
                      <StateMark state={effect.action} compact />
                      <code role="cell" title={effect.beforeFingerprint || undefined}>{shortFingerprint(effect.beforeFingerprint)}</code>
                      <code role="cell" title={effect.afterFingerprint || undefined}>{shortFingerprint(effect.afterFingerprint)}</code>
                    </div>
                  );
                })}
              </div>
              <footer><strong>Paths and bytes withheld</strong><span>Every private path and exact byte snapshot remains sealed by the scope and effect fingerprints.</span></footer>
            </section>

            <aside className="pack-install-ceremony" aria-label="Pack install transaction actions">
              <header><span className="eyebrow">Explicit authority chain</span><h3>Review, start, execute</h3></header>
              {canRequest && <div><span>02 · Request</span><p>Open a five-minute confirmation window inside the exact plan expiry.</p><button disabled={busy !== null} onClick={() => settle('request', () => window.soterStudio.beginPackInstallRequest({ planId: inspection.plan!.id }))}>{busy === 'request' ? 'Requesting…' : inspection.request ? 'Request fresh confirmation' : 'Request confirmation'}</button></div>}
              {inspection.request && !inspection.confirmation && <div><span>03 · Confirm</span><p>Confirmation binds this exact release set, target fingerprint, dependency result, and file-effect scope.</p><label><input type="checkbox" checked={confirmAcknowledged} onChange={(event) => setConfirmAcknowledged(event.target.checked)} /><span>I reviewed this exact fingerprint-bound install plan.</span></label><button disabled={!canConfirm || !confirmAcknowledged || busy !== null} onClick={() => settle('confirm', () => window.soterStudio.confirmPackInstallRequest({ requestId: inspection.request!.id, confirmed: true }))}>{busy === 'confirm' ? 'Confirming…' : 'Confirm exact install request'}</button></div>}
              {inspection.confirmation && !inspection.checkpoint && <div><span>04 · Single-use start</span><p>Create one durable checkpoint. No managed file changes occur during this step.</p><button disabled={!canStart || busy !== null} onClick={() => settle('start', () => window.soterStudio.startPackInstall({ confirmationId: inspection.confirmation!.id }))}>{busy === 'start' ? 'Starting…' : 'Start this exact install plan'}</button></div>}
              {inspection.checkpoint && <div><span>05 · Durable checkpoint</span><p>Only Core may apply or recover this exact checkpoint. Display guidance is not execution authority.</p><label><input type="checkbox" checked={effectAcknowledged} onChange={(event) => setEffectAcknowledged(event.target.checked)} /><span>I understand this changes only the selected target's managed pack files.</span></label>{canExecute && <button disabled={!effectAcknowledged || busy !== null} onClick={() => settle('execute', () => window.soterStudio.executePackInstall({ checkpointId: inspection.checkpoint!.id, confirmed: true }))}>{busy === 'execute' ? 'Installing…' : 'Install exact checkpoint'}</button>}{canRecover && <button disabled={!effectAcknowledged || busy !== null} onClick={() => settle('recover', () => window.soterStudio.recoverPackInstall({ checkpointId: inspection.checkpoint!.id, confirmed: true }))}>{busy === 'recover' ? 'Recovering…' : 'Recover exact checkpoint'}</button>}{!canExecute && !canRecover && <button disabled>No executable checkpoint action</button>}</div>}
            </aside>
          </div>

          {inspection.checkpoint && (
            <section className="pack-install-progress" aria-label="Pack install checkpoint progress">
              <div><span>Completed prefix</span><strong>{inspection.checkpoint.completedPrefix.length}</strong><code>{inspection.checkpoint.completedPrefix.join(' · ') || 'none'}</code></div>
              <div><span>Exact current step</span><strong>{inspection.checkpoint.currentStep || 'none'}</strong><code>{inspection.checkpoint.reasonCode}</code></div>
              <div><span>Remaining</span><strong>{inspection.checkpoint.pendingSteps.length}</strong><code>{inspection.checkpoint.pendingSteps.join(' · ') || 'none'}</code></div>
              <div><span>Manifest last</span><StateMark state={inspection.checkpoint.manifestState} compact /><code>{inspection.checkpoint.blocker || 'no blocker'}</code></div>
            </section>
          )}

          <section className={`pack-install-resume resume-${inspection.resume.classification}`} aria-label="Pack install resume guidance">
            <div><span className="eyebrow">Core-derived guidance · not authority</span><strong>{inspection.resume.reasonCode}</strong><p>{inspection.resume.reason}</p><code>{inspection.resume.permittedNextAction}</code></div>
            <StateMark state={inspection.resume.classification} />
          </section>

          <section className="pack-install-claims" aria-label="Pack install claim boundary">
            <header><span className="eyebrow">Truth stopline</span><h3>Materialized locally does not mean configured or working.</h3></header>
            <div>{([
              ['Local release bytes', inspection.claims.localReleaseBytes],
              ['Dependency constraints', inspection.claims.dependencyConstraints],
              ['Local materialization', inspection.claims.localMaterialization],
              ['Installed registry', inspection.claims.installedRegistry],
              ['Configured', inspection.claims.configured],
              ['Host realization', inspection.claims.hostRealization],
              ['Ready', inspection.claims.ready],
              ['Verified', inspection.claims.verified],
              ['Healthy', inspection.claims.healthy]
            ] as const).map(([label, state]) => <article key={label}><span>{label}</span><StateMark state={state} compact /></article>)}</div>
            <p>No fetch, uninstall, configuration mutation, host realization, package manager, network, publication, or trust promotion is authorized by this inspection.</p>
          </section>

          {inspection.checkpoint && ['completed', 'rolled-back', 'failed'].includes(inspection.checkpoint.state) && <button className="pack-install-reset" onClick={reset}>Close exact install transaction</button>}
        </>
      )}

      {error && <div className="pack-install-error" role="alert"><code>{error.code}</code><p>{error.message}</p></div>}

      <details className="pack-install-existing">
        <summary>Inspect an existing exact install</summary>
        <p>After restart, enter known identifiers and choose the private target through the operating-system picker. Studio never stores or displays its path.</p>
        <div>
          <label>Plan ID<input value={references.planId || ''} onChange={(event) => setReferences((value) => ({ ...value, planId: event.target.value || undefined }))} /></label>
          <label>Request ID<input value={references.requestId || ''} onChange={(event) => setReferences((value) => ({ ...value, requestId: event.target.value || undefined }))} /></label>
          <label>Confirmation ID<input value={references.confirmationId || ''} onChange={(event) => setReferences((value) => ({ ...value, confirmationId: event.target.value || undefined }))} /></label>
          <label>Consumption ID<input value={references.consumptionId || ''} onChange={(event) => setReferences((value) => ({ ...value, consumptionId: event.target.value || undefined }))} /></label>
          <label>Checkpoint ID<input value={references.checkpointId || ''} onChange={(event) => setReferences((value) => ({ ...value, checkpointId: event.target.value || undefined }))} /></label>
        </div>
        <button disabled={!Object.values(references).some(Boolean) || busy !== null} onClick={() => settle('inspect', () => window.soterStudio.inspectPackInstall(references))}>{busy === 'inspect' ? 'Inspecting…' : 'Inspect exact identifiers'}</button>
      </details>
    </section>
  );
}
