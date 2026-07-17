import type { Activity } from '../types';
import { DataField } from './DataField';
import { StateMark } from './StateMark';

const terminalStates = new Set(['completed', 'passed', 'failed', 'blocked']);

export function RunsView({ activity }: { activity: Activity | null }) {
  if (!activity) {
    return <div className="empty-view"><span className="empty-shape">◇</span><h1>No activity selected</h1><p>Choose a checked-in example or a private local checkpoint.</p></div>;
  }
  const completed = activity.timeline.filter((item) => item.state === 'completed' || item.state === 'passed').length;
  const active = activity.timeline.find((item) => !terminalStates.has(item.state));
  const stopped = activity.timeline.find((item) => item.state === 'failed' || item.state === 'blocked');

  return (
    <div className="runs-view">
      <header className={`view-intro run-intro source-${activity.source}`}>
        <div>
          <span className="eyebrow">{activity.source === 'fixture' ? 'Checked-in example' : 'Private local runtime'} · {activity.kind}</span>
          <h1>{activity.label}</h1>
          <code className="run-id">{activity.id}</code>
        </div>
        <div className="run-state"><StateMark state={activity.state} /><code>{activity.updatedAt || 'no timestamp'}</code></div>
      </header>

      <section className={`run-position source-${activity.source}`} aria-label="Activity position">
        <div className="position-source"><span className="eyebrow">Observation class</span><strong>{activity.source === 'fixture' ? 'Example evidence' : 'Private checkpoint'}</strong><p>{activity.source === 'fixture' ? 'Checked into the repository; not a live provider observation.' : 'Read from .soter/state; never treated as distributable evidence.'}</p></div>
        <DataField label="Completed prefix" value={`${completed} / ${activity.timeline.length}`} accent />
        <DataField label="Current / pending" value={active?.label || 'none'} />
        <DataField label="Stopped at" value={stopped?.label || 'not stopped'} />
      </section>

      {activity.kind === 'operation-plan' && (
        <section className={`operation-plan-boundary source-${activity.source}`} aria-label="Operation plan scope">
          <span className="eyebrow">Checkpoint scope</span>
          <strong>Capability progress, not workflow completion</strong>
          <p>Completed steps report only this plan's exact capability progress. They do not establish workflow outcomes, readiness, verification, health, proof, or authority.</p>
        </section>
      )}

      <section className="run-identity">
        <DataField label="Source" value={activity.source} accent />
        <DataField label="Kind" value={activity.kind} />
        <DataField label="Host" value={activity.host || 'not observed'} />
        <DataField label="Provider" value={activity.provider || 'mixed / none'} />
        <DataField label="Recovery" value={activity.recoveryId || 'not resumable'} />
        <DataField label="Exact lock" value={shortFingerprint(activity.configurationLockFingerprint)} />
        <DataField label="Graph" value={shortFingerprint(activity.graphFingerprint)} />
        <DataField label="Observed" value={activity.updatedAt || activity.createdAt || 'not observed'} />
      </section>

      <section className="timeline-panel">
        <div className="section-heading">
          <div><span className="eyebrow">Normalized timeline</span><h2>Evidence and recovery sequence</h2></div>
          <p>{activity.timeline.length} observed item{activity.timeline.length === 1 ? '' : 's'}; private inputs, outputs, and response payloads excluded.</p>
        </div>
        <div className="timeline-key" aria-label="Timeline state summary">
          {timelineStateCounts(activity).map(([state, count]) => <span key={state}><i className={`key-${state}`} />{state}<code>{count}</code></span>)}
        </div>
        <ol className="timeline">
          {activity.timeline.map((item) => (
            <li className={`timeline-item timeline-${item.state}`} key={item.id}>
              <div className="timeline-rail"><span>{String(item.sequence).padStart(2, '0')}</span><i /></div>
              <div className="timeline-content">
                <div className="timeline-heading"><div><span className="eyebrow">{item.kind}</span><code>{item.id}</code></div><StateMark state={item.state} compact /></div>
                <h3>{item.label}</h3>
                <p>{item.details}</p>
                <div className="timeline-meta">
                  {item.capability && <code>cap · {item.capability}</code>}
                  {item.provider && <code>provider · {item.provider}</code>}
                  {item.authority && <code>authority · {item.authority}</code>}
                  {item.at && <code>at · {item.at}</code>}
                </div>
                {(item.inputFingerprint || item.outputFingerprint) && (
                  <div className="fingerprint-pair">
                    <DataField label="Input fingerprint" value={shortFingerprint(item.inputFingerprint)} />
                    <DataField label="Output fingerprint" value={shortFingerprint(item.outputFingerprint)} />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="evidence-section">
        <div className="section-heading"><div><span className="eyebrow">Evidence ledger</span><h2>Claims, provenance, and limits</h2></div><p>Evidence establishes only its stated claim at its recorded level.</p></div>
        {activity.evidence.length ? (
          <div className="evidence-ledger">
            <div className="evidence-header" aria-hidden="true"><span>Evidence</span><span>Claim</span><span>Level / observed</span><span>Result</span></div>
            {activity.evidence.map((evidence) => (
              <details className="evidence-row" key={evidence.id}>
                <summary><code>{evidence.id}</code><strong>{evidence.claim}</strong><span className="mono">{evidence.level} · {evidence.createdAt}</span><StateMark state={evidence.result} compact /></summary>
                <div className="evidence-limitations"><span className="eyebrow">Limitations</span><ul>{evidence.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></div>
              </details>
            ))}
          </div>
        ) : <p className="empty-evidence">No evidence document is attached to this activity.</p>}
      </section>
    </div>
  );
}

function timelineStateCounts(activity: Activity) {
  const counts = new Map<string, number>();
  activity.timeline.forEach((item) => counts.set(item.state, (counts.get(item.state) || 0) + 1));
  return [...counts.entries()];
}

function shortFingerprint(value: string | null) {
  return value ? value.slice(0, 20) + '…' : 'not observed';
}
