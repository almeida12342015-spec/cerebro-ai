/**
 * Background collector for Blaze Double (blaze.bet.br).
 *
 * Primary: Blaze public API (current + recent history) — múltiplas URLs.
 * Fallback: FALLBACK_HISTORY_URL (lista separada por vírgula) e/ou proxy BR.
 *
 * NO Blaze login. NO auto-betting. Read-only observation of public round results.
 *
 * Geo-block: IPs de cloud US (ex. Render Oregon) costumam receber HTTP 451 / code 1016.
 * Soluções: br-relay no Brasil, FALLBACK_HISTORY_URL, ou BLAZE_HTTP_PROXY.
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { rounds, collectorMeta, predictions } from '../db';
import type { Color, CollectorStatus } from '../types';
import { onNewRound, predictNextColor, retrainFromDb } from './predictor';

const PRIMARY_URLS = [
  'https://blaze.bet.br/api/singleplayer-originals/originals/roulette_games/recent/history/1',
  'https://blaze.bet.br/api/singleplayer-originals/originals/roulette_games/current/1',
  'https://blaze.com/api/roulette_games/recent',
  'https://blaze.com/api/roulette_games/current',
];

function getFallbackUrls(): string[] {
  const raw = process.env.FALLBACK_HISTORY_URL || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function getProxyDispatcher(): ProxyAgent | undefined {
  const proxyUrl = process.env.BLAZE_HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxyUrl) return undefined;
  try {
    return new ProxyAgent(proxyUrl);
  } catch (e) {
    console.warn('[collector] proxy inválido:', (e as Error).message);
    return undefined;
  }
}

const REQUEST_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Origin: 'https://blaze.bet.br',
  Referer: 'https://blaze.bet.br/',
};

function rollToColor(roll: number): Color {
  if (roll === 0) return 'white';
  if (roll >= 1 && roll <= 7) return 'red';
  return 'black'; // 8-14
}

export interface BlazeGame {
  id: string | number;
  roll?: number;
  color?: number | string; // 0 white, 1 red, 2 black (API) ou string
  created_at?: string;
  status?: string;
}

export function normalizeGame(
  g: BlazeGame
): { blaze_id: string; color: Color; roll: number; created_at: string } | null {
  if (g == null || g.id == null) return null;
  const blaze_id = String(g.id);
  let roll = typeof g.roll === 'number' && Number.isFinite(g.roll) ? g.roll : -1;
  let color: Color | null = null;

  if (typeof g.color === 'number') {
    color = g.color === 0 ? 'white' : g.color === 1 ? 'red' : g.color === 2 ? 'black' : null;
  } else if (typeof g.color === 'string') {
    const c = g.color.toLowerCase();
    if (c === 'white' || c === 'vermelho' || c === 'red' || c === 'black' || c === 'preto' || c === 'branco') {
      color = c === 'white' || c === 'branco' ? 'white' : c === 'red' || c === 'vermelho' ? 'red' : 'black';
    } else if (c === '0' || c === '1' || c === '2') {
      const n = Number(c);
      color = n === 0 ? 'white' : n === 1 ? 'red' : 'black';
    }
  }

  if (color) {
    if (roll < 0) {
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

function extractGames(data: unknown): BlazeGame[] {
  if (data == null) return [];
  if (Array.isArray(data)) return data as BlazeGame[];
  if (typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.data)) return obj.data as BlazeGame[];
  if (Array.isArray(obj.records)) return obj.records as BlazeGame[];
  if (Array.isArray(obj.games)) return obj.games as BlazeGame[];
  // single current game object with id
  if (obj.id != null) return [obj as unknown as BlazeGame];
  return [];
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastFetchAt: string | null = null;
let lastSuccessAt: string | null = null;
let lastError: string | null = null;
let source = 'idle';
let roundsCollectedSession = 0;
let retrainCounter = 0;
let proxyDispatcher: ProxyAgent | undefined | null = null; // null = not resolved yet

function dispatcher(): ProxyAgent | undefined {
  if (proxyDispatcher === null) {
    proxyDispatcher = getProxyDispatcher();
    if (proxyDispatcher) {
      console.log('[collector] usando proxy HTTP (BLAZE_HTTP_PROXY / HTTPS_PROXY)');
    }
  }
  return proxyDispatcher;
}

async function fetchJson(url: string): Promise<unknown> {
  const opts: Parameters<typeof undiciFetch>[1] = {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(12_000),
  };
  const d = dispatcher();
  if (d) {
    (opts as { dispatcher?: ProxyAgent }).dispatcher = d;
  }
  const res = await undiciFetch(url, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint = body.includes('1016') || res.status === 451 ? ' (geo-block 451/1016?)' : '';
    throw new Error(`HTTP ${res.status} from ${url}${hint}`);
  }
  return res.json();
}

async function tryUrls(urls: string[], label: string): Promise<{ games: BlazeGame[]; used: string } | null> {
  const errors: string[] = [];
  for (const url of urls) {
    try {
      const data = await fetchJson(url);
      const games = extractGames(data);
      if (games.length > 0) {
        return { games, used: `${label}:${url}` };
      }
      // empty but OK response — keep trying
      errors.push(`${url}: empty`);
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  if (errors.length) {
    lastError = errors.slice(0, 3).join(' | ');
  }
  return null;
}

async function fetchAllGames(): Promise<BlazeGame[]> {
  const fallbacks = getFallbackUrls();
  // Prefer history-like URLs first among primaries, then fallbacks, then remaining
  const ordered = [...PRIMARY_URLS, ...fallbacks.filter((u) => !PRIMARY_URLS.includes(u))];

  const historyLike = ordered.filter((u) => /history|recent/i.test(u));
  const currentLike = ordered.filter((u) => /current/i.test(u) && !historyLike.includes(u));
  const other = ordered.filter((u) => !historyLike.includes(u) && !currentLike.includes(u));

  const map = new Map<string, BlazeGame>();

  const hist = await tryUrls([...historyLike, ...other], 'history');
  if (hist) {
    source = hist.used.includes('FALLBACK') || fallbacks.some((f) => hist.used.includes(f))
      ? 'fallback-history-url'
      : 'blaze-api-history';
    for (const g of hist.games) map.set(String(g.id), g);
  }

  const curr = await tryUrls(currentLike, 'current');
  if (curr) {
    if (!hist) source = 'blaze-api-current';
    for (const g of curr.games) {
      if (g.status === 'complete' || typeof g.roll === 'number' || typeof g.color === 'number') {
        map.set(String(g.id), g);
      }
    }
  }

  // If nothing from categorized lists, try everything once more as a flat list
  if (map.size === 0) {
    const any = await tryUrls(ordered, 'any');
    if (any) {
      source = fallbacks.some((f) => any.used.includes(f)) ? 'fallback-history-url' : 'blaze-api';
      for (const g of any.games) map.set(String(g.id), g);
    } else {
      source = 'none';
    }
  }

  return [...map.values()];
}

/**
 * Shared ingest path used by the background collector and POST /api/ingest/rounds.
 * Accepts raw Blaze-shaped games (id + roll/color). Returns number inserted.
 */
export async function ingestGames(games: BlazeGame[]): Promise<number> {
  // oldest first for model order
  const normalized = games
    .map(normalizeGame)
    .filter((x): x is NonNullable<typeof x> => !!x)
    .reverse();

  let inserted = 0;
  for (const g of normalized) {
    const row = rounds.insert(g);
    if (row) {
      inserted++;
      roundsCollectedSession++;
      predictions.resolveLatestOpen(row.color, row.id);
      const hist = rounds.allColorsAsc(5000);
      const before = hist.slice(0, -1);
      await onNewRound(before, row.color);
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

/**
 * Ingest from external relay body shape: { id, roll?, color?, created_at? }
 */
export async function ingestExternalRounds(
  roundsIn: Array<{ id: string | number; roll?: number; color?: number | string; created_at?: string }>
): Promise<number> {
  const games: BlazeGame[] = roundsIn.map((r) => ({
    id: r.id,
    roll: r.roll,
    color: r.color,
    created_at: r.created_at,
    status: 'complete',
  }));
  const n = await ingestGames(games);
  if (n > 0) {
    lastSuccessAt = new Date().toISOString();
    lastError = null;
    source = 'ingest-api';
    collectorMeta.set('last_success_at', lastSuccessAt);
    collectorMeta.set('last_error', '');
    collectorMeta.set('source', source);
  }
  return n;
}

async function tick(): Promise<void> {
  lastFetchAt = new Date().toISOString();
  collectorMeta.set('last_fetch_at', lastFetchAt);
  try {
    const games = await fetchAllGames();
    const n = await ingestGames(games);
    if (n > 0 || games.length > 0) {
      lastSuccessAt = new Date().toISOString();
      lastError = null;
      collectorMeta.set('last_success_at', lastSuccessAt);
      collectorMeta.set('last_error', '');
      collectorMeta.set('source', source);
    } else if (source === 'none') {
      collectorMeta.set('last_error', lastError || 'nenhuma URL Blaze respondeu');
      collectorMeta.set('source', 'none');
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
  if (process.env.BLAZE_HTTP_PROXY || process.env.HTTPS_PROXY) {
    console.log('[collector] proxy configurado via env');
  }
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
