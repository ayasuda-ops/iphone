/**
 * 友メシ帳 共有リスト同期サーバー
 *
 * POST /sync   Authorization: Bearer <合言葉>
 *   body: { since: number, changes: [{ id, updatedAt, deleted?, data? }] }
 *   res : { cursor: number, changes: [{ id, updatedAt, deleted, data }] }
 *
 * - 送られてきた変更を「updatedAt が新しい方が勝つ」で保存し、
 *   since より後に変わったお店をすべて返す（自分の変更も含む）。
 * - 削除は deleted=true の墓標として残し、相手の端末にも削除を伝える。
 * - データは 1 つの Durable Object (SQLite) に保存する。
 */
import { DurableObject } from "cloudflare:workers";

const MAX_BODY = 2_000_000;      // 2MB
const MAX_CHANGES = 5000;
const MAX_ITEM = 50_000;         // 1 件あたりの JSON 上限
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class SyncList extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items(
      id TEXT PRIMARY KEY,
      data TEXT,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS items_seq ON items(seq)`);
  }

  sync(since, changes) {
    let seq = this.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS s FROM items`).one().s;
    if (since > seq) since = 0; // サーバー側が作り直された場合は全件を返す

    for (const c of changes) {
      const row = this.sql.exec(`SELECT updated_at FROM items WHERE id = ?`, c.id).toArray()[0];
      if (row && row.updated_at >= c.updatedAt) continue; // サーバーの方が新しい/同じ
      seq++;
      this.sql.exec(
        `INSERT INTO items(id, data, updated_at, deleted, seq) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at,
           deleted = excluded.deleted, seq = excluded.seq`,
        c.id, c.deleted ? null : c.json, c.updatedAt, c.deleted ? 1 : 0, seq
      );
    }

    const out = this.sql
      .exec(`SELECT id, data, updated_at, deleted FROM items WHERE seq > ? ORDER BY seq`, since)
      .toArray()
      .map(r => ({ id: r.id, updatedAt: r.updated_at, deleted: !!r.deleted, data: r.data ? JSON.parse(r.data) : null }));
    return { cursor: seq, changes: out };
  }
}

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : (allowed[0] || ""),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });

async function keyMatches(given, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function validate(body) {
  if (!body || typeof body !== "object") return null;
  const since = Number.isSafeInteger(body.since) && body.since >= 0 ? body.since : 0;
  if (!Array.isArray(body.changes) || body.changes.length > MAX_CHANGES) return null;
  const changes = [];
  for (const c of body.changes) {
    if (!c || typeof c.id !== "string" || !ID_RE.test(c.id)) return null;
    if (!Number.isSafeInteger(c.updatedAt) || c.updatedAt <= 0) return null;
    if (c.deleted) { changes.push({ id: c.id, updatedAt: c.updatedAt, deleted: true }); continue; }
    if (!c.data || typeof c.data !== "object" || c.data.id !== c.id) return null;
    const s = JSON.stringify(c.data);
    if (s.length > MAX_ITEM) return null;
    changes.push({ id: c.id, updatedAt: c.updatedAt, deleted: false, json: s });
  }
  return { since, changes };
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true, configured: !!env.SYNC_KEY }, 200, cors);
    if (url.pathname !== "/sync" || req.method !== "POST") return json({ error: "not_found" }, 404, cors);
    if (!env.SYNC_KEY) return json({ error: "server_not_configured" }, 500, cors);

    const key = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!key || !(await keyMatches(key, env.SYNC_KEY))) return json({ error: "unauthorized" }, 401, cors);

    const text = await req.text();
    if (text.length > MAX_BODY) return json({ error: "too_large" }, 413, cors);
    let body; try { body = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400, cors); }
    const v = validate(body);
    if (!v) return json({ error: "bad_request" }, 400, cors);

    const stub = env.LIST.get(env.LIST.idFromName("main"));
    return json(await stub.sync(v.since, v.changes), 200, cors);
  },
};
