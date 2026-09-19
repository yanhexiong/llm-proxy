declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }

  interface Env {
    DB: D1Database;
    LINK_SIGNING_SECRET: string;
    ADMIN_USERNAME: string;
    ADMIN_PASSWORD_HASH: string;
    DEFAULT_MAX_TOKENS: string;
    SESSION_TTL_SECONDS: string;
    MAX_STREAM_STATE_BYTES: string;
    UPSTREAM_TIMEOUT_MS: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
