import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { users } from '../db';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { signToken, COOKIE_NAME, MAX_AGE_SEC } from '../auth/jwt';
import type { AuthedRequest } from '../middleware/auth';
import { isPaid } from '../middleware/auth';

const router = Router();

const credSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(128),
});

router.post('/register', async (req, res) => {
  const parsed = credSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Email ou senha inválidos (mín. 8 caracteres)' });
    return;
  }
  const { email, password } = parsed.data;
  if (users.findByEmail(email)) {
    res.status(409).json({ error: 'Email já cadastrado' });
    return;
  }
  const password_hash = await hashPassword(password);
  const user = users.create({
    id: randomUUID(),
    email,
    password_hash,
    role: 'user',
    paid_until: null,
  });
  const token = signToken({ userId: user.id, email: user.email, role: user.role });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: MAX_AGE_SEC * 1000,
    secure: process.env.NODE_ENV === 'production',
  });
  res.status(201).json({
    user: { id: user.id, email: user.email, role: user.role, paid_until: user.paid_until, paid: isPaid(user) },
    token,
  });
});

router.post('/login', async (req, res) => {
  const parsed = credSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Credenciais inválidas' });
    return;
  }
  const user = users.findByEmail(parsed.data.email);
  if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) {
    res.status(401).json({ error: 'Email ou senha incorretos' });
    return;
  }
  const token = signToken({ userId: user.id, email: user.email, role: user.role });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: MAX_AGE_SEC * 1000,
    secure: process.env.NODE_ENV === 'production',
  });
  res.json({
    user: { id: user.id, email: user.email, role: user.role, paid_until: user.paid_until, paid: isPaid(user) },
    token,
  });
});

router.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', (req: AuthedRequest, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'Não autenticado' });
    return;
  }
  const u = req.user;
  res.json({
    id: u.id,
    email: u.email,
    role: u.role,
    paid_until: u.paid_until,
    paid: isPaid(u),
  });
});

export default router;
