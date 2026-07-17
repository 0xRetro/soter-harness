import { useMemo, useState } from 'react';
import type {
  Configuration,
  HostRealizationInspection,
  HostRealizationReferences,
  HostRealizationResult
} from '../types';
import { StateMark } from './StateMark';

const unavailableMessage = 'The local host realization adapter is unavailable.';
const claims = [
  ['localProjection', 'Local projection'],
  ['hostLaunch', 'Host launch'],
  ['toolDiscovery', 'Tool discovery'],
  ['authentication', 'Authentication'],
  ['providerReachability', 'Provider reachability'],
  ['connectedBehavior', 'Connected behavior'],
  ['health', 'Health']
] as const;

function fingerprint(value: string | null) {
  return value || 'unavailable';
}

function stageState(inspection: HostRealizationInspection | null, stage: 'plan' | 'request' | 'confirmation' | 'consumption' | 'checkpoint') {
  if (!inspection) return stage === 'plan' ? 'available' : 'pending';
  if (stage === 'plan') return inspection.plan.applicability;
  if (stage === 'request') return inspection.request?.state || 'pending';
  if (stage === 'confirmation') return inspection.confirmation ? 'confirmed' : inspection.request ? 'current' : 'pending';
  if (stage === 'consumption') return inspection.consumption?.state || (inspection.confirmation ? 'current' : 'pending');
  return inspection.checkpoint?.state || (inspection.consumption ? 'current' : 'pending');
}

export function HostRealizationDesk({ configuration }: { configuration: Configuration }) {
  const [inspection, setInspection] = useState<HostRealizationInspection | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [confirmationAcknowledged, setConfirmationAcknowledged] = useState(false);
  const [effectAcknowledged, setEffectAcknowledged] = useState(false);
  const [references, setReferences] = useState<HostRealizationReferences>({ planId: '' });

  const checkpointOutputs = useMemo(
    () => new Map(inspection?.checkpoint?.outputs.map((output) => [output.id, output.state]) || []),
    [inspection]
  );

  const settle = async (label: string, operation: () => Promise<HostRealizationResult>) => {
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
        planId: result.inspection.plan.id,
        requestId: result.inspection.request?.id,
        confirmationId: result.inspection.confirmation?.id,
        consumptionId: result.inspection.consumption?.id,
        checkpointId: result.inspection.checkpoint?.id
      });
    } catch {
      setError({ code: 'HOST_REALIZATION_ADAPTER_UNAVAILABLE', message: unavailableMessage });
    } finally {
      setBusy(null);
    }
  };

  const canRequest = inspection?.plan.applicability === 'current'
    && inspection.request === null
    && inspection.resume.classification === 'safe';
  const canConfirm = inspection?.request?.state === 'current'
    && inspection.confirmation === null
    && inspection.resume.classification === 'safe';
  const canStart = inspection?.confirmation !== null
    && inspection?.consumption === null
    && inspection?.checkpoint === null
    && inspection?.resume.classification === 'safe';
  const canExecute = inspection?.plan.applicability === 'current'
    && inspection?.consumption?.state === 'started'
    && inspection?.checkpoint?.state === 'prepared';
  const canRecover = inspection?.plan.applicability === 'current'
    && inspection?.checkpoint !== null
    && ['applying', 'verifying', 'rolling-back'].includes(inspection?.checkpoint?.state || '');
  const canRenewRequest = inspection?.plan.applicability === 'current'
    && inspection?.request?.state === 'expired'
    && inspection?.confirmation === null
    && inspection?.consumption === null
    && inspection?.checkpoint === null;

  const resetDesk = () => {
    setInspection(null);
    setError(null);
    setConfirmationAcknowledged(false);
    setEffectAcknowledged(false);
    setReferences({ planId: '' });
  };

  return (
    <section className="host-realization" aria-labelledby="host-realization-title">
      <header className="host-realization-header">
        <div>
          <span className="eyebrow">Realize host · separate local transaction</span>
          <h2 id="host-realization-title">Manifest-last projection</h2>
          <p>Translate one exact active lock into managed host files. Configuration apply, host launch, and provider behavior remain separate boundaries.</p>
        </div>
        <div className="host-boundary-stamps" aria-label="Host realization boundaries">
          <span>Whole files</span>
          <span>Manifest last</span>
          <span>No provider calls</span>
        </div>
      </header>

      <ol className="host-realization-spine" aria-label="Host realization lifecycle">
        {([
          ['01', 'Plan', 'Target + outputs'],
          ['02', 'Request', 'Expiring window'],
          ['03', 'Confirm', 'Actor decision'],
          ['04', 'Consume', 'One-time start'],
          ['05', 'Checkpoint', 'Apply or recover']
        ] as const).map(([number, label, note], index) => {
          const stage = (['plan', 'request', 'confirmation', 'consumption', 'checkpoint'] as const)[index];
          const state = stageState(inspection, stage);
          return <li key={stage} className={`host-stage stage-${state}`}><span>{number}</span><strong>{label}</strong><small>{note}</small><code>{state}</code></li>;
        })}
      </ol>

      {!inspection ? (
        <div className="host-realization-entry">
          <div>
            <span className="eyebrow">Current launch root · identity withheld</span>
            <h3>Prepare a fingerprint-only output plan</h3>
            <p>Core requires the private active lock for <code>{configuration.name}</code>, checks unmanaged and cross-host collisions, and returns only relative paths and fingerprints.</p>
            <button
              className="host-primary-action"
              disabled={busy !== null}
              onClick={() => settle('plan', () => window.soterStudio.prepareHostRealization({ configurationName: configuration.name }))}
            >{busy === 'plan' ? 'Preparing exact plan…' : 'Prepare host projection'}</button>
          </div>
          <aside>
            <span className="eyebrow">Ownership boundary</span>
            <dl>
              <div><dt>Consumer root</dt><dd>private fingerprint only</dd></div>
              <div><dt>File contents</dt><dd>never projected here</dd></div>
              <div><dt>Existing outputs</dt><dd>must match exact manifest</dd></div>
              <div><dt>Host launch</dt><dd>not performed</dd></div>
            </dl>
          </aside>
        </div>
      ) : (
        <>
          <section className="host-identity-strip" aria-label="Host realization identity">
            <div><span>Target fingerprint</span><code>{inspection.target.fingerprint}</code></div>
            <div><span>Host / adapter</span><strong>{inspection.host.id}</strong><code>{inspection.host.adapter}</code></div>
            <div><span>Definition</span><strong>{inspection.host.definition.id} · v{inspection.host.definition.version}</strong><code>{inspection.host.definition.fingerprint}</code></div>
            <div><span>Generator</span><strong>{inspection.host.generator.id} · v{inspection.host.generator.version}</strong><code>{inspection.host.generator.fingerprint}</code></div>
            <StateMark state={inspection.plan.applicability} compact />
          </section>

          <div className="host-realization-workbench">
            <section className="host-output-scope" aria-label="Exact host output scope">
              <header>
                <div><span className="eyebrow">Ordered whole-file scope</span><h3>{inspection.scope.outputs.length} managed outputs</h3></div>
                <div><span>Plan window</span><code>{inspection.plan.createdAt}</code><code>{inspection.plan.validUntil}</code></div>
              </header>
              <div className="host-output-header"><span>Output</span><span>Effect</span><span>Prior</span><span>Candidate</span><span>State</span></div>
              <ol className="host-output-ledger">
                {inspection.scope.outputs.map((output) => {
                  const state = checkpointOutputs.get(output.id) || 'pending';
                  return (
                    <li key={output.id} className={inspection.checkpoint?.currentOutputId === output.id ? 'is-current' : ''}>
                      <span className="host-output-sequence">{String(output.sequence + 1).padStart(2, '0')}</span>
                      <div><strong>{output.path}</strong><small>{output.role} · {output.mode || 'mode unavailable'}</small></div>
                      <StateMark state={output.action} compact />
                      <code>{fingerprint(output.beforeFingerprint)}</code>
                      <code>{fingerprint(output.afterFingerprint)}</code>
                      <StateMark state={state} compact />
                    </li>
                  );
                })}
                <li className="host-manifest-last">
                  <span aria-hidden="true">M</span>
                  <div><strong>Managed ownership manifest</strong><small>Committed only after every exact output effect</small></div>
                  <StateMark state={inspection.checkpoint?.phase === 'manifest' ? 'current' : inspection.checkpoint?.state === 'completed' ? 'verified' : 'pending'} compact />
                </li>
                <li className="host-verification-last">
                  <span aria-hidden="true">V</span>
                  <div><strong>Exact bytes + modes verification</strong><small>Only this may promote local projection</small></div>
                  <StateMark state={inspection.claims.localProjection} compact />
                </li>
              </ol>
              <footer><span>Scope fingerprint</span><code>{inspection.scope.fingerprint}</code></footer>
            </section>

            <aside className="host-ceremony" aria-label="Host realization actions">
              <header><span className="eyebrow">Ceremony control</span><h3>Exact authority chain</h3></header>
              {!inspection.request && (
                <div className="host-ceremony-step">
                  <span>02 · Request</span><p>Open a shorter confirmation window inside this plan's separate expiry.</p>
                  <button disabled={!canRequest || busy !== null} onClick={() => settle('request', () => window.soterStudio.beginHostRealizationRequest({ planId: inspection.plan.id }))}>{busy === 'request' ? 'Requesting…' : 'Request confirmation'}</button>
                </div>
              )}
              {inspection.request?.state === 'expired' && !inspection.confirmation && (
                <div className="host-ceremony-step">
                  <span>02 · Request expired</span><p>The plan remains current, but the actor needs a fresh bounded confirmation window.</p>
                  <button disabled={!canRenewRequest || busy !== null} onClick={() => settle('request', () => window.soterStudio.beginHostRealizationRequest({ planId: inspection.plan.id }))}>{busy === 'request' ? 'Requesting…' : 'Request fresh confirmation'}</button>
                </div>
              )}
              {inspection.request && inspection.request.state !== 'expired' && !inspection.confirmation && (
                <div className="host-ceremony-step">
                  <span>03 · Confirm</span><p>Record a local actor decision only. No output or manifest changes yet.</p>
                  <label><input type="checkbox" checked={confirmationAcknowledged} onChange={(event) => setConfirmationAcknowledged(event.target.checked)} /> <span>I reviewed every relative path, effect, mode, and fingerprint.</span></label>
                  <button disabled={!canConfirm || !confirmationAcknowledged || busy !== null} onClick={() => settle('confirm', () => window.soterStudio.confirmHostRealizationRequest({ requestId: inspection.request!.id, confirmed: true }))}>{busy === 'confirm' ? 'Confirming…' : 'Confirm exact request'}</button>
                </div>
              )}
              {inspection.confirmation && !inspection.checkpoint && (
                <div className="host-ceremony-step">
                  <span>04 · Consume</span><p>Consume this confirmation once into one durable checkpoint. Host outputs stay unchanged.</p>
                  <button disabled={!canStart || busy !== null} onClick={() => settle('start', () => window.soterStudio.startHostRealization({ confirmationId: inspection.confirmation!.id }))}>{busy === 'start' ? 'Reserving…' : 'Reserve one-time start'}</button>
                </div>
              )}
              {inspection.checkpoint && (
                <div className="host-ceremony-step">
                  <span>05 · Checkpoint</span><p>Core owns atomic output effects, manifest-last commit, exact verification, and rollback.</p>
                  <label><input type="checkbox" checked={effectAcknowledged} onChange={(event) => setEffectAcknowledged(event.target.checked)} /> <span>I understand this changes managed host files in the current launch root.</span></label>
                  {canExecute && <button disabled={!effectAcknowledged || busy !== null} onClick={() => settle('execute', () => window.soterStudio.executeHostRealization({ checkpointId: inspection.checkpoint!.id, confirmed: true }))}>{busy === 'execute' ? 'Realizing…' : 'Realize exact checkpoint'}</button>}
                  {canRecover && <button disabled={!effectAcknowledged || busy !== null} onClick={() => settle('recover', () => window.soterStudio.recoverHostRealization({ checkpointId: inspection.checkpoint!.id, confirmed: true }))}>{busy === 'recover' ? 'Recovering…' : 'Recover exact checkpoint'}</button>}
                  {!canExecute && !canRecover && <button disabled>Canonical checkpoint has no executable UI action</button>}
                </div>
              )}
            </aside>
          </div>

          {inspection.checkpoint?.failure && (
            <div className="host-checkpoint-failure" role="alert">
              <code>{inspection.checkpoint.failure.reasonCode}</code>
              <p>{inspection.checkpoint.failure.summary}</p>
            </div>
          )}

          <section className={`host-resume resume-${inspection.resume.classification}`}>
            <div><span className="eyebrow">Core-derived guidance · not authority</span><strong>{inspection.resume.reasonCode}</strong><p>{inspection.resume.reason}</p><code>{inspection.resume.permittedNextAction}</code></div>
            <dl>
              <div><dt>Request</dt><dd>{inspection.request?.state || 'not requested'}</dd></div>
              <div><dt>Confirmation</dt><dd>{inspection.confirmation ? `recorded · ${inspection.confirmation.actor}` : 'not recorded'}</dd></div>
              <div><dt>Consumption</dt><dd>{inspection.consumption?.state || 'not consumed'}</dd></div>
              <div><dt>Checkpoint</dt><dd>{inspection.checkpoint ? `${inspection.checkpoint.state} · ${inspection.checkpoint.phase}` : 'not created'}</dd></div>
            </dl>
          </section>

          <section className="host-claim-boundary" aria-label="Host realization claim boundary">
            <header><span className="eyebrow">Claim boundary</span><h3>Local projection stops here</h3><p>Completion proves deterministic local bytes and modes—not a working host or provider.</p></header>
            <div>
              {claims.map(([key, label]) => <article className="host-realization-claim" key={key}><span>{label}</span><StateMark state={inspection.claims[key]} compact /></article>)}
            </div>
          </section>
          {['stale', 'expired', 'applied'].includes(inspection.plan.applicability) && (
            <div className="host-reset-boundary">
              <p>{inspection.plan.applicability === 'applied' ? 'This exact realization is complete.' : 'This plan is no longer usable. Clearing the desk grants no authority.'}</p>
              <button onClick={resetDesk}>{inspection.plan.applicability === 'applied' ? 'Close realization' : 'Clear and prepare a new plan'}</button>
            </div>
          )}
        </>
      )}

      {error && <div className="host-realization-error" role="alert"><code>{error.code}</code><p>{error.message}</p></div>}

      <details className="host-existing-transaction">
        <summary>Open an existing exact realization</summary>
        <p>Enter known private-state identifiers after restart. Studio stores no root path, manifest, file content, or alternate transaction index.</p>
        <div>
          <label>Plan ID<input value={references.planId} onChange={(event) => setReferences((value) => ({ ...value, planId: event.target.value }))} /></label>
          <label>Request ID<input value={references.requestId || ''} onChange={(event) => setReferences((value) => ({ ...value, requestId: event.target.value || undefined }))} /></label>
          <label>Confirmation ID<input value={references.confirmationId || ''} onChange={(event) => setReferences((value) => ({ ...value, confirmationId: event.target.value || undefined }))} /></label>
          <label>Consumption ID<input value={references.consumptionId || ''} onChange={(event) => setReferences((value) => ({ ...value, consumptionId: event.target.value || undefined }))} /></label>
          <label>Checkpoint ID<input value={references.checkpointId || ''} onChange={(event) => setReferences((value) => ({ ...value, checkpointId: event.target.value || undefined }))} /></label>
        </div>
        <button disabled={!references.planId || busy !== null} onClick={() => settle('inspect', () => window.soterStudio.inspectHostRealization(references))}>{busy === 'inspect' ? 'Inspecting…' : 'Inspect exact references'}</button>
      </details>
    </section>
  );
}
