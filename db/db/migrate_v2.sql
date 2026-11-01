
-- CivicLINK v2: business image + delete account support
ALTER TABLE locations ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Optional audit: soft-delete not required; hard delete via API
