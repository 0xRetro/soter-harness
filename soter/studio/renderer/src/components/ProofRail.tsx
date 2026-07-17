import type { InspectionSnapshot } from '../types';
import { StateMark } from './StateMark';

const dimensions = [
  ['valid', 'VD', 'Structure', 'Are canonical contracts and the selected graph internally sound?', 'Repair the reported contract or exact-lock diagnostic.'],
  ['ready', 'RD', 'Preconditions', 'Can the selected configuration satisfy execution requirements now?', 'Run an exact-lock connected readiness probe.'],
  ['verified', 'VF', 'Behavior', 'Does applicable evidence establish the promised behavior?', 'Execute applicable scenarios and record verifier evidence.'],
  ['healthy', 'HL', 'Runtime', 'Are connected dependencies healthy at the observed time?', 'Observe connected provider health against this exact lock.']
] as const;

export function ProofRail({ snapshot }: { snapshot: InspectionSnapshot }) {
  const scenarioExecutions = snapshot.workflows.flatMap((workflow) => workflow.scenarios)
    .filter((scenario) => scenario.execution);
  return (
    <aside className="proof-rail" aria-label="Workspace proof">
      <div className="rail-heading">
        <span className="eyebrow">Persistent proof</span>
        <span className="mono subtle">{snapshot.proof.source}</span>
      </div>
      <div className="proof-stack">
        {dimensions.map(([dimension, code, label, question, remediation]) => {
          const state = snapshot.proof.states[dimension];
          const checks = snapshot.proof.checks.filter((check) => {
            if (dimension === 'valid') return check.id.includes('graph') || check.id.includes('lock');
            if (dimension === 'ready') return check.id.includes('credential') || check.id.includes('reachable');
            if (dimension === 'verified') return check.id.includes('evidence');
            return check.id.includes('health');
          });
          return (
            <details className={`proof-card proof-${dimension}`} key={dimension} open={dimension === 'valid'}>
              <summary>
                <span className="proof-index" aria-label={`${dimension} dimension`}>{code}</span>
                <span className="proof-title">
                  <strong>{dimension[0].toUpperCase() + dimension.slice(1)}</strong>
                  <small>{label}</small>
                </span>
                <StateMark state={state} compact />
              </summary>
              <p className="proof-question">{question}</p>
              {checks.length ? checks.map((check) => (
                <div className="proof-reason" key={check.id}>
                  <div className="proof-check-heading"><code>{check.id}</code><StateMark state={check.state} compact /></div>
                  <strong>{check.claim}</strong>
                  <p>{check.details}</p>
                  {check.evidenceIds.length > 0 && <div className="proof-evidence"><span>Evidence</span><code>{check.evidenceIds.join(', ')}</code></div>}
                </div>
              )) : <p className="proof-reason">No stronger observation is available.</p>}
              <div className="proof-remediation"><span>Next proof action</span><p>{remediation}</p></div>
            </details>
          );
        })}
      </div>
      <section className="rail-trace-index" aria-label="Scenario evidence traces">
        <div className="rail-trace-heading"><span className="eyebrow">Fixture proof traces</span><code>{scenarioExecutions.length}</code></div>
        {scenarioExecutions.map((scenario) => (
          <a href={`#/runs/${encodeURIComponent(scenario.execution!.runId)}`} key={scenario.id}>
            <span><strong>{scenario.id.split('.').at(-1)?.replaceAll('-', ' ')}</strong><code>{scenario.execution!.evidenceIds[0]}</code></span>
            <StateMark state={scenario.execution!.result} compact />
          </a>
        ))}
        {!scenarioExecutions.length && <p>No exact scenario evidence is available.</p>}
        <small>Fixture traces remain separate from workspace Verified and connected readiness.</small>
      </section>
      <div className="rail-observation">
        <span className="eyebrow">Observation provenance</span>
        <div><span>Source</span><code>{snapshot.proof.source}</code></div>
        <div><span>Observed</span><code>{snapshot.proof.observedAt || 'not observed'}</code></div>
        <div><span>Evidence</span><code>{snapshot.proof.evidenceIds.length || 0} referenced</code></div>
      </div>
      {snapshot.diagnostics.length > 0 && (
        <details className="diagnostic-drawer">
          <summary>{snapshot.diagnostics.length} workspace diagnostic{snapshot.diagnostics.length === 1 ? '' : 's'}</summary>
          {snapshot.diagnostics.map((item, index) => (
            <div className="diagnostic" key={`${item.code}:${item.subject}:${index}`}>
              <code>{item.code}</code>
              <strong>{item.subject}</strong>
              <p>{item.message}</p>
              <small>{item.remediation}</small>
            </div>
          ))}
        </details>
      )}
    </aside>
  );
}
