import jwt from 'jsonwebtoken';
import type { AuthPayload } from '../types';

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET must be set to a long random string in production');
    }
    return 'dev-only-insecure-jwt-secret-change-me';
  }
  return s;
}

const COOKIE_NAME = 'rd_token';
const MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, secret(), { expiresIn: MAX_AGE_SEC });
}

export function verifyToken(token: string): AuthPayload | null {
  try {
    return jwt.verify(token, secret()) as AuthPayload;
  } catch {
    return null;
  }
}

export { COOKIE_NAME, MAX_AGE_SEC };
