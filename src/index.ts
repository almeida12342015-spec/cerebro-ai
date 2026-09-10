import 'dotenv/config';
import path from 'path';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { initDb } from './db';
import { seedAdmin } from './auth/seed';
import { attachUser } from './middleware/auth';
import authRoutes from './routes/auth';
import paymentRoutes from './routes/payments';
import dashboardRoutes from './routes/dashboard';
import adminRoutes from './routes/admin';
import ingestRoutes from './routes/ingest';
import { initPredictor } from './services/predictor';
import {
  startCollector,
  seedSyntheticDevRounds,
  getCollectorStatus,
} from './services/blaze-collector';
import { hasMercadoPago } from './services/mercadopago';

async function main(): Promise<void> {
  initDb();
  await seedAdmin();
  await initPredictor();

  const app = express();
  const port = Number(process.env.PORT || 3000);

  app.set('trust proxy', 1);
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(attachUser);

  app.use(
    '/api/auth/login',
    rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false })
  );
  app.use(
    '/api/auth/register',
    rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false })
  );
  app.use(
    '/api/ingest',
    rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false })
  );

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'relogio-double',
      mercadopago: hasMercadoPago(),
      collector: getCollectorStatus(),
      ingest_enabled: Boolean(process.env.INGEST_SECRET?.trim()),
      disclaimer:
        'Double é RNG. Sem apostas reais, sem login na Blaze, sem sinais Telegram, sem garantia de lucro.',
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/payments', paymentRoutes);
  // webhook aliases at /api/webhooks/mercadopago (also under payments)
  app.use('/api', paymentRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/ingest', ingestRoutes);

  const publicDir = path.join(__dirname, 'public');
  // In tsx/dev, public is next to src; in build, copied to dist/public
  const altPublic = path.join(process.cwd(), 'public');
  app.use(express.static(publicDir));
  app.use(express.static(altPublic));

  // SPA-ish fallback for clean URLs
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    const indexPath = path.join(altPublic, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) next();
    });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  });

  // Start collector after listen
  app.listen(port, () => {
    console.log(`[server] Relógio Double ouvindo em :${port}`);
    console.log(`[server] Mercado Pago: ${hasMercadoPago() ? 'configurado' : 'STUB (sem token)'}`);
    console.log(
      `[server] Ingest API: ${process.env.INGEST_SECRET?.trim() ? 'habilitado' : 'desabilitado (sem INGEST_SECRET)'}`
    );
    seedSyntheticDevRounds(100);
    startCollector();
  });
}

main().catch((e) => {
  console.error('Falha ao iniciar:', e);
  process.exit(1);
});
