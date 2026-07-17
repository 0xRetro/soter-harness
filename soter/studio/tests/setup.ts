import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  window.location.hash = '';
  vi.restoreAllMocks();
});

vi.mock('@xyflow/react', () => ({
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Right: 'right', Left: 'left' },
  Background: () => null,
  Controls: () => null,
  ReactFlow: ({ nodes, edges, onNodeClick, children }: {
    nodes: Array<{ id: string; className?: string; data: { label: string } }>;
    edges: Array<{ id: string }>;
    onNodeClick?: (event: React.MouseEvent, node: { id: string }) => void;
    children?: React.ReactNode;
  }) => React.createElement(
    'div',
    { 'data-testid': 'react-flow', 'data-edge-count': edges.length },
    ...nodes.map((node) => React.createElement('button', {
      key: node.id,
      className: node.className,
      'data-node-id': node.id,
      onClick: (event) => onNodeClick?.(event, { id: node.id })
    }, node.data.label)),
    children
  )
}));
