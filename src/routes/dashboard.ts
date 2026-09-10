import { Router } from 'express';
import type { AuthedRequest } from '../middleware/auth';
import { requireSubscriber } from '../middleware/auth';
import { rounds, predictions } from '../db';
import { predictNextColor, getPredictorInfo } from '../services/predictor';
import { simulateFromPredictions, stakeTable, createGaleState } from '../services/gale-simulator';
import { getCollectorStatus } from '../services/blaze-collector';

const router = Router();

const DISCLAIMER =
  'Double é RNG. Sem apostas reais, sem login na Blaze, sem sinais Telegram, sem garantia de lucro. Lab educativo apenas.';

router.get('/live', requireSubscriber, (_req: AuthedRequest, res) => {
  const latest = rounds.latest(60);
  const pred = predictNextColor();
  const stats = predictions.stats();
  const recentPreds = predictions.recent(80);
  const gale = simulateFromPredictions(
    recentPreds
      .filter((p) => p.actual_color)
      .map((p) => ({
        predicted_color: p.predicted_color,
        actual_color: p.actual_color!,
        confidence: p.confidence,
      }))
  );

  res.json({
    disclaimer: DISCLAIMER,
    colors: latest.map((r) => ({
      id: r.id,
      blaze_id: r.blaze_id,
      color: r.color,
      roll: r.roll,
      created_at: r.created_at,
    })),
    prediction: {
      color: pred.color,
      confidence: pred.confidence,
      probabilities: pred.probabilities,
      modelType: pred.modelType,
      locked: true,
    },
    accuracy: stats,
    model: getPredictorInfo(),
    gale: {
      ...gale,
      history: gale.history.slice(-30),
      stakes: stakeTable(gale.bank || 1100),
      initial: createGaleState(),
    },
    collector: getCollectorStatus(),
  });
});

router.get('/stats', requireSubscriber, (_req, res) => {
  res.json({
    disclaimer: DISCLAIMER,
    accuracy: predictions.stats(),
    rounds: rounds.count(),
    model: getPredictorInfo(),
    recent: predictions.recent(30),
  });
});

export default router;
