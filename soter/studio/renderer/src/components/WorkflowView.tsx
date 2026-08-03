import type { CSSProperties } from 'react';
import type { Configuration, Workflow } from '../types';
import { DataField } from './DataField';
import { StateMark } from './StateMark';

export function WorkflowView({ workflow, configuration }: { workflow: Workflow; configuration: Configuration | null }) {
  const outcomes = workflow.scenarios.flatMap((scenario) => scenario.outcomes).filter(unique);
  const executedCount = workflow.scenarios.filter((scenario) => scenario.execution).length;
  const hostCompatibility = Object.entries(workflow.hostCompatibility);
  const compatibleHosts = hostCompatibility
    .filter(([, fact]) => fact.state === 'compatible')
    .map(([host]) => host);
  const unavailableHosts = hostCompatibility.filter(([, fact]) => fact.state === 'unavailable');
  return (
    <div className="workflow-view">
      <header className="view-intro workflow-intro">
        <div>
          <span className="eyebrow">Automation contract · builder view</span>
          <h1>{workflow.label}</h1>
          <p>{workflow.summary}</p>
        </div>
        <div className="workflow-stamp">
          <code>{workflow.id}</code>
          <span className="mono">v{workflow.version}</span>
        </div>
      </header>

      {!configuration && (
        <section className="workflow-availability" aria-label="Workflow selection state">
          <div><span className="eyebrow">Catalog availability</span><strong>Not selected</strong></div>
          <p>This automation is declared and inspectable, but no desired configuration resolves it. Its scenarios remain declared—not executed.</p>
          <a href="#/config">Preview in Config <span aria-hidden="true">→</span></a>
        </section>
      )}

      {unavailableHosts.length > 0 && (
        <section className="workflow-availability" aria-label="Workflow host compatibility">
          <div>
            <span className="eyebrow">Compatible hosts</span>
            <strong>{compatibleHosts.join(', ')}</strong>
          </div>
          <div>
            {unavailableHosts.map(([host, unavailable]) => unavailable.state === 'unavailable' && (
              <p key={host}>
                <code>{host}</code> unavailable · <code>{unavailable.reasonCode}</code> · {unavailable.reason}
              </p>
            ))}
          </div>
        </section>
      )}

      <section className="workflow-lock-band" aria-label="Workflow exact configuration">
        <div className="lock-band-title"><span className="eyebrow">Resolved through</span><strong>{configuration?.name || 'Not selected in a configuration'}</strong></div>
        <DataField label="Lock" value={configuration?.lockState || 'not resolved'} accent />
        <DataField label="Host" value={workflow.host || 'not resolved'} />
        <DataField label="Effects" value={`${workflow.effects.length} declared`} />
        <DataField label="Scenarios" value={`${executedCount} / ${workflow.scenarios.length} fixture-executed`} />
      </section>

      {workflow.id === 'automation.project-pulse' && <WorkLedger workflow={workflow} />}

      <section className="relationship-band" aria-label="Exact workflow relationships">
        <RelationshipBlock index="01" label="Promises" note="Outcomes" values={outcomes} />
        <RelationshipBlock index="02" label="Requires" note="Portable capabilities" values={workflow.requiredCapabilities} />
        <RelationshipBlock index="03" label="Resolves" note="Exact bindings" values={workflow.bindings} />
        <RelationshipBlock index="04" label="Projects" note="Execution host" values={[workflow.host || 'No exact host']} />
      </section>

      <section className="binding-section">
        <div className="section-heading">
          <div><span className="eyebrow">Resolution matrix</span><h2>Capability → provider → authority</h2></div>
          <p>Every portable requirement is traced through the exact selected configuration and its permitted effects.</p>
        </div>
        <div className="binding-table">
          <div className="binding-header" aria-hidden="true"><span>Capability</span><span>Provider pack</span><span>Authority</span><span>Effects</span><span>Reason</span></div>
          {configuration?.bindings.filter((binding) => workflow.requiredCapabilities.includes(binding.capability)).map((binding) => (
            <div className="binding-row" key={binding.capability}>
              <code>{binding.capability}</code>
              <code>{binding.providerPack}</code>
              <div className="token-line">{binding.authorities.map((authority) => <span className="authority-token" key={authority}>{authority}</span>)}</div>
              <div className="token-line">{binding.effects.map((effect) => <span className="effect-token" key={effect}>{effect}</span>)}</div>
              <p>{binding.reason}</p>
            </div>
          )) || <p className="inspector-empty">No exact bindings resolved.</p>}
        </div>
      </section>

      <div className="workflow-columns">
        <section className="instrument-panel">
          <div className="panel-heading"><span className="eyebrow">Effect policy</span><code>{configuration?.effectPolicies.length || 0} rules</code></div>
          <div className="policy-table">
            {configuration?.effectPolicies.map((policy) => (
              <div className="policy-row" key={policy.effect}>
                <span className="policy-effect">{policy.effect}</span>
                <span className={`policy-mode mode-${policy.mode}`}>{policy.mode}</span>
                <p>{policy.reason}</p>
              </div>
            )) || <p className="inspector-empty">No exact effect policies resolved.</p>}
          </div>
        </section>
        <section className="instrument-panel">
          <div className="panel-heading"><span className="eyebrow">Authority register</span><code>{configuration?.authorities.length || 0} declared</code></div>
          <div className="authority-list">
            {configuration?.authorities.map((authority) => (
              <div className="authority-row" key={authority.id}>
                <strong>{authority.subject}</strong>
                <span>{authority.role}</span>
                <code>{authority.id}</code>
                <p>{authority.reason}</p>
              </div>
            )) || <p className="inspector-empty">No exact authorities resolved.</p>}
          </div>
        </section>
      </div>

      <section className="scenario-section">
        <div className="section-heading">
          <div><span className="eyebrow">Scenario truth</span><h2>Declaration → execution → evidence</h2></div>
          <p>{executedCount} of {workflow.scenarios.length} scenarios have exact-lock fixture evidence. This does not establish connected readiness or workspace verification.</p>
        </div>
        <div className="scenario-register">
          <div className="scenario-register-header" aria-hidden="true"><span>Scenario</span><span>Intent</span><span>Contract surface</span><span>Execution</span></div>
          {workflow.scenarios.map((scenario, index) => (
            <details className="scenario-row" key={scenario.id}>
              <summary>
                <div className="scenario-name"><span>S{String(index + 1).padStart(2, '0')}</span><div><strong>{readableId(scenario.id)}</strong><code>{scenario.id}</code></div></div>
                <code>{scenario.intent}</code>
                <span className="scenario-counts">{scenario.outcomes.length} outcomes · {scenario.invariants.length} invariants · {scenario.evidence.length} evidence</span>
                <StateMark state={scenario.execution?.result || scenario.status} compact />
              </summary>
              {scenario.execution
                ? <ScenarioExecutionTrace scenario={scenario} />
                : <div className="scenario-unexecuted"><StateMark state="unknown" compact /><p>No applicable execution evidence matches this scenario fingerprint and exact configuration lock.</p></div>}
              <div className="scenario-detail-grid">
                <ScenarioList label="Expected outcomes" values={scenario.outcomes} />
                <ScenarioList label="Invariants" values={scenario.invariants} />
                <ScenarioList label="Required evidence" values={scenario.evidence} />
              </div>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}

function WorkLedger({ workflow }: { workflow: Workflow }) {
  const outcomes = workflow.scenarios.flatMap((scenario) => scenario.outcomes).filter(unique);
  const executed = workflow.scenarios.filter((scenario) => scenario.execution);
  const executionState = executed.length === workflow.scenarios.length && executed.every((scenario) => scenario.execution?.result === 'passed')
    ? 'passed'
    : 'declared-not-executed';
  return (
    <section className="work-ledger" aria-label="Project Pulse work ledger">
      <header>
        <div><span className="eyebrow">Generated work ledger</span><h2>Evidence in → reviewable pulse out</h2></div>
        <StateMark state={executionState} compact />
      </header>
      <div className="work-ledger-flow">
        <article>
          <span>01 · Ground</span>
          <strong>Authoritative records</strong>
          <p>Read project, policy, promoted-task, and milestone state through portable capabilities.</p>
          <div>{workflow.requiredCapabilities.map((item) => <code key={item}>{item}</code>)}</div>
        </article>
        <i aria-hidden="true">→</i>
        <article>
          <span>02 · Judge</span>
          <strong>Progress and health</strong>
          <p>Separate observed task completion from milestone work items and refuse unsupported precision.</p>
          <div>{outcomes.filter((item) => item.includes('grounded') || item.includes('health') || item.includes('supported')).slice(0, 4).map((item) => <code key={item}>{item}</code>)}</div>
        </article>
        <i aria-hidden="true">→</i>
        <article>
          <span>03 · Gate</span>
          <strong>Status and milestone diff</strong>
          <p>Present one consistent batch; external writes remain bound to the configured confirmation policy.</p>
          <div>{workflow.effects.map((item) => <code key={item}>{item}</code>)}</div>
        </article>
      </div>
      <footer>
        <span>This ledger is descriptive and never initiates a run.</span>
        <span>{executed.length === workflow.scenarios.length
          ? `${executed.length} exact fixture runs are linked; connected and write behavior remain unproven.`
          : `${workflow.scenarios.length - executed.length} scenarios remain declared—not executed.`}</span>
      </footer>
    </section>
  );
}

function ScenarioExecutionTrace({ scenario }: { scenario: Workflow['scenarios'][number] }) {
  const execution = scenario.execution;
  if (!execution) return null;
  const coverage = [
    ['Outcomes', execution.coverage.outcome],
    ['Invariants', execution.coverage.invariant],
    ['Evidence', execution.coverage.evidence]
  ] as const;
  return (
    <section className="scenario-trace" aria-label={`${scenario.id} proof trace`}>
      <div className="trace-heading">
        <div><span className="eyebrow">Proof trace · {execution.source}</span><strong>Exact scenario evidence</strong></div>
        <StateMark state={execution.result} compact />
      </div>
      <div className="trace-chain" aria-label="Scenario evidence chain">
        <div><span>01 · declaration</span><code>{scenario.id}</code></div>
        <i aria-hidden="true">→</i>
        <div><span>02 · observed run</span><code>{execution.runId}</code></div>
        <i aria-hidden="true">→</i>
        <div><span>03 · assessment</span><code>{execution.evidenceIds.join(', ')}</code></div>
      </div>
      <div className="trace-measures">
        {coverage.map(([label, value]) => (
          <div key={label}><span>{label}</span><strong>{value.passed}/{value.total}</strong><i style={{ '--coverage': value.total ? value.passed / value.total : 0 } as CSSProperties} /></div>
        ))}
        <div><span>Capability order</span><StateMark state={execution.capabilityOrder.state} compact /></div>
        <div><span>Effect modes</span><StateMark state={execution.effectModes.state} compact /></div>
      </div>
      <div className="capability-sequence">
        <span className="eyebrow">Observed capability order</span>
        <ol>{execution.capabilityOrder.observed.map((capability, index) => <li key={`${capability}:${index}`}><span>{String(index + 1).padStart(2, '0')}</span><code>{capability}</code></li>)}</ol>
      </div>
      <footer className="trace-foot">
        <div><span>Observed</span><code>{execution.observedAt}</code></div>
        <a href={`#/runs/${encodeURIComponent(execution.runId)}`}>Inspect run evidence <span aria-hidden="true">→</span></a>
      </footer>
      <p className="trace-limitation">{execution.limitations[0]}</p>
    </section>
  );
}

function RelationshipBlock({ index, label, note, values }: { index: string; label: string; note: string; values: string[] }) {
  return (
    <div className="relationship-block">
      <span className="relationship-index">{index}</span>
      <div className="relationship-label"><strong>{label}</strong><span>{note}</span></div>
      <div className="relationship-values">{values.slice(0, 6).map((value) => <code key={value}>{value}</code>)}</div>
    </div>
  );
}

function ScenarioList({ label, values, mono = false }: { label: string; values: string[]; mono?: boolean }) {
  return <div><strong>{label}</strong><ul className={mono ? 'mono' : ''}>{values.map((value) => <li key={value}>{mono ? value : value.replaceAll('-', ' ')}</li>)}</ul></div>;
}

function readableId(value: string) {
  return value.split('.').at(-1)?.replaceAll('-', ' ') || value;
}

function unique(value: string, index: number, values: string[]) {
  return values.indexOf(value) === index;
}
