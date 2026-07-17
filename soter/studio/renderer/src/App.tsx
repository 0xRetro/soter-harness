import { useEffect, useRef } from 'react';
import { CatalogNav } from './components/CatalogNav';
import { ConfigView } from './components/ConfigView';
import { EntityDetail } from './components/EntityDetail';
import { DistributionView } from './components/DistributionView';
import { ExploreGraph } from './components/ExploreGraph';
import { OperatorView } from './components/OperatorView';
import { ProofRail } from './components/ProofRail';
import { RunsView } from './components/RunsView';
import { WorkflowView } from './components/WorkflowView';
import { useRoute } from './useRoute';
import { useWorkspace } from './useWorkspace';
import type { ViewName } from './types';

const views: Array<{ id: ViewName; label: string; note: string }> = [
  { id: 'operate', label: 'Operate', note: 'Work + review' },
  { id: 'explore', label: 'Explore', note: 'Catalog + graph' },
  { id: 'config', label: 'Config', note: 'Preview + impact' },
  { id: 'workflow', label: 'Workflow', note: 'Promises + gates' },
  { id: 'runs', label: 'Runs', note: 'Evidence + recovery' },
  { id: 'distribution', label: 'Releases', note: 'Capsules + bundles' }
];

export function App() {
  const canvasRef = useRef<HTMLElement>(null);
  const { snapshot, loading, refreshing, error, refresh } = useWorkspace();
  const { view, selectedId, navigate } = useRoute();
  useEffect(() => {
    if (!canvasRef.current) return;
    canvasRef.current.scrollTop = 0;
    canvasRef.current.scrollLeft = 0;
  }, [view]);

  if (loading) return <LoadingScreen label="Inspecting canonical workspace" />;
  if (error || !snapshot) return (
    <main className="fatal-screen"><span className="empty-shape">×</span><h1>Workspace inspection failed</h1><p>{error || 'No snapshot was returned.'}</p><button onClick={refresh}>Try again</button></main>
  );

  const defaultSelection = view === 'explore'
    ? snapshot.catalog[0]?.id
    : view === 'config'
      ? snapshot.configurations[0]?.name
    : view === 'workflow' || view === 'operate'
      ? snapshot.workflows[0]?.id
      : snapshot.activity[0]?.id;
  const activeId = selectedId || defaultSelection || null;
  const selectedOperatorActivity = view === 'operate'
    ? snapshot.activity.find((item) => item.id === activeId
      && (item.kind === 'connected-transaction' || item.kind === 'prepared-work')) || null
    : null;
  const operatorAutomationId = selectedOperatorActivity?.automationId || null;
  const workflow = snapshot.workflows.find((item) => item.id === activeId)
    || snapshot.workflows.find((item) => item.id === operatorAutomationId)
    || snapshot.workflows[0]
    || null;
  const selectedConfiguration = view === 'workflow' || view === 'operate'
    ? snapshot.configurations.find((item) => item.name === workflow?.configuration) || null
    : snapshot.configurations.find((item) => item.name === activeId) || snapshot.configurations[0] || null;
  const activity = snapshot.activity.find((item) => item.id === activeId) || snapshot.activity[0] || null;

  return (
    <div className="studio-shell">
      <header className="app-header">
        <a className="brand" href="#/explore" aria-label="Soter Studio home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Soter</strong><em>Studio</em></span>
        </a>
        <nav className="view-tabs" aria-label="Primary views">
          {views.map((item) => (
            <a key={item.id} href={`#/${item.id}`} className={view === item.id ? 'active' : ''} aria-current={view === item.id ? 'page' : undefined}>
              <strong>{item.label}</strong><small>{item.note}</small>
            </a>
          ))}
        </nav>
        <div className="workspace-status">
          <span className={`refresh-indicator${refreshing ? ' spinning' : ''}`} aria-hidden="true">↻</span>
          <span><strong>{snapshot.workspace.name}</strong><small>{snapshot.workspace.mode} · current repository</small></span>
          <button onClick={refresh} disabled={refreshing}>{refreshing ? 'Refreshing' : 'Refresh'}</button>
        </div>
      </header>

      <div className="workspace-grid">
        <CatalogNav
          snapshot={snapshot}
          view={view}
          selectedId={activeId}
          onSelect={(id) => navigate(view, id)}
        />
        <main className="primary-canvas" ref={canvasRef}>
          {view === 'operate' && workflow && <OperatorView
            snapshot={snapshot}
            workflow={workflow}
            configuration={selectedConfiguration}
            initialActivity={selectedOperatorActivity}
            onChanged={refresh}
          />}
          {view === 'explore' && (
            <div className="explore-view">
              <ExploreGraph snapshot={snapshot} selectedId={activeId} onSelect={(id) => navigate('explore', id)} />
              <EntityDetail snapshot={snapshot} selectedId={activeId} />
            </div>
          )}
          {view === 'config' && selectedConfiguration && <ConfigView key={selectedConfiguration.name} snapshot={snapshot} configuration={selectedConfiguration} />}
          {view === 'workflow' && workflow && <WorkflowView workflow={workflow} configuration={selectedConfiguration} />}
          {view === 'runs' && <RunsView activity={activity} />}
          {view === 'distribution' && <DistributionView />}
        </main>
        <ProofRail snapshot={snapshot} />
      </div>
    </div>
  );
}

function LoadingScreen({ label }: { label: string }) {
  return <main className="loading-screen"><div className="loading-instrument"><span /><span /><span /></div><h1>{label}</h1><p>Reading contracts, exact locks, evidence, and private checkpoint metadata.</p></main>;
}
