// PostgreSQL persistence for the invoice app.
// The server keeps working on one in-memory `db` object; save() writes only the rows that changed
// since the last flush, in a single transaction, so every mutation is durable before it is acknowledged.
const { Pool } = require("pg");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, seq BIGSERIAL, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, sort_key TEXT NOT NULL DEFAULT '', data JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS invoices_sort ON invoices (sort_key DESC);
CREATE TABLE IF NOT EXISTS journals (id TEXT PRIMARY KEY, seq BIGSERIAL, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS mail_log (id TEXT PRIMARY KEY, seq BIGSERIAL, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY, time TEXT NOT NULL, username TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '');
`;

// Collections stored one row per record: [db key, table, id of a record, extra column values]
const COLLECTIONS = [
  { key: "users", table: "users", idCol: "username", id: r => r.username, extra: () => [], extraCols: [], newestFirst: false },
  { key: "invoices", table: "invoices", idCol: "id", id: r => r.id,
    extraCols: ["number", "sort_key"], extra: r => [r.number, String(r.createdAt || r.date || "")] },
  { key: "journals", table: "journals", idCol: "id", id: r => r.id, extraCols: [], extra: () => [] },
  { key: "mailLog", table: "mail_log", idCol: "id", id: r => r.id, extraCols: [], extra: () => [] }
];
const KV_KEYS = ["settings", "mail", "telegram"];
const ORDER = { users: "seq", invoices: "sort_key DESC, id", journals: "seq DESC", mail_log: "seq DESC" };

function createStore(connectionString) {
  const pool = new Pool({ connectionString, max: 5 });
  pool.on("error", (e) => console.error("Postgres pool error:", e.message));
  const snapshot = new Map(); // "table:id" -> JSON string last written (dirty detection)
  const kvSnapshot = new Map();

  async function init() { await pool.query(SCHEMA); }

  // Returns the stored data, or null when the database is empty (first run / not yet migrated).
  async function load() {
    const kv = await pool.query("SELECT key, data FROM kv");
    if (!kv.rowCount) return null;
    const db = {};
    for (const r of kv.rows) { db[r.key] = r.data; kvSnapshot.set(r.key, JSON.stringify(r.data)); }
    for (const c of COLLECTIONS) {
      const rows = await pool.query(`SELECT data FROM ${c.table} ORDER BY ${ORDER[c.table]}`);
      db[c.key] = rows.rows.map(r => r.data);
      for (const rec of db[c.key]) snapshot.set(`${c.table}:${c.id(rec)}`, JSON.stringify(rec));
    }
    return db;
  }

  async function loadAudit() {
    const r = await pool.query("SELECT time, username, role, action, target, details, ip FROM audit_log ORDER BY id");
    return r.rows.map(x => ({ time: x.time, user: x.username, role: x.role, action: x.action, target: x.target, details: x.details, ip: x.ip }));
  }

  async function flush(db) {
    const client = await pool.connect();
    const nextSnapshot = [];
    try {
      await client.query("BEGIN");
      for (const k of KV_KEYS) {
        const s = JSON.stringify(db[k]);
        if (kvSnapshot.get(k) === s) continue;
        await client.query("INSERT INTO kv (key, data) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data", [k, s]);
        nextSnapshot.push(() => kvSnapshot.set(k, s));
      }
      for (const c of COLLECTIONS) {
        const live = new Set(db[c.key].map(rec => `${c.table}:${c.id(rec)}`));
        // deletes first so a removed row can't collide with a new row's unique number
        for (const sk of [...snapshot.keys()]) {
          if (!sk.startsWith(c.table + ":") || live.has(sk)) continue;
          await client.query(`DELETE FROM ${c.table} WHERE ${c.idCol} = $1`, [sk.slice(c.table.length + 1)]);
          nextSnapshot.push(() => snapshot.delete(sk));
        }
        // insert oldest first so the BIGSERIAL seq grows in creation order (arrays are newest-first, except users)
        for (const rec of c.newestFirst === false ? db[c.key] : [...db[c.key]].reverse()) {
          const id = c.id(rec), sk = `${c.table}:${id}`, s = JSON.stringify(rec);
          if (snapshot.get(sk) === s) continue;
          const cols = [c.idCol, ...c.extraCols, "data"];
          const vals = [id, ...c.extra(rec), s];
          const updates = [...c.extraCols, "data"].map(col => `${col} = EXCLUDED.${col}`).join(", ");
          await client.query(`INSERT INTO ${c.table} (${cols.join(", ")}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(", ")})
            ON CONFLICT (${c.idCol}) DO UPDATE SET ${updates}`, vals);
          nextSnapshot.push(() => snapshot.set(sk, s));
        }
      }
      await client.query("COMMIT");
      nextSnapshot.forEach(fn => fn());
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { client.release(); }
  }

  // Flushes are serialized; calls made while one is waiting share it, since each flush writes the
  // current in-memory state anyway.
  let chain = Promise.resolve(), queued = null;
  function save(db) {
    if (queued) return queued;
    const p = chain.then(() => { queued = null; return flush(db); });
    queued = p; chain = p.catch(() => {});
    return p;
  }

  let auditChain = Promise.resolve();
  function appendAudit(e) {
    auditChain = auditChain.then(() => pool.query(
      "INSERT INTO audit_log (time, username, role, action, target, details, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [e.time, e.user, e.role, e.action, e.target, e.details, e.ip])).catch(err => console.error("Audit write failed:", err.message));
    return auditChain;
  }

  return { init, load, loadAudit, save, appendAudit, query: (...a) => pool.query(...a), close: () => pool.end() };
}

module.exports = { createStore, SCHEMA };
