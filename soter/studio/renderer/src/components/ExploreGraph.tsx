import { useMemo, useState } from 'react';
import { Background, Controls, MarkerType, Position, ReactFlow, type Edge, type Node } from '@xyflow/react';
import type { GraphEdge, GraphNode, InspectionSnapshot } from '../types';
import { GraphNodeCard } from './GraphNodeCard';

const edgeKinds = ['dependency', 'requires', 'provides', 'implements', 'binding', 'authority', 'provider', 'host', 'selects'];
const architecturePresets = [
  { id: 'resolved', label: 'Resolved flow', description: 'Exact execution chain from selection to provider implementation.' },
  { id: 'selection', label: 'Selected graph', description: 'Chosen packs, host projection, and dependency foundation.' },
  { id: 'authority', label: 'Authority gates', description: 'Required capabilities and the authorities that bound them.' },
  { id: 'all', label: 'All relations', description: 'Every canonical relation; useful for diagnosis, intentionally dense.' }
] as const;
const laneOrder = ['Selection', 'Foundation + host', 'Automation', 'Capabilities', 'Authorities', 'Integrations', 'Provider implementations'];
const nodeTypes = { evidence: GraphNodeCard };
type ArchitecturePreset = typeof architecturePresets[number]['id'];

function graphLayout(
  snapshot: InspectionSnapshot,
  selectedId: string | null,
  activeKinds: Set<string>,
  focusPath: boolean,
  architecturePreset: ArchitecturePreset
) {
  const canonicalEdges = focusPath
    ? snapshot.graph.edges.filter((item) => activeKinds.has(item.kind) && (!selectedId || item.source === selectedId || item.target === selectedId))
    : architectureEdges(snapshot.graph.edges, architecturePreset);
  const visibleIds = new Set<string>();
  canonicalEdges.forEach((edge) => {
    visibleIds.add(edge.source);
    visibleIds.add(edge.target);
  });
  if (selectedId) visibleIds.add(selectedId);
  const visibleItems = architecturePreset === 'all' && !focusPath
    ? snapshot.graph.nodes
    : snapshot.graph.nodes.filter((item) => visibleIds.has(item.id));

  const architecture = focusPath ? null : architectureLayout(visibleItems);
  const positions = focusPath && selectedId
    ? focusedPositions(visibleItems, canonicalEdges, selectedId)
    : architecture?.positions || new Map<string, { x: number; y: number }>();

  const nodes: Node[] = visibleItems.map((item) => ({
    id: item.id,
    type: 'evidence',
    ariaLabel: item.label,
    position: positions.get(item.id) || { x: 0, y: 0 },
    data: {
      label: item.label,
      kind: item.kind,
      group: item.group,
      state: item.state,
      selected: item.selected,
      orientation: 'horizontal'
    },
    className: [
      'evidence-node',
      'node-' + item.kind,
      item.selected ? 'node-selected' : 'node-available',
      item.id === selectedId ? 'node-focus' : ''
    ].join(' '),
    selectable: true,
    draggable: false,
    sourcePosition: Position.Right,
    targetPosition: Position.Left
  }));

  if (architecture) {
    architecture.lanes.forEach((lane) => nodes.push({
      id: `architecture-lane:${lane.label}`,
      position: { x: lane.x, y: 0 },
      data: { label: `${lane.label} · ${lane.count}` },
      className: 'architecture-lane-node',
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      ariaLabel: `${lane.label}: ${lane.count} entities`
    }));
  }

  const edges: Edge[] = canonicalEdges.map((item) => {
    const display = architecture ? normalizeArchitectureEdge(item, architecture.laneIndexByNode) : item;
    return {
      id: item.id,
      type: 'smoothstep',
      source: display.source,
      target: display.target,
      label: display.label,
      className: ['edge-' + item.kind, selectedId && (item.source === selectedId || item.target === selectedId) ? 'edge-focus' : ''].join(' '),
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
      animated: false
    };
  });
  return { nodes, edges, entityCount: visibleItems.length };
}

function architectureEdges(edges: GraphEdge[], preset: ArchitecturePreset) {
  if (preset === 'all') return edges;
  if (preset === 'selection') return edges.filter((edge) => ['selects', 'dependency', 'host'].includes(edge.kind));
  if (preset === 'authority') return edges.filter((edge) => edge.kind === 'requires' || edge.kind === 'authority' || (edge.kind === 'selects' && edge.target.startsWith('automation.')));
  return edges.filter((edge) => ['requires', 'binding', 'provider'].includes(edge.kind) || (edge.kind === 'selects' && edge.target.startsWith('automation.')));
}

function focusedPositions(nodes: GraphNode[], edges: GraphEdge[], selectedId: string) {
  const incomingIds = new Set(edges.filter((edge) => edge.target === selectedId).map((edge) => edge.source));
  const outgoingIds = new Set(edges.filter((edge) => edge.source === selectedId).map((edge) => edge.target));
  const incoming = nodes.filter((node) => incomingIds.has(node.id));
  const outgoing = nodes.filter((node) => outgoingIds.has(node.id) && !incomingIds.has(node.id));
  const rowCount = Math.max(incoming.length, outgoing.length, 1);
  const rowGap = 86;
  const centerY = ((rowCount - 1) * rowGap) / 2;
  const positions = new Map<string, { x: number; y: number }>([[selectedId, { x: 390, y: centerY }]]);
  placeColumn(positions, incoming, 30, centerY, rowGap);
  placeColumn(positions, outgoing, 750, centerY, rowGap);
  return positions;
}

function placeColumn(positions: Map<string, { x: number; y: number }>, nodes: GraphNode[], x: number, centerY: number, gap: number) {
  const startY = centerY - ((nodes.length - 1) * gap) / 2;
  nodes.forEach((node, index) => positions.set(node.id, { x, y: startY + index * gap }));
}

function architectureLayout(nodes: GraphNode[]) {
  const byLane = new Map<string, GraphNode[]>();
  nodes.forEach((node) => {
    const lane = architectureLane(node);
    byLane.set(lane, [...(byLane.get(lane) || []), node]);
  });
  const activeLanes = laneOrder.filter((lane) => byLane.has(lane));
  const widest = Math.max(...activeLanes.map((lane) => byLane.get(lane)?.length || 0), 1);
  const positions = new Map<string, { x: number; y: number }>();
  const laneIndexByNode = new Map<string, number>();
  const lanes = activeLanes.map((label, laneIndex) => {
    const items = byLane.get(label) || [];
    const x = laneIndex * 224;
    const startY = 60 + ((widest - items.length) * 88) / 2;
    items.forEach((item, row) => {
      positions.set(item.id, { x, y: startY + row * 88 });
      laneIndexByNode.set(item.id, laneIndex);
    });
    return { label, x, count: items.length };
  });
  return { positions, lanes, laneIndexByNode };
}

function architectureLane(node: GraphNode) {
  if (node.kind === 'configuration') return 'Selection';
  if (node.group === 'automation') return 'Automation';
  if (node.kind === 'capability') return 'Capabilities';
  if (node.kind === 'authority') return 'Authorities';
  if (node.group === 'integration') return 'Integrations';
  if (node.kind === 'provider') return 'Provider implementations';
  return 'Foundation + host';
}

function normalizeArchitectureEdge(edge: GraphEdge, laneIndexByNode: Map<string, number>): GraphEdge {
  const reversed = (laneIndexByNode.get(edge.source) || 0) > (laneIndexByNode.get(edge.target) || 0);
  return {
    ...edge,
    source: reversed ? edge.target : edge.source,
    target: reversed ? edge.source : edge.target,
    label: architectureEdgeLabel(edge, reversed)
  };
}

function architectureEdgeLabel(edge: GraphEdge, reversed: boolean) {
  if (reversed && edge.kind === 'dependency') return `required by · ${edge.label}`;
  if (reversed && edge.kind === 'implements') return `implemented by · ${edge.label}`;
  if (reversed && edge.kind === 'provides') return `provided by · ${edge.label}`;
  if (edge.kind === 'provider') return `${edge.label} provider`;
  if (edge.kind === 'requires') return `requires · ${edge.label}`;
  if (edge.kind === 'selects') return `selects · ${edge.label}`;
  if (edge.kind === 'host') return 'launch host';
  if (edge.kind === 'binding') return 'bound provider';
  if (edge.kind === 'authority') return 'authorized by';
  return `${edge.kind} · ${edge.label}`;
}

export function ExploreGraph({ snapshot, selectedId, onSelect }: {
  snapshot: InspectionSnapshot;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [activeKinds, setActiveKinds] = useState(() => new Set(edgeKinds));
  const [focusPath, setFocusPath] = useState(true);
  const [architecturePreset, setArchitecturePreset] = useState<ArchitecturePreset>('resolved');
  const { nodes, edges, entityCount } = useMemo(
    () => graphLayout(snapshot, selectedId, activeKinds, focusPath, architecturePreset),
    [activeKinds, architecturePreset, focusPath, selectedId, snapshot]
  );
  const connectionCount = snapshot.graph.edges.filter((edge) => edge.source === selectedId || edge.target === selectedId).length;
  const activePreset = architecturePresets.find((preset) => preset.id === architecturePreset) || architecturePresets[0];
  const toggle = (kind: string) => setActiveKinds((current) => {
    const next = new Set(current);
    next.has(kind) ? next.delete(kind) : next.add(kind);
    return next;
  });

  return (
    <section className="graph-surface" aria-label="Workspace relationship graph">
      <header className="graph-header">
        <div className="graph-context">
          <span className="eyebrow">Relationship bench</span>
          <div><strong>{selectedId || 'No entity selected'}</strong><span className="mono">{connectionCount} direct connection{connectionCount === 1 ? '' : 's'}</span></div>
        </div>
        <div className="graph-actions">
          <button className={`focus-toggle${focusPath ? ' active' : ''}`} onClick={() => setFocusPath((current) => !current)} aria-pressed={focusPath}>
            <span className="focus-glyph" aria-hidden="true">◎</span>{focusPath ? 'Selected neighborhood' : 'Full architecture'}
          </button>
          {focusPath && (
            <details className="relationship-filter">
              <summary>Relationships <span>{activeKinds.size}/{edgeKinds.length}</span></summary>
              <div className="relationship-filter-menu" aria-label="Graph relationship filters">
                <div className="filter-menu-heading"><span>Visible relations</span><button onClick={() => setActiveKinds(new Set(edgeKinds))}>Show all</button></div>
                {edgeKinds.map((kind) => (
                  <button key={kind} className={activeKinds.has(kind) ? 'active' : ''} onClick={() => toggle(kind)} aria-pressed={activeKinds.has(kind)}>
                    <span className={`edge-swatch edge-${kind}`} aria-hidden="true" />{kind}
                  </button>
                ))}
              </div>
            </details>
          )}
        </div>
      </header>
      {focusPath ? (
        <div className="graph-orientation" aria-hidden="true"><span>Relations into selection</span><strong>Selected entity</strong><span>Relations from selection</span></div>
      ) : (
        <div className="graph-orientation graph-orientation-full">
          <div className="architecture-presets" aria-label="Architecture relation lens">
            {architecturePresets.map((preset) => <button key={preset.id} className={preset.id === architecturePreset ? 'active' : ''} onClick={() => setArchitecturePreset(preset.id)}>{preset.label}</button>)}
          </div>
          <span>{activePreset.description}</span>
          <strong>{entityCount} entities · {edges.length} relations</strong>
        </div>
      )}
      <div className="graph-stage">
        <ReactFlow
          key={focusPath ? `focus:${selectedId}:${[...activeKinds].join(',')}` : `architecture:${architecturePreset}`}
          nodeTypes={nodeTypes}
          nodes={nodes}
          edges={edges}
          onNodeClick={(_event, node) => !node.id.startsWith('architecture-lane:') && onSelect(node.id)}
          fitView
          fitViewOptions={{ padding: focusPath ? 0.28 : 0.14, minZoom: 0.48, maxZoom: focusPath ? 1.12 : 1 }}
          minZoom={0.25}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          deleteKeyCode={null}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#D5E0E2" gap={24} size={1} />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
      </div>
    </section>
  );
}
