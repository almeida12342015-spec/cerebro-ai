import { randomUUID } from 'crypto';
import { users } from '../db';
import { hashPassword } from './passwords';

export async function seedAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('[seed] ADMIN_EMAIL / ADMIN_PASSWORD não definidos — admin não criado');
    return;
  }
  const existing = users.findByEmail(email);
  if (existing) {
    if (existing.role !== 'admin') {
      console.warn(`[seed] Usuário ${email} já existe mas não é admin`);
    }
    return;
  }
  const password_hash = await hashPassword(password);
  users.create({
    id: randomUUID(),
    email,
    password_hash,
    role: 'admin',
    paid_until: null, // admin bypasses paywall
  });
  console.log(`[seed] Admin criado: ${email}`);
}
