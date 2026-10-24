-- CivicLINK Sierra Leone – Self-Service Model
-- ASK&KNOW BEFORE YOU GO

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users (Citizens, Publishers, Admins)
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'publisher'
                  CHECK (role IN ('citizen', 'publisher', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Locations (the core entity)
CREATE TABLE IF NOT EXISTS locations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'business',
  address       TEXT,
  phone         TEXT,
  hours         TEXT,
  services      TEXT,
  description   TEXT,
  slug          TEXT NOT NULL UNIQUE,          -- used in QR URL
  is_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_locations_slug ON locations(slug);
CREATE INDEX IF NOT EXISTS idx_locations_owner ON locations(owner_id);
CREATE INDEX IF NOT EXISTS idx_locations_active ON locations(is_active);
CREATE INDEX IF NOT EXISTS idx_locations_type ON locations(type);

-- Seed a default admin (password: civiclink2026)
-- Password hash for 'civiclink2026' will be generated at runtime if needed
INSERT INTO users (name, email, password_hash, role)
VALUES (
  'ACOSAT Admin',
  'admin@civiclink.sl',
  '$2a$10$8K1p/a0dL1LXMIgoEDFrwOfMQkHvqHvqHvqHvqHvqHvqHvqHvqHvq',  -- placeholder, will reset
  'admin'
) ON CONFLICT (email) DO NOTHING;

-- WhatsApp number for direct chat (Phase 2)
ALTER TABLE locations ADD COLUMN IF NOT EXISTS whatsapp TEXT;

-- Payments (pay-per-QR via Monime)
CREATE TABLE IF NOT EXISTS payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  monime_session_id TEXT,
  amount_value    INTEGER NOT NULL,          -- minor units (cents)
  currency        TEXT NOT NULL DEFAULT 'SLE',
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'cancelled', 'failed')),
  reference       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(monime_session_id);

-- Credits: how many QR locations the user can still create
ALTER TABLE users ADD COLUMN IF NOT EXISTS qr_credits INTEGER NOT NULL DEFAULT 0;
