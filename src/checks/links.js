'use strict';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': BROWSER_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

// Status codes that mean the resource EXISTS — auth-gated, rate-limited, or temporarily down
const RESOURCE_EXISTS = new Set([401, 403, 405, 429, 503]);

async function fetchUrl(url, method, referer, timeoutMs = 10000) {
  const headers = { ...BROWSER_HEADERS };
  if (referer) headers['Referer'] = referer;
  const res = await fetch(url, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
    headers,
  });
  return res;
}

async function checkUrl(url, referer) {
  // Step 1: HEAD request with real browser UA
  let headStatus;
  try {
    const res = await fetchUrl(url, 'HEAD', referer);
    headStatus = res.status;

    if (res.ok || RESOURCE_EXISTS.has(res.status)) {
      return { status: res.status, ok: true };
    }
  } catch {
    headStatus = 0;
  }

  // Step 2: HEAD failed or returned 4xx — confirm with GET before reporting broken.
  // Many servers (especially WordPress + security plugins) block HEAD or return 404
  // for non-browser agents even when the page exists.
  try {
    const res = await fetchUrl(url, 'GET', referer, 12000);
    if (res.ok || RESOURCE_EXISTS.has(res.status)) {
      return { status: res.status, ok: true };
    }
    return { status: res.status, ok: false };
  } catch {
    // If HEAD also got a status (not a network error), trust it
    if (headStatus > 0) return { status: headStatus, ok: false };
    return { status: 0, ok: false };
  }
}

async function checkLinks(absoluteLinks, addLog, referersByUrl = {}) {
  const issues = [];
  const BATCH = 8;

  addLog(`Checking ${absoluteLinks.length} link(s)...`);

  for (let i = 0; i < absoluteLinks.length; i += BATCH) {
    const batch = absoluteLinks.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (link) => {
      const referer = referersByUrl[link];
      const { status, ok } = await checkUrl(link, referer);
      if (!ok) {
        const label = status === 0 ? 'unreachable / timed out' : `HTTP ${status}`;
        return {
          severity: 'major',
          type: 'broken_link',
          message: `Broken link (${label}): ${link}`,
          url: link,
          details: { status },
        };
      }
      return null;
    }));

    for (const r of results) {
      if (r) issues.push(r);
    }
  }

  return issues;
}

module.exports = { checkLinks };
