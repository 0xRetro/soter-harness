import type { ProofState } from '../types';

export function stateSymbol(state: ProofState) {
  const normalized = String(state).replace(/^executed-/, '');
  if (normalized === 'passed' || normalized === 'completed' || normalized === 'current' || normalized === 'observed' || normalized === 'supported' || normalized === 'preserved') return '●';
  if (normalized === 'failed' || normalized === 'blocked' || normalized === 'invalid' || normalized === 'unsupported') return '×';
  if (normalized === 'stale' || normalized === 'invalidated' || normalized === 'changed') return '◒';
  if (state === 'pending' || state === 'requested' || state === 'executing') return '◐';
  return '◇';
}

export function stateTone(state: ProofState) {
  const normalized = String(state).replace(/^executed-/, '');
  if (normalized === 'passed' || normalized === 'completed' || normalized === 'current' || normalized === 'observed' || normalized === 'supported' || normalized === 'preserved') return 'passed';
  if (normalized === 'failed' || normalized === 'blocked' || normalized === 'invalid' || normalized === 'unsupported') return 'failed';
  if (normalized === 'stale' || normalized === 'invalidated' || normalized === 'changed') return 'stale';
  return 'unknown';
}

export function StateMark({ state, compact = false }: { state: ProofState; compact?: boolean }) {
  const label = state === 'ready-for-acquisition'
    ? 'staged for acquisition'
    : state.replaceAll('-', ' ');
  return (
    <span className={`state-mark state-${stateTone(state)}${compact ? ' state-compact' : ''}`} title={state}>
      <span aria-hidden="true">{stateSymbol(state)}</span>
      <span>{label}</span>
    </span>
  );
}
