import { useMemo, useState } from 'react';
import type { Activity, CatalogItem, InspectionSnapshot, ViewName } from '../types';
import { StateMark } from './StateMark';

const kindOrder = ['configuration', 'pack', 'capability', 'provider', 'host'];
const queueSections = [
  { id: 'attention', label: 'Needs attention', states: ['needs-input', 'approval-expired', 'blocked', 'verification-failed', 'failed'] },
  { id: 'review', label: 'Ready for review', states: ['ready-for-review'] },
  { id: 'acquisition', label: 'Staged for acquisition', states: ['ready-for-acquisition'] },
  { id: 'approval', label: 'Approval desk', states: ['awaiting-approval', 'approved-not-started'] },
  { id: 'active', label: 'In progress', states: ['draft', 'preparing', 'running'] },
  { id: 'recent', label: 'Recent', states: ['completed'] }
] as const;

export function CatalogNav({
  snapshot,
  view,
  selectedId,
  onSelect
}: {
  snapshot: InspectionSnapshot;
  view: ViewName;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'selected' | 'available'>('all');
  const groups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = snapshot.catalog.filter((item) => {
      const matchesQuery = !normalized || item.id.toLowerCase().includes(normalized) || item.summary.toLowerCase().includes(normalized);
      const matchesScope = scope === 'all' || (scope === 'selected' ? item.selected : !item.selected);
      return matchesQuery && matchesScope;
    });
    return kindOrder.map((kind) => ({ kind, items: filtered.filter((item) => item.kind === kind) }))
      .filter((group) => group.items.length > 0);
  }, [query, scope, snapshot.catalog]);
  const operatorWorkflows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return snapshot.workflows.filter((workflow) => workflow.operator?.preparation.supported)
      .filter((workflow) => !normalized
        || workflow.id.toLowerCase().includes(normalized)
        || workflow.label.toLowerCase().includes(normalized)
        || workflow.summary.toLowerCase().includes(normalized));
  }, [query, snapshot.workflows]);
  const operatorQueue = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const work = snapshot.activity.filter((item) => item.source === 'runtime'
      && (item.kind === 'connected-transaction' || item.kind === 'prepared-work'))
      .filter((item) => !normalized
        || item.id.toLowerCase().includes(normalized)
        || item.label.toLowerCase().includes(normalized)
        || item.state.toLowerCase().includes(normalized)
        || (item.automationId || '').toLowerCase().includes(normalized));
    const claimed = new Set<string>(queueSections.flatMap((section) => [...section.states]));
    return [
      ...queueSections.map((section) => ({ ...section, items: work.filter((item) => section.states.includes(item.state as never)) })),
      { id: 'other', label: 'Other state', states: [] as readonly string[], items: work.filter((item) => !claimed.has(item.state)) }
    ].filter((section) => section.items.length);
  }, [query, snapshot.activity]);
  const operatorWorkCount = snapshot.activity.filter((item) => item.source === 'runtime'
    && (item.kind === 'connected-transaction' || item.kind === 'prepared-work')).length;
  const attentionCount = snapshot.activity.filter((item) => item.source === 'runtime'
    && (item.kind === 'connected-transaction' || item.kind === 'prepared-work')
    && queueSections[0].states.includes(item.state as never)).length;

  return (
    <aside className="catalog-panel" aria-label="Soter catalog">
      <div className="catalog-header">
        <span className="eyebrow">{view === 'operate' ? 'Operator queue' : view === 'distribution' ? 'Local evidence dock' : 'Canonical catalog'}</span>
        {(view === 'explore' || view === 'operate') && (
          <label className="catalog-search">
            <span className="sr-only">{view === 'operate' ? 'Filter work' : 'Filter catalog'}</span>
            <span aria-hidden="true">⌕</span>
            <input aria-label={view === 'operate' ? 'Filter work' : 'Filter catalog'} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={view === 'operate' ? 'Filter work' : 'Filter entities'} />
          </label>
        )}
        {view === 'explore' && (
          <div className="catalog-scope" aria-label="Catalog selection scope">
            {(['all', 'selected', 'available'] as const).map((value) => (
              <button key={value} className={scope === value ? 'active' : ''} onClick={() => setScope(value)} aria-pressed={scope === value}>{value}</button>
            ))}
          </div>
        )}
      </div>
      <div className="catalog-scroll">
        {view === 'explore' ? (groups.length ? groups.map((group) => (
          <section className="catalog-group" key={group.kind}>
            <h2>{group.kind}<span>{group.items.length}</span></h2>
            {group.items.map((item) => (
              <CatalogRow key={item.id} item={item} active={selectedId === item.id} onSelect={onSelect} />
            ))}
          </section>
        )) : <p className="catalog-empty">No entities match this filter.</p>) : view === 'operate' ? (
          <>
            {operatorQueue.map((section) => (
              <section className={`catalog-group operator-queue-group queue-${section.id}`} key={section.id}>
                <h2>{section.label}<span>{section.items.length}</span></h2>
                {section.items.map((item) => (
                  <OperatorQueueRow key={item.id} item={item} active={selectedId === item.id} onSelect={onSelect} />
                ))}
              </section>
            ))}
            {!operatorQueue.length && (
              <section className="operator-inbox-empty" aria-label="Empty operator inbox">
                <span className="operator-inbox-glyph" aria-hidden="true">◇</span>
                <strong>{operatorWorkCount ? 'No operator work matches this filter' : 'Operator inbox is clear'}</strong>
                <p>{operatorWorkCount ? 'Change the filter to reveal other private work states.' : 'Prepared work, approval requests, and connected checkpoints will appear here.'}</p>
              </section>
            )}
            <section className="catalog-group operator-catalog">
              <h2>Start from automation<span>{operatorWorkflows.length}</span></h2>
              {operatorWorkflows.map((workflow) => {
                const executed = workflow.scenarios.filter((scenario) => scenario.execution).length;
                return (
                  <button
                    className={`catalog-row operator-row${selectedId === workflow.id ? ' active' : ''}`}
                    key={workflow.id}
                    onClick={() => onSelect(workflow.id)}
                  >
                    <span className="catalog-kind">{workflow.configuration ? 'configured work' : 'available work'}</span>
                    <strong>{workflow.label}</strong>
                    <span className="catalog-meta"><code>{executed}/{workflow.scenarios.length} rehearsals</code><StateMark state={workflow.configuration ? 'configured' : 'unknown'} compact /></span>
                  </button>
                );
              })}
              {!operatorWorkflows.length && <p className="catalog-empty">No work automation matches this filter.</p>}
            </section>
            <section className="operator-catalog-note">
              <span className="eyebrow">Operator build</span>
              <p>Work surfaces are projected from automation, configuration, scenario, and evidence contracts.</p>
            </section>
          </>
        ) : view === 'config' ? (
          <section className="catalog-group">
            <h2>Configurations<span>{snapshot.configurations.length}</span></h2>
            {snapshot.configurations.map((configuration) => (
              <button
                className={`catalog-row${selectedId === configuration.name ? ' active' : ''}`}
                key={configuration.name}
                onClick={() => onSelect(configuration.name)}
              >
                <span className="catalog-kind">desired configuration</span>
                <strong>{configuration.name}</strong>
                <span className="catalog-meta"><code>{configuration.host}</code><StateMark state={configuration.lockState} compact /></span>
              </button>
            ))}
          </section>
        ) : view === 'workflow' ? snapshot.workflows.map((workflow) => (
          <button
            className={`catalog-row workflow-row${selectedId === workflow.id ? ' active' : ''}`}
            key={workflow.id}
            onClick={() => onSelect(workflow.id)}
          >
            <span className="catalog-kind">automation</span>
            <strong>{workflow.label}</strong>
            <span className="mono">v{workflow.version}</span>
          </button>
        )) : view === 'distribution' ? (
          <>
            <section className="catalog-group distribution-catalog">
              <h2>Inspection sources<span>2</span></h2>
              <article className="distribution-catalog-row"><span>01</span><div><strong>Pack capsule</strong><small>Exact local bytes</small></div></article>
              <article className="distribution-catalog-row"><span>02</span><div><strong>Bundle + catalog</strong><small>Deterministic resolution</small></div></article>
            </section>
            <section className="catalog-group distribution-catalog-boundary">
              <h2>Boundary<span>0</span></h2>
              <p>Selected paths and capsule bytes remain in Electron main for one inspection call. They never enter the renderer or workspace snapshot.</p>
              <code>network:none</code>
              <code>authority:none</code>
              <code>persistence:none</code>
            </section>
          </>
        ) : (
          <>
            <section className="catalog-group">
              <h2>Examples<span>{snapshot.activity.filter((item) => item.source === 'fixture').length}</span></h2>
              {snapshot.activity.filter((item) => item.source === 'fixture').map((item) => (
                <button className={`catalog-row${selectedId === item.id ? ' active' : ''}`} key={item.id} onClick={() => onSelect(item.id)}>
                  <span className="catalog-kind">fixture · {item.kind}</span>
                  <strong>{item.id.replace('run.', '')}</strong>
                  <StateMark state={item.state} compact />
                </button>
              ))}
            </section>
            <section className="catalog-group runtime-group">
              <h2>Local runtime<span>{snapshot.activity.filter((item) => item.source === 'runtime').length}</span></h2>
              {snapshot.activity.filter((item) => item.source === 'runtime').map((item) => (
                <button className={`catalog-row${selectedId === item.id ? ' active' : ''}`} key={item.id} onClick={() => onSelect(item.id)}>
                  <span className="catalog-kind">private · {item.kind}</span>
                  <strong>{item.id}</strong>
                  <StateMark state={item.state} compact />
                </button>
              ))}
              {!snapshot.activity.some((item) => item.source === 'runtime') && (
                <p className="catalog-empty">No private checkpoints in this launch root.</p>
              )}
            </section>
          </>
        )}
      </div>
      {view === 'operate' ? (
        <div className="catalog-foot operator-foot"><span>Private work</span><strong>{operatorWorkCount}</strong><span>Attention</span><strong>{attentionCount}</strong></div>
      ) : view === 'distribution' ? (
        <div className="catalog-foot distribution-foot"><span>Mode</span><strong>local</strong><span>Writes</span><strong>0</strong></div>
      ) : (
        <div className="catalog-foot">
          <span>Selected</span>
          <strong>{snapshot.catalog.filter((item) => item.selected).length}</strong>
          <span>Available</span>
          <strong>{snapshot.catalog.filter((item) => !item.selected).length}</strong>
        </div>
      )}
    </aside>
  );
}

function OperatorQueueRow({ item, active, onSelect }: { item: Activity; active: boolean; onSelect: (id: string) => void }) {
  return (
    <button className={`catalog-row operator-work-row${active ? ' active' : ''}`} onClick={() => onSelect(item.id)} aria-pressed={active}>
      <span className="catalog-kind">private transaction · {readableState(item.state)}</span>
      <strong>{item.label}</strong>
      <span className="catalog-meta">
        <code>{item.updatedAt ? new Date(item.updatedAt).toLocaleString() : 'time unknown'}</code>
        <StateMark state={item.state} compact />
      </span>
      {item.recoveryId && <small className="operator-work-recovery">checkpoint · {item.recoveryId}</small>}
    </button>
  );
}

function readableState(state: string) {
  if (state === 'ready-for-acquisition') return 'staged input + lock';
  return state.replaceAll('-', ' ');
}

function CatalogRow({ item, active, onSelect }: { item: CatalogItem; active: boolean; onSelect: (id: string) => void }) {
  return (
    <button className={`catalog-row${active ? ' active' : ''}`} onClick={() => onSelect(item.id)} aria-pressed={active}>
      <span className="catalog-kind"><i className={item.selected ? 'selection-dot' : 'availability-dot'} aria-hidden="true" />{item.group} · {item.selected ? 'selected' : 'available'}</span>
      <strong>{item.label}</strong>
      <span className="catalog-meta">
        <span className="mono">{item.version ? 'v' + item.version : item.kind}</span>
        <StateMark state={item.state} compact />
      </span>
    </button>
  );
}
