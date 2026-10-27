// Minimal, dependency-free Telegram Bot API client — sends a file to a chat via sendDocument.
// Multipart/form-data body built by hand (same approach as mailer.js's MIME builder), no SDK.
const https = require("https");

function sendTelegramDocument({ botToken, chatId, filename, content, caption, timeout = 20000 }) {
  return new Promise((resolve, reject) => {
    const boundary = "----CLTBackup" + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`, "utf8")
    ];
    if (caption) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`, "utf8"));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/json\r\n\r\n`, "utf8"));
    parts.push(Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
    const body = Buffer.concat(parts);

    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${encodeURIComponent(botToken)}/sendDocument`,
      method: "POST",
      timeout,
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length }
    }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && parsed.ok) resolve(parsed);
        else reject(new Error(parsed.description || `Telegram API responded with ${res.statusCode}`));
      });
    });

    req.on("timeout", () => req.destroy(new Error("Telegram API request timed out")));
    req.on("error", (e) => reject(new Error(`Telegram API request failed: ${e.message}`)));
    req.end(body);
  });
}

module.exports = { sendTelegramDocument };
