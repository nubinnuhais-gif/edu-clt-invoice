// Invoice screen: create, edit, print invoices and payment receipts (data stored on the server).
(async () => {
  const PAYMENT_MODES = ["Cash", "Card", "Bank Transfer", "Tabby", "Tamara", "Cheque", "Online"];
  let me, settings, invoices = [];
  let doc = null, view = "invoice", receiptIdx = 0, saving = false;

  // ------------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------------
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const fmt = (n) => r2(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // UAE dirham symbol, drawn as SVG (fonts don't support the new sign yet)
  const DH = `<svg class="dh" viewBox="0 0 22 20" fill="none" stroke="currentColor" stroke-width="2.3" aria-label="AED"><path d="M5 1.2h4.6a8.8 8.8 0 0 1 0 17.6H5z"/><path d="M0.5 7.6h20M0.5 12.4h20"/></svg>`;
  const isAED = () => (settings.currency || "").trim().toUpperCase() === "AED";
  const cur = (n) => isAED() ? `${DH}${fmt(n)}` : `${esc(settings.currency)} ${fmt(n)}`;
  const curText = (n) => `${esc(settings.currency)} ${fmt(n)}`;
  const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const fmtDate = (iso) => {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    return `${String(d).padStart(2, "0")} ${MONTHS[m - 1]} ${y}`;
  };
  const addDays = (iso, days) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  };
  const invNo = (n) => `${settings.invPrefix}${String(n).padStart(settings.invDigits, "0")}`;
  const draftKey = () => `clt_inv_draft_${me.username}`;
  const saveDraft = () => { try { if (!doc.id) localStorage.setItem(draftKey(), JSON.stringify(doc)); } catch {} };
  const loadDraft = () => { try { return JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch { return null; } };
  const clearDraft = () => { try { localStorage.removeItem(draftKey()); } catch {} };

  const blankItem = () => ({ courseId: "", desc: "", qty: 1, rate: 0, tax: settings.vat });
  function blankInvoice() {
    const d = today();
    return { id: null, number: "", date: d, terms: "Due on Receipt", due: d,
      customer: { name: "", email: "", phone: "" }, items: [blankItem()],
      inclusive: settings.inclusive, vatEnabled: settings.vatEnabled, payments: [], notes: "" };
  }

  // ------------------------------------------------------------------
  // Calculations
  // ------------------------------------------------------------------
  // VAT only when the invoice was created with the admin VAT switch on
  const vatOf = (d) => d.vatEnabled === true;

  function calc(d) {
    let taxable = 0, tax = 0, total = 0;
    const lines = d.items.map(it => {
      const qty = Number(it.qty) || 0, rate = Number(it.rate) || 0, pct = vatOf(d) ? Number(it.tax) || 0 : 0;
      const gross = r2(qty * rate);
      let lt, lx, la;
      if (d.inclusive) { la = gross; lt = r2(gross / (1 + pct / 100)); lx = r2(la - lt); }
      else { lt = gross; lx = r2(gross * pct / 100); la = r2(lt + lx); }
      taxable += lt; tax += lx; total += la;
      return { ...it, qty, rate, pct, taxable: lt, taxAmt: lx, amount: la };
    });
    const byRate = {};
    lines.forEach(l => {
      byRate[l.pct] = byRate[l.pct] || { taxable: 0, tax: 0 };
      byRate[l.pct].taxable += l.taxable; byRate[l.pct].tax += l.taxAmt;
    });
    const paid = r2(d.payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
    total = r2(total);
    return { lines, taxable: r2(taxable), tax: r2(tax), total, paid, balance: r2(total - paid), byRate };
  }

  function status(c) {
    if (c.total > 0 && c.balance <= 0) return ["paid", "Paid"];
    if (c.paid > 0) return ["partial", "Partially paid"];
    return ["due", "Unpaid"];
  }

  // ------------------------------------------------------------------
  // Editor
  // ------------------------------------------------------------------
  function fillForm() {
    if (!doc.id) { // unsaved: show the next number and use the current VAT setting
      doc.number = invNo(settings.nextInvoice);
      doc.vatEnabled = settings.vatEnabled;
      doc.inclusive = settings.inclusive;
    }
    $("f_number").value = doc.id ? doc.number : `${doc.number} (on save)`;
    $("f_date").value = doc.date;
    $("f_terms").value = doc.terms;
    $("f_due").value = doc.due;
    $("f_due").disabled = doc.terms !== "Custom";
    $("c_name").value = doc.customer.name;
    $("c_email").value = doc.customer.email;
    $("c_phone").value = doc.customer.phone;
    $("f_notes").value = doc.notes || "";
    renderItems(); renderPayments(); refresh();
  }

  function recomputeDue() {
    const map = { "Due on Receipt": 0, "Net 7": 7, "Net 15": 15, "Net 30": 30 };
    if (doc.terms in map && doc.date) doc.due = addDays(doc.date, map[doc.terms]);
    $("f_due").value = doc.due;
    $("f_due").disabled = doc.terms !== "Custom";
  }

  function renderItems() {
    const canEdit = settings.allowPriceEdit || me.role === "admin";
    const lock = canEdit ? "" : "readonly";
    $("items").innerHTML = doc.items.map((it, i) => {
      const known = settings.courses.some(c => c.id === it.courseId);
      const opts = [`<option value="">— Select course —</option>`]
        .concat(settings.courses.map(c => `<option value="${esc(c.id)}" ${c.id === it.courseId ? "selected" : ""}>${esc(c.name)} (${fmt(c.fee)})</option>`));
      // keep courses on older invoices that admin has since renamed/removed
      if (!known && it.desc && it.courseId !== "custom") opts.push(`<option value="${esc(it.courseId || "__old")}" selected>${esc(it.desc)}</option>`);
      if (canEdit) opts.push(`<option value="custom" ${it.courseId === "custom" ? "selected" : ""}>Other (type below)</option>`);
      return `
      <div class="item-card">
        <div class="item-grid">
          <div><label>Course</label><select data-item="${i}" data-k="courseId">${opts.join("")}</select></div>
          <div><label>Qty</label><input type="number" step="any" min="0" data-item="${i}" data-k="qty" value="${esc(it.qty)}"></div>
          <div><label>Fee</label><input type="number" step="any" min="0" data-item="${i}" data-k="rate" value="${esc(it.rate)}" ${lock}></div>
          ${vatOf(doc) ? `<div><label>VAT %</label><input type="number" step="any" min="0" data-item="${i}" data-k="tax" value="${esc(it.tax)}" ${lock}></div>` : "<div></div>"}
          <div><button class="icon danger" data-del-item="${i}" title="Remove">✕</button></div>
        </div>
        ${it.courseId === "custom" ? `<div style="margin-top:6px"><label>Description</label><input data-item="${i}" data-k="desc" value="${esc(it.desc)}"></div>` : ""}
      </div>`;
    }).join("");
  }

  function renderPayments() {
    $("payments").innerHTML = doc.payments.length ? doc.payments.map((p, i) => `
      <div class="pay-card">
        <div class="pay-head"><span>${p.no ? `Receipt #${esc(p.no)}` : "New receipt (number on save)"}</span><button class="icon danger" data-del-pay="${i}" title="Remove payment">✕</button></div>
        <div class="pay-grid">
          <div><label>Amount</label><input type="number" step="any" min="0" data-pay="${i}" data-k="amount" value="${esc(p.amount)}"></div>
          <div><label>Date</label><input type="date" data-pay="${i}" data-k="date" value="${esc(p.date)}"></div>
          <div><label>Mode</label><select data-pay="${i}" data-k="mode">${PAYMENT_MODES.map(m => `<option ${m === p.mode ? "selected" : ""}>${m}</option>`).join("")}</select></div>
          <div><label>Reference #</label><input data-pay="${i}" data-k="ref" value="${esc(p.ref)}"></div>
        </div>
      </div>`).join("") : `<p style="font-size:13px;color:var(--ui-muted);margin:0 0 10px">No payments recorded yet.</p>`;
  }

  function addPayment(amount) {
    doc.payments.push({ no: null, amount: r2(amount), date: today(), mode: "Cash", ref: "" });
    receiptIdx = doc.payments.length - 1;
    renderPayments(); refresh();
  }

  function refresh() {
    const c = calc(doc);
    const [cls, label] = status(c);
    $("editSummary").innerHTML = `
      ${vatOf(doc) ? `<span>Taxable amount</span><b>${cur(c.taxable)}</b>
      <span>VAT</span><b>${cur(c.tax)}</b>` : ""}
      <span>Total</span><b>${cur(c.total)}</b>
      <span>Paid</span><b>${cur(c.paid)}</b>
      <span>Balance due</span><b>${cur(c.balance)} <span class="badge ${cls}">${label}</span></b>`;
    const pick = $("receiptPick");
    if (receiptIdx >= doc.payments.length) receiptIdx = Math.max(0, doc.payments.length - 1);
    pick.innerHTML = doc.payments.map((p, i) => `<option value="${i}" ${i === receiptIdx ? "selected" : ""}>${p.no ? `Receipt #${esc(p.no)}` : "New receipt"} – ${curText(p.amount)}</option>`).join("");
    pick.style.display = view === "receipt" && doc.payments.length ? "" : "none";
    renderPreview(c);
    saveDraft();
  }

  // ------------------------------------------------------------------
  // Document rendering
  // ------------------------------------------------------------------
  function companyBlock() {
    const lines = (settings.address || "").split("\n").filter(Boolean).map(esc);
    if (settings.trn) lines.push(`TRN ${esc(settings.trn)}`);
    if (settings.phone) lines.push(esc(settings.phone));
    if (settings.email) lines.push(esc(settings.email));
    if (settings.website) lines.push(esc(settings.website));
    return lines.join("<br>");
  }
  const termsList = () => (settings.terms || "").split("\n").map(t => t.trim()).filter(Boolean);
  const logoHtml = () => settings.logo
    ? `<div class="inv-logo-html">
          <div class="inv-logo-name">Consulting, Learning &amp; Training FZE (CLT)</div>
          <div class="inv-logo-tags">
            <span><svg viewBox="0 0 24 24" fill="none" stroke="#50A048" stroke-width="1.5" width="12" height="12"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg> CONSULTING</span>
            <span class="sep">|</span>
            <span><svg viewBox="0 0 24 24" fill="none" stroke="#50A048" stroke-width="1.5" width="12" height="12"><path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/></svg> LEARNING</span>
            <span class="sep">|</span>
            <span><svg viewBox="0 0 24 24" fill="none" stroke="#50A048" stroke-width="1.5" width="12" height="12"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/><path d="M13 13h4M13 17h4"/></svg> TRAINING</span>
          </div>
        </div>`
    : `<div class="name">${esc(settings.name)}</div>`;

  function renderInvoice(c) {
    const rates = Object.entries(c.byRate).filter(([, v]) => v.taxable || v.tax);
    const vatOn = vatOf(doc);
    return `
    <div class="page">
      <div class="inv-head">
        <div class="inv-title">
          <div class="t">${vatOn ? "TAX INVOICE" : "INVOICE"}</div>
          <div class="no"># ${esc(doc.number)}</div>
          <div class="bd-label">Balance Due</div>
          <div class="bd">${cur(c.balance)}</div>
        </div>
        <div class="inv-company">
          ${logoHtml()}
          ${companyBlock()}
        </div>
      </div>

      <div class="inv-meta">
        <table class="meta-table">
          <tr><td>Invoice Date :</td><td>${fmtDate(doc.date)}</td></tr>
          <tr><td>Terms :</td><td>${esc(doc.terms)}</td></tr>
          <tr><td>Due Date :</td><td>${fmtDate(doc.due)}</td></tr>
        </table>
        <div class="billto">
          <div style="font-size:10.5pt">Bill To</div>
          <div class="name">${esc(doc.customer.name) || "&nbsp;"}</div>
          ${doc.customer.email ? `<div>${esc(doc.customer.email)}</div>` : ""}
          ${doc.customer.phone ? `<div>${esc(doc.customer.phone)}</div>` : ""}
        </div>
      </div>

      <table class="items">
        <thead><tr>
          <th style="width:36px;text-align:center">#</th>
          <th class="l">Item &amp; Description</th>
          <th>Qty</th><th>Rate</th>${vatOn ? `<th>Taxable<br>Amount</th><th>Tax</th>` : ""}<th>Amount</th>
        </tr></thead>
        <tbody>
          ${c.lines.map((l, i) => `
          <tr>
            <td style="text-align:center">${i + 1}</td>
            <td class="l">${esc(l.desc)}</td>
            <td>${fmt(l.qty)}</td>
            <td>${fmt(l.rate)}</td>
            ${vatOn ? `<td>${fmt(l.taxable)}</td>
            <td>${fmt(l.taxAmt)}<br><span class="pct">${fmt(l.pct)}%</span></td>` : ""}
            <td>${fmt(l.amount)}</td>
          </tr>`).join("")}
          <tr class="subtotal">
            <td colspan="4" style="font-weight:700">Sub Total</td>
            ${vatOn ? `<td>${fmt(c.taxable)}</td><td>${fmt(c.tax)}</td>` : ""}<td>${fmt(c.total)}</td>
          </tr>
        </tbody>
      </table>

      <div class="totals">
        <div class="r bold"><span>Total</span><span>${cur(c.total)}</span></div>
        ${c.paid ? `<div class="r"><span>Payment Made</span><span class="neg">(-) ${fmt(c.paid)}</span></div>` : ""}
        <div class="r bal"><span>Balance Due</span><span>${cur(c.balance)}</span></div>
      </div>

      ${vatOn ? `
      <div class="section-title">Tax Summary</div>
      <table class="taxsum">
        <thead><tr><th>Tax Details</th><th>Taxable Amount (${esc(settings.currency)})</th><th>Tax Amount (${esc(settings.currency)})</th></tr></thead>
        <tbody>
          ${rates.map(([pct, v]) => `<tr><td>${Number(pct) ? `Standard Rate (${Number(pct)}%)` : "Zero Rate (0%)"}</td><td>${fmt(v.taxable)}</td><td>${fmt(v.tax)}</td></tr>`).join("")}
          <tr class="tot"><td>Total</td><td>${cur(c.taxable)}</td><td>${cur(c.tax)}</td></tr>
        </tbody>
      </table>` : ""}

      ${doc.notes ? `<div class="notes"><b>Notes</b><br>${esc(doc.notes)}</div>` : ""}

      <div class="tnc">
        <div class="section-title">Terms &amp; Conditions</div>
        <ul>${termsList().map(t => `<li>${esc(t)}</li>`).join("")}</ul>
      </div>
    </div>`;
  }

  function renderReceipt(c) {
    const p = doc.payments[receiptIdx];
    if (!p) return `<div class="empty-note">Record a payment in the editor to generate a payment receipt.</div>`;
    return `
    <div class="page">
      <div class="rc-company">
        ${logoHtml()}
        <div class="addr">${companyBlock()}</div>
      </div>
      <hr class="rc-hr">
      <div class="rc-title"><span>PAYMENT RECEIPT</span></div>
      <div class="rc-body">
        <div class="rc-fields">
          <div class="rc-field"><span>Payment Date</span><b>${fmtDate(p.date)}</b></div>
          <div class="rc-field"><span>Reference Number</span><b>${esc(p.ref)}</b></div>
          <div class="rc-field"><span>Payment Mode</span><b>${esc(p.mode)}</b></div>
        </div>
        <div class="rc-box"><div class="lbl">Amount Received</div><div class="amt">${cur(p.amount)}</div></div>
      </div>
      <div class="rc-from">
        <div class="lbl">Received From</div>
        <div class="name">${esc(doc.customer.name)}</div>
        ${doc.customer.email ? `<p>${esc(doc.customer.email)}</p>` : ""}
        ${doc.customer.phone ? `<p>${esc(doc.customer.phone)}</p>` : ""}
      </div>
      <div class="rc-for">
        <h3>Payment for</h3>
        <table class="rcfor">
          <thead><tr><th>Invoice Number</th><th>Invoice Date</th><th class="r">Invoice Amount</th><th class="r">Payment Amount</th></tr></thead>
          <tbody><tr>
            <td>${esc(doc.number)}</td><td>${fmtDate(doc.date)}</td>
            <td class="r">${cur(c.total)}</td><td class="r">${cur(p.amount)}</td>
          </tr></tbody>
        </table>
      </div>
    </div>
    <div class="page rc-tnc">
      <h2>Terms &amp; Conditions</h2>
      <ul>${termsList().map(t => `<li>${esc(t)}</li>`).join("")}</ul>
    </div>`;
  }

  function renderPreview(c) {
    $("preview").innerHTML = view === "invoice" ? renderInvoice(c) : renderReceipt(c);
  }

  // ------------------------------------------------------------------
  // Save / load (server)
  // ------------------------------------------------------------------
  async function saveInvoice() {
    if (saving) return false;
    if (!doc.customer.name.trim()) { toast("Enter the student's name first"); $("c_name").focus(); return false; }
    if (!doc.items.some(i => i.desc && Number(i.rate))) { toast("Select at least one course"); return false; }
    saving = true;
    try {
      const r = doc.id ? await api("PUT", `/api/invoices/${doc.id}`, doc) : await api("POST", "/api/invoices", doc);
      const isNew = !doc.id;
      doc = r.invoice; settings = r.settings;
      const i = invoices.findIndex(x => x.id === doc.id);
      if (i >= 0) invoices[i] = structuredClone(doc); else invoices.unshift(structuredClone(doc));
      if (isNew) clearDraft();
      fillForm();
      toast(`${doc.number} saved`);
      return true;
    } catch (e) { toast(e.message); return false; }
    finally { saving = false; }
  }

  function newInvoice() {
    clearDraft(); doc = blankInvoice(); view = "invoice"; receiptIdx = 0; setTab(); fillForm();
  }

  function renderHistory() {
    const q = $("histSearch").value.trim().toLowerCase();
    const list = invoices.filter(x => !q || [x.number, x.customer.name, x.customer.email, x.customer.phone].join(" ").toLowerCase().includes(q));
    $("histList").innerHTML = list.length ? list.map(x => {
      const c = calc(x); const [cls, label] = status(c);
      return `<div class="hist-item">
        <div><b>${esc(x.number)}</b> · ${esc(x.customer.name)} <span class="badge ${cls}">${label}</span><br>
          <small>${fmtDate(x.date)} · Total ${cur(c.total)} · Balance ${cur(c.balance)}${x.createdBy ? ` · by ${esc(x.createdBy)}` : ""}</small></div>
        <div class="hist-actions">
          <button data-open="${x.id}">Open</button>
          <button data-dup="${x.id}" title="Duplicate as new invoice">Copy</button>
          ${me.role === "admin" ? `<button class="danger" data-del="${x.id}">Delete</button>` : ""}
        </div></div>`;
    }).join("") : `<p style="color:var(--ui-muted)">No saved invoices${q ? " match your search" : " yet"}.</p>`;
  }

  // ------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------
  const bindings = { f_date: v => { doc.date = v; recomputeDue(); },
    f_terms: v => { doc.terms = v; recomputeDue(); }, f_due: v => doc.due = v,
    c_name: v => doc.customer.name = v, c_email: v => doc.customer.email = v, c_phone: v => doc.customer.phone = v,
    f_notes: v => doc.notes = v };
  Object.entries(bindings).forEach(([id, fn]) => $(id).addEventListener("input", e => { fn(e.target.value); refresh(); }));
  $("items").addEventListener("input", e => {
    const i = e.target.dataset.item; if (i === undefined || e.target.tagName === "SELECT") return;
    doc.items[i][e.target.dataset.k] = e.target.value;
    refresh();
  });
  $("items").addEventListener("change", e => {
    if (e.target.tagName !== "SELECT") return;
    const it = doc.items[e.target.dataset.item], id = e.target.value;
    const c = settings.courses.find(x => x.id === id);
    if (c) Object.assign(it, { courseId: c.id, desc: c.name, rate: c.fee, tax: c.vat });
    else if (id === "custom") Object.assign(it, { courseId: "custom", desc: "", rate: 0, tax: settings.vat });
    else if (id === "") Object.assign(it, blankItem());
    renderItems(); refresh();
  });
  $("items").addEventListener("click", e => {
    const i = e.target.dataset.delItem; if (i === undefined) return;
    doc.items.splice(i, 1); if (!doc.items.length) doc.items.push(blankItem());
    renderItems(); refresh();
  });
  $("btnAddItem").onclick = () => { doc.items.push(blankItem()); renderItems(); refresh(); };

  $("payments").addEventListener("input", e => {
    const i = e.target.dataset.pay; if (i === undefined) return;
    doc.payments[i][e.target.dataset.k] = e.target.value; refresh();
  });
  $("payments").addEventListener("click", e => {
    const i = e.target.dataset.delPay; if (i === undefined) return;
    const p = doc.payments[i];
    if (!confirm(`Remove ${p.no ? `receipt #${p.no}` : "this payment"}?`)) return;
    doc.payments.splice(i, 1); renderPayments(); refresh();
  });
  $("btnAddPay").onclick = () => addPayment(0);
  $("btnPayFull").onclick = () => {
    const c = calc(doc);
    if (c.balance <= 0) { toast("Nothing left to pay"); return; }
    addPayment(c.balance);
  };

  function setTab() {
    document.querySelectorAll(".tabs [data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  }
  document.querySelectorAll(".tabs [data-view]").forEach(b => b.onclick = () => { view = b.dataset.view; setTab(); refresh(); });
  $("receiptPick").onchange = e => { receiptIdx = Number(e.target.value); refresh(); };

  $("btnNew").onclick = () => {
    if (!doc.id && doc.customer.name && !confirm("Discard this unsaved invoice and start a new one?")) return;
    newInvoice();
  };
  $("btnSave").onclick = saveInvoice;
  $("btnPrint").onclick = async () => {
    if (!(await saveInvoice())) return; // every printed invoice is saved with its final number
    const prev = document.title;
    const p = doc.payments[receiptIdx];
    const isReceipt = view === "receipt" && p;
    document.title = isReceipt ? `Payment-${p.no}` : doc.number;
    window.print();
    document.title = prev;
    // record the print in the audit log
    api("POST", `/api/invoices/${doc.id}/printed`, isReceipt ? { kind: "receipt", receipt: p.no } : { kind: "invoice" }).catch(() => {});
  };

  document.querySelectorAll(".overlay").forEach(o => o.addEventListener("click", e => {
    if (e.target === o || e.target.hasAttribute("data-close")) o.classList.remove("open");
  }));
  $("btnHistory").onclick = async () => {
    try { invoices = await api("GET", "/api/invoices"); } catch (e) { toast(e.message); }
    renderHistory(); $("histOverlay").classList.add("open");
  };
  $("histSearch").oninput = renderHistory;
  $("histList").addEventListener("click", async e => {
    const { open, dup, del } = e.target.dataset;
    if (open) { doc = structuredClone(invoices.find(x => x.id === open)); view = "invoice"; receiptIdx = 0; setTab(); fillForm(); $("histOverlay").classList.remove("open"); }
    if (dup) {
      const src = invoices.find(x => x.id === dup);
      doc = { ...structuredClone(src), id: null, number: "", date: today(), payments: [] };
      recomputeDue(); view = "invoice"; setTab(); fillForm(); $("histOverlay").classList.remove("open");
      toast("Copied – edit and save as a new invoice");
    }
    if (del) {
      const x = invoices.find(i => i.id === del);
      if (!confirm(`Delete ${x.number} (${x.customer.name})? This cannot be undone.`)) return;
      try {
        await api("DELETE", `/api/invoices/${del}`);
        invoices = invoices.filter(i => i.id !== del);
        if (doc.id === del) { doc.id = null; fillForm(); }
        renderHistory(); toast(`${x.number} deleted`);
      } catch (ex) { toast(ex.message); }
    }
  });

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------
  me = await api("GET", "/api/me");
  [settings, invoices] = await Promise.all([api("GET", "/api/settings"), api("GET", "/api/invoices")]);
  $("who").textContent = me.role === "admin" ? `${me.username} (admin)` : me.username;
  if (me.role !== "admin") {
    document.querySelectorAll(".side .rail-btn[onclick*='/admin']").forEach(b => b.style.display = "none");
    document.querySelectorAll(".side .nav .sep").forEach(s => s.style.display = "none");
  }

  // One-time move of invoices saved in this browser by the old version onto the server
  if (me.role === "admin") {
    try {
      const old = JSON.parse(localStorage.getItem("clt_inv_invoices") || "[]");
      if (old.length && !localStorage.getItem("clt_inv_migrated")) {
        if (confirm(`Found ${old.length} invoice(s) saved in this browser by the old version. Move them to the server so everyone can see them?`)) {
          const r = await api("POST", "/api/import", { invoices: old });
          settings = r.settings; invoices = await api("GET", "/api/invoices");
          toast(`Moved ${r.added} invoice(s) to the server`);
        }
        localStorage.setItem("clt_inv_migrated", "1");
      }
    } catch {}
  }

  doc = loadDraft() || blankInvoice();
  if (doc.id) doc = blankInvoice();
  fillForm();
})();
