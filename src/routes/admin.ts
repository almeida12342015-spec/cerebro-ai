import { Router } from 'express';
import { z } from 'zod';
import type { AuthedRequest } from '../middleware/auth';
import { requireAdmin } from '../middleware/auth';
import { users, payments, rounds } from '../db';
import { getCollectorStatus } from '../services/blaze-collector';
import { getPredictorInfo } from '../services/predictor';
import { hasMercadoPago } from '../services/mercadopago';

const router = Router();

router.use(requireAdmin);

router.get('/users', (_req, res) => {
  const list = users.list().map((u) => ({
    id: u.id,
    email: u.email,
    role: u.role,
    paid_until: u.paid_until,
    created_at: u.created_at,
  }));
  res.json({ users: list });
});

router.post('/users/:id/grant', (req: AuthedRequest, res) => {
  const days = z.coerce.number().int().min(1).max(365).safeParse(req.body?.days ?? 30);
  if (!days.success) {
    res.status(400).json({ error: 'days inválido' });
    return;
  }
  const user = users.findById(req.params.id);
  if (!user) {
    res.status(404).json({ error: 'Usuário não encontrado' });
    return;
  }
  const updated = users.grantDays(user.id, days.data);
  res.json({ user: { id: updated.id, email: updated.email, paid_until: updated.paid_until } });
});

router.post('/users/:id/revoke', (req, res) => {
  const user = users.findById(req.params.id);
  if (!user) {
    res.status(404).json({ error: 'Usuário não encontrado' });
    return;
  }
  if (user.role === 'admin') {
    res.status(400).json({ error: 'Não é possível revogar admin' });
    return;
  }
  users.revoke(user.id);
  res.json({ ok: true });
});

router.get('/payments', (_req, res) => {
  res.json({ payments: payments.list(200), mercadopago_configured: hasMercadoPago() });
});

router.get('/collector', (_req, res) => {
  res.json({
    collector: getCollectorStatus(),
    rounds: rounds.count(),
    model: getPredictorInfo(),
  });
});

router.get('/overview', (_req, res) => {
  res.json({
    users: users.list().length,
    rounds: rounds.count(),
    payments: payments.list(5),
    collector: getCollectorStatus(),
    mercadopago_configured: hasMercadoPago(),
    model: getPredictorInfo(),
  });
});

export default router;
