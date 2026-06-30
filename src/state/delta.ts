import * as jsondiffpatch from 'jsondiffpatch';
import { GameState } from '../types';

export type StateDelta = jsondiffpatch.Delta | undefined;

const objectHash = (item: object, index?: number): string | undefined => {
  const obj = item as Record<string, unknown>;
  const id = obj.id ?? obj.roomId;
  if (typeof id === 'string') return id;
  return index !== undefined ? String(index) : undefined;
};

const differ = jsondiffpatch.create({
  objectHash,
  arrays: { detectMove: true, includeValueOnMove: false },
});

const patcher = jsondiffpatch.create({
  objectHash,
});

export interface DeltaPayload {
  /** When true the client should replace local state entirely (reconnect / large change). */
  full: boolean;
  version: number;
  seq: number;
  log: string;
  delta?: StateDelta;
  state?: GameState;
}

/** Deep clone via JSON — game state is plain JSON-serializable data. */
export function cloneState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

/** Compute a minimal jsondiffpatch delta between two authoritative snapshots. */
export function createStateDelta(previous: GameState, next: GameState): StateDelta {
  return differ.diff(previous, next);
}

/** Apply a server-issued delta onto a client/server snapshot. */
export function applyStateDelta(base: GameState, delta: StateDelta): GameState {
  if (!delta) return cloneState(base);
  const patched = patcher.patch(cloneState(base), delta) as GameState;
  return patched;
}

/**
 * Heuristic: if the delta is larger than ~40% of the full payload, send full state.
 * Avoids pathological diffs when most of the tree changed (e.g. game start).
 */
export function shouldSendFullState(previous: GameState, next: GameState, delta: StateDelta): boolean {
  if (!delta) return false;
  const deltaSize = JSON.stringify(delta).length;
  const fullSize = JSON.stringify(next).length;
  return deltaSize > fullSize * 0.4;
}

export function buildDeltaPayload(
  previous: GameState,
  next: GameState,
  version: number,
  log: string
): DeltaPayload {
  const delta = createStateDelta(previous, next);
  const seq = Date.now();
  const full = shouldSendFullState(previous, next, delta);

  if (full) {
    return { full: true, version, seq, log, state: next };
  }

  return { full: false, version, seq, log, delta };
}
