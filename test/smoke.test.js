// End-to-end smoke tests: spin up the real server against a throwaway data dir and a fake SMTP
// server, then exercise the main API surface (auth, invoices, journals, email + PDF attachment).
// Uses only Node's built-in test runner — no new dependencies.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const { Pool } = require("pg");

// Tests need a PostgreSQL server (default: the docker container from the README). A throwaway
// database is created for the run and dropped afterwards.
const PG_ADMIN_URL = process.env.TEST_PG_URL || "postgres://postgres:postgres@127.0.0.1:55432/postgres";
const TEST_DB = "clt_test_" + Math.random().toString(36).slice(2, 10);
const TEST_DB_URL = PG_ADMIN_URL.replace(/\/[^/]*$/, "/" + TEST_DB);

const ROOT = path.join(__dirname, "..");
const PORT = 8411;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clt-test-"));
const ADMIN_PASSWORD = "TestPass123!";

let serverProc, fakeSmtp, fakeSmtpPort;
const receivedEmails = [];

function waitForServer(url, tries = 80) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      fetch(url).then(() => resolve()).catch(() => {
        if (n <= 0) return reject(new Error("server did not start in time"));
        setTimeout(() => attempt(n - 1), 250);
      });
    };
    attempt(tries);
  });
}

function startFakeSmtp() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.write("220 fake.smtp greeting\r\n");
      let buf = "", mode = "cmd", authStep = 0, data = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          let line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (mode === "data") {
            if (line === ".") { mode = "cmd"; socket.write("250 OK queued\r\n"); receivedEmails.push(data); data = ""; }
            else data += line.replace(/^\.\./, ".") + "\n";
            continue;
          }
          if (authStep === 1) { authStep = 2; socket.write("334 UGFzc3dvcmQ6\r\n"); continue; }
          if (authStep === 2) { authStep = 0; socket.write("235 Authentication successful\r\n"); continue; }
          if (/^EHLO/i.test(line)) socket.write("250-fake.smtp\r\n250 AUTH LOGIN\r\n");
          else if (/^AUTH LOGIN/i.test(line)) { authStep = 1; socket.write("334 VXNlcm5hbWU6\r\n"); }
          else if (/^MAIL FROM/i.test(line)) socket.write("250 OK\r\n");
          else if (/^RCPT TO/i.test(line)) socket.write("250 OK\r\n");
          else if (/^DATA/i.test(line)) { mode = "data"; socket.write("354 Send data\r\n"); }
          else if (/^QUIT/i.test(line)) socket.write("221 Bye\r\n");
          else socket.write("500 Unrecognized\r\n");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function api(method, p, { body, cookie } = {}) {
  const headers = {};
  if (body !== undefined || method !== "GET") headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + p, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : (method !== "GET" ? "{}" : undefined)
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  const setCookie = res.headers.get("set-cookie");
  const sid = setCookie && /sid=[a-f0-9]+/.exec(setCookie)?.[0];
  return { status: res.status, body: json, cookie: sid };
}

before(async () => {
  const admin = new Pool({ connectionString: PG_ADMIN_URL });
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  const fake = await startFakeSmtp();
  fakeSmtp = fake.server; fakeSmtpPort = fake.port;
  serverProc = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR, ADMIN_PASSWORD, DATABASE_URL: TEST_DB_URL },
    stdio: "pipe"
  });
  await waitForServer(BASE + "/login.html");
});

after(async () => {
  serverProc?.kill();
  await new Promise((r) => fakeSmtp.close(r));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const admin = new Pool({ connectionString: PG_ADMIN_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
});

let adminCookie, invoiceId;

test("rejects a wrong password", async () => {
  const r = await api("POST", "/api/login", { body: { username: "admin", password: "wrong" } });
  assert.equal(r.status, 401);
});

test("logs in as admin", async () => {
  const r = await api("POST", "/api/login", { body: { username: "admin", password: ADMIN_PASSWORD } });
  assert.equal(r.status, 200);
  assert.equal(r.body.role, "admin");
  adminCookie = r.cookie;
  assert.ok(adminCookie);
});

test("redirects an unauthenticated page request to login", async () => {
  const res = await fetch(BASE + "/", { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /login\.html$/);
});

test("default settings look sane", async () => {
  const r = await api("GET", "/api/settings", { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.currency, "AED");
  assert.ok(r.body.courses.length > 0);
});

test("creates an invoice", async () => {
  const r = await api("POST", "/api/invoices", {
    cookie: adminCookie,
    body: {
      date: "2026-01-01", terms: "Due on Receipt", due: "2026-01-01",
      customer: { name: "Test Student", email: "student@example.com", phone: "" },
      items: [{ courseId: "c1", desc: "Profit Matrix", qty: 1, rate: 4500, tax: 5 }],
      payments: [], notes: ""
    }
  });
  assert.equal(r.status, 201);
  assert.match(r.body.invoice.number, /^INV-/);
  invoiceId = r.body.invoice.id;
});

test("lists the created invoice", async () => {
  const r = await api("GET", "/api/invoices", { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.ok(r.body.some((i) => i.id === invoiceId));
});

test("rejects an invoice with no student name", async () => {
  const r = await api("POST", "/api/invoices", {
    cookie: adminCookie,
    body: { date: "2026-01-01", customer: { name: "" }, items: [{ courseId: "c1", desc: "Profit Matrix", qty: 1, rate: 4500, tax: 5 }], payments: [] }
  });
  assert.equal(r.status, 400);
});

test("a staff user cannot read mail settings, manage users, download the backup, or read the audit log", async () => {
  const create = await api("POST", "/api/users", { cookie: adminCookie, body: { username: "staffer", password: "StaffPass1", role: "staff" } });
  assert.equal(create.status, 201);
  const login = await api("POST", "/api/login", { body: { username: "staffer", password: "StaffPass1" } });
  assert.equal(login.status, 200);
  assert.equal((await api("GET", "/api/mail-settings", { cookie: login.cookie })).status, 403);
  assert.equal((await api("GET", "/api/users", { cookie: login.cookie })).status, 403);
  assert.equal((await api("GET", "/api/backup", { cookie: login.cookie })).status, 403);
  assert.equal((await api("GET", "/api/audit", { cookie: login.cookie })).status, 403);
  assert.equal((await api("GET", "/api/audit/export", { cookie: login.cookie })).status, 403);
});

test("a staff user can use journals, reports, and company/course settings", async () => {
  const login = await api("POST", "/api/login", { body: { username: "staffer", password: "StaffPass1" } });
  assert.equal(login.status, 200);
  assert.equal((await api("GET", "/api/journals", { cookie: login.cookie })).status, 200);
  assert.equal((await api("GET", "/api/accounts", { cookie: login.cookie })).status, 200);
  assert.equal((await api("GET", "/api/reports", { cookie: login.cookie })).status, 200);
  const settingsResp = await api("PUT", "/api/settings", { cookie: login.cookie, body: { address: "123 Staff-edited Street" } });
  assert.equal(settingsResp.status, 200);
  assert.equal(settingsResp.body.address, "123 Staff-edited Street");
});

test("saves mail settings and never echoes the password back", async () => {
  const r = await api("PUT", "/api/mail-settings", {
    cookie: adminCookie,
    body: { host: "127.0.0.1", port: fakeSmtpPort, secure: false, insecureTLS: true, user: "tester", pass: "secret", fromName: "CLT Test", fromEmail: "billing@clt.test" }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.hasPassword, true);
  assert.equal("pass" in r.body, false);
});

test("emails the invoice with a valid PDF attachment", async () => {
  const send = await api("POST", `/api/invoices/${invoiceId}/send`, { cookie: adminCookie, body: {} });
  assert.equal(send.status, 202);
  assert.equal(send.body.queued, true);

  let status;
  for (let i = 0; i < 25; i++) {
    const poll = await api("GET", `/api/mail-log/${send.body.id}`, { cookie: adminCookie });
    status = poll.body.status;
    if (status !== "pending") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(status, "sent");
  assert.equal(receivedEmails.length, 1);
  const eml = receivedEmails[0];
  assert.match(eml, /Content-Type: multipart\/mixed/);
  assert.match(eml, /Content-Type: application\/pdf/);

  const afterHeader = eml.split(/Content-Disposition: attachment[^\n]*\n\n/)[1];
  const b64 = afterHeader.split(/\n--b_/)[0].replace(/\n/g, "");
  const pdf = Buffer.from(b64, "base64");
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");

  const pixel = await api("GET", `/api/mail-log/${send.body.id}/open.gif`);
  assert.equal(pixel.status, 200);
  const after = await api("GET", `/api/mail-log/${send.body.id}`, { cookie: adminCookie });
  assert.ok(after.body.openedAt);
  assert.equal(after.body.openCount, 1);

  const activity = await api("GET", `/api/invoices/${invoiceId}/activity`, { cookie: adminCookie });
  assert.equal(activity.status, 200);
  const actions = activity.body.entries.map((e) => e.action);
  assert.ok(actions.includes("invoice.email"));
  assert.ok(actions.includes("invoice.opened"));
  assert.ok(activity.body.labels["invoice.opened"]);
});

test("rejects an unbalanced journal entry", async () => {
  const r = await api("POST", "/api/journals", {
    cookie: adminCookie,
    body: { date: "2026-01-01", rows: [{ account: "Cash", debit: 100, credit: 0 }, { account: "Revenue - Training", debit: 0, credit: 50 }] }
  });
  assert.equal(r.status, 400);
});

test("accepts a balanced journal entry and lists it", async () => {
  const r = await api("POST", "/api/journals", {
    cookie: adminCookie,
    body: { date: "2026-01-01", rows: [{ account: "Cash", debit: 100, credit: 0 }, { account: "Revenue - Training", debit: 0, credit: 100 }] }
  });
  assert.equal(r.status, 201);
  const list = await api("GET", "/api/journals", { cookie: adminCookie });
  assert.ok(list.body.some((j) => j.id === r.body.journal.id));
});

// ----- security regression checks -----

test("login with a nonexistent username still fails cleanly (constant-time path)", async () => {
  const r = await api("POST", "/api/login", { body: { username: "no-such-user-xyz", password: "whatever" } });
  assert.equal(r.status, 401);
});

test("session cookie omits Secure over plain HTTP but keeps HttpOnly/SameSite", async () => {
  const res = await fetch(BASE + "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD })
  });
  const setCookie = res.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.doesNotMatch(setCookie, /Secure/);
});

test("rejects a From address with a CRLF injection attempt", async () => {
  const r = await api("PUT", "/api/mail-settings", {
    cookie: adminCookie,
    body: { host: "smtp.example.com", port: 587, fromEmail: "x@example.com\r\nBCC:attacker@evil.com" }
  });
  assert.equal(r.status, 400);
});

test("rejects a malformed From address", async () => {
  const r = await api("PUT", "/api/mail-settings", { cookie: adminCookie, body: { host: "smtp.example.com", port: 587, fromEmail: "not-an-email" } });
  assert.equal(r.status, 400);
});

test("accepts a valid From address", async () => {
  const r = await api("PUT", "/api/mail-settings", { cookie: adminCookie, body: { host: "smtp.example.com", port: 587, fromEmail: "billing@example.com" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.fromEmail, "billing@example.com");
});

test("caps invoice items at 200 regardless of how many are submitted", async () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ courseId: "c1", desc: `Item ${i}`, qty: 1, rate: 10, tax: 0 }));
  const r = await api("POST", "/api/invoices", {
    cookie: adminCookie,
    body: { date: "2026-01-01", customer: { name: "Cap Test", email: "" }, items, payments: [] }
  });
  assert.equal(r.status, 201);
  assert.ok(r.body.invoice.items.length <= 200);
});

test("rate-limits repeated test emails from the same user", async () => {
  await api("PUT", "/api/mail-settings", { cookie: adminCookie, body: { host: "127.0.0.1", port: fakeSmtpPort, insecureTLS: true, fromEmail: "billing@clt.test" } });
  let sawLimit = false;
  for (let i = 0; i < 35; i++) {
    const r = await api("POST", "/api/mail-settings/test", { cookie: adminCookie, body: { to: `probe${i}@example.com` } });
    if (r.status === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit, "expected a 429 after enough rapid email sends");
  // the queued sends before the 429 are still completing against the fake SMTP server in the
  // background — give them a moment so they don't outlive the suite's teardown (ECONNRESET noise).
  await new Promise((r) => setTimeout(r, 1500));
});

test("backup import sanitizes and rejects invalid records instead of trusting the file", async () => {
  const bogus = {
    invoices: [
      { id: "bogus-1", number: "BOGUS-0001", date: "2026-01-01", customer: { name: "A".repeat(5000) }, items: [{ desc: "x", qty: 1, rate: 1 }], payments: [] },
      { id: "bogus-2", number: "BOGUS-0002", date: "2026-01-01", customer: { name: "" }, items: [{ desc: "x", qty: 1, rate: 1 }], payments: [] }, // no name -> rejected
      { id: "bogus-3", number: "BOGUS-0003", date: "2026-01-01", customer: { name: "No Items" }, items: [], payments: [] } // no items -> rejected
    ]
  };
  const r = await api("POST", "/api/import", { cookie: adminCookie, body: bogus });
  assert.equal(r.status, 200);
  assert.equal(r.body.added, 1); // only bogus-1 is valid enough to import
  const list = await api("GET", "/api/invoices", { cookie: adminCookie });
  const imported = list.body.find((i) => i.id === "bogus-1");
  assert.ok(imported);
  assert.ok(imported.customer.name.length <= 200); // oversized name was truncated, not stored raw
});

test("a staff user cannot read or change the Telegram backup settings", async () => {
  const login = await api("POST", "/api/login", { body: { username: "staffer", password: "StaffPass1" } });
  assert.equal(login.status, 200);
  assert.equal((await api("GET", "/api/telegram-settings", { cookie: login.cookie })).status, 403);
  assert.equal((await api("PUT", "/api/telegram-settings", { cookie: login.cookie, body: { enabled: true, botToken: "x", chatId: "123" } })).status, 403);
});

test("Telegram backup settings validate the chat ID and require both fields before enabling", async () => {
  const badChat = await api("PUT", "/api/telegram-settings", { cookie: adminCookie, body: { botToken: "123:abc", chatId: "not a chat id!" } });
  assert.equal(badChat.status, 400);

  const enableWithoutToken = await api("PUT", "/api/telegram-settings", { cookie: adminCookie, body: { enabled: true, chatId: "123456789" } });
  assert.equal(enableWithoutToken.status, 400);

  const saved = await api("PUT", "/api/telegram-settings", { cookie: adminCookie, body: { enabled: true, botToken: "123456789:AAfake-token", chatId: "123456789" } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.enabled, true);
  assert.equal(saved.body.hasToken, true);
  assert.equal(saved.body.chatId, "123456789");
  assert.equal("botToken" in saved.body, false); // the raw token is never echoed back

  const read = await api("GET", "/api/telegram-settings", { cookie: adminCookie });
  assert.equal(read.status, 200);
  assert.equal(read.body.hasToken, true);

  // a channel-username chat ID is also accepted
  const channelChat = await api("PUT", "/api/telegram-settings", { cookie: adminCookie, body: { chatId: "@my_channel" } });
  assert.equal(channelChat.status, 200);
  assert.equal(channelChat.body.chatId, "@my_channel");
});

test("Telegram test-backup refuses to run when unconfigured", async () => {
  const r = await api("PUT", "/api/telegram-settings", { cookie: adminCookie, body: { enabled: false, chatId: "" } });
  assert.equal(r.status, 200);
  const test = await api("POST", "/api/telegram-settings/test", { cookie: adminCookie });
  assert.equal(test.status, 400);
});

test("responses carry baseline security headers", async () => {
  const res = await fetch(BASE + "/api/me", { headers: { Cookie: adminCookie } });
  assert.match(res.headers.get("content-security-policy") || "", /default-src 'self'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.ok(res.headers.get("strict-transport-security"));
});

test("audit log records the real client IP from CF-Connecting-IP, not the tunnel's loopback address", async () => {
  const res = await fetch(BASE + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.42" },
    body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD })
  });
  assert.equal(res.status, 200);
  const audit = await api("GET", "/api/audit?limit=5", { cookie: adminCookie });
  const entry = audit.body.entries.find((e) => e.action === "login.success" && e.user === "admin");
  assert.equal(entry.ip, "203.0.113.42");
});

test("locks out repeated wrong-password login attempts from the same IP", async () => {
  const ip = "198.51.100.7"; // isolated synthetic IP so this doesn't lock out the shared loopback address other tests log in from
  let sawLimit = false;
  for (let i = 0; i < 10; i++) {
    const res = await fetch(BASE + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ username: "admin", password: "wrong" })
    });
    if (res.status === 429) { sawLimit = true; break; }
    assert.equal(res.status, 401);
  }
  assert.ok(sawLimit, "expected a 429 after 8 wrong attempts from the same IP");
  // even the correct password is now rejected until the lockout window passes
  const res = await fetch(BASE + "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD })
  });
  assert.equal(res.status, 429);
});

test("locks out repeated wrong-current-password attempts on the password-change endpoint", async () => {
  let sawLimit = false;
  for (let i = 0; i < 10; i++) {
    const r = await api("POST", "/api/password", { cookie: adminCookie, body: { current: "definitely-wrong", next: "irrelevant1" } });
    if (r.status === 429) { sawLimit = true; break; }
    assert.equal(r.status, 400);
  }
  assert.ok(sawLimit, "expected a 429 after enough wrong current-password attempts");
});

test("management can impersonate a user, act as them, then exit back to their own account", async () => {
  const create = await api("POST", "/api/users", { cookie: adminCookie, body: { username: "accounts@clt.test", password: "AccPass123", role: "staff" } });
  assert.equal(create.status, 201);

  const staffLogin = await api("POST", "/api/login", { body: { username: "accounts@clt.test", password: "AccPass123" } });
  const denied = await api("POST", `/api/users/admin/impersonate`, { cookie: staffLogin.cookie });
  assert.equal(denied.status, 403, "a non-management user must not be able to impersonate anyone");

  const start = await api("POST", `/api/users/${encodeURIComponent("accounts@clt.test")}/impersonate`, { cookie: adminCookie });
  assert.equal(start.status, 200);
  assert.equal(start.body.username, "accounts@clt.test");

  const me = await api("GET", "/api/me", { cookie: start.cookie });
  assert.equal(me.body.username, "accounts@clt.test");
  assert.equal(me.body.impersonatedBy, "admin");

  const blocked = await api("GET", "/api/mail-settings", { cookie: start.cookie });
  assert.equal(blocked.status, 403, "impersonated session only has the target user's real permissions");

  const exit = await api("POST", "/api/impersonate/exit", { cookie: start.cookie });
  assert.equal(exit.status, 200);
  assert.equal(exit.body.username, "admin");
  const meAfter = await api("GET", "/api/me", { cookie: exit.cookie });
  assert.equal(meAfter.body.impersonatedBy, null);

  const staleCheck = await api("GET", "/api/me", { cookie: start.cookie });
  assert.equal(staleCheck.status, 401, "the impersonation session is invalidated after exiting");
});
