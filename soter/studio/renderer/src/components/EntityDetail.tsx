import type { GraphEdge, InspectionSnapshot } from '../types';
import { DataField } from './DataField';
import { StateMark } from './StateMark';

export function EntityDetail({ snapshot, selectedId }: { snapshot: InspectionSnapshot; selectedId: string | null }) {
  const item = snapshot.catalog.find((candidate) => candidate.id === selectedId) || snapshot.catalog[0];
  if (!item) return null;
  const node = snapshot.graph.nodes.find((candidate) => candidate.id === item.id);
  const relationships = snapshot.graph.edges.filter((edge) => edge.source === item.id || edge.target === item.id);
  const configuration = item.kind === 'configuration'
    ? snapshot.configurations.find((candidate) => 'configuration.' + candidate.name === item.id)
    : null;
  const maturityRows = configuration
    ? [configuration.maturity.host, ...configuration.maturity.selections]
    : [];

  return (
    <article className="entity-detail" aria-live="polite">
      <header className="detail-heading">
        <div>
          <span className="eyebrow">Canonical {item.kind} · {item.group} layer</span>
          <h1>{item.label}</h1>
          <code className="detail-identifier">{item.id}</code>
        </div>
        <div className="detail-state-stack">
          <StateMark state={item.state} />
          <span className={`selection-tag ${item.selected ? 'is-selected' : 'is-available'}`}>{item.selected ? 'In exact selection' : 'Available to select'}</span>
        </div>
      </header>

      <div className="detail-sheet">
        <section className="detail-overview">
          <span className="field-label">Purpose</span>
          <p>{item.summary}</p>
        </section>
        <div className="detail-fields">
          <DataField label="Version" value={item.version ? `v${item.version}` : 'unversioned'} />
          <DataField label="Graph state" value={node?.state || 'not mapped'} />
          <DataField label="Effects" value={item.effects.length ? `${item.effects.length} declared` : 'none declared'} />
          <DataField label="Connections" value={`${relationships.length} direct`} accent />
        </div>
      </div>

      {configuration && (
        <>
          <section className="exact-lock-sheet" aria-label="Exact configuration lock">
            <div className="sheet-heading">
              <div><span className="eyebrow">Exact configuration</span><h2>Resolved lock</h2></div>
              <StateMark state={configuration.lockState} compact />
            </div>
            <div className="data-field-grid data-field-grid-four">
              <DataField label="Lock state" value={configuration.lockState} accent />
              <DataField label="Host" value={configuration.host} />
              <DataField label="Graph fingerprint" value={shortFingerprint(configuration.graphFingerprint)} />
              <DataField label="Lock fingerprint" value={shortFingerprint(configuration.lockFingerprint)} />
            </div>
          </section>

          <section className="maturity-sheet" aria-label="Maturity evidence applicability">
            <div className="sheet-heading">
              <div>
                <span className="eyebrow">Evidence applicability</span>
                <h2>Maturity claims</h2>
                <p>Manifest claims stay distinct from proof tied to this exact lock and dependency graph.</p>
              </div>
              <code>{maturityRows.filter((row) => row.state === 'supported').length}/{maturityRows.length} supported</code>
            </div>
            <div className="maturity-header" aria-hidden="true"><span>Subject</span><span>Claim</span><span>Proof</span><span>Applicable evidence</span></div>
            {maturityRows.map((row) => (
              <details className={`maturity-entry maturity-entry-${row.state}`} key={row.id}>
                <summary className="maturity-row">
                  <div><strong>{row.id}</strong><span>{row.id === configuration.maturity.host.id ? 'host adapter' : 'selected pack'}</span></div>
                  <div><code>{row.claim || 'none'}</code><span>{row.requiredLevel || 'no level'} floor</span></div>
                  <div><StateMark state={row.state} compact /><span>{row.result}</span></div>
                  <div className="maturity-evidence-count"><strong>{row.evidenceIds.length ? `${row.evidenceIds.length} record${row.evidenceIds.length === 1 ? '' : 's'}` : 'No applicable record'}</strong><code>{row.evidenceIds[0] || 'exact fingerprints required'}</code><i aria-hidden="true">⌄</i></div>
                </summary>
                <div className="maturity-expansion">
                  <div className="maturity-reasoning">
                    <section><span className="field-label">Why this state</span><code>{row.reasonCode}</code><p>{row.basis}</p></section>
                    <section><span className="field-label">Boundary</span><p>{row.limitations.join(' ')}</p></section>
                    <section><span className="field-label">Next proof action</span><p>{row.remediation}</p></section>
                  </div>
                  {row.evidence.length ? (
                    <div className="maturity-records">
                      {row.evidence.map((record) => (
                        <article key={record.id}>
                          <div><span className="field-label">Evidence record</span><code>{record.id}</code></div>
                          <div><StateMark state={record.result} compact /><code>{record.level} · {record.createdAt}{record.validUntil ? ` · valid until ${record.validUntil}` : ''}</code></div>
                          <p>{record.claim}</p>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </div>
              </details>
            ))}
          </section>
        </>
      )}

      <div className="entity-inspector-grid">
        <section className="relationship-ledger">
          <div className="sheet-heading">
            <div><span className="eyebrow">Relationship ledger</span><h2>Direct graph connections</h2></div>
            <code>{relationships.length} rows</code>
          </div>
          <div className="ledger-header" aria-hidden="true"><span>Direction</span><span>Relation</span><span>Entity</span><span>Constraint</span></div>
          {relationships.length ? relationships.map((edge) => (
            <RelationshipRow key={edge.id} edge={edge} selectedId={item.id} snapshot={snapshot} />
          )) : <p className="inspector-empty">No direct graph relationships are declared.</p>}
        </section>

        <aside className="policy-sheet">
          <TokenSection label="Effect surface" values={item.effects} empty="No effects declared" tone="effect" />
          <TokenSection label="Known limitations" values={item.limitations} empty="No item-specific limitations" tone="limitation" />
        </aside>
      </div>
    </article>
  );
}

function RelationshipRow({ edge, selectedId, snapshot }: { edge: GraphEdge; selectedId: string; snapshot: InspectionSnapshot }) {
  const outgoing = edge.source === selectedId;
  const relatedId = outgoing ? edge.target : edge.source;
  const related = snapshot.graph.nodes.find((node) => node.id === relatedId);
  return (
    <div className="ledger-row">
      <span className={`direction-mark ${outgoing ? 'direction-out' : 'direction-in'}`}><i aria-hidden="true">{outgoing ? '→' : '←'}</i>{outgoing ? 'outbound' : 'inbound'}</span>
      <code className={`relation-kind relation-${edge.kind}`}>{edge.kind}</code>
      <div><strong>{related?.label || relatedId}</strong><code>{relatedId}</code></div>
      <code>{edge.label}</code>
    </div>
  );
}

function TokenSection({ label, values, empty, tone }: { label: string; values: string[]; empty: string; tone: string }) {
  return (
    <section className="token-section">
      <span className="eyebrow">{label}</span>
      {values.length ? <ul>{values.map((value) => <li className={`token-${tone}`} key={value}>{value}</li>)}</ul> : <p>{empty}</p>}
    </section>
  );
}

function shortFingerprint(value: string | null) {
  return value ? value.slice(0, 18) + '…' : 'not observed';
}
