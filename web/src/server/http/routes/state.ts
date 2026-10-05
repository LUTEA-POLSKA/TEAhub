/**
 * Per-database process state.
 *
 * Held in a `WeakMap` keyed by the database handle so tests get their own
 * limiters instead of sharing one global — a shared counter turns two independent
 * tests into one flaky one.
 */
import type { Db } from '../../db/task-store';
import { RateWindow } from '../guard';

export interface PerDbState {
  writeLimiter: RateWindow;
}

const states = new WeakMap<object, PerDbState>();

export function rateWindow(db: Db): RateWindow {
  return stateFor(db).writeLimiter;
}

export function stateFor(db: Db): PerDbState {
  let state = states.get(db);
  if (!state) {
    state = { writeLimiter: new RateWindow() };
    states.set(db, state);
  }
  return state;
}