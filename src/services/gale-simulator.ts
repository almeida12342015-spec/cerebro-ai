/**
 * Simulated bank / gale lab (educational only).
 * - Initial bank R$1100; stake 1% floor
 * - G0/G1/G2: 11/22/44 at bank 1100; scale to 20/40/80 at 2000 (linear)
 * - White = skip (no stake change)
 * - G2 loss => 30-round cooldown
 * - Pending gale resumes on next confident signal
 *
 * NO real bets. Double is RNG.
 */

import type { Color, GaleHistoryEntry, GaleState } from '../types';

const INITIAL = 1100;
const STAKE_PCT = 0.01;
const COOLDOWN_ROUNDS = 30;
const CONFIDENCE_MIN = 0.38;

function galeStakes(bank: number): [number, number, number] {
  // At 1100: 11/22/44; at 2000: 20/40/80 — linear interpolate by bank/1100
  const scale = bank / INITIAL;
  const g0 = Math.max(bank * STAKE_PCT, 11 * scale);
  return [round2(g0), round2(g0 * 2), round2(g0 * 4)];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function createGaleState(initialBank = INITIAL): GaleState {
  return {
    bank: initialBank,
    initialBank,
    stakePercent: STAKE_PCT,
    currentGale: null,
    cooldownUntilRound: null,
    pendingGale: null,
    history: [],
    wins: 0,
    losses: 0,
    skippedWhites: 0,
  };
}

export interface GaleStepInput {
  state: GaleState;
  roundIndex: number;
  predicted: Color;
  actual: Color;
  confidence: number;
}

export function stepGale(input: GaleStepInput): GaleState {
  const state: GaleState = {
    ...input.state,
    history: [...input.state.history],
  };

  if (input.actual === 'white') {
    state.skippedWhites++;
    state.history.push({
      roundIndex: input.roundIndex,
      galeLevel: state.currentGale ?? 0,
      stake: 0,
      predicted: input.predicted,
      actual: input.actual,
      result: 'skip_white',
      bankAfter: state.bank,
      confidence: input.confidence,
    });
    return state;
  }

  // cooldown
  if (state.cooldownUntilRound != null && input.roundIndex < state.cooldownUntilRound) {
    return state;
  }
  if (state.cooldownUntilRound != null && input.roundIndex >= state.cooldownUntilRound) {
    state.cooldownUntilRound = null;
  }

  // need confident signal to open or continue pending
  let level: 0 | 1 | 2;
  if (state.pendingGale != null) {
    level = state.pendingGale;
    state.pendingGale = null;
  } else if (state.currentGale != null) {
    level = state.currentGale;
  } else {
    if (input.confidence < CONFIDENCE_MIN || input.predicted === 'white') {
      return state;
    }
    level = 0;
  }

  const stakes = galeStakes(state.bank);
  const stake = Math.min(stakes[level], state.bank);
  if (stake <= 0) return state;

  const win = input.predicted === input.actual;
  // Blaze Double pays ~2x on red/black (even money simplified for lab)
  if (win) {
    state.bank = round2(state.bank + stake);
    state.wins++;
    state.currentGale = null;
    state.history.push({
      roundIndex: input.roundIndex,
      galeLevel: level,
      stake,
      predicted: input.predicted,
      actual: input.actual,
      result: 'win',
      bankAfter: state.bank,
      confidence: input.confidence,
    });
  } else {
    state.bank = round2(state.bank - stake);
    state.losses++;
    state.history.push({
      roundIndex: input.roundIndex,
      galeLevel: level,
      stake,
      predicted: input.predicted,
      actual: input.actual,
      result: 'loss',
      bankAfter: state.bank,
      confidence: input.confidence,
    });
    if (level >= 2) {
      state.currentGale = null;
      state.pendingGale = null;
      state.cooldownUntilRound = input.roundIndex + COOLDOWN_ROUNDS;
    } else {
      const next = (level + 1) as 1 | 2;
      state.currentGale = next;
      state.pendingGale = next; // pending until next confident signal
    }
  }

  return state;
}

/** Replay last N resolved predictions for the lab table */
export function simulateFromPredictions(
  rows: { predicted_color: Color; actual_color: Color; confidence: number }[]
): GaleState {
  let state = createGaleState();
  // oldest first
  const ordered = [...rows].reverse();
  let idx = 0;
  for (const r of ordered) {
    if (!r.actual_color) continue;
    state = stepGale({
      state,
      roundIndex: idx++,
      predicted: r.predicted_color,
      actual: r.actual_color,
      confidence: r.confidence,
    });
  }
  return state;
}

export function stakeTable(bank: number): { g0: number; g1: number; g2: number; cooldown: number } {
  const [g0, g1, g2] = galeStakes(bank);
  return { g0, g1, g2, cooldown: COOLDOWN_ROUNDS };
}
