// Reports, audit-log helpers and a small dependency-free Excel (.xlsx) writer.
const zlib = require("zlib");

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pad2 = (n) => String(n).padStart(2, "0");

// Local date/time "YYYY-MM-DD HH:MM:SS" (server time zone, i.e. UAE time on this PC)
function localStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Invoice totals (same rules as the invoice screen)
// ---------------------------------------------------------------------------
function invTotals(inv) {
  let total = 0;
  const lines = (inv.items || []).map(it => {
    const gross = r2(num(it.qty) * num(it.rate));
    const pct = inv.vatEnabled === true ? num(it.tax) : 0;
    const amount = inv.inclusive ? gross : r2(gross + r2(gross * pct / 100));
    total += amount;
    return { desc: it.desc, qty: num(it.qty), rate: num(it.rate), amount };
  });
  total = r2(total);
  const paid = r2((inv.payments || []).reduce((s, p) => s + num(p.amount), 0));
  const balance = r2(total - paid);
  const status = total > 0 && balance <= 0 ? "Paid" : paid > 0 ? "Partially paid" : "Unpaid";
  return { lines, total, paid, balance, status };
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseRange(q) {
  const now = new Date();
  const from = DATE_RE.test(q.get("from") || "") ? q.get("from") : `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
  const to = DATE_RE.test(q.get("to") || "") ? q.get("to") : localStamp(now).slice(0, 10);
  return from <= to ? { from, to } : { from: to, to: from };
}
function monthsBetween(from, to) {
  const out = []; let [y, m] = from.split("-").map(Number); const [ty, tm] = to.split("-").map(Number);
  while ((y < ty || (y === ty && m <= tm)) && out.length < 600) { out.push(`${y}-${pad2(m)}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (ym) => { const [y, m] = ym.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };

// ---------------------------------------------------------------------------
// Sales report
// ---------------------------------------------------------------------------
function buildReport(invoices, from, to) {
  const inRange = (d) => d && d >= from && d <= to;
  const invs = invoices.filter(i => inRange(i.date))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.number).localeCompare(String(b.number)));

  const rows = invs.map(i => {
    const t = invTotals(i);
    return { number: i.number, date: i.date, student: i.customer?.name || "", email: i.customer?.email || "", phone: i.customer?.phone || "",
      courses: t.lines.map(l => l.qty !== 1 ? `${l.desc} ×${l.qty}` : l.desc).join(", "), total: t.total, paid: t.paid, balance: t.balance, status: t.status, createdBy: i.createdBy || "", lines: t.lines };
  });

  // payments received in the period (by payment date), from any invoice
  const payments = [];
  for (const i of invoices) for (const p of i.payments || []) if (inRange(p.date))
    payments.push({ receipt: p.no, date: p.date, invoice: i.number, student: i.customer?.name || "", mode: p.mode || "", ref: p.ref || "", amount: r2(num(p.amount)) });
  payments.sort((a, b) => a.date.localeCompare(b.date) || num(a.receipt) - num(b.receipt));

  const group = (list, key, init, add) => {
    const map = new Map();
    for (const x of list) { const k = key(x); if (!map.has(k)) map.set(k, init(k)); add(map.get(k), x); }
    return [...map.values()];
  };
  const byCourse = group(rows.flatMap(r => r.lines), l => l.desc, k => ({ course: k, qty: 0, amount: 0 }), (g, l) => { g.qty += l.qty; g.amount = r2(g.amount + l.amount); })
    .sort((a, b) => b.amount - a.amount);
  const byMode = group(payments, p => p.mode || "Other", k => ({ mode: k, count: 0, amount: 0 }), (g, p) => { g.count++; g.amount = r2(g.amount + p.amount); })
    .sort((a, b) => b.amount - a.amount);
  const byStaff = group(rows, r => r.createdBy || "—", k => ({ user: k, invoices: 0, billed: 0 }), (g, r) => { g.invoices++; g.billed = r2(g.billed + r.total); })
    .sort((a, b) => b.billed - a.billed);
  const monthly = monthsBetween(from, to).map(ym => {
    const ri = rows.filter(r => r.date.startsWith(ym)), pi = payments.filter(p => p.date.startsWith(ym));
    return { month: ym, label: monthName(ym), invoices: ri.length, billed: r2(ri.reduce((s, r) => s + r.total, 0)), received: r2(pi.reduce((s, p) => s + p.amount, 0)) };
  });

  const sum = (list, k) => r2(list.reduce((s, x) => s + x[k], 0));
  const summary = {
    invoices: rows.length, billed: sum(rows, "total"), paidOnInvoices: sum(rows, "paid"), outstanding: r2(rows.reduce((s, r) => s + Math.max(0, r.balance), 0)),
    payments: payments.length, received: sum(payments, "amount"),
    paidCount: rows.filter(r => r.status === "Paid").length, partialCount: rows.filter(r => r.status === "Partially paid").length, unpaidCount: rows.filter(r => r.status === "Unpaid").length
  };
  rows.forEach(r => delete r.lines);
  return { from, to, summary, monthly, byCourse, byMode, byStaff, invoices: rows, payments };
}

function reportSheets(rep, currency, generatedBy) {
  const c = `(${currency})`;
  return [
    { name: "Summary", widths: [34, 22], rows: [
      ["Sales report", ""], ["Period", `${rep.from} to ${rep.to}`], ["Generated", `${localStamp()} by ${generatedBy}`], [],
      ["Invoices issued", rep.summary.invoices], [`Total billed ${c}`, rep.summary.billed], [`Paid on these invoices ${c}`, rep.summary.paidOnInvoices],
      [`Outstanding ${c}`, rep.summary.outstanding], ["Payments received in period", rep.summary.payments], [`Amount received in period ${c}`, rep.summary.received], [],
      ["Paid invoices", rep.summary.paidCount], ["Partially paid invoices", rep.summary.partialCount], ["Unpaid invoices", rep.summary.unpaidCount]
    ], header: false, boldCol: true },
    { name: "Monthly", widths: [14, 12, 18, 18], rows: [["Month", "Invoices", `Billed ${c}`, `Received ${c}`], ...rep.monthly.map(m => [m.label, m.invoices, m.billed, m.received])] },
    { name: "Invoices", widths: [14, 12, 26, 28, 16, 34, 14, 14, 14, 15, 14], rows: [["Invoice #", "Date", "Student", "Email", "Phone", "Courses", `Total ${c}`, `Paid ${c}`, `Balance ${c}`, "Status", "Created by"],
      ...rep.invoices.map(r => [r.number, r.date, r.student, r.email, r.phone, r.courses, r.total, r.paid, r.balance, r.status, r.createdBy])] },
    { name: "Payments", widths: [11, 12, 14, 26, 16, 18, 16], rows: [["Receipt #", "Date", "Invoice #", "Student", "Mode", "Reference", `Amount ${c}`],
      ...rep.payments.map(p => [p.receipt, p.date, p.invoice, p.student, p.mode, p.ref, p.amount])] },
    { name: "By course", widths: [34, 10, 18], rows: [["Course", "Qty", `Amount ${c}`], ...rep.byCourse.map(x => [x.course, x.qty, x.amount])] },
    { name: "By payment mode", widths: [20, 12, 18], rows: [["Payment mode", "Payments", `Amount ${c}`], ...rep.byMode.map(x => [x.mode, x.count, x.amount])] },
    { name: "By staff", widths: [20, 12, 18], rows: [["User", "Invoices", `Billed ${c}`], ...rep.byStaff.map(x => [x.user, x.invoices, x.billed])] }
  ];
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
const ACTION_LABELS = {
  "login.success": "Signed in", "login.failed": "Failed sign-in", "logout": "Signed out",
  "invoice.create": "Created invoice", "invoice.update": "Edited invoice", "invoice.delete": "Deleted invoice",
  "invoice.print": "Printed invoice", "receipt.print": "Printed receipt",
  "settings.update": "Changed settings",
  "user.create": "Added user", "user.update": "Changed user", "user.delete": "Deleted user", "password.change": "Changed own password",
  "backup.download": "Downloaded backup", "backup.import": "Imported backup", "report.export": "Downloaded report"
};
const ACTION_GROUPS = { login: ["login.success", "login.failed", "logout"], invoice: ["invoice.create", "invoice.update", "invoice.delete", "invoice.print", "receipt.print"],
  settings: ["settings.update"], user: ["user.create", "user.update", "user.delete", "password.change"], data: ["backup.download", "backup.import", "report.export"] };

function filterAudit(entries, q) {
  const from = DATE_RE.test(q.get("from") || "") ? q.get("from") : "";
  const to = DATE_RE.test(q.get("to") || "") ? q.get("to") : "";
  const user = q.get("user") || "", group = q.get("group") || "", text = (q.get("q") || "").toLowerCase().trim();
  const actions = ACTION_GROUPS[group];
  return entries.filter(e => {
    const d = e.time.slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (user && e.user !== user) return false;
    if (actions && !actions.includes(e.action)) return false;
    if (text && !`${e.user} ${ACTION_LABELS[e.action] || e.action} ${e.target} ${e.details}`.toLowerCase().includes(text)) return false;
    return true;
  }).reverse(); // newest first
}

function auditSheets(entries, generatedBy, filterText) {
  return [{ name: "Audit log", widths: [20, 14, 9, 22, 18, 80, 14], rows: [
    ["Date & time", "User", "Role", "Action", "Item", "Details", "IP address"],
    ...entries.map(e => [e.time, e.user, e.role, ACTION_LABELS[e.action] || e.action, e.target, e.details, e.ip])
  ], footer: [`Generated ${localStamp()} by ${generatedBy}${filterText ? " · " + filterText : ""}`] }];
}

// What changed between two versions of an invoice, in plain words
function invoiceChanges(a, b, currency) {
  const out = [];
  const f = (label, x, y) => { if ((x || "") !== (y || "")) out.push(`${label}: "${x || ""}" → "${y || ""}"`); };
  f("Student", a.customer?.name, b.customer?.name); f("Email", a.customer?.email, b.customer?.email); f("Phone", a.customer?.phone, b.customer?.phone);
  f("Date", a.date, b.date); f("Terms", a.terms, b.terms); f("Due date", a.due, b.due); f("Notes", a.notes, b.notes);
  const items = (inv) => (inv.items || []).map(i => `${i.desc} ×${num(i.qty)} @ ${num(i.rate)}`).join(", ");
  if (items(a) !== items(b)) out.push(`Courses: ${items(a) || "none"} → ${items(b) || "none"}`);
  const oldPay = new Map((a.payments || []).map(p => [p.no, p]));
  const newPay = new Map((b.payments || []).map(p => [p.no, p]));
  for (const [no, p] of newPay) {
    const o = oldPay.get(no);
    if (!o) out.push(`Payment added: receipt #${no}, ${currency} ${r2(num(p.amount))} (${p.mode || "—"})`);
    else if (num(o.amount) !== num(p.amount) || o.mode !== p.mode || o.date !== p.date || (o.ref || "") !== (p.ref || ""))
      out.push(`Receipt #${no} changed: ${currency} ${r2(num(o.amount))} ${o.mode} ${o.date} → ${currency} ${r2(num(p.amount))} ${p.mode} ${p.date}`);
  }
  for (const [no, p] of oldPay) if (!newPay.has(no)) out.push(`Payment removed: receipt #${no}, ${currency} ${r2(num(p.amount))}`);
  const ta = invTotals(a).total, tb = invTotals(b).total;
  if (ta !== tb) out.push(`Total: ${currency} ${ta} → ${currency} ${tb}`);
  return out;
}

// What changed in the admin settings, in plain words
const SETTING_NAMES = { name: "Company name", address: "Address", trn: "TRN", email: "Email", website: "Website", phone: "Phone", currency: "Currency",
  vat: "Default VAT %", invPrefix: "Invoice prefix", invDigits: "Invoice digits", nextInvoice: "Next invoice number", nextReceipt: "Next receipt number",
  logo: "Logo", vatEnabled: "VAT registered", inclusive: "Fees include VAT", allowPriceEdit: "Staff may change fees", terms: "Terms & conditions" };
function settingsChanges(a, b) {
  const out = [];
  const short = (v) => { const s = String(v ?? "").replace(/\n/g, ", "); return s.length > 70 ? s.slice(0, 67) + "…" : s; };
  for (const [k, label] of Object.entries(SETTING_NAMES)) {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    if (k === "logo") out.push(b[k] ? "Logo changed" : "Logo removed");
    else if (k === "terms") out.push("Terms & conditions updated");
    else if (typeof b[k] === "boolean") out.push(`${label}: ${b[k] ? "on" : "off"}`);
    else out.push(`${label}: "${short(a[k])}" → "${short(b[k])}"`);
  }
  const oldC = new Map((a.courses || []).map(c => [c.id, c])), newC = new Map((b.courses || []).map(c => [c.id, c]));
  for (const [id, c] of newC) {
    const o = oldC.get(id);
    if (!o) out.push(`Course added: ${c.name} (${c.fee})`);
    else {
      if (o.name !== c.name) out.push(`Course renamed: ${o.name} → ${c.name}`);
      if (num(o.fee) !== num(c.fee)) out.push(`Fee changed: ${c.name} ${o.fee} → ${c.fee}`);
      if (num(o.vat) !== num(c.vat)) out.push(`VAT changed: ${c.name} ${o.vat}% → ${c.vat}%`);
    }
  }
  for (const [id, c] of oldC) if (!newC.has(id)) out.push(`Course deleted: ${c.name} (${c.fee})`);
  return out;
}

// ---------------------------------------------------------------------------
// Minimal .xlsx writer (Office Open XML in a ZIP container)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), data = Buffer.from(f.data, "utf8"), comp = zlib.deflateRawSync(data), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp); centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const xmlEsc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const colName = (i) => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

// styles: 0 normal, 1 header (bold, filled), 2 number 0.00, 3 bold text, 4 integer
function sheetXml(sheet) {
  const rows = [...sheet.rows]; if (sheet.footer) rows.push([], sheet.footer);
  const header = sheet.header !== false;
  const xmlRows = rows.map((r, ri) => `<row r="${ri + 1}">${(r || []).map((v, ci) => {
    const ref = `${colName(ci)}${ri + 1}`;
    if (header && ri === 0) return `<c r="${ref}" t="inlineStr" s="1"><is><t>${xmlEsc(v)}</t></is></c>`;
    if (typeof v === "number") return `<c r="${ref}" s="${Number.isInteger(v) && !/amount|billed|received|total|paid|balance|outstanding|\(/i.test(String(rows[0]?.[ci] ?? "")) ? 4 : 2}"><v>${v}</v></c>`;
    const s = sheet.boldCol && ci === 0 ? 3 : 0;
    return `<c r="${ref}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const cols = (sheet.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const freeze = header ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : "";
  const filter = header && sheet.rows.length > 1 ? `<autoFilter ref="A1:${colName(sheet.rows[0].length - 1)}${sheet.rows.length}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${xmlRows}</sheetData>${filter}</worksheet>`;
}

function buildXlsx(sheets) {
  const names = sheets.map((s, i) => xmlEsc(String(s.name).replace(/[\[\]:*?\/\\]/g, " ").slice(0, 31) || `Sheet${i + 1}`));
  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF203868"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>` },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }))
  ];
  return zip(files);
}

module.exports = { localStamp, invTotals, parseRange, buildReport, reportSheets, ACTION_LABELS, ACTION_GROUPS, filterAudit, auditSheets, invoiceChanges, settingsChanges, buildXlsx };
