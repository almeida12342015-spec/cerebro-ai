import type Database from 'better-sqlite3';
import { getDb, migrate } from './schema';
import type { User, Round, Payment, PredictionRecord, Color } from '../types';

let db: Database.Database;

export function initDb(): Database.Database {
  db = getDb();
  migrate(db);
  return db;
}

export function dbInstance(): Database.Database {
  if (!db) throw new Error('DB not initialized');
  return db;
}

export const users = {
  findByEmail(email: string): User | undefined {
    return dbInstance().prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email) as User | undefined;
  },
  findById(id: string): User | undefined {
    return dbInstance().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  },
  create(u: Omit<User, 'created_at' | 'updated_at'>): User {
    dbInstance()
      .prepare(
        `INSERT INTO users (id, email, password_hash, role, paid_until) VALUES (@id, @email, @password_hash, @role, @paid_until)`
      )
      .run(u);
    return this.findById(u.id)!;
  },
  list(): User[] {
    return dbInstance().prepare('SELECT * FROM users ORDER BY created_at DESC').all() as User[];
  },
  setPaidUntil(id: string, paidUntil: string | null): void {
    dbInstance()
      .prepare(`UPDATE users SET paid_until = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(paidUntil, id);
  },
  grantDays(id: string, days: number): User {
    const user = this.findById(id);
    if (!user) throw new Error('User not found');
    const now = new Date();
    const base = user.paid_until && new Date(user.paid_until) > now ? new Date(user.paid_until) : now;
    base.setUTCDate(base.getUTCDate() + days);
    this.setPaidUntil(id, base.toISOString());
    return this.findById(id)!;
  },
  revoke(id: string): void {
    this.setPaidUntil(id, null);
  },
};

export const rounds = {
  insert(r: { blaze_id: string; color: Color; roll: number; created_at: string }): Round | null {
    try {
      const info = dbInstance()
        .prepare(
          `INSERT INTO rounds (blaze_id, color, roll, created_at) VALUES (?, ?, ?, ?)`
        )
        .run(r.blaze_id, r.color, r.roll, r.created_at);
      return dbInstance().prepare('SELECT * FROM rounds WHERE id = ?').get(info.lastInsertRowid) as Round;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE')) return null;
      throw e;
    }
  },
  latest(limit = 100): Round[] {
    return dbInstance()
      .prepare('SELECT * FROM rounds ORDER BY id DESC LIMIT ?')
      .all(limit) as Round[];
  },
  count(): number {
    const row = dbInstance().prepare('SELECT COUNT(*) as c FROM rounds').get() as { c: number };
    return row.c;
  },
  allColorsAsc(limit = 5000): Color[] {
    const rows = dbInstance()
      .prepare('SELECT color FROM rounds ORDER BY id ASC LIMIT ?')
      .all(limit) as { color: Color }[];
    return rows.map((r) => r.color);
  },
  findByBlazeId(blazeId: string): Round | undefined {
    return dbInstance().prepare('SELECT * FROM rounds WHERE blaze_id = ?').get(blazeId) as Round | undefined;
  },
};

export const payments = {
  create(p: Omit<Payment, 'created_at' | 'updated_at'>): Payment {
    dbInstance()
      .prepare(
        `INSERT INTO payments (id, user_id, provider, provider_id, amount_cents, status, pix_qr_code, pix_qr_base64)
         VALUES (@id, @user_id, @provider, @provider_id, @amount_cents, @status, @pix_qr_code, @pix_qr_base64)`
      )
      .run(p);
    return this.findById(p.id)!;
  },
  findById(id: string): Payment | undefined {
    return dbInstance().prepare('SELECT * FROM payments WHERE id = ?').get(id) as Payment | undefined;
  },
  findByProviderId(providerId: string): Payment | undefined {
    return dbInstance().prepare('SELECT * FROM payments WHERE provider_id = ?').get(providerId) as Payment | undefined;
  },
  updateStatus(id: string, status: Payment['status'], providerId?: string): void {
    if (providerId) {
      dbInstance()
        .prepare(`UPDATE payments SET status = ?, provider_id = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(status, providerId, id);
    } else {
      dbInstance()
        .prepare(`UPDATE payments SET status = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(status, id);
    }
  },
  list(limit = 100): Payment[] {
    return dbInstance().prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT ?').all(limit) as Payment[];
  },
  listByUser(userId: string): Payment[] {
    return dbInstance()
      .prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as Payment[];
  },
};

export const predictions = {
  insert(p: {
    round_id: number | null;
    predicted_color: Color;
    confidence: number;
    actual_color: Color | null;
    correct: number | null;
    model_type: string;
  }): void {
    dbInstance()
      .prepare(
        `INSERT INTO predictions (round_id, predicted_color, confidence, actual_color, correct, model_type)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(p.round_id, p.predicted_color, p.confidence, p.actual_color, p.correct, p.model_type);
  },
  resolveLatestOpen(actual: Color, roundId: number): void {
    const open = dbInstance()
      .prepare(`SELECT id, predicted_color FROM predictions WHERE actual_color IS NULL ORDER BY id DESC LIMIT 1`)
      .get() as { id: number; predicted_color: Color } | undefined;
    if (!open) return;
    // white is neither red nor black — miss unless prediction was white
    const isCorrect = open.predicted_color === actual ? 1 : 0;
    dbInstance()
      .prepare(`UPDATE predictions SET actual_color = ?, correct = ?, round_id = ? WHERE id = ?`)
      .run(actual, isCorrect, roundId, open.id);
  },
  stats(): { total: number; correct: number; accuracy: number } {
    const row = dbInstance()
      .prepare(
        `SELECT COUNT(*) as total, COALESCE(SUM(correct),0) as correct
         FROM predictions WHERE actual_color IS NOT NULL AND predicted_color != 'white'`
      )
      .get() as { total: number; correct: number };
    const total = row.total || 0;
    const correct = row.correct || 0;
    return { total, correct, accuracy: total ? correct / total : 0 };
  },
  recent(limit = 50): PredictionRecord[] {
    return dbInstance()
      .prepare('SELECT * FROM predictions ORDER BY id DESC LIMIT ?')
      .all(limit) as PredictionRecord[];
  },
};

export const collectorMeta = {
  get(key: string): string | null {
    const row = dbInstance().prepare('SELECT value FROM collector_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  },
  set(key: string, value: string): void {
    dbInstance()
      .prepare(
        `INSERT INTO collector_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  },
};

export const modelState = {
  load(): string | null {
    const row = dbInstance().prepare('SELECT weights_json FROM model_state WHERE id = 1').get() as
      | { weights_json: string }
      | undefined;
    return row?.weights_json ?? null;
  },
  save(weightsJson: string): void {
    dbInstance()
      .prepare(
        `INSERT INTO model_state (id, weights_json, updated_at) VALUES (1, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET weights_json = excluded.weights_json, updated_at = datetime('now')`
      )
      .run(weightsJson);
  },
};
