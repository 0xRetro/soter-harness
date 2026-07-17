import { useMemo, useState } from 'react';
import type {
  Configuration,
  ConfigurationChangeInspection,
  ConfigurationChangeReferences,
  ConfigurationChangeResult
} from '../types';
import { StateMark } from './StateMark';

const requestReason = 'Review this exact private configuration replacement and its fingerprint-only scope.';
const unavailableMessage = 'The local configuration transaction adapter is unavailable.';

function fingerprint(value: string | null) {
  return value || 'unavailable';
}

function stageState(inspection: ConfigurationChangeInspection | null, stage: 'plan' | 'request' | 'confirmation' | 'consumption' | 'checkpoint') {
  if (!inspection) return stage === 'plan' ? 'current' : 'pending';
  if (stage === 'plan') return inspection.configuration.applicability;
  if (stage === 'request') return inspection.request?.state || 'current';
  if (stage === 'confirmation') return inspection.confirmation ? 'confirmed' : inspection.request ? 'current' : 'pending';
  if (stage === 'consumption') return inspection.consumption?.state || (inspection.confirmation ? 'current' : 'pending');
  return inspection.checkpoint?.state || (inspection.consumption ? 'current' : 'pending');
}

export function ConfigurationTransactionDesk({ configuration }: { configuration: Configuration }) {
  const [candidateText, setCandidateText] = useState('');
  const [inspection, setInspection] = useState<ConfigurationChangeInspection | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [confirmationAcknowledged, setConfirmationAcknowledged] = useState(false);
  const [applyAcknowledged, setApplyAcknowledged] = useState(false);
  const [references, setReferences] = useState<ConfigurationChangeReferences>({ planId: '' });

  const candidate = useMemo(() => {
    if (!candidateText.trim()) return { value: null, error: 'Paste one complete configuration/v1 document.' };
    try {
      const parsed = JSON.parse(candidateText) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { value: null, error: 'The candidate must be one JSON object.' };
      }
      const record = parsed as Record<string, unknown>;
      if (record.$contract !== 'soter://contracts/configuration/v1') {
        return { value: null, error: 'The candidate must declare configuration/v1.' };
      }
      if (record.name !== configuration.name) {
        return { value: null, error: `The candidate must replace ${configuration.name}.` };
      }
      return { value: record, error: null };
    } catch {
      return { value: null, error: 'The candidate is not valid JSON.' };
    }
  }, [candidateText, configuration.name]);

  const settle = async (label: string, operation: () => Promise<ConfigurationChangeResult>, clearCandidate = false) => {
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
        checkpointId: result.inspection.checkpoint?.id
      });
      if (clearCandidate) setCandidateText('');
    } catch {
      setError({ code: 'CONFIGURATION_ADAPTER_UNAVAILABLE', message: unavailableMessage });
    } finally {
      setBusy(null);
    }
  };

  const canRequest = inspection?.configuration.applicability === 'current'
    && inspection.request === null
    && inspection.resume.classification === 'safe';
  const canConfirm = inspection?.request?.state === 'awaiting'
    && inspection.confirmation === null
    && inspection.resume.classification === 'safe';
  const canStart = inspection?.confirmation !== null
    && inspection?.consumption === null
    && inspection?.checkpoint === null
    && inspection?.resume.classification === 'safe';
  const canExecute = inspection?.consumption?.state === 'started'
    && inspection?.checkpoint?.state === 'prepared';
  const canRecover = inspection?.checkpoint !== null
    && ['applying', 'verifying', 'rolling-back'].includes(inspection?.checkpoint?.state || '');

  return (
    <section className="configuration-transaction" aria-labelledby="configuration-transaction-title">
      <header className="configuration-transaction-header">
        <div>
          <span className="eyebrow">Configure intent · local transaction</span>
          <h2 id="configuration-transaction-title">Exact lock transfer</h2>
          <p>A complete private candidate crosses a separate Core ceremony. Preview controls above never become apply authority.</p>
        </div>
        <div className="configuration-boundary-stamps" aria-label="Configuration transaction boundaries">
          <span>Local files only</span>
          <span>No provider calls</span>
          <span>No proof promotion</span>
        </div>
      </header>

      <ol className="configuration-transaction-spine" aria-label="Configuration transaction lifecycle">
        {([
          ['01', 'Plan', 'Private candidate'],
          ['02', 'Request', 'Expiring window'],
          ['03', 'Confirm', 'Actor decision'],
          ['04', 'Consume', 'One-time start'],
          ['05', 'Checkpoint', 'Apply or recover']
        ] as const).map(([number, label, note], index) => {
          const stage = (['plan', 'request', 'confirmation', 'consumption', 'checkpoint'] as const)[index];
          const state = stageState(inspection, stage);
          return <li key={stage} className={`transaction-stage stage-${state}`}><span>{number}</span><strong>{label}</strong><small>{note}</small><code>{state}</code></li>;
        })}
      </ol>

      {!inspection ? (
        <div className="configuration-candidate-workbench">
          <div className="configuration-candidate-editor">
            <label htmlFor="configuration-candidate-document">
              <span>Complete private candidate</span>
              <small>Not derived from preview · released from renderer after Core seals the plan</small>
            </label>
            <textarea
              id="configuration-candidate-document"
              aria-label="Complete private candidate"
              aria-describedby="configuration-candidate-status"
              value={candidateText}
              onChange={(event) => setCandidateText(event.target.value)}
              placeholder={`Paste the complete configuration/v1 document for ${configuration.name}`}
              spellCheck={false}
            />
            <div id="configuration-candidate-status" className={`configuration-candidate-status ${candidate.error ? 'is-invalid' : 'is-ready'}`} role="status">
              <span aria-hidden="true">{candidate.error ? '◇' : '◆'}</span>
              <p>{candidate.error || 'Candidate envelope is locally parseable. Core still owns complete graph validation.'}</p>
            </div>
            <button
              className="configuration-primary-action"
              disabled={!candidate.value || busy !== null}
              onClick={() => settle('plan', () => window.soterStudio.prepareConfigurationChange({
                name: configuration.name,
                candidateConfiguration: candidate.value!
              }), true)}
            >{busy === 'plan' ? 'Sealing exact plan…' : 'Seal exact private plan'}</button>
          </div>
          <aside className="configuration-candidate-boundary">
            <span className="eyebrow">Candidate handling</span>
            <h3>Private input, minimized inspection</h3>
            <p>The candidate may contain settings, source inputs, authority locations, and secret references. Only identifiers and fingerprints return to this desk.</p>
            <dl>
              <div><dt>Desired file</dt><dd>unchanged during planning</dd></div>
              <div><dt>Active lock</dt><dd>private state only after apply</dd></div>
              <div><dt>Fixture locks</dt><dd>never mutated</dd></div>
              <div><dt>Host projection</dt><dd>validated, not generated</dd></div>
            </dl>
          </aside>
        </div>
      ) : (
        <>
          <div className="configuration-lock-transfer" aria-label="Exact lock fingerprint transfer">
            <div><span>Baseline lock</span><code>{inspection.configuration.baselineLockFingerprint}</code></div>
            <i aria-hidden="true">→</i>
            <div><span>Candidate lock</span><code>{inspection.configuration.candidateLockFingerprint}</code></div>
            <i aria-hidden="true">→</i>
            <div><span>Observed lock</span><code>{fingerprint(inspection.configuration.observedLockFingerprint)}</code></div>
            <StateMark state={inspection.configuration.applicability} compact />
          </div>

          <div className="configuration-transaction-ledger">
            <section className="configuration-scope-ledger" aria-label="Exact configuration scope">
              <header><div><span className="eyebrow">Fingerprint-only scope</span><h3>{inspection.scope.changes.length} changed subjects</h3></div><code>{inspection.scope.fingerprint}</code></header>
              <div className="configuration-scope-header"><span>Category / subject</span><span>State</span><span>Before</span><span>After</span></div>
              {inspection.scope.changes.map((change) => (
                <article key={change.id}>
                  <div><small>{change.category}</small><strong>{change.subject}</strong></div>
                  <StateMark state={change.state} compact />
                  <div><span>{change.beforeDescriptor || 'unavailable'}</span><code>{fingerprint(change.beforeFingerprint)}</code></div>
                  <div><span>{change.afterDescriptor || 'unavailable'}</span><code>{fingerprint(change.afterFingerprint)}</code></div>
                </article>
              ))}
            </section>

            <aside className="configuration-ceremony" aria-label="Configuration transaction actions">
              <header><span className="eyebrow">Ceremony control</span><h3>One boundary at a time</h3></header>
              {!inspection.request && (
                <div className="configuration-ceremony-step">
                  <span>02 · Request</span><p>Create a ten-minute confirmation window for this exact plan.</p>
                  <button disabled={!canRequest || busy !== null} onClick={() => settle('request', () => window.soterStudio.beginConfigurationChangeRequest({ planId: inspection.plan.id, reason: requestReason }))}>{busy === 'request' ? 'Requesting…' : 'Request confirmation'}</button>
                </div>
              )}
              {inspection.request && !inspection.confirmation && (
                <div className="configuration-ceremony-step">
                  <span>03 · Confirm</span><p>Confirmation records the local actor decision. It does not start or write.</p>
                  <label><input type="checkbox" checked={confirmationAcknowledged} onChange={(event) => setConfirmationAcknowledged(event.target.checked)} /> <span>I reviewed this exact fingerprint-only scope.</span></label>
                  <button disabled={!canConfirm || !confirmationAcknowledged || busy !== null} onClick={() => settle('confirm', () => window.soterStudio.confirmConfigurationChangeRequest({ requestId: inspection.request!.id, confirmed: true }))}>{busy === 'confirm' ? 'Confirming…' : 'Confirm exact request'}</button>
                </div>
              )}
              {inspection.confirmation && !inspection.checkpoint && (
                <div className="configuration-ceremony-step">
                  <span>04 · Consume</span><p>Reserve this confirmation once into one deterministic checkpoint. No desired file is changed yet.</p>
                  <button disabled={!canStart || busy !== null} onClick={() => settle('start', () => window.soterStudio.startConfigurationChange({ confirmationId: inspection.confirmation!.id }))}>{busy === 'start' ? 'Starting…' : 'Reserve one-time start'}</button>
                </div>
              )}
              {inspection.checkpoint && (
                <div className="configuration-ceremony-step">
                  <span>05 · Checkpoint</span><p>Execution replaces the desired configuration and its private active lock, then resolves and verifies both.</p>
                  <label><input type="checkbox" checked={applyAcknowledged} onChange={(event) => setApplyAcknowledged(event.target.checked)} /> <span>I understand this changes the local desired configuration.</span></label>
                  {canExecute && <button disabled={!applyAcknowledged || busy !== null} onClick={() => settle('execute', () => window.soterStudio.executeConfigurationChange({ checkpointId: inspection.checkpoint!.id, confirmed: true }))}>{busy === 'execute' ? 'Applying…' : 'Apply exact checkpoint'}</button>}
                  {canRecover && <button disabled={!applyAcknowledged || busy !== null} onClick={() => settle('recover', () => window.soterStudio.recoverConfigurationChange({ checkpointId: inspection.checkpoint!.id, confirmed: true }))}>{busy === 'recover' ? 'Recovering…' : 'Recover exact checkpoint'}</button>}
                  {!canExecute && !canRecover && <button disabled>Canonical checkpoint has no executable UI action</button>}
                </div>
              )}
            </aside>
          </div>

          <div className={`configuration-resume resume-${inspection.resume.classification}`}>
            <span className="configuration-resume-mark" aria-hidden="true">{inspection.resume.classification === 'safe' ? '↻' : '!'}</span>
            <div><span className="eyebrow">Core-derived guidance · not authority</span><strong>{inspection.resume.reasonCode}</strong><p>{inspection.resume.reason}</p><code>{inspection.resume.permittedNextAction}</code></div>
            <dl>
              <div><dt>Request</dt><dd>{inspection.request?.state || 'not requested'}</dd></div>
              <div><dt>Confirmation</dt><dd>{inspection.confirmation ? `recorded · ${inspection.confirmation.actor}` : 'not recorded'}</dd></div>
              <div><dt>Consumption</dt><dd>{inspection.consumption?.state || 'not consumed'}</dd></div>
              <div><dt>Checkpoint</dt><dd>{inspection.checkpoint ? `${inspection.checkpoint.state} · ${inspection.checkpoint.phase}` : 'not created'}</dd></div>
            </dl>
          </div>
        </>
      )}

      {error && <div className="configuration-transaction-error" role="alert"><code>{error.code}</code><p>{error.message}</p></div>}

      <details className="configuration-existing-transaction">
        <summary>Open an existing exact transaction</summary>
        <p>Paste known private-state identifiers after restart. Studio stores no alternate transaction index.</p>
        <div>
          <label>Plan ID<input value={references.planId} onChange={(event) => setReferences((value) => ({ ...value, planId: event.target.value }))} /></label>
          <label>Request ID<input value={references.requestId || ''} onChange={(event) => setReferences((value) => ({ ...value, requestId: event.target.value || undefined }))} /></label>
          <label>Confirmation ID<input value={references.confirmationId || ''} onChange={(event) => setReferences((value) => ({ ...value, confirmationId: event.target.value || undefined }))} /></label>
          <label>Checkpoint ID<input value={references.checkpointId || ''} onChange={(event) => setReferences((value) => ({ ...value, checkpointId: event.target.value || undefined }))} /></label>
        </div>
        <button disabled={!references.planId || busy !== null} onClick={() => settle('inspect', () => window.soterStudio.inspectConfigurationChange(references))}>{busy === 'inspect' ? 'Inspecting…' : 'Inspect exact references'}</button>
      </details>
    </section>
  );
}
