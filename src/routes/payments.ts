import { Router } from 'express';
import type { AuthedRequest } from '../middleware/auth';
import { requireAuth } from '../middleware/auth';
import { createPixCheckout, handleWebhook, hasMercadoPago, PRICE_LABEL } from '../services/mercadopago';
import { payments } from '../db';

const router = Router();

router.get('/pricing', (_req, res) => {
  res.json({
    price: PRICE_LABEL,
    amount_cents: 2990,
    currency: 'BRL',
    mercadopago_configured: hasMercadoPago(),
    disclaimer:
      'Double é RNG. Sem apostas reais, sem login na Blaze, sem sinais Telegram, sem garantia de lucro.',
  });
});

router.post('/checkout', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const payment = await createPixCheckout(req.user!.id, req.user!.email);
    res.json({
      payment: {
        id: payment.id,
        status: payment.status,
        amount_cents: payment.amount_cents,
        pix_qr_code: payment.pix_qr_code,
        pix_qr_base64: payment.pix_qr_base64,
        stub: payment.status === 'stub',
      },
      mercadopago_configured: hasMercadoPago(),
    });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

router.get('/mine', requireAuth, (req: AuthedRequest, res) => {
  res.json({ payments: payments.listByUser(req.user!.id) });
});

router.post('/webhook/mercadopago', async (req, res) => {
  try {
    const result = await handleWebhook(req.body || {});
    res.status(200).json(result);
  } catch (e) {
    console.error('[webhook]', e);
    res.status(200).json({ ok: false, message: (e as Error).message });
  }
});

// alias used in MP notification_url
router.post('/webhooks/mercadopago', async (req, res) => {
  try {
    const result = await handleWebhook(req.body || {});
    res.status(200).json(result);
  } catch (e) {
    res.status(200).json({ ok: false, message: (e as Error).message });
  }
});

export default router;
