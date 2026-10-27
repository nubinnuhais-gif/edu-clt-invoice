// Renders a page of this same app to PDF with a real (headless) browser, so the PDF is pixel-identical
// to what a person sees when they click "Print / PDF" — same HTML, same CSS, same @media print rules.
const puppeteer = require("puppeteer");

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    browserPromise.catch(() => { browserPromise = null; }); // let a failed launch be retried next time
  }
  return browserPromise;
}

// Each render opens a full browser page/tab. On a small VPS, several PDF requests firing at once
// (a few people viewing/emailing invoices together) can exhaust memory/CPU and make everything on
// the box feel slow — so only a few run at a time; the rest queue and run as slots free up, instead
// of all starting immediately and fighting over the same resources.
const MAX_CONCURRENT_RENDERS = 3;
let activeRenders = 0;
const renderQueue = [];

function runQueued() {
  if (activeRenders >= MAX_CONCURRENT_RENDERS || !renderQueue.length) return;
  activeRenders++;
  const { task, resolve, reject } = renderQueue.shift();
  task().then(resolve, reject).finally(() => { activeRenders--; runQueued(); });
}

function withRenderLimit(task) {
  return new Promise((resolve, reject) => { renderQueue.push({ task, resolve, reject }); runQueued(); });
}

async function renderPdfFromUrl({ url, cookieName, cookieValue, timeout = 30000 }) {
  return withRenderLimit(async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setCookie({ name: cookieName, value: cookieValue, url });
      await page.goto(url, { waitUntil: "networkidle0", timeout });
      await page.waitForSelector(".page", { timeout });
      // page.pdf() returns a Uint8Array in recent Puppeteer versions, not a Node Buffer — wrap it so
      // downstream code (Buffer#toString("base64") etc.) behaves correctly instead of comma-joining bytes.
      return Buffer.from(await page.pdf({ printBackground: true, preferCSSPageSize: true }));
    } finally {
      await page.close().catch(() => {});
    }
  });
}

module.exports = { renderPdfFromUrl };
