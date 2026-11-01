/**
 * Background thread for Centuries: regenerates the world from its parameters (deterministic,
 * so it matches the page's) and simulates its history, which takes about a second.
 */
import { generateWorld, type WorldParams } from './world.ts';
import { gameData } from './gamedata.ts';
import { simulateHistory, type History } from './civ.ts';

export interface HistoryRequest { id: number; params: WorldParams }
export interface HistoryResult { id: number; history: History }

self.onmessage = (e: MessageEvent<HistoryRequest>) => {
  const w = generateWorld(e.data.params);
  const history = simulateHistory(w, gameData(w));
  (self as unknown as Worker).postMessage({ id: e.data.id, history } satisfies HistoryResult);
};
