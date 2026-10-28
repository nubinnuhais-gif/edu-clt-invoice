// One-time import of the old file storage (data/db.json + data/audit.log) into PostgreSQL.
// Usage:  DATABASE_URL=postgres://user:pass@127.0.0.1:5432/clt_invoice node migrate-to-postgres.js
// Refuses to run if the database already contains data. The old files are left untouched.
const fs = require("fs");
const path = require("path");
const { createStore } = require("./store");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const AUDIT_FILE = path.join(DATA_DIR, "audit.log");

(async () => {
  if (!process.env.DATABASE_URL) { console.error("Set DATABASE_URL first."); process.exit(1); }
  if (!fs.existsSync(DB_FILE)) { console.error(`No ${DB_FILE} to migrate.`); process.exit(1); }
  const store = createStore(process.env.DATABASE_URL);
  await store.init();
  if (await store.load()) { console.error("The database already has data; refusing to import over it."); process.exit(1); }

  const old = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  const db = {
    settings: old.settings || {}, mail: old.mail || {}, telegram: old.telegram || {},
    users: old.users || [], invoices: old.invoices || [], journals: old.journals || [], mailLog: old.mailLog || []
  };
  await store.save(db);

  let audits = 0;
  if (fs.existsSync(AUDIT_FILE)) {
    for (const line of fs.readFileSync(AUDIT_FILE, "utf8").split("\n").filter(Boolean)) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      await store.appendAudit({ time: e.time || "", user: e.user || "", role: e.role || "", action: e.action || "",
        target: e.target || "", details: e.details || "", ip: e.ip || "" });
      audits++;
    }
  }

  const count = async (t) => (await store.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;
  const got = { users: await count("users"), invoices: await count("invoices"), journals: await count("journals"), mail_log: await count("mail_log"), audit_log: await count("audit_log") };
  const want = { users: db.users.length, invoices: db.invoices.length, journals: db.journals.length, mail_log: db.mailLog.length, audit_log: audits };
  console.log("Imported:", got);
  const bad = Object.keys(want).filter(k => want[k] !== got[k]);
  if (bad.length) { console.error("COUNT MISMATCH for:", bad.join(", "), "expected", want); process.exit(1); }
  console.log("Row counts match the old files.");
  await store.close();
})().catch(e => { console.error("Migration failed:", e.message); process.exit(1); });
