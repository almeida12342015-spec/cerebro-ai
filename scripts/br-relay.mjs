#!/usr/bin/env node
/**
 * br-relay.mjs — Relé brasileiro para contornar geo-block da Blaze (HTTP 451 / code 1016)
 *
 * Rode esta máquina/script em uma rede no Brasil (residencial, VPS BR, etc.).
 * Ele consulta o histórico público da Blaze e envia rodadas novas para o
 * backend (ex.: Render Oregon) via POST /api/ingest/rounds.
 *
 * Uso:
 *   export TARGET_URL="https://seu-app.onrender.com"
 *   export INGEST_SECRET="mesma-chave-do-servidor"
 *   export INTERVAL_MS=5000          # opcional (default 5000)
 *   node scripts/br-relay.mjs
 *
 * Variáveis:
 *   TARGET_URL     — URL base do Relógio Double (obrigatório)
 *   INGEST_SECRET  — deve coincidir com INGEST_SECRET do servidor (obrigatório)
 *   INTERVAL_MS    — intervalo de polling em ms (default 5000)
 *
 * Requisitos: Node 18+ (fetch nativo). Sem dependências npm.
 */

const TARGET_URL = (process.env.TARGET_URL || '').replace(/\/$/, '');
const INGEST_SECRET = process.env.INGEST_SECRET || '';
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 5000);

const HISTORY_URLS = [
  'https://blaze.bet.br/api/singleplayer-originals/originals/roulette_games/recent/history/1',
  'https://blaze.com/api/roulette_games/recent',
];

const HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Origin: 'https://blaze.bet.br',
  Referer: 'https://blaze.bet.br/',
};

if (!TARGET_URL || !INGEST_SECRET) {
  console.error(`
[br-relay] Configuração incompleta.

Defina no ambiente:
  TARGET_URL      URL do backend, ex: https://seu-app.onrender.com
  INGEST_SECRET   Mesma chave configurada no servidor (INGEST_SECRET)
  INTERVAL_MS     Opcional, default 5000

Exemplo:
  TARGET_URL=https://seu-app.onrender.com INGEST_SECRET=segredo node scripts/br-relay.mjs
`);
  process.exit(1);
}

const seen = new Set();
let tickCount = 0;

function extractGames(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.records)) return data.records;
  if (Array.isArray(data.games)) return data.games;
  if (data.id != null) return [data];
  return [];
}

async function fetchHistory() {
  const errors = [];
  for (const url of HISTORY_URLS) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        errors.push(`${url} → HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const games = extractGames(data);
      if (games.length) return { games, url };
      errors.push(`${url} → vazio`);
    } catch (e) {
      errors.push(`${url} → ${e.message}`);
    }
  }
  throw new Error(errors.join(' | ') || 'nenhuma URL respondeu');
}

async function postRounds(rounds) {
  const res = await fetch(`${TARGET_URL}/api/ingest/rounds`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Ingest-Secret': INGEST_SECRET,
      Accept: 'application/json',
    },
    body: JSON.stringify({ rounds }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`ingest HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function tick() {
  tickCount++;
  try {
    const { games, url } = await fetchHistory();
    const fresh = [];
    for (const g of games) {
      const id = String(g.id);
      if (seen.has(id)) continue;
      if (g.roll == null && g.color == null) continue;
      // only finished-looking rounds
      if (g.status && g.status !== 'complete' && g.roll == null) continue;
      fresh.push({
        id: g.id,
        roll: typeof g.roll === 'number' ? g.roll : undefined,
        color: g.color,
        created_at: g.created_at,
      });
    }

    // On first successful poll, mark everything seen without flooding ingest
    // (optional warm-start: still send last ~30 so the cloud DB fills quickly)
    if (seen.size === 0 && fresh.length > 0) {
      const warm = fresh.slice(0, 40);
      for (const g of games) seen.add(String(g.id));
      if (warm.length) {
        const result = await postRounds(warm);
        console.log(
          `[br-relay] warm-start ${warm.length} rounds → inserted=${result.inserted ?? '?'} (fonte ${url})`
        );
      }
      return;
    }

    for (const g of games) seen.add(String(g.id));

    if (fresh.length === 0) {
      if (tickCount % 12 === 0) {
        console.log(`[br-relay] ok — sem rodadas novas (visto=${seen.size}, fonte=${url})`);
      }
      return;
    }

    const result = await postRounds(fresh);
    console.log(
      `[br-relay] +${fresh.length} novas → inserted=${result.inserted ?? '?'} (fonte ${url})`
    );
  } catch (e) {
    console.error(`[br-relay] erro: ${e.message}`);
  }
}

console.log(`[br-relay] alvo=${TARGET_URL} intervalo=${INTERVAL_MS}ms`);
console.log('[br-relay] iniciando polling da Blaze (rede BR recomendada)…');
void tick();
setInterval(() => void tick(), INTERVAL_MS);
