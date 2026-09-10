/**
 * Background collector for Blaze Double (blaze.bet.br).
 *
 * Primary: Blaze public API (current + recent history).
 * Fallback: documented public history mirrors / synthetic seeding comments if API fails.
 *
 * NO Blaze login. NO auto-betting. Read-only observation of public round results.
 */

import { rounds, collectorMeta, predictions } from '../db';
import type { Color, CollectorStatus } from '../types';
import { onNewRound, predictNextColor, retrainFromDb } from './predictor';

const BLAZE_CURRENT =
  'https://blaze.bet.br/api/singleplayer-originals/originals/roulette_games/current/1';
const BLAZE_HISTORY =
  'https://blaze.bet.br/api/singleplayer-originals/originals/roulette_games/recent/history/1';

/**
 * Fallback public history source (community mirrors occasionally expose JSON).
 * Documented for operators; may be empty — we then keep last known DB state.
 * Example pattern used by open monitors (not affiliated with Blaze):
 *   https://blaze.bet.br/api/singleplayer-originals/originals/roulette_games/recent/history/1
 * If Blaze blocks our egress, operators can point FALLBACK_HISTORY_URL to a proxy.
 */
const FALLBACK_HISTORY_URL =
  process.env.FALLBACK_HISTORY_URL ||
  'https://blaze.bet.br/api/singleplayer-originals/originals/roulette_games/recent/history/1';

function rollToColor(roll: number): Color {
  if (roll === 0) return 'white';
  if (roll >= 1 && roll <= 7) return 'red';
  return 'black'; // 8-14
}

interface BlazeGame {
  id: string | number;
  roll?: number;
  color?: number; // 0 white, 1 red, 2 black
  created_at?: string;
  status?: string;
}

function normalizeGame(g: BlazeGame): { blaze_id: string; color: Color; roll: number; created_at: string } | null {
  const blaze_id = String(g.id);
  let roll = typeof g.roll === 'number' ? g.roll : -1;
  let color: Color;
  if (typeof g.color === 'number') {
    color = g.color === 0 ? 'white' : g.color === 1 ? 'red' : 'black';
    if (roll < 0) {
      // invent roll consistent with color if missing
      roll = color === 'white' ? 0 : color === 'red' ? 1 : 8;
    }
  } else if (roll >= 0) {
    color = rollToColor(roll);
  } else {
    return null;
  }
  return {
    blaze_id,
    color,
    roll,
    created_at: g.created_at || new Date().toISOString(),
  };
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastFetchAt: string | null = null;
let lastSuccessAt: string | null = null;
let lastError: string | null = null;
let source = 'idle';
let roundsCollectedSession = 0;
let retrainCounter = 0;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'RelogioDoubleMonitor/1.0 (educational; no betting)',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function fetchHistory(): Promise<BlazeGame[]> {
  try {
    const data = (await fetchJson(BLAZE_HISTORY)) as BlazeGame[] | { data?: BlazeGame[]; records?: BlazeGame[] };
    source = 'blaze-api-history';
    if (Array.isArray(data)) return data;
    if (Array.isArray((data as { data?: BlazeGame[] }).data)) return (data as { data: BlazeGame[] }).data;
    if (Array.isArray((data as { records?: BlazeGame[] }).records)) return (data as { records: BlazeGame[] }).records;
    return [];
  } catch (e1) {
    lastError = `Blaze history falhou: ${(e1 as Error).message}`;
    try {
      const data = (await fetchJson(FALLBACK_HISTORY_URL)) as BlazeGame[] | { data?: BlazeGame[] };
      source = 'fallback-history-url';
      if (Array.isArray(data)) return data;
      if (Array.isArray((data as { data?: BlazeGame[] }).data)) return (data as { data: BlazeGame[] }).data;
      return [];
    } catch (e2) {
      lastError = `Fallback history falhou: ${(e2 as Error).message}`;
      source = 'none';
      return [];
    }
  }
}

async function fetchCurrent(): Promise<BlazeGame | null> {
  try {
    const data = (await fetchJson(BLAZE_CURRENT)) as BlazeGame;
    source = 'blaze-api-current';
    return data;
  } catch {
    return null;
  }
}

async function ingestGames(games: BlazeGame[]): Promise<number> {
  // oldest first for model order
  const normalized = games
    .map(normalizeGame)
    .filter((x): x is NonNullable<typeof x> => !!x)
    .reverse();

  let inserted = 0;
  for (const g of normalized) {
    // only finished rounds with known roll
    const row = rounds.insert(g);
    if (row) {
      inserted++;
      roundsCollectedSession++;
      predictions.resolveLatestOpen(row.color, row.id);
      const hist = rounds.allColorsAsc(5000);
      // hist includes the new color at end — train on prefix
      const before = hist.slice(0, -1);
      await onNewRound(before, row.color);
      // lock next prediction after ingest
      const pred = predictNextColor(hist);
      predictions.insert({
        round_id: null,
        predicted_color: pred.color,
        confidence: pred.confidence,
        actual_color: null,
        correct: null,
        model_type: pred.modelType,
      });
      retrainCounter++;
    }
  }
  if (retrainCounter >= 50) {
    retrainCounter = 0;
    await retrainFromDb().catch((e) => console.warn('[collector] retrain:', e));
  }
  return inserted;
}

async function tick(): Promise<void> {
  lastFetchAt = new Date().toISOString();
  collectorMeta.set('last_fetch_at', lastFetchAt);
  try {
    const history = await fetchHistory();
    const current = await fetchCurrent();
    const bundle: BlazeGame[] = [...history];
    if (current && (current.status === 'complete' || typeof current.roll === 'number')) {
      bundle.push(current);
    }
    // dedupe by id
    const map = new Map<string, BlazeGame>();
    for (const g of bundle) map.set(String(g.id), g);
    const n = await ingestGames([...map.values()]);
    if (n > 0 || history.length > 0) {
      lastSuccessAt = new Date().toISOString();
      lastError = null;
      collectorMeta.set('last_success_at', lastSuccessAt);
      collectorMeta.set('last_error', '');
      collectorMeta.set('source', source);
    }
  } catch (e) {
    lastError = (e as Error).message;
    collectorMeta.set('last_error', lastError);
    console.warn('[collector]', lastError);
  }
}

export function startCollector(): void {
  if (running) return;
  running = true;
  const interval = Number(process.env.COLLECTOR_INTERVAL_MS || 5000);
  console.log(`[collector] iniciando (intervalo ${interval}ms)`);
  void tick();
  timer = setInterval(() => void tick(), interval);
}

export function stopCollector(): void {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
}

export function getCollectorStatus(): CollectorStatus {
  return {
    running,
    last_fetch_at: lastFetchAt || collectorMeta.get('last_fetch_at'),
    last_success_at: lastSuccessAt || collectorMeta.get('last_success_at'),
    last_error: lastError || collectorMeta.get('last_error') || null,
    source: source || collectorMeta.get('source') || 'idle',
    rounds_collected: rounds.count(),
  };
}

/**
 * Optional seed of synthetic history when APIs are unreachable (dev only).
 * Marked clearly — not real Blaze data.
 */
export function seedSyntheticDevRounds(n = 80): void {
  if (process.env.NODE_ENV === 'production') return;
  if (rounds.count() > 0) return;
  console.warn('[collector] API offline — semeando histórico sintético DEV (não é Blaze real)');
  const colors: Color[] = ['red', 'black', 'white'];
  for (let i = 0; i < n; i++) {
    const roll = i % 15;
    const color = rollToColor(roll === 0 && Math.random() < 0.7 ? Math.floor(Math.random() * 14) + 1 : roll);
    rounds.insert({
      blaze_id: `synthetic-dev-${i}`,
      color: color === 'white' && Math.random() > 0.08 ? colors[i % 2] : color,
      roll: color === 'white' ? 0 : color === 'red' ? (i % 7) + 1 : (i % 7) + 8,
      created_at: new Date(Date.now() - (n - i) * 30_000).toISOString(),
    });
  }
}
