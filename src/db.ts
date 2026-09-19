import type { AliasRecord, LinkRecord } from "./types";

const LINK_SELECT = `
  SELECT l.id, l.client_protocol, l.upstream_protocol, l.target_type,
         l.direct_base_url, l.alias_id, l.revoked_at, l.created_at,
         a.name AS alias_name, a.base_url AS alias_base_url
  FROM links l LEFT JOIN aliases a ON a.id = l.alias_id`;

export async function findLink(db: D1Database, id: string): Promise<LinkRecord | null> {
  return db.prepare(`${LINK_SELECT} WHERE l.id = ?`).bind(id).first<LinkRecord>();
}

export async function listLinks(db: D1Database): Promise<LinkRecord[]> {
  const result = await db.prepare(`${LINK_SELECT} ORDER BY l.created_at DESC`).all<LinkRecord>();
  return result.results;
}

export async function listAliases(db: D1Database): Promise<AliasRecord[]> {
  const result = await db
    .prepare(
      `SELECT a.id, a.name, a.base_url, a.created_at, a.updated_at,
              COUNT(l.id) AS link_count
       FROM aliases a
       LEFT JOIN links l ON l.alias_id = a.id AND l.revoked_at IS NULL
       GROUP BY a.id
       ORDER BY a.name COLLATE NOCASE`,
    )
    .all<AliasRecord>();
  return result.results;
}

export async function findAlias(db: D1Database, id: string): Promise<AliasRecord | null> {
  return db.prepare("SELECT * FROM aliases WHERE id = ?").bind(id).first<AliasRecord>();
}

export async function executeBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  const results = await db.batch(statements);
  if (results.some((result) => !result.success)) throw new Error("D1 batch operation failed");
}
