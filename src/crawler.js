'use strict';

const { checkSEO } = require('./checks/seo');
const store = require('./store');

const MAX_PAGES = 150;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet:  { width: 820,  height: 1180 },
  mobile:  { width: 390,  height: 844 },
};

const PLACEHOLDER_HOSTS = [
  'placeholder.com', 'via.placeholder.com', 'placehold.it', 'placeimg.com',
  'picsum.photos', 'lorempixum.com', 'dummyimage.com', 'fillmurray.com',
  'placekitten.com', 'loremflickr.com',
];

function normalizeUrl(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.href;
  } catch { return href; }
}

// ── Launch browser (puppeteer-core + sparticuz on Vercel, system Chrome locally) ──
async function launchBrowser() {
  const puppeteer = require('puppeteer-core');

  let executablePath;
  let args = [];

  if (process.env.VERCEL || process.env.USE_SERVERLESS_CHROMIUM) {
    const chromiumPkg = require('@sparticuz/chromium');
    executablePath = await chromiumPkg.executablePath();
    args = chromiumPkg.args;
  } else {
    // Local dev — use system Chrome/Chromium
    executablePath = process.env.CHROME_PATH || (
      process.platform === 'win32'
        ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        : process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : '/usr/bin/google-chrome-stable'
    );
    args = ['--no-sandbox', '--disable-setuid-sandbox'];
  }

  return puppeteer.launch({
    executablePath,
    args,
    headless: true,
    ignoreHTTPSErrors: true,
  });
}

// ── Annotated screenshot: outline problematic elements, capture, clean up ─────
async function takeAnnotatedScreenshot(page) {
  const count = await page.evaluate((placeholderHosts) => {
    document.querySelectorAll('[data-qa-type]').forEach(el => el.removeAttribute('data-qa-type'));

    let n = 0;
    function mark(el, type) { if (!el) return; el.setAttribute('data-qa-type', type); n++; }
    function hasHandler(el) {
      return !!(el.onclick || el.getAttribute('onclick') ||
        el.getAttribute('data-action') || el.getAttribute('data-toggle') ||
        el.getAttribute('data-bs-toggle') || el.getAttribute('@click') || el.getAttribute('ng-click'));
    }

    document.querySelectorAll('img').forEach(img => {
      const src = (img.src || '').toLowerCase();
      const broken = img.complete && img.naturalWidth === 0 && src && !src.startsWith('data:');
      const placeholder = placeholderHosts.some(h => src.includes(h));
      if (broken) mark(img, 'broken');
      else if (placeholder) mark(img, 'placeholder');
    });

    document.querySelectorAll('button, [role="button"]').forEach(btn => {
      const text = (btn.textContent || '').trim();
      const label = btn.getAttribute('aria-label') || '';
      const hasIcon = btn.querySelector('svg, img, i[class]');
      if (!text && !label && !hasIcon) mark(btn, 'empty-btn');
    });

    document.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href') || '';
      const dead = href === '#' || href === '' || href === 'javascript:void(0)' ||
        href === 'javascript:;' || href === 'javascript:void(0);';
      const text = (a.textContent || '').trim();
      if (dead && !hasHandler(a) && text.length > 1) mark(a, 'dead-link');
    });

    const LOREM = [/lorem ipsum/i, /dolor sit amet/i];
    document.querySelectorAll('p, h1, h2, h3, h4, li, td').forEach(el => {
      const t = el.textContent || '';
      if (LOREM.some(r => r.test(t))) mark(el, 'placeholder-text');
    });

    document.querySelectorAll('form').forEach(form => {
      const fields = form.querySelectorAll('input:not([type=hidden]), textarea, select');
      const hasSubmit = !!form.querySelector('[type=submit], button:not([type=button]):not([type=reset])');
      const hasAction = !!(form.getAttribute('action') && form.getAttribute('action') !== '#');
      const hasJsHandler = !!(form.onsubmit || form.getAttribute('onsubmit'));
      if (fields.length > 0 && hasSubmit && !hasAction && !hasJsHandler) mark(form, 'dead-form');
    });

    return n;
  }, PLACEHOLDER_HOSTS);

  if (!count) return null;

  await page.addStyleTag({ content: `
    [data-qa-type] { outline: 4px solid #ef4444 !important; outline-offset: 2px !important; }
    [data-qa-type="dead-link"], [data-qa-type="dead-form"] { outline-color: #f97316 !important; }
    [data-qa-type="placeholder-text"], [data-qa-type="placeholder"] { outline-color: #f59e0b !important; }
  ` });

  const buf = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 85 });

  await page.evaluate(() => {
    document.querySelectorAll('[data-qa-type]').forEach(el => el.removeAttribute('data-qa-type'));
    document.querySelectorAll('style').forEach(s => {
      if (s.textContent.includes('data-qa-type')) s.remove();
    });
  });

  return buf;
}

// ── Visit a single page ───────────────────────────────────────────────────────
async function visitPage(browser, url, index, scanId) {
  const result = {
    url, status: null, loadTimeMs: null,
    issues: [],
    screenshots: { annotated: null, desktop: null, tablet: null, mobile: null },
    seo: null, _desktopBase64: null,
  };

  const page = await browser.newPage();
  await page.setViewport(VIEWPORTS.desktop);
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 QA-Agent/1.0');

  const jsErrors = [];
  const failedResources = [];

  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/failed to load resource/i.test(text)) return;
    jsErrors.push(text);
  });
  page.on('pageerror', err => jsErrors.push(err.message));

  page.on('response', response => {
    const resUrl = response.url();
    if (normalizeUrl(resUrl) === normalizeUrl(url)) return;
    const status = response.status();
    if (status >= 400) {
      const type = response.request().resourceType();
      failedResources.push({ resUrl, status, type });
    }
  });

  try {
    const t0 = Date.now();
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (err) {
      result.issues.push({ type: 'load_failure', message: `Page failed to load: ${err.message}`, url });
      return result;
    }

    result.loadTimeMs = Date.now() - t0;
    result.status = response?.status() ?? 0;

    if (result.status >= 400) {
      result.issues.push({ type: 'http_error', message: `HTTP ${result.status} — page returned an error`, url });
    }
    if (result.loadTimeMs > 5000) {
      result.issues.push({ type: 'performance', message: `Slow page load: ${(result.loadTimeMs / 1000).toFixed(1)}s`, url });
    }

    const check = await checkSEO(page, url);
    result.seo = { links: check.links };
    result.wpDetected = check.wpDetected || false;
    result.imageUrls = check.imageUrls || [];
    result.issues.push(...check.issues);

    const RESOURCE_LABELS = {
      image: 'Image file', stylesheet: 'CSS file', script: 'JS file',
      font: 'Font file', fetch: 'API/fetch call', xhr: 'AJAX/XHR call',
      media: 'Media file', document: 'Document',
    };
    for (const { resUrl, status, type } of failedResources.slice(0, 10)) {
      const label = RESOURCE_LABELS[type] || 'Resource';
      let shortUrl = resUrl;
      try { shortUrl = new URL(resUrl).pathname + new URL(resUrl).search; } catch {}
      result.issues.push({ type: 'missing_resource', message: `${label} not found (${status}): ${shortUrl}`, url });
    }

    for (const err of [...new Set(jsErrors)].slice(0, 5)) {
      result.issues.push({ type: 'js_error', message: `JS error: ${err.slice(0, 300)}`, url });
    }

    // ── Annotated screenshot ──────────────────────────────────────────────────
    await page.setViewport(VIEWPORTS.desktop);
    await new Promise(r => setTimeout(r, 300));

    const annotatedBuf = await takeAnnotatedScreenshot(page);
    if (annotatedBuf) {
      const fname = `page-${index}-annotated.jpg`;
      await store.setScreenshot(`${scanId}/${fname}`, annotatedBuf);
      result.screenshots.annotated = `/screenshots/${scanId}/${fname}`;
    }

    // ── Viewport screenshots ──────────────────────────────────────────────────
    for (const [vp, size] of Object.entries(VIEWPORTS)) {
      await page.setViewport(size);
      await new Promise(r => setTimeout(r, 250));
      const buf = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 80 });
      const fname = `page-${index}-${vp}.jpg`;
      await store.setScreenshot(`${scanId}/${fname}`, buf);
      result.screenshots[vp] = `/screenshots/${scanId}/${fname}`;
      if (vp === 'desktop') result._desktopBase64 = buf.toString('base64');
    }
  } catch (err) {
    result.issues.push({ type: 'load_failure', message: `Unexpected error: ${err.message}`, url });
  } finally {
    await page.close();
  }

  return result;
}

const BATCH_SIZE = 12;

// ── Crawl entire site (or resume from a batch) ────────────────────────────────
async function crawlSite(startUrl, scanId, onProgress, opts = {}) {
  const { resumeQueue = null, visitedUrls = null, pageOffset = 0 } = opts;

  const base = new URL(startUrl);
  const visited = visitedUrls || new Set();
  const queued = new Set([...visited]);

  let queue;
  if (resumeQueue && resumeQueue.length > 0) {
    queue = [...resumeQueue];
  } else {
    const startNorm = normalizeUrl(startUrl);
    queued.add(startNorm);
    queue = [startUrl];
  }

  const results = [];
  const browser = await launchBrowser();

  try {
    while (queue.length > 0 && results.length < BATCH_SIZE) {
      const url = queue.shift();
      const normalized = normalizeUrl(url);
      if (visited.has(normalized)) continue;
      visited.add(normalized);

      const globalIdx = pageOffset + results.length;
      onProgress(
        `Scanning page ${globalIdx + 1}: ${url}`,
        Math.min(Math.round((results.length / Math.max(queue.length + results.length + 1, 1)) * 55), 55)
      );

      const pageResult = await visitPage(browser, url, globalIdx, scanId);
      results.push(pageResult);

      for (const href of (pageResult.seo?.links ?? [])) {
        try {
          const abs = new URL(href, url);
          if (abs.origin === base.origin) {
            const n = normalizeUrl(abs.href);
            if (!queued.has(n)) { queued.add(n); queue.push(abs.href); }
          }
        } catch { /* skip invalid hrefs */ }
      }
    }
  } finally {
    await browser.close();
  }

  return { pages: results, remainingQueue: [...queue], visitedUrls: visited };
}

// ── Re-scan a single page ─────────────────────────────────────────────────────
async function scanSinglePage(url, scanId, index) {
  const browser = await launchBrowser();
  try {
    return await visitPage(browser, url, index, scanId);
  } finally {
    await browser.close();
  }
}

module.exports = { crawlSite, scanSinglePage, normalizeUrl };
