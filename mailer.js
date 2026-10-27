// Minimal, dependency-free SMTP client (talks raw SMTP over net/tls) plus a MIME builder.
// Supports: implicit TLS (secure:true, e.g. port 465), STARTTLS (port 587/25), AUTH LOGIN.
const net = require("net");
const tls = require("tls");
const https = require("https");
const os = require("os");
const crypto = require("crypto");

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const foldHeader = (s) => String(s ?? "").replace(/[\r\n]+/g, " ");
const encodeWord = (s) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

function chunkBase64(b64str) {
  const lines = [];
  for (let i = 0; i < b64str.length; i += 76) lines.push(b64str.slice(i, i + 76));
  return lines.join("\r\n");
}

// Escape any line that begins with "." so the server doesn't mistake it for the end-of-DATA marker.
function dotStuff(msg) {
  return msg.split("\r\n").map(l => l.startsWith(".") ? "." + l : l).join("\r\n");
}

function buildMime({ fromName, fromEmail, to, subject, html, text, attachments = [] }) {
  const altBoundary = "b_" + crypto.randomBytes(12).toString("hex");
  const messageId = `<${crypto.randomBytes(16).toString("hex")}@${(fromEmail.split("@")[1] || "localhost")}>`;
  const fromHeader = fromName ? `${encodeWord(foldHeader(fromName))} <${fromEmail}>` : fromEmail;
  const alt = [
    `--${altBoundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    chunkBase64(Buffer.from(text || "", "utf8").toString("base64")),
    `--${altBoundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    chunkBase64(Buffer.from(html || "", "utf8").toString("base64")),
    `--${altBoundary}--`
  ].join("\r\n");

  const baseHeaders = {
    From: fromHeader, To: foldHeader(to), Subject: encodeWord(foldHeader(subject)),
    Date: new Date().toUTCString(), "Message-ID": messageId, "MIME-Version": "1.0"
  };

  if (!attachments.length) {
    const headers = { ...baseHeaders, "Content-Type": `multipart/alternative; boundary="${altBoundary}"` };
    const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");
    return { mime: `${head}\r\n\r\n${alt}\r\n`, messageId };
  }

  const mixBoundary = "b_" + crypto.randomBytes(12).toString("hex");
  const attachParts = attachments.map(a => [
    `--${mixBoundary}`,
    `Content-Type: ${a.contentType || "application/octet-stream"}; name="${foldHeader(a.filename)}"`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="${foldHeader(a.filename)}"`,
    ``,
    chunkBase64(Buffer.from(a.content).toString("base64"))
  ].join("\r\n")).join("\r\n");

  const headers = { ...baseHeaders, "Content-Type": `multipart/mixed; boundary="${mixBoundary}"` };
  const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");
  const body = [
    `--${mixBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    ``,
    alt,
    attachParts,
    `--${mixBoundary}--`,
    ``
  ].join("\r\n");
  return { mime: `${head}\r\n\r\n${body}`, messageId };
}

// Buffers incoming bytes into complete SMTP lines ("\r\n" or bare "\n" terminated).
function makeReader() {
  let buf = "";
  const lines = [];
  const waiters = [];
  let onData = null, sock = null;
  function bind(socket) {
    if (sock && onData) sock.removeListener("data", onData);
    sock = socket; buf = "";
    onData = (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (waiters.length) waiters.shift().resolve(line);
        else lines.push(line);
      }
    };
    sock.on("data", onData);
  }
  function nextLine() {
    if (lines.length) return Promise.resolve(lines.shift());
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }
  function rejectAll(err) { while (waiters.length) waiters.shift().reject(err); }
  return { bind, nextLine, rejectAll };
}

// Collects one full (possibly multi-line) SMTP response, e.g. "250-A\r\n250 B".
async function readResponse(nextLine) {
  let code = "", message = [];
  for (;;) {
    const line = await nextLine();
    code = line.slice(0, 3);
    message.push(line.slice(4));
    if (line[3] !== "-") break;
  }
  return { code: Number(code), message: message.join("\n") };
}

function sendMail(opts) {
  const {
    host, port, secure, insecureTLS, user, pass, fromEmail, fromName,
    to, subject, html, text, attachments, timeout = 20000
  } = opts;

  return new Promise((resolve, reject) => {
    let socket, settled = false;
    const reader = makeReader();

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reader.rejectAll(err);
      try { socket && socket.destroy(); } catch {}
      reject(err);
    };
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };

    function wire(s) {
      s.setTimeout(timeout);
      s.on("timeout", () => fail(new Error(`Connection to ${host}:${port} timed out`)));
      s.on("error", (e) => fail(new Error(`SMTP connection error: ${e.message}`)));
      reader.bind(s);
    }

    try {
      socket = secure
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: !insecureTLS })
        : net.connect({ host, port });
    } catch (e) { return fail(new Error(`Could not connect: ${e.message}`)); }
    wire(socket);

    const write = (line) => socket.write(line + "\r\n");
    const read = () => readResponse(reader.nextLine);
    const localName = () => { try { return os.hostname() || "localhost"; } catch { return "localhost"; } };

    async function ehlo() {
      write(`EHLO ${localName()}`);
      let r = await read();
      if (r.code !== 250) {
        write(`HELO ${localName()}`);
        r = await read();
        if (r.code !== 250) throw new Error(`Server did not accept EHLO/HELO: ${r.message || r.code}`);
      }
      return r.message;
    }

    async function upgradeToTls() {
      write("STARTTLS");
      const r = await read();
      if (r.code !== 220) throw new Error(`STARTTLS was refused: ${r.message || r.code}`);
      const plain = socket;
      const upgraded = await new Promise((res, rej) => {
        const s = tls.connect({ socket: plain, servername: host, rejectUnauthorized: !insecureTLS }, () => res(s));
        s.once("error", rej);
      });
      socket = upgraded;
      wire(socket);
    }

    async function run() {
      const greeting = await read();
      if (greeting.code !== 220) throw new Error(`Server refused the connection: ${greeting.message || greeting.code}`);

      let caps = await ehlo();
      if (!secure && /^STARTTLS/im.test(caps)) {
        await upgradeToTls();
        caps = await ehlo();
      }

      if (user) {
        write("AUTH LOGIN");
        let r = await read();
        if (r.code !== 334) throw new Error(`Server did not accept AUTH LOGIN: ${r.message || r.code}`);
        write(b64(user));
        r = await read();
        if (r.code !== 334) throw new Error(`Username was rejected: ${r.message || r.code}`);
        write(b64(pass || ""));
        r = await read();
        if (r.code !== 235) throw new Error(`Login failed — check the username and password: ${r.message || r.code}`);
      }

      write(`MAIL FROM:<${fromEmail}>`);
      let r = await read();
      if (r.code !== 250) throw new Error(`Sender address was rejected: ${r.message || r.code}`);

      const recipients = Array.isArray(to) ? to : [to];
      for (const rcpt of recipients) {
        write(`RCPT TO:<${rcpt}>`);
        r = await read();
        if (r.code !== 250 && r.code !== 251) throw new Error(`Recipient ${rcpt} was rejected: ${r.message || r.code}`);
      }

      write("DATA");
      r = await read();
      if (r.code !== 354) throw new Error(`Server did not accept DATA: ${r.message || r.code}`);

      const { mime, messageId } = buildMime({ fromName, fromEmail, to: recipients.join(", "), subject, html, text, attachments });
      socket.write(dotStuff(mime) + "\r\n.\r\n");
      r = await read();
      if (r.code !== 250) throw new Error(`Server rejected the message: ${r.message || r.code}`);

      write("QUIT");
      try { await read(); } catch {}
      try { socket.end(); } catch {}
      return { messageId };
    }

    run().then(finish, fail);
  });
}

// Sends via the Resend HTTPS API (https://resend.com), for hosts where outbound SMTP ports
// are firewalled but 443 is open. No SDK — a plain JSON POST over Node's built-in https module.
function sendMailHttp({ apiKey, fromEmail, fromName, to, subject, html, text, attachments = [], timeout = 20000 }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
      attachments: attachments.map(a => ({
        filename: a.filename,
        content: Buffer.from(a.content).toString("base64"),
      })),
    });

    const req = https.request({
      hostname: "api.resend.com",
      path: "/emails",
      method: "POST",
      timeout,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ messageId: parsed.id || null });
        } else {
          reject(new Error(parsed.message || `Resend API responded with ${res.statusCode}`));
        }
      });
    });

    req.on("timeout", () => { req.destroy(new Error("Resend API request timed out")); });
    req.on("error", (e) => reject(new Error(`Resend API request failed: ${e.message}`)));
    req.end(payload);
  });
}

module.exports = { sendMail, sendMailHttp };
