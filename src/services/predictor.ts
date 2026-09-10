/**
 * predictNextColor() — TensorFlow.js multinomial logistic regression when available,
 * with a pure-TS/JSON weighted frequency fallback if tfjs-node fails to load.
 *
 * Features: one-hot of last N colors + simple streak/transition counts.
 * Disclaimer: Double is RNG; this is entertainment / lab only — no edge claimed.
 */

import type { Color } from '../types';
import { modelState, rounds } from '../db';

const LOOKBACK = 12;
const COLORS: Color[] = ['red', 'black', 'white'];
const COLOR_INDEX: Record<Color, number> = { red: 0, black: 1, white: 2 };

export interface PredictionResult {
  color: Color;
  confidence: number;
  probabilities: Record<Color, number>;
  modelType: 'tfjs' | 'logistic-fallback';
  locked: true;
}

type TfModule = typeof import('@tensorflow/tfjs-node');

let tf: TfModule | null = null;
let tfModel: InstanceType<TfModule['Sequential']> | null = null;
let tfReady = false;
let useFallback = true;

/** Softmax multinomial logistic weights (fallback) */
interface FallbackWeights {
  W: number[][]; // [features][3]
  b: number[]; // [3]
  nSamples: number;
}

let fallback: FallbackWeights = {
  W: [],
  b: [0, 0, 0],
  nSamples: 0,
};

function featureDim(): number {
  // LOOKBACK one-hots (LOOKBACK * 3) + streak of last color (1) + last-was-white (1) + red/black ratio in window (1)
  return LOOKBACK * 3 + 3;
}

function encodeHistory(history: Color[]): Float32Array | null {
  if (history.length < LOOKBACK) return null;
  const window = history.slice(-LOOKBACK);
  const feats = new Float32Array(featureDim());
  for (let i = 0; i < LOOKBACK; i++) {
    const c = window[i];
    feats[i * 3 + COLOR_INDEX[c]] = 1;
  }
  // streak
  let streak = 1;
  const last = window[LOOKBACK - 1];
  for (let i = LOOKBACK - 2; i >= 0; i--) {
    if (window[i] === last) streak++;
    else break;
  }
  feats[LOOKBACK * 3] = Math.min(streak, 10) / 10;
  feats[LOOKBACK * 3 + 1] = last === 'white' ? 1 : 0;
  const reds = window.filter((c) => c === 'red').length;
  const blacks = window.filter((c) => c === 'black').length;
  const rb = reds + blacks;
  feats[LOOKBACK * 3 + 2] = rb ? reds / rb : 0.5;
  return feats;
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

function initFallback(): void {
  const d = featureDim();
  fallback = {
    W: Array.from({ length: d }, () => [0, 0, 0].map(() => (Math.random() - 0.5) * 0.01)),
    b: [0, 0, 0],
    nSamples: 0,
  };
}

function predictFallback(feats: Float32Array): PredictionResult {
  const logits = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let s = fallback.b[k];
    for (let i = 0; i < feats.length; i++) s += feats[i] * fallback.W[i][k];
    logits[k] = s;
  }
  const probs = softmax(logits);
  let best = 0;
  for (let i = 1; i < 3; i++) if (probs[i] > probs[best]) best = i;
  // Prefer red/black for gale lab; if white is top but close, pick second if confidence gap small
  let color = COLORS[best];
  let confidence = probs[best];
  if (color === 'white') {
    const second = probs[0] >= probs[1] ? 0 : 1;
    if (probs[second] > 0.28) {
      color = COLORS[second];
      confidence = probs[second];
    }
  }
  return {
    color,
    confidence,
    probabilities: { red: probs[0], black: probs[1], white: probs[2] },
    modelType: 'logistic-fallback',
    locked: true,
  };
}

function trainFallbackStep(feats: Float32Array, label: Color, lr = 0.05): void {
  const logits = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let s = fallback.b[k];
    for (let i = 0; i < feats.length; i++) s += feats[i] * fallback.W[i][k];
    logits[k] = s;
  }
  const probs = softmax(logits);
  const y = [0, 0, 0];
  y[COLOR_INDEX[label]] = 1;
  for (let k = 0; k < 3; k++) {
    const err = probs[k] - y[k];
    fallback.b[k] -= lr * err;
    for (let i = 0; i < feats.length; i++) {
      fallback.W[i][k] -= lr * err * feats[i];
    }
  }
  fallback.nSamples++;
}

async function tryLoadTf(): Promise<void> {
  try {
    tf = await import('@tensorflow/tfjs-node');
    const model = tf.sequential();
    model.add(
      tf.layers.dense({
        units: 24,
        activation: 'relu',
        inputShape: [featureDim()],
      })
    );
    model.add(tf.layers.dense({ units: 3, activation: 'softmax' }));
    model.compile({
      optimizer: tf.train.adam(0.01),
      loss: 'categoricalCrossentropy',
      metrics: ['accuracy'],
    });
    tfModel = model;
    tfReady = true;
    useFallback = false;
    console.log('[predictor] TensorFlow.js carregado');
  } catch (e) {
    console.warn('[predictor] tfjs-node indisponível — usando fallback logístico TS/JSON:', (e as Error).message);
    useFallback = true;
    tfReady = false;
  }
}

function persistFallback(): void {
  modelState.save(JSON.stringify({ type: 'logistic-fallback', ...fallback }));
}

function loadPersisted(): void {
  const raw = modelState.load();
  if (!raw) {
    initFallback();
    return;
  }
  try {
    const parsed = JSON.parse(raw) as { type?: string; W: number[][]; b: number[]; nSamples: number };
    if (parsed.W?.length === featureDim() && parsed.b?.length === 3) {
      fallback = { W: parsed.W, b: parsed.b, nSamples: parsed.nSamples || 0 };
      return;
    }
  } catch {
    /* ignore */
  }
  initFallback();
}

export async function initPredictor(): Promise<void> {
  loadPersisted();
  await tryLoadTf();
  // warm train from history
  await retrainFromDb();
}

export async function retrainFromDb(): Promise<void> {
  const history = rounds.allColorsAsc(5000);
  if (history.length < LOOKBACK + 10) return;

  if (!useFallback && tf && tfModel) {
    const xs: number[][] = [];
    const ys: number[][] = [];
    for (let i = LOOKBACK; i < history.length; i++) {
      const feats = encodeHistory(history.slice(0, i));
      if (!feats) continue;
      xs.push(Array.from(feats));
      const y = [0, 0, 0];
      y[COLOR_INDEX[history[i]]] = 1;
      ys.push(y);
    }
    if (xs.length < 5) return;
    const xTensor = tf.tensor2d(xs);
    const yTensor = tf.tensor2d(ys);
    await tfModel.fit(xTensor, yTensor, { epochs: 8, batchSize: 32, verbose: 0 });
    xTensor.dispose();
    yTensor.dispose();
  } else {
    // online-ish batch for fallback
    for (let i = LOOKBACK; i < history.length; i++) {
      const feats = encodeHistory(history.slice(0, i));
      if (!feats) continue;
      trainFallbackStep(feats, history[i], 0.03);
    }
    persistFallback();
  }
}

/** Call when a new round arrives — update model incrementally */
export async function onNewRound(history: Color[], newColor: Color): Promise<void> {
  if (history.length < LOOKBACK) return;
  const feats = encodeHistory(history);
  if (!feats) return;

  if (!useFallback && tf && tfModel) {
    const x = tf.tensor2d([Array.from(feats)]);
    const yArr = [0, 0, 0];
    yArr[COLOR_INDEX[newColor]] = 1;
    const y = tf.tensor2d([yArr]);
    await tfModel.fit(x, y, { epochs: 1, verbose: 0 });
    x.dispose();
    y.dispose();
  } else {
    trainFallbackStep(feats, newColor);
    if (fallback.nSamples % 20 === 0) persistFallback();
  }
}

export function predictNextColor(history?: Color[]): PredictionResult {
  const hist = history ?? rounds.allColorsAsc(5000);
  const feats = encodeHistory(hist);
  if (!feats) {
    // not enough data — weak prior
    return {
      color: 'red',
      confidence: 0.34,
      probabilities: { red: 0.34, black: 0.34, white: 0.32 },
      modelType: useFallback ? 'logistic-fallback' : 'tfjs',
      locked: true,
    };
  }

  if (!useFallback && tf && tfModel) {
    const x = tf.tensor2d([Array.from(feats)]);
    const out = tfModel.predict(x) as InstanceType<TfModule['Tensor']>;
    const data = Array.from(out.dataSync()) as number[];
    x.dispose();
    out.dispose();
    let best = 0;
    for (let i = 1; i < 3; i++) if (data[i] > data[best]) best = i;
    let color = COLORS[best];
    let confidence = data[best];
    if (color === 'white') {
      const second = data[0] >= data[1] ? 0 : 1;
      if (data[second] > 0.28) {
        color = COLORS[second];
        confidence = data[second];
      }
    }
    return {
      color,
      confidence,
      probabilities: { red: data[0], black: data[1], white: data[2] },
      modelType: 'tfjs',
      locked: true,
    };
  }

  return predictFallback(feats);
}

export function getPredictorInfo(): { modelType: string; samples: number; lookback: number } {
  return {
    modelType: useFallback || !tfReady ? 'logistic-fallback' : 'tfjs',
    samples: fallback.nSamples,
    lookback: LOOKBACK,
  };
}
