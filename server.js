// Invoice app server: login, admin settings, and invoice storage.
// Usage: node server.js   (then open http://localhost:8080)
// Data is stored in data/db.json (daily copies in data/backups/).
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const R = require("./reports");
const { sendMail } = require("./mailer");
const { renderPdfFromUrl } = require("./pdf");

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const AUDIT_FILE = path.join(DATA_DIR, "audit.log"); // append-only, one JSON entry per line
const SESSION_HOURS = 12;
const MAX_BODY = 6 * 1024 * 1024; // logo uploads are sent as data URLs

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const DEFAULT_TERMS = [
  "The student hereby acknowledges that he/she has read, understood, and agreed to the terms and conditions provided on our website.",
  "The student acknowledges that any fees paid hereby are non-refundable and non-transferable under any circumstances, including withdrawal, termination, dissatisfaction, or partial completion.",
  "The student acknowledges that the information provided for registration is accurate, current, and complete to the best of his knowledge, and agrees to intimate CLT of any change in the information during the term of the course.",
  "The student acknowledges CLT’s code of conduct provided in the terms and conditions, and agrees to abide by the same at all times during the term of the course.",
  "The student hereby acknowledges that any decision that may be taken by the student to deposit, invest, or engage in any manner in any third-party financial, investment, or trading opportunity, whether related to forex, commodities, or otherwise, or any access to third-party trading credits that may be availed by the student during or after the term of the course(s), are entirely voluntary and at his/her sole discretion, and CLT shall not be held liable for any direct, indirect, incidental or consequential damages, loss of profits or capital, due to action or omission of any third party.",
  "CLT shall not be liable for any losses, financial or otherwise, arising out of or in connection with the course content or actions taken based on it.",
  "If the student has not already enrolled in a course provided by CLT, payment of the fees does not automatically guarantee enrolment in the course. Enrolment will be confirmed only upon verification of the information furnished by the student, and confirmation of enrolment in written form or otherwise by a CLT representative.",
  "CLT is an educational establishment providing instructional courses on forex trading and related subjects. The course(s) provided by CLT are solely for educational and informational purposes, and do not constitute any kind of professional, financial, legal, or investment advice, and/or solicitation.",
  "The student agrees to indemnify, defend and hold harmless CLT and its directors, representatives, agents, and affiliates from any claims, damages, expenses or liabilities arising from the breach of the terms and conditions, any trading activity, or his/her conduct during or after the term of the course."
];

const DEFAULT_SETTINGS = {
  name: "Consulting, Learning & Training FZE",
  address: "", trn: "", email: "", website: "", phone: "",
  currency: "AED", vat: 5,
  invPrefix: "INV-", invDigits: 6, nextInvoice: 2657, nextReceipt: 3895,
  logo: "logo-new.png",
  vatEnabled: false, inclusive: true, allowPriceEdit: false,
  courses: [{ id: "c1", name: "Profit Matrix", fee: 4500, vat: 5 }],
  terms: DEFAULT_TERMS.join("\n")
};

// Settings fields the admin may change, with their type
const SETTING_TYPES = {
  name: "string", address: "string", trn: "string", email: "string", website: "string", phone: "string",
  currency: "string", vat: "number", invPrefix: "string", invDigits: "int", nextInvoice: "int", nextReceipt: "int",
  logo: "string", vatEnabled: "bool", inclusive: "bool", allowPriceEdit: "bool", courses: "courses", terms: "string"
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
let db;

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}
function checkPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"));
}
function makePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(crypto.randomBytes(10), b => chars[b % chars.length]).join("");
}

function loadDb() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    db.settings = { ...DEFAULT_SETTINGS, ...db.settings };
    db.invoices = db.invoices || [];
    db.journals = db.journals || [];
    db.users = db.users || [];
    db.settings.nextJournal = db.settings.nextJournal || 1;
    db.settings.accounts = db.settings.accounts || [];
    db.mail = { host: "", port: 587, secure: false, insecureTLS: false, user: "", pass: "", fromName: "", fromEmail: "", ...db.mail };
    db.mailLog = db.mailLog || [];
  } else {
    db = { settings: { ...DEFAULT_SETTINGS }, invoices: [], journals: [], users: [], mailLog: [],
      mail: { host: "", port: 587, secure: false, insecureTLS: false, user: "", pass: "", fromName: "", fromEmail: "" } };
  }
  if (!db.users.length) {
    const password = process.env.ADMIN_PASSWORD || makePassword();
    db.users.push({ username: "admin", role: "admin", ...hashPassword(password), createdAt: new Date().toISOString() });
    saveDb();
    const note = `Admin login created\n  Username: admin\n  Password: ${password}\nChange it after first login (Admin > My password).\n`;
    fs.writeFileSync(path.join(DATA_DIR, "FIRST-LOGIN.txt"), note);
    console.log("\n" + note);
  }
}

// ---------------------------------------------------------------------------
// Audit log (append-only file; the app has no way to edit or delete entries)
// ---------------------------------------------------------------------------
let audit = [];
function loadAudit() {
  if (!fs.existsSync(AUDIT_FILE)) return;
  audit = fs.readFileSync(AUDIT_FILE, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function logAudit(req, who, action, target = "", details = "") {
  const e = { time: R.localStamp(), user: who?.username || "", role: who?.role || "", action,
    target: String(target).slice(0, 200), details: (Array.isArray(details) ? details.join("; ") : String(details)).slice(0, 4000),
    ip: (req?.socket?.remoteAddress || "").replace(/^::ffff:/, "") };
  audit.push(e);
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(e) + "\n");
}

function saveDb() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
  // one backup copy per day
  const daily = path.join(BACKUP_DIR, `db-${new Date().toISOString().slice(0, 10)}.json`);
  if (!fs.existsSync(daily)) fs.copyFileSync(DB_FILE, daily);
}

// ---------------------------------------------------------------------------
// Sessions & login throttling
// ---------------------------------------------------------------------------
const sessions = new Map(); // token -> { username, expires }
const failures = new Map(); // ip -> { count, until }

function getUser(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || "");
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.expires < Date.now()) { sessions.delete(m[1]); return null; }
  const user = db.users.find(u => u.username === s.username);
  return user ? { username: user.username, role: user.role, token: m[1] } : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const uid = () => Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Email send log: every attempt starts "pending" and is updated to "sent"/"failed" once the SMTP
// conversation finishes, so the UI can show live delivery status instead of blocking on it.
function addMailLog(entry) {
  const e = { id: uid(), time: new Date().toISOString(), status: "pending", ...entry };
  db.mailLog.unshift(e);
  if (db.mailLog.length > 300) db.mailLog.length = 300;
  saveDb();
  return e;
}
function updateMailLog(id, patch) {
  const e = db.mailLog.find(x => x.id === id);
  if (e) { Object.assign(e, patch, { finishedAt: new Date().toISOString() }); saveDb(); }
  return e;
}
const invNo = (n) => `${db.settings.invPrefix}${String(n).padStart(db.settings.invDigits, "0")}`;
const str = (v, max = 2000) => String(v ?? "").slice(0, max);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
const fail = (res, status, error) => send(res, status, { error });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}

function cleanCourses(list) {
  if (!Array.isArray(list)) return db.settings.courses;
  return list.filter(c => c && str(c.name).trim()).map(c => ({
    id: str(c.id, 64) || uid(), name: str(c.name, 200).trim(), fee: Math.max(0, num(c.fee)), vat: Math.max(0, num(c.vat))
  }));
}

// Sanitise an invoice coming from the browser. Staff cannot change fees unless the admin allows it.
function cleanInvoice(body, user, existing) {
  const s = db.settings;
  const canEditFee = user.role === "admin" || s.allowPriceEdit;
  const oldItems = existing ? existing.items : [];
  const items = (Array.isArray(body.items) ? body.items : []).map(it => {
    let item = { courseId: str(it.courseId, 64), desc: str(it.desc, 300), qty: Math.max(0, num(it.qty)), rate: Math.max(0, num(it.rate)), tax: Math.max(0, num(it.tax)) };
    if (!canEditFee) {
      const unchanged = oldItems.find(o => o.courseId === item.courseId && o.desc === item.desc && num(o.rate) === item.rate && num(o.tax) === item.tax);
      const course = s.courses.find(c => c.id === item.courseId);
      if (!unchanged) {
        if (!course) return null; // staff may only pick admin-defined courses
        item = { ...item, desc: course.name, rate: course.fee, tax: course.vat };
      }
    }
    return item;
  }).filter(it => it && it.desc);
  const payments = (Array.isArray(body.payments) ? body.payments : []).map(p => ({
    no: p.no ? Math.trunc(num(p.no)) : null, amount: Math.max(0, num(p.amount)), date: str(p.date, 10),
    mode: str(p.mode, 40), ref: str(p.ref, 100)
  }));
  const c = body.customer || {};
  return {
    date: str(body.date, 10), terms: str(body.terms, 40), due: str(body.due, 10),
    customer: { name: str(c.name, 200).trim(), email: str(c.email, 200), phone: str(c.phone, 60) },
    items, payments, notes: str(body.notes, 2000),
    inclusive: existing ? existing.inclusive : !!s.inclusive,
    vatEnabled: existing ? existing.vatEnabled === true : !!s.vatEnabled
  };
}

function assignReceiptNumbers(inv) {
  const used = new Set(db.invoices.flatMap(i => i.payments.map(p => p.no)));
  inv.payments.forEach(p => {
    if (!p.no) {
      while (used.has(db.settings.nextReceipt)) db.settings.nextReceipt++;
      p.no = db.settings.nextReceipt++;
      used.add(p.no);
    }
  });
}

const publicSettings = () => db.settings;
const publicUser = (u) => ({ username: u.username, role: u.role, createdAt: u.createdAt });

const DEFAULT_ACCOUNTS = [
  "Cash", "Petty Cash", "Bank", "Accounts Receivable", "Accounts Payable",
  "Revenue - Training", "Revenue - Consulting", "Revenue - Other",
  "Cost of Services", "Salaries & Wages", "Rent Expense", "Office Supplies",
  "Marketing Expense", "Travel Expense", "Utilities", "Professional Fees",
  "Depreciation", "VAT Input", "VAT Output", "Owner's Equity",
  "Retained Earnings", "Prepaid Expenses", "Accrued Expenses"
];

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const ip = req.socket.remoteAddress;

  // Mutating requests must be JSON (blocks cross-site form posts)
  if (req.method !== "GET" && !(req.headers["content-type"] || "").startsWith("application/json")) return fail(res, 415, "JSON required");

  if (route === "POST /api/login") {
    const f = failures.get(ip);
    if (f && f.until > Date.now()) return fail(res, 429, "Too many attempts. Try again in a few minutes.");
    const body = await readBody(req);
    const user = db.users.find(u => u.username.toLowerCase() === str(body.username, 100).trim().toLowerCase());
    if (!user || !checkPassword(user, str(body.password, 200))) {
      const n = (f && f.until <= Date.now() ? 0 : (f?.count || 0)) + 1;
      failures.set(ip, { count: n, until: n >= 8 ? Date.now() + 5 * 60 * 1000 : 0 });
      logAudit(req, { username: str(body.username, 50).trim(), role: user?.role || "" }, "login.failed", "",
        `${user ? "Wrong password" : "Unknown username"}${n >= 8 ? " · sign-in locked for 5 minutes" : ""}`);
      return fail(res, 401, "Wrong username or password");
    }
    failures.delete(ip);
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { username: user.username, expires: Date.now() + SESSION_HOURS * 3600 * 1000 });
    logAudit(req, user, "login.success");
    return send(res, 200, publicUser(user), { "Set-Cookie": `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}` });
  }

  const user = getUser(req);
  if (!user) return fail(res, 401, "Please log in");
  const isAdmin = user.role === "admin";
  const adminOnly = () => { if (!isAdmin) { fail(res, 403, "Admin only"); return true; } return false; };

  if (route === "POST /api/logout") {
    sessions.delete(user.token);
    logAudit(req, user, "logout");
    return send(res, 200, { ok: true }, { "Set-Cookie": "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
  }
  if (route === "GET /api/me") return send(res, 200, { username: user.username, role: user.role });
  if (route === "GET /api/settings") return send(res, 200, publicSettings());

  if (route === "PUT /api/settings") {
    if (adminOnly()) return;
    const body = await readBody(req);
    const before = structuredClone(db.settings);
    for (const [k, type] of Object.entries(SETTING_TYPES)) {
      if (!(k in body)) continue;
      const v = body[k];
      if (type === "string") db.settings[k] = str(v, k === "logo" ? MAX_BODY : 20000);
      else if (type === "number") db.settings[k] = Math.max(0, num(v));
      else if (type === "int") db.settings[k] = Math.max(1, Math.trunc(num(v)) || 1);
      else if (type === "bool") db.settings[k] = !!v;
      else if (type === "courses") db.settings[k] = cleanCourses(v);
    }
    db.settings.invDigits = Math.min(db.settings.invDigits, 12);
    saveDb();
    const changes = R.settingsChanges(before, db.settings);
    if (changes.length) logAudit(req, user, "settings.update", "", changes);
    return send(res, 200, publicSettings());
  }

  if (route === "GET /api/invoices") return send(res, 200, db.invoices);

  if (route === "POST /api/invoices") {
    const inv = cleanInvoice(await readBody(req), user, null);
    if (!inv.customer.name) return fail(res, 400, "Student name is required");
    if (!inv.items.length) return fail(res, 400, "Select at least one course");
    while (db.invoices.some(i => i.number === invNo(db.settings.nextInvoice))) db.settings.nextInvoice++;
    const now = new Date().toISOString();
    Object.assign(inv, { id: uid(), number: invNo(db.settings.nextInvoice++), createdAt: now, updatedAt: now, createdBy: user.username });
    assignReceiptNumbers(inv);
    db.invoices.unshift(inv);
    saveDb();
    const t = R.invTotals(inv);
    logAudit(req, user, "invoice.create", inv.number, [`Student: ${inv.customer.name}`, `Courses: ${inv.items.map(i => i.desc).join(", ")}`,
      `Total: ${db.settings.currency} ${t.total}`, ...inv.payments.map(p => `Payment: receipt #${p.no}, ${db.settings.currency} ${p.amount} (${p.mode})`)]);
    return send(res, 201, { invoice: inv, settings: publicSettings() });
  }

  let m = /^\/api\/invoices\/([\w-]+)$/.exec(url.pathname);
  if (m && (req.method === "PUT" || req.method === "DELETE")) {
    const idx = db.invoices.findIndex(i => i.id === m[1]);
    if (idx < 0) return fail(res, 404, "Invoice not found");
    if (req.method === "DELETE") {
      if (adminOnly()) return;
      const [gone] = db.invoices.splice(idx, 1); saveDb();
      const t = R.invTotals(gone);
      logAudit(req, user, "invoice.delete", gone.number, [`Student: ${gone.customer.name}`, `Date: ${gone.date}`,
        `Total: ${db.settings.currency} ${t.total}`, `Paid: ${db.settings.currency} ${t.paid}`, `Created by: ${gone.createdBy || "—"}`]);
      return send(res, 200, { ok: true });
    }
    const old = db.invoices[idx];
    const inv = cleanInvoice(await readBody(req), user, old);
    if (!inv.customer.name) return fail(res, 400, "Student name is required");
    if (!inv.items.length) return fail(res, 400, "Select at least one course");
    Object.assign(inv, { id: old.id, number: old.number, createdAt: old.createdAt, createdBy: old.createdBy, updatedAt: new Date().toISOString(), updatedBy: user.username });
    // receipts keep their numbers; new payments get the next free number
    const oldNos = new Set(old.payments.map(p => p.no));
    inv.payments.forEach(p => { if (p.no && !oldNos.has(p.no)) p.no = null; });
    assignReceiptNumbers(inv);
    db.invoices[idx] = inv; saveDb();
    const changes = R.invoiceChanges(old, inv, db.settings.currency);
    if (changes.length) logAudit(req, user, "invoice.update", inv.number, changes);
    return send(res, 200, { invoice: inv, settings: publicSettings() });
  }

  // Printing happens in the browser; the page tells the server so it is logged
  m = /^\/api\/invoices\/([\w-]+)\/printed$/.exec(url.pathname);
  if (m && req.method === "POST") {
    const inv = db.invoices.find(i => i.id === m[1]);
    if (!inv) return fail(res, 404, "Invoice not found");
    const body = await readBody(req);
    if (body.kind === "receipt") logAudit(req, user, "receipt.print", `Receipt #${Math.trunc(num(body.receipt))}`, `Invoice ${inv.number} · ${inv.customer.name}`);
    else logAudit(req, user, "invoice.print", inv.number, `Student: ${inv.customer.name}`);
    return send(res, 200, { ok: true });
  }

  // Email the invoice to the customer (any signed-in user; staff may email the invoices they create).
  // Responds immediately with a "pending" log id; the actual SMTP send happens in the background —
  // poll GET /api/mail-log/:id (or check Admin > Email settings) for the final sent/failed status.
  m = /^\/api\/invoices\/([\w-]+)\/send$/.exec(url.pathname);
  if (m && req.method === "POST") {
    const inv = db.invoices.find(i => i.id === m[1]);
    if (!inv) return fail(res, 404, "Invoice not found");
    if (!db.mail.host || !db.mail.fromEmail) return fail(res, 400, "Email is not set up yet. Ask an admin to configure it under Admin → Email settings.");
    const body = await readBody(req);
    const to = str(body.to, 200).trim() || inv.customer.email;
    if (!EMAIL_RE.test(to)) return fail(res, 400, "Enter a valid email address for the customer");
    const log = addMailLog({ kind: "invoice", to, invoiceId: inv.id, invoiceNumber: inv.number, by: user.username });
    send(res, 202, { ok: true, queued: true, id: log.id, to });
    (async () => {
      // Render the invoice to PDF with a real browser (same page, same CSS the "Print / PDF" button
      // uses), via a short-lived internal session so Puppeteer can load the logged-in page.
      const pdfToken = crypto.randomBytes(32).toString("hex");
      sessions.set(pdfToken, { username: user.username, expires: Date.now() + 2 * 60 * 1000 });
      try {
        const pdf = await renderPdfFromUrl({ url: `http://127.0.0.1:${PORT}/?id=${inv.id}`, cookieName: "sid", cookieValue: pdfToken });
        await sendMail({
          host: db.mail.host, port: db.mail.port, secure: db.mail.secure, insecureTLS: db.mail.insecureTLS,
          user: db.mail.user, pass: db.mail.pass, fromEmail: db.mail.fromEmail, fromName: db.mail.fromName || db.settings.name,
          to, subject: `Invoice ${inv.number} from ${db.settings.name}`,
          html: R.invoiceEmailHtml(inv, db.settings), text: R.invoiceEmailText(inv, db.settings),
          attachments: [{ filename: `${inv.number}.pdf`, content: pdf, contentType: "application/pdf" }]
        });
        updateMailLog(log.id, { status: "sent" });
        logAudit(req, user, "invoice.email", inv.number, [`Sent to ${to}`, `Student: ${inv.customer.name}`]);
      } catch (e) {
        updateMailLog(log.id, { status: "failed", error: e.message });
      } finally {
        sessions.delete(pdfToken);
      }
    })();
    return;
  }

  // ----- reports & audit log (admin) -----
  if (route === "GET /api/reports" || route === "GET /api/reports/export") {
    if (adminOnly()) return;
    const { from, to } = R.parseRange(url.searchParams);
    const rep = R.buildReport(db.invoices, from, to);
    if (route === "GET /api/reports") return send(res, 200, { ...rep, currency: db.settings.currency });
    logAudit(req, user, "report.export", "Sales report (Excel)", `Period ${from} to ${to}`);
    const file = R.buildXlsx(R.reportSheets(rep, db.settings.currency, user.username));
    return send(res, 200, file, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="sales-report_${from}_to_${to}.xlsx"` });
  }
  if (route === "GET /api/audit" || route === "GET /api/audit/export") {
    if (adminOnly()) return;
    const list = R.filterAudit(audit, url.searchParams);
    if (route === "GET /api/audit") {
      const limit = Math.min(5000, Math.max(1, Math.trunc(num(url.searchParams.get("limit"))) || 200));
      return send(res, 200, { total: list.length, entries: list.slice(0, limit), labels: R.ACTION_LABELS,
        users: [...new Set(audit.map(e => e.user).filter(Boolean))].sort() });
    }
    const q = url.searchParams, filterText = [q.get("from") && `from ${q.get("from")}`, q.get("to") && `to ${q.get("to")}`, q.get("user") && `user ${q.get("user")}`,
      q.get("group") && `type ${q.get("group")}`, q.get("q") && `search "${q.get("q")}"`].filter(Boolean).join(", ");
    logAudit(req, user, "report.export", "Audit log (Excel)", filterText || "All entries");
    const file = R.buildXlsx(R.auditSheets(list, user.username, filterText));
    return send(res, 200, file, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="audit-log_${R.localStamp().slice(0, 10)}.xlsx"` });
  }
  if (route === "POST /api/audit/viewed") { // PDF views of reports are opened in the browser; log them
    if (adminOnly()) return;
    const body = await readBody(req);
    logAudit(req, user, "report.export", str(body.what, 100), str(body.details, 300));
    return send(res, 200, { ok: true });
  }

  // ----- users (admin) -----
  if (route === "GET /api/users") { if (adminOnly()) return; return send(res, 200, db.users.map(publicUser)); }
  if (route === "POST /api/users") {
    if (adminOnly()) return;
    const body = await readBody(req);
    const username = str(body.username, 50).trim();
    if (!/^[A-Za-z0-9._-]{3,50}$/.test(username)) return fail(res, 400, "Username: 3+ letters/numbers (. _ - allowed)");
    if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return fail(res, 400, "That username already exists");
    if (str(body.password).length < 6) return fail(res, 400, "Password must be at least 6 characters");
    const u = { username, role: body.role === "admin" ? "admin" : "staff", ...hashPassword(str(body.password)), createdAt: new Date().toISOString() };
    db.users.push(u); saveDb();
    logAudit(req, user, "user.create", u.username, `Role: ${u.role}`);
    return send(res, 201, publicUser(u));
  }
  m = /^\/api\/users\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
  if (m && (req.method === "PUT" || req.method === "DELETE")) {
    if (adminOnly()) return;
    const u = db.users.find(x => x.username === m[1]);
    if (!u) return fail(res, 404, "User not found");
    const admins = db.users.filter(x => x.role === "admin").length;
    if (req.method === "DELETE") {
      if (u.username === user.username) return fail(res, 400, "You cannot delete your own account");
      if (u.role === "admin" && admins <= 1) return fail(res, 400, "Keep at least one admin");
      db.users = db.users.filter(x => x !== u);
      for (const [t, s] of sessions) if (s.username === u.username) sessions.delete(t);
      saveDb(); logAudit(req, user, "user.delete", u.username, `Role was: ${u.role}`);
      return send(res, 200, { ok: true });
    }
    const body = await readBody(req);
    const changes = [];
    if (body.role && body.role !== u.role) {
      if (u.role === "admin" && admins <= 1) return fail(res, 400, "Keep at least one admin");
      changes.push(`Role: ${u.role} → ${body.role === "admin" ? "admin" : "staff"}`);
      u.role = body.role === "admin" ? "admin" : "staff";
    }
    if (body.password) {
      if (str(body.password).length < 6) return fail(res, 400, "Password must be at least 6 characters");
      Object.assign(u, hashPassword(str(body.password)));
      for (const [t, s] of sessions) if (s.username === u.username && t !== user.token) sessions.delete(t);
      changes.push("Password reset");
    }
    saveDb();
    if (changes.length) logAudit(req, user, "user.update", u.username, changes);
    return send(res, 200, publicUser(u));
  }

  if (route === "POST /api/password") {
    const body = await readBody(req);
    const u = db.users.find(x => x.username === user.username);
    if (!checkPassword(u, str(body.current))) return fail(res, 400, "Current password is wrong");
    if (str(body.next).length < 6) return fail(res, 400, "New password must be at least 6 characters");
    Object.assign(u, hashPassword(str(body.next)));
    saveDb(); logAudit(req, user, "password.change", user.username);
    return send(res, 200, { ok: true });
  }

  // ----- backup (admin) -----
  if (route === "GET /api/backup") {
    if (adminOnly()) return;
    logAudit(req, user, "backup.download", "", `${db.invoices.length} invoices`);
    return send(res, 200, { settings: db.settings, invoices: db.invoices, exportedAt: new Date().toISOString() },
      { "Content-Disposition": `attachment; filename="invoices-backup-${new Date().toISOString().slice(0, 10)}.json"` });
  }
  if (route === "POST /api/import") {
    if (adminOnly()) return;
    const body = await readBody(req);
    if (!Array.isArray(body.invoices)) return fail(res, 400, "Not a valid backup file");
    const ids = new Set(db.invoices.map(i => i.id)), nums = new Set(db.invoices.map(i => i.number));
    const added = body.invoices.filter(i => i && i.id && i.number && !ids.has(i.id) && !nums.has(i.number));
    db.invoices.push(...added);
    db.invoices.sort((a, b) => String(b.createdAt || b.date).localeCompare(String(a.createdAt || a.date)));
    // keep the counters ahead of every imported number
    for (const i of added) {
      const n = parseInt(String(i.number).slice(db.settings.invPrefix.length).replace(/\D/g, ""), 10);
      if (n >= db.settings.nextInvoice) db.settings.nextInvoice = n + 1;
      for (const p of i.payments || []) if (num(p.no) >= db.settings.nextReceipt) db.settings.nextReceipt = num(p.no) + 1;
    }
    if (body.settings && body.restoreSettings) {
      const { logo, courses, ...rest } = body.settings;
      for (const k of Object.keys(SETTING_TYPES)) if (k in rest) db.settings[k] = rest[k];
      if (courses) db.settings.courses = cleanCourses(courses);
    }
    saveDb();
    logAudit(req, user, "backup.import", "", [`Added ${added.length} invoice(s)`, `Skipped ${body.invoices.length - added.length} already present`,
      body.settings && body.restoreSettings ? "Company settings restored" : "Settings not changed", ...added.slice(0, 50).map(i => i.number)]);
    return send(res, 200, { added: added.length, skipped: body.invoices.length - added.length, settings: publicSettings() });
  }

  // ----- email / SMTP settings (admin) -----
  if (route === "GET /api/mail-settings") {
    if (adminOnly()) return;
    const { pass, ...rest } = db.mail;
    return send(res, 200, { ...rest, hasPassword: !!pass });
  }
  if (route === "PUT /api/mail-settings") {
    if (adminOnly()) return;
    const body = await readBody(req);
    const before = { ...db.mail };
    db.mail.host = str(body.host, 200).trim();
    db.mail.port = Math.min(65535, Math.max(1, Math.trunc(num(body.port)) || 587));
    db.mail.secure = !!body.secure;
    db.mail.insecureTLS = !!body.insecureTLS;
    db.mail.user = str(body.user, 200).trim();
    if (str(body.pass)) db.mail.pass = str(body.pass, 500);
    db.mail.fromName = str(body.fromName, 200).trim();
    db.mail.fromEmail = str(body.fromEmail, 200).trim();
    saveDb();
    const changes = [
      before.host !== db.mail.host ? `Host: "${before.host || "—"}" → "${db.mail.host || "—"}"` : null,
      before.port !== db.mail.port ? `Port: ${before.port} → ${db.mail.port}` : null,
      before.secure !== db.mail.secure ? `Connection: ${before.secure ? "SSL/TLS" : "STARTTLS"} → ${db.mail.secure ? "SSL/TLS" : "STARTTLS"}` : null,
      before.user !== db.mail.user ? `Username: "${before.user || "—"}" → "${db.mail.user || "—"}"` : null,
      str(body.pass) ? "Password updated" : null,
      before.fromName !== db.mail.fromName ? `From name: "${before.fromName || "—"}" → "${db.mail.fromName || "—"}"` : null,
      before.fromEmail !== db.mail.fromEmail ? `From address: "${before.fromEmail || "—"}" → "${db.mail.fromEmail || "—"}"` : null
    ].filter(Boolean);
    if (changes.length) logAudit(req, user, "mail.settings.update", "", changes);
    const { pass, ...rest } = db.mail;
    return send(res, 200, { ...rest, hasPassword: !!pass });
  }
  if (route === "POST /api/mail-settings/test") {
    if (adminOnly()) return;
    const body = await readBody(req);
    const to = str(body.to, 200).trim();
    if (!EMAIL_RE.test(to)) return fail(res, 400, "Enter a valid email address");
    if (!db.mail.host || !db.mail.fromEmail) return fail(res, 400, "Fill in the SMTP host and from-email first, then save, before sending a test");
    const log = addMailLog({ kind: "test", to, by: user.username });
    send(res, 202, { ok: true, queued: true, id: log.id });
    sendMail({
      host: db.mail.host, port: db.mail.port, secure: db.mail.secure, insecureTLS: db.mail.insecureTLS,
      user: db.mail.user, pass: db.mail.pass, fromEmail: db.mail.fromEmail, fromName: db.mail.fromName || db.settings.name,
      to, subject: `Test email from ${db.settings.name}`,
      html: `<p>This is a test email from your invoice system (${str(db.settings.name, 200)}).</p><p>If you received this, your email settings are working correctly.</p>`,
      text: `This is a test email from your invoice system (${db.settings.name}). If you received this, your email settings are working correctly.`
    }).then(() => {
      updateMailLog(log.id, { status: "sent" });
      logAudit(req, user, "mail.settings.test", "", `Sent to ${to}`);
    }).catch((e) => {
      updateMailLog(log.id, { status: "failed", error: e.message });
    });
    return;
  }
  if (route === "GET /api/mail-log") {
    if (adminOnly()) return;
    const limit = Math.min(300, Math.max(1, Math.trunc(num(url.searchParams.get("limit"))) || 100));
    return send(res, 200, db.mailLog.slice(0, limit));
  }
  m = /^\/api\/mail-log\/([\w-]+)$/.exec(url.pathname);
  if (m && req.method === "GET") {
    const e = db.mailLog.find(x => x.id === m[1]);
    if (!e) return fail(res, 404, "Not found");
    if (!isAdmin && (e.kind !== "invoice" || e.by !== user.username)) return fail(res, 403, "Not yours to view");
    return send(res, 200, { id: e.id, status: e.status, error: e.error, to: e.to, time: e.time });
  }

  // ----- journals (admin) -----
  if (route === "GET /api/journals") {
    if (adminOnly()) return;
    return send(res, 200, db.journals);
  }
  if (route === "GET /api/accounts") {
    if (adminOnly()) return;
    const list = db.settings.accounts.length ? db.settings.accounts : DEFAULT_ACCOUNTS;
    return send(res, 200, list);
  }
  if (route === "POST /api/accounts") {
    if (adminOnly()) return;
    const body = await readBody(req);
    const name = str(body.name, 100).trim();
    if (!name) return fail(res, 400, "Account name is required");
    if (!db.settings.accounts.length) db.settings.accounts = [...DEFAULT_ACCOUNTS];
    if (db.settings.accounts.some(a => a.toLowerCase() === name.toLowerCase())) return fail(res, 400, "Account already exists");
    db.settings.accounts.push(name);
    db.settings.accounts.sort();
    saveDb();
    return send(res, 201, db.settings.accounts);
  }
  if (route === "POST /api/journals") {
    if (adminOnly()) return;
    const body = await readBody(req);
    const j = {
      id: uid(),
      number: db.settings.nextJournal++,
      date: str(body.date, 10) || new Date().toISOString().slice(0, 10),
      reverseDate: str(body.reverseDate, 10) || "",
      reference: str(body.reference, 100),
      notes: str(body.notes, 500),
      method: ["accrual_cash", "accrual", "cash"].includes(body.method) ? body.method : "accrual_cash",
      currency: str(body.currency, 10) || db.settings.currency,
      rows: [],
      createdAt: new Date().toISOString(),
      createdBy: user.username
    };
    if (Array.isArray(body.rows)) {
      j.rows = body.rows.slice(0, 50).map(r => ({
        account: str(r.account, 100),
        description: str(r.description, 500),
        contact: str(r.contact, 100),
        debit: Math.max(0, num(r.debit)),
        credit: Math.max(0, num(r.credit))
      })).filter(r => r.account || r.debit || r.credit);
    }
    if (!j.rows.length) return fail(res, 400, "Add at least one journal row");
    const totalDebit = j.rows.reduce((s, r) => s + r.debit, 0);
    const totalCredit = j.rows.reduce((s, r) => s + r.credit, 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) return fail(res, 400, "Debits and credits must be equal");
    db.journals.unshift(j);
    saveDb();
    logAudit(req, user, "journal.create", `JRN-${j.number}`, [`Date: ${j.date}`, `Rows: ${j.rows.length}`, `Total: ${db.settings.currency} ${totalDebit.toFixed(2)}`]);
    return send(res, 201, { journal: j });
  }
  m = /^\/api\/journals\/([\w-]+)$/.exec(url.pathname);
  if (m && req.method === "DELETE") {
    if (adminOnly()) return;
    const idx = db.journals.findIndex(j => j.id === m[1]);
    if (idx < 0) return fail(res, 404, "Journal not found");
    const [gone] = db.journals.splice(idx, 1);
    saveDb();
    logAudit(req, user, "journal.delete", `JRN-${gone.number}`, `Date: ${gone.date}`);
    return send(res, 200, { ok: true });
  }

  return fail(res, 404, "Not found");
}

// ---------------------------------------------------------------------------
// Pages & static files (only these files are ever served)
// ---------------------------------------------------------------------------
const STATIC = {
  "/login.html": ["login.html", "text/html; charset=utf-8"],
  "/logo.png": ["logo.png", "image/png"],
  "/logo-mark.png": ["logo-mark.png", "image/png"],
  "/background.svg": ["background.svg", "image/svg+xml"],
  "/background-dark.svg": ["background-dark.svg", "image/svg+xml"],
  "/background-light.svg": ["background-light.svg", "image/svg+xml"],
  "/logo-transparent.png": ["logo-transparent.png", "image/png"],
  "/logo-dark.png": ["logo-dark.png", "image/png"],
  "/logo-mark-transparent.png": ["logo-mark-transparent.png", "image/png"],
  "/logo-mark-dark.png": ["logo-mark-dark.png", "image/png"],
  "/logo-new.png": ["logo-new.png", "image/png"],
  "/common.js": ["common.js", "text/javascript; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"]
};
const PAGES = { "/": ["index.html", "staff"], "/index.html": ["index.html", "staff"], "/admin": ["admin.html", "admin"], "/admin.html": ["admin.html", "admin"], "/report": ["report.html", "admin"] };

function serveFile(res, file, type) {
  fs.readFile(path.join(ROOT, file), (err, data) => {
    if (err) return send(res, 404, "Not found");
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" });
    res.end(data);
  });
}

loadDb();
loadAudit();

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (STATIC[url.pathname]) return serveFile(res, ...STATIC[url.pathname]);
    const page = PAGES[url.pathname];
    if (page) {
      const user = getUser(req);
      if (!user) { res.writeHead(302, { Location: "/login.html" }); return res.end(); }
      if (page[1] === "admin" && user.role !== "admin") { res.writeHead(302, { Location: "/" }); return res.end(); }
      return serveFile(res, page[0], "text/html; charset=utf-8");
    }
    send(res, 404, "Not found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, e.message === "too large" ? 413 : 400, e.message === "too large" ? "Upload too large" : "Bad request");
  }
}).listen(PORT, HOST, () => console.log(`Invoice app running at http://localhost:${PORT}`));
