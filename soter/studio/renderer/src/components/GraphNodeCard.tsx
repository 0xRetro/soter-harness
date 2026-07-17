import { Handle, Position, type NodeProps } from '@xyflow/react';

interface GraphNodeData extends Record<string, unknown> {
  label: string;
  kind: string;
  group: string;
  state: string;
  selected: boolean;
  orientation: 'horizontal' | 'vertical';
}

export function GraphNodeCard({ data }: NodeProps) {
  const node = data as GraphNodeData;
  const targetPosition = node.orientation === 'vertical' ? Position.Top : Position.Left;
  const sourcePosition = node.orientation === 'vertical' ? Position.Bottom : Position.Right;
  return (
    <div className="graph-node-card">
      <Handle type="target" position={targetPosition} />
      <div className="graph-node-meta">
        <span>{node.kind}</span>
        <i aria-hidden="true">{node.selected ? 'selected' : 'available'}</i>
      </div>
      <strong>{node.label}</strong>
      <code>{node.state}</code>
      <Handle type="source" position={sourcePosition} />
    </div>
  );
}
