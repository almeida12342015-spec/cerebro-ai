import { Router } from 'express';
import { z } from 'zod';
import { ingestExternalRounds } from '../services/blaze-collector';

const router = Router();

const roundSchema = z.object({
  id: z.union([z.string(), z.number()]),
  roll: z.number().int().min(0).max(14).optional(),
  color: z.union([z.number().int().min(0).max(2), z.string()]).optional(),
  created_at: z.string().optional(),
});

const bodySchema = z.object({
  rounds: z.array(roundSchema).min(1).max(500),
});

function extractSecret(req: { headers: Record<string, unknown> }): string | null {
  const header = req.headers['x-ingest-secret'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && typeof header[0] === 'string') return header[0].trim();

  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * POST /api/ingest/rounds
 * Header: X-Ingest-Secret: $INGEST_SECRET  (ou Authorization: Bearer …)
 * Body: { rounds: [{ id, roll?, color?, created_at? }] }
 */
router.post('/rounds', async (req, res) => {
  const expected = process.env.INGEST_SECRET;
  if (!expected || !expected.trim()) {
    res.status(503).json({
      error: 'Ingest desabilitado',
      detail: 'Defina INGEST_SECRET no ambiente do servidor para habilitar este endpoint.',
    });
    return;
  }

  const provided = extractSecret(req as { headers: Record<string, unknown> });
  if (!provided || provided !== expected) {
    res.status(401).json({ error: 'Não autorizado' });
    return;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', detail: parsed.error.flatten() });
    return;
  }

  // Require at least roll or color on each round
  const invalid = parsed.data.rounds.filter(
    (r) => r.roll === undefined && r.color === undefined
  );
  if (invalid.length) {
    res.status(400).json({
      error: 'Cada round precisa de roll e/ou color',
      invalid_ids: invalid.map((r) => r.id),
    });
    return;
  }

  try {
    const inserted = await ingestExternalRounds(parsed.data.rounds);
    res.json({
      ok: true,
      received: parsed.data.rounds.length,
      inserted,
    });
  } catch (e) {
    console.error('[ingest]', e);
    res.status(500).json({ error: 'Falha ao ingerir rounds' });
  }
});

export default router;
