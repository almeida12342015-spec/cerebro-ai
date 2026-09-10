/**
 * Mercado Pago PIX checkout — R$ 29,90 / mês.
 * If MERCADOPAGO_ACCESS_TOKEN is missing, returns a graceful stub payment
 * so the app still runs; admin can grant days manually.
 */

import { randomUUID } from 'crypto';
import { payments, users } from '../db';
import type { Payment } from '../types';

const AMOUNT_CENTS = 2990;
const AMOUNT = 29.9;

export function hasMercadoPago(): boolean {
  return Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN?.trim());
}

export async function createPixCheckout(userId: string, payerEmail: string): Promise<Payment> {
  const id = randomUUID();

  if (!hasMercadoPago()) {
    const stub = payments.create({
      id,
      user_id: userId,
      provider: 'mercadopago-stub',
      provider_id: `stub-${id}`,
      amount_cents: AMOUNT_CENTS,
      status: 'stub',
      pix_qr_code: 'STUB-PIX-SEM-TOKEN-MERCADOPAGO — peça ao admin para liberar dias ou configure MERCADOPAGO_ACCESS_TOKEN',
      pix_qr_base64: null,
    });
    return stub;
  }

  const token = process.env.MERCADOPAGO_ACCESS_TOKEN!.trim();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  const body = {
    transaction_amount: AMOUNT,
    description: 'Relógio Double — assinatura mensal',
    payment_method_id: 'pix',
    payer: { email: payerEmail },
    external_reference: id,
    notification_url: `${baseUrl}/api/webhooks/mercadopago`,
  };

  const res = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': id,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mercado Pago error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    id: number;
    status: string;
    point_of_interaction?: {
      transaction_data?: { qr_code?: string; qr_code_base64?: string };
    };
  };

  const qr = data.point_of_interaction?.transaction_data?.qr_code ?? null;
  const qr64 = data.point_of_interaction?.transaction_data?.qr_code_base64 ?? null;

  return payments.create({
    id,
    user_id: userId,
    provider: 'mercadopago',
    provider_id: String(data.id),
    amount_cents: AMOUNT_CENTS,
    status: data.status === 'approved' ? 'approved' : 'pending',
    pix_qr_code: qr,
    pix_qr_base64: qr64,
  });
}

export async function handleWebhook(payload: {
  action?: string;
  type?: string;
  data?: { id?: string };
}): Promise<{ ok: boolean; message: string }> {
  if (!hasMercadoPago()) {
    return { ok: true, message: 'stub mode — webhook ignored' };
  }

  const paymentId = payload.data?.id;
  if (!paymentId) return { ok: false, message: 'missing payment id' };

  const token = process.env.MERCADOPAGO_ACCESS_TOKEN!.trim();
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { ok: false, message: `fetch payment ${res.status}` };

  const data = (await res.json()) as {
    id: number;
    status: string;
    external_reference?: string;
  };

  const local =
    (data.external_reference && payments.findById(data.external_reference)) ||
    payments.findByProviderId(String(data.id));

  if (!local) return { ok: false, message: 'payment not found locally' };

  if (data.status === 'approved' && local.status !== 'approved') {
    payments.updateStatus(local.id, 'approved', String(data.id));
    users.grantDays(local.user_id, 30);
    return { ok: true, message: 'approved — +30 days' };
  }

  if (['rejected', 'cancelled', 'refunded'].includes(data.status)) {
    payments.updateStatus(local.id, data.status === 'refunded' ? 'cancelled' : (data.status as Payment['status']), String(data.id));
  }

  return { ok: true, message: `status ${data.status}` };
}

export const PRICE_LABEL = 'R$ 29,90/mês';
export const PRICE_CENTS = AMOUNT_CENTS;
