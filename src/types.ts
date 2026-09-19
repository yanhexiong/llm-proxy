export const PROTOCOLS = ["messages", "responses", "chat"] as const;
export type Protocol = (typeof PROTOCOLS)[number];
export type TargetMode = "u" | "a";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  LINK_SIGNING_SECRET: string;
  ADMIN_USERNAME: string;
  /** Preferred Worker Secret: the original administrator password. */
  ADMIN_PASSWORD?: string;
  /** Legacy Worker Secret retained for existing deployments. */
  ADMIN_PASSWORD_HASH?: string;
  DEFAULT_MAX_TOKENS?: string;
  SESSION_TTL_SECONDS?: string;
  MAX_STREAM_STATE_BYTES?: string;
  UPSTREAM_TIMEOUT_MS?: string;
  CROSS_PROTOCOL_THINKING?: "compatible" | "strict";
}

export interface LinkRecord {
  id: string;
  client_protocol: Protocol;
  upstream_protocol: Protocol;
  target_type: "direct" | "alias";
  direct_base_url: string | null;
  alias_id: string | null;
  alias_name: string | null;
  alias_base_url: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface AliasRecord {
  id: string;
  name: string;
  base_url: string;
  created_at: string;
  updated_at: string;
  link_count?: number;
}

export interface ProxyRoute {
  credential: string;
  clientProtocol: Protocol;
  upstreamProtocol: Protocol;
  mode: TargetMode;
  target: string;
  clientEndpoint: string;
}
