// Shared helpers for the invoice app pages.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Slim progress bar at the top of the page while any request is in flight, so network calls never
// feel "stuck" with no feedback. Shared by every page that loads this file.
let _apiPending = 0, _apiBar;
function _apiBarEl() {
  if (_apiBar) return _apiBar;
  _apiBar = document.createElement("div");
  _apiBar.id = "apiProgressBar";
  _apiBar.style.cssText = "position:fixed;top:0;left:0;height:3px;width:0%;z-index:99999;" +
    "background:linear-gradient(90deg,#203868,#50A048);opacity:0;pointer-events:none;" +
    "transition:width .3s ease,opacity .2s ease;";
  document.body.appendChild(_apiBar);
  return _apiBar;
}
function _apiBarStart() {
  _apiPending++;
  if (_apiPending > 1) return;
  const bar = _apiBarEl();
  bar.style.transition = "none"; bar.style.width = "0%"; bar.style.opacity = "1";
  requestAnimationFrame(() => { bar.style.transition = "width .3s ease, opacity .2s ease"; bar.style.width = "75%"; });
}
function _apiBarEnd() {
  _apiPending = Math.max(0, _apiPending - 1);
  if (_apiPending > 0) return;
  const bar = _apiBarEl();
  bar.style.width = "100%";
  setTimeout(() => { bar.style.opacity = "0"; }, 150);
}

// Call the server API; sends the user to the login page when the session has expired.
async function api(method, url, body) {
  _apiBarStart();
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined || method !== "GET" ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : (method !== "GET" ? "{}" : undefined),
      credentials: "same-origin"
    });
    if (res.status === 401 && !url.endsWith("/login")) { location.href = "/login.html"; throw new Error("Please log in"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  } finally {
    _apiBarEnd();
  }
}

function toast(msg) {
  const t = $("toast"); if (!t) return;
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

// Line icons (Lucide style). Any element with data-icon="name" gets the icon put in front of its text.
const ICON_PATHS = {
  dashboard: '<path d="M3 3v18h18"/><path d="M8 17V9"/><path d="M13 17V5"/><path d="M18 17v-6"/>',
  book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  back: '<path d="m12 19-7-7 7-7M19 12H5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>',
  pie: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  receipt: '<path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2-3 2z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'
};
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
document.querySelectorAll("[data-icon]").forEach(el => el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon)));

// Adds a show/hide toggle to every password field on the page, so people can check what they
// typed before submitting instead of guessing from dots. Renders the icon's own markup rather than
// going through icon()/the shared ".ic" class, since pages like login.html give ".ic" page-specific
// positioning (e.g. the lock icon prefix) that would otherwise hijack this one too.
const pwIconSvg = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:16px;height:16px;display:block">${ICON_PATHS[name] || ""}</svg>`;
document.querySelectorAll('input[type="password"]').forEach((input) => {
  // The button is inserted as a sibling in the input's own parent (making that parent
  // position:relative if it isn't already) rather than into a new wrapper — a new positioned
  // wrapper would itself join the parent's "positioned element" paint layer and, since it'd come
  // after any existing absolutely-positioned icon (e.g. login.html's lock icon prefix) in DOM
  // order, would paint over it and hide it.
  const parent = input.parentNode;
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
  input.style.paddingRight = "38px";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = btn.ariaLabel = "Show password";
  btn.style.cssText = "position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;" +
    "cursor:pointer;padding:5px;display:flex;color:var(--ui-muted,#6b7280);line-height:0;";
  btn.innerHTML = pwIconSvg("eye");
  btn.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.innerHTML = pwIconSvg(show ? "eyeOff" : "eye");
    btn.title = btn.ariaLabel = show ? "Hide password" : "Show password";
  });
  input.after(btn);
});

// Light / dark mode. The page sets the theme in <head> before it is drawn; these buttons switch it.
function currentTheme() { return document.documentElement.dataset.theme === "dark" ? "dark" : "light"; }
function paintThemeButtons() {
  const dark = currentTheme() === "dark";
  document.querySelectorAll(".theme-toggle").forEach(b => {
    b.innerHTML = icon(dark ? "sun" : "moon") + (b.dataset.text !== undefined ? `<span>${dark ? "Light mode" : "Dark mode"}</span>` : "");
    b.title = b.dataset.label = dark ? "Switch to light mode" : "Switch to dark mode";
    b.setAttribute("aria-label", b.title);
  });
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("clt_theme", t); } catch {}
  paintThemeButtons();
}
document.querySelectorAll(".theme-toggle").forEach(b => b.addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark")));
paintThemeButtons();
// Keep same-origin frames (e.g. the invoice screen embedded in the admin panel) in sync when the
// theme changes elsewhere — the "storage" event fires in other same-origin windows/iframes, not the one that made the change.
window.addEventListener("storage", (e) => { if (e.key === "clt_theme" && e.newValue) setTheme(e.newValue); });

// Display label for a stored role value. The role is still "admin" in the data/API/permissions —
// only how it's shown in the UI changes.
const roleLabel = (r) => r === "admin" ? "Management" : "Staff";

// Fixed banner shown while a Management user is viewing the app as someone else (via Admin > Users
// > Impersonate), so it's always obvious the session isn't their own and there's a one-click way back.
function renderImpersonationBanner(me) {
  const existing = $("impersonationBanner");
  if (!me || !me.impersonatedBy) { if (existing) existing.remove(); document.body.style.removeProperty("--impersonation-offset"); return; }
  if (existing) return;
  const bar = document.createElement("div");
  bar.id = "impersonationBanner";
  bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99998;display:flex;align-items:center;" +
    "justify-content:center;gap:10px;padding:8px 14px;background:#8a6d00;color:#fff;font-size:13px;font-weight:600;";
  bar.innerHTML = `<span>Viewing as <b>${esc(me.username)}</b> — impersonated by ${esc(me.impersonatedBy)}</span>` +
    `<button id="exitImpersonation" style="background:#fff;color:#8a6d00;border:none;border-radius:6px;padding:4px 10px;font-weight:700;cursor:pointer">Exit</button>`;
  document.body.prepend(bar);
  document.body.style.paddingTop = bar.offsetHeight + "px";
  $("exitImpersonation").onclick = async () => {
    try { await api("POST", "/api/impersonate/exit"); location.href = "/admin.html#users"; } catch (e) { toast(e.message); }
  };
}

async function logout() {
  try { await api("POST", "/api/logout"); } catch {}
  location.href = "/login.html";
}
