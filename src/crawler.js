'use strict';

const { chromium } = require('playwright');
const { checkSEO } = require('./checks/seo');

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

// ── Inject CSS outlines onto problematic elements, take screenshot, clean up ──
async function takeAnnotatedScreenshot(page) {
  // Mark problematic elements with data-qa-type attribute
  const count = await page.evaluate((placeholderHosts) => {
    // Clear previous marks
    document.querySelectorAll('[data-qa-type]').forEach(el => el.removeAttribute('data-qa-type'));

    let n = 0;
    function mark(el, type) {
      if (!el) return;
      el.setAttribute('data-qa-type', type);
      n++;
    }
    function hasHandler(el) {
      return !!(el.onclick || el.getAttribute('onclick') ||
        el.getAttribute('data-action') || el.getAttribute('data-toggle') ||
        el.getAttribute('data-bs-toggle') || el.getAttribute('@click') || el.getAttribute('ng-click'));
    }

    // Broken & placeholder images
    document.querySelectorAll('img').forEach(img => {
      const src = (img.src || '').toLowerCase();
      const broken = img.complete && img.naturalWidth === 0 && src && !src.startsWith('data:');
      const placeholder = placeholderHosts.some(h => src.includes(h));
      if (broken) mark(img, 'broken');
      else if (placeholder) mark(img, 'placeholder');
    });

    // Empty buttons
    document.querySelectorAll('button, [role="button"]').forEach(btn => {
      const text = (btn.textContent || '').trim();
      const label = btn.getAttribute('aria-label') || '';
      const hasIcon = btn.querySelector('svg, img, i[class]');
      if (!text && !label && !hasIcon) mark(btn, 'empty-btn');
    });

    // Dead links (href="#" / empty / javascript: with no handler)
    document.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href') || '';
      const dead = href === '#' || href === '' || href === 'javascript:void(0)' ||
        href === 'javascript:;' || href === 'javascript:void(0);';
      const text = (a.textContent || '').trim();
      if (dead && !hasHandler(a) && text.length > 1) mark(a, 'dead-link');
    });

    // Lorem ipsum text
    const LOREM = [/lorem ipsum/i, /dolor sit amet/i];
    document.querySelectorAll('p, h1, h2, h3, h4, li, td').forEach(el => {
      const t = el.textContent || '';
      if (LOREM.some(r => r.test(t))) mark(el, 'placeholder-text');
    });

    // Disconnected forms
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

  // Inject highlight styles — CSS outlines work on ALL elements including fullPage screenshots
  await page.addStyleTag({ content: `
    [data-qa-type] {
      outline: 4px solid #ef4444 !important;
      outline-offset: 2px !important;
    }
    [data-qa-type="dead-link"],
    [data-qa-type="dead-form"] {
      outline-color: #f97316 !important;
    }
    [data-qa-type="placeholder-text"],
    [data-qa-type="placeholder"] {
      outline-color: #f59e0b !important;
    }
  ` });

  const buf = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 85 });

  // Cleanup
  await page.evaluate(() => {
    document.querySelectorAll('[data-qa-type]').forEach(el => el.removeAttribute('data-qa-type'));
    document.querySelectorAll('style').forEach(s => {
      if (s.textContent.includes('data-qa-type')) s.remove();
    });
  });

  return buf;
}

// ── Visit single page ─────────────────────────────────────────────────────────
async function visitPage(browser, url, index, scanId, screenshotStore) {
  const result = {
    url, status: null, loadTimeMs: null,
    issues: [],
    screenshots: { annotated: null, desktop: null, tablet: null, mobile: null },
    seo: null, _desktopBase64: null,
  };

  const context = await browser.newContext({
    viewport: VIEWPORTS.desktop,
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 QA-Agent/1.0',
  });
  const page = await context.newPage();

  const jsErrors = [];
  const failedResources = []; // sub-resources that 404/500

  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Skip the generic "Failed to load resource" — we capture those via response events with the actual URL
    if (/failed to load resource/i.test(text)) return;
    jsErrors.push(text);
  });
  page.on('pageerror', err => jsErrors.push(err.message));

  page.on('response', response => {
    const resUrl = response.url();
    // Skip the main page itself
    if (normalizeUrl(resUrl) === normalizeUrl(url)) return;
    const status = response.status();
    if (status >= 400) {
      const type = response.request().resourceType(); // image, stylesheet, script, font, fetch, xhr...
      failedResources.push({ resUrl, status, type });
    }
  });

  try {
    const t0 = Date.now();
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
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

    // Dev checks (placeholder, buttons, links, forms, WP detection)
    const check = await checkSEO(page, url);
    result.seo = { links: check.links };
    result.wpDetected = check.wpDetected || false;
    result.imageUrls = check.imageUrls || [];
    result.issues.push(...check.issues);

    // Failed sub-resources (images, scripts, CSS, fonts, API calls)
    const RESOURCE_LABELS = {
      image:      'Image file',
      stylesheet: 'CSS file',
      script:     'JS file',
      font:       'Font file',
      fetch:      'API/fetch call',
      xhr:        'AJAX/XHR call',
      media:      'Media file',
      document:   'Document',
    };
    for (const { resUrl, status, type } of failedResources.slice(0, 10)) {
      const label = RESOURCE_LABELS[type] || 'Resource';
      // Extract just the filename/path for readability
      let shortUrl = resUrl;
      try { shortUrl = new URL(resUrl).pathname + new URL(resUrl).search; } catch {}
      result.issues.push({
        type: 'missing_resource',
        message: `${label} not found (${status}): ${shortUrl}`,
        url,
      });
    }

    // JS errors (actual script errors, not resource load failures)
    for (const err of [...new Set(jsErrors)].slice(0, 5)) {
      result.issues.push({ type: 'js_error', message: `JS error: ${err.slice(0, 300)}`, url });
    }

    // ── Annotated screenshot (CSS outline approach) ────────────────────────
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.waitForTimeout(300);

    const annotatedBuf = await takeAnnotatedScreenshot(page);
    if (annotatedBuf) {
      const fname = `page-${index}-annotated.jpg`;
      screenshotStore.set(`${scanId}/${fname}`, annotatedBuf);
      result.screenshots.annotated = `/screenshots/${scanId}/${fname}`;
    }

    // ── Regular screenshots at all viewports ──────────────────────────────
    for (const [vp, size] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(size);
      await page.waitForTimeout(250);
      const buf = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 80 });
      const fname = `page-${index}-${vp}.jpg`;
      screenshotStore.set(`${scanId}/${fname}`, buf);
      result.screenshots[vp] = `/screenshots/${scanId}/${fname}`;
      if (vp === 'desktop') result._desktopBase64 = buf.toString('base64');
    }
  } catch (err) {
    result.issues.push({ type: 'load_failure', message: `Unexpected error: ${err.message}`, url });
  } finally {
    await context.close();
  }

  return result;
}

const BATCH_SIZE = 12;

// ── Crawl entire site (or one batch of pages) ────────────────────────────────
// opts.resumeQueue  — array of URLs to continue from (for batch continuation)
// opts.visitedUrls  — Set of already-visited normalized URLs
// opts.pageOffset   — screenshot index offset so filenames don't collide across batches
// Returns { pages, remainingQueue, visitedUrls }
async function crawlSite(startUrl, scanId, screenshotStore, onProgress, opts = {}) {
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

  const browser = await chromium.launch({ headless: true });
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

      const pageResult = await visitPage(browser, url, globalIdx, scanId, screenshotStore);
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

// ── Re-scan a single page (used by /api/scan/:id/rescan) ─────────────────────
async function scanSinglePage(url, scanId, screenshotStore, index) {
  const browser = await chromium.launch({ headless: true });
  try {
    return await visitPage(browser, url, index, scanId, screenshotStore);
  } finally {
    await browser.close();
  }
}

module.exports = { crawlSite, scanSinglePage, normalizeUrl };
