-- Gateway metadata only. Request bodies, upstream API keys and cookies are
-- intentionally not persisted in D1.

CREATE TABLE IF NOT EXISTS aliases (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
);

CREATE INDEX IF NOT EXISTS idx_aliases_updated_at ON aliases(updated_at);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY NOT NULL,
  client_protocol TEXT NOT NULL,
  upstream_protocol TEXT NOT NULL,
  target_type TEXT NOT NULL,
  direct_base_url TEXT,
  alias_id TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
  FOREIGN KEY (alias_id) REFERENCES aliases(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_links_alias_id ON links(alias_id);
CREATE INDEX IF NOT EXISTS idx_links_revoked_at ON links(revoked_at);
CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  blocked_until TEXT
);
