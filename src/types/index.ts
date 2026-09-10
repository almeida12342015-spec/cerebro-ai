export type Role = 'admin' | 'user';
export type Color = 'red' | 'black' | 'white';

export interface User {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  paid_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface Round {
  id: number;
  blaze_id: string;
  color: Color;
  roll: number;
  created_at: string;
  collected_at: string;
}

export interface Payment {
  id: string;
  user_id: string;
  provider: string;
  provider_id: string | null;
  amount_cents: number;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'stub';
  pix_qr_code: string | null;
  pix_qr_base64: string | null;
  created_at: string;
  updated_at: string;
}

export interface PredictionRecord {
  id: number;
  round_id: number | null;
  predicted_color: Color;
  confidence: number;
  actual_color: Color | null;
  correct: number | null;
  model_type: string;
  created_at: string;
}

export interface CollectorStatus {
  running: boolean;
  last_fetch_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  source: string;
  rounds_collected: number;
}

export interface AuthPayload {
  userId: string;
  email: string;
  role: Role;
}

export interface GaleState {
  bank: number;
  initialBank: number;
  stakePercent: number;
  currentGale: 0 | 1 | 2 | null;
  cooldownUntilRound: number | null;
  pendingGale: 0 | 1 | 2 | null;
  history: GaleHistoryEntry[];
  wins: number;
  losses: number;
  skippedWhites: number;
}

export interface GaleHistoryEntry {
  roundIndex: number;
  galeLevel: 0 | 1 | 2;
  stake: number;
  predicted: Color;
  actual: Color;
  result: 'win' | 'loss' | 'skip_white';
  bankAfter: number;
  confidence: number;
}
