-- Subscription support
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'SL';
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT; -- 'monthly' | 'annual'
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'none';
  -- none | pending | active | expired
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS qr_credits INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  monime_session_id TEXT,
  plan              TEXT NOT NULL,
  country           TEXT NOT NULL,
  amount_value      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'SLE',
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'completed', 'cancelled', 'failed')),
  reference         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(monime_session_id);

ALTER TABLE locations ADD COLUMN IF NOT EXISTS whatsapp TEXT;
