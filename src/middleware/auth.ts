import type { Request, Response, NextFunction } from 'express';
import { verifyToken, COOKIE_NAME } from '../auth/jwt';
import { users } from '../db';
import type { AuthPayload, User } from '../types';

export interface AuthedRequest extends Request {
  auth?: AuthPayload;
  user?: User;
}

export function attachUser(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const cookieToken = req.cookies?.[COOKIE_NAME] as string | undefined;
  const token = bearer || cookieToken;
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      req.auth = payload;
      req.user = users.findById(payload.userId);
    }
  }
  next();
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.auth || !req.user) {
    res.status(401).json({ error: 'Não autenticado' });
    return;
  }
  next();
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.auth || !req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Acesso restrito a administradores' });
    return;
  }
  next();
}

/** Admin sempre passa; usuário precisa paid_until no futuro */
export function requireSubscriber(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.auth || !req.user) {
    res.status(401).json({ error: 'Não autenticado' });
    return;
  }
  if (req.user.role === 'admin') {
    next();
    return;
  }
  if (!isPaid(req.user)) {
    res.status(402).json({ error: 'Assinatura necessária', code: 'PAYMENT_REQUIRED' });
    return;
  }
  next();
}

export function isPaid(user: User): boolean {
  if (user.role === 'admin') return true;
  if (!user.paid_until) return false;
  return new Date(user.paid_until) > new Date();
}
