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

async function renderPdfFromUrl({ url, cookieName, cookieValue, timeout = 30000 }) {
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
}

module.exports = { renderPdfFromUrl };
