PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE auth_challenges_new (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO auth_challenges_new(id,user_id,challenge,kind,expires_at,created_at)
SELECT id,user_id,challenge,kind,expires_at,created_at FROM auth_challenges;

DROP TABLE auth_challenges;
ALTER TABLE auth_challenges_new RENAME TO auth_challenges;
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires ON auth_challenges(expires_at);

COMMIT;

PRAGMA foreign_keys = ON;
