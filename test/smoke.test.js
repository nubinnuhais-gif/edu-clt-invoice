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
  const fake = await startFakeSmtp();
  fakeSmtp = fake.server; fakeSmtpPort = fake.port;
  serverProc = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR, ADMIN_PASSWORD },
    stdio: "pipe"
  });
  await waitForServer(BASE + "/login.html");
});

after(async () => {
  serverProc?.kill();
  await new Promise((r) => fakeSmtp.close(r));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
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

test("a staff user cannot read mail settings", async () => {
  const create = await api("POST", "/api/users", { cookie: adminCookie, body: { username: "staffer", password: "StaffPass1", role: "staff" } });
  assert.equal(create.status, 201);
  const login = await api("POST", "/api/login", { body: { username: "staffer", password: "StaffPass1" } });
  assert.equal(login.status, 200);
  const r = await api("GET", "/api/mail-settings", { cookie: login.cookie });
  assert.equal(r.status, 403);
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
