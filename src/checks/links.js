'use strict';

async function checkUrl(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'QA-Agent/1.0 link-checker' },
    });
    clearTimeout(timer);
    // Some servers reject HEAD — treat 405 as ok (method not allowed, but resource exists)
    if (res.status === 405) {
      const res2 = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000), redirect: 'follow' });
      return { status: res2.status, ok: res2.ok };
    }
    return { status: res.status, ok: res.ok };
  } catch {
    return { status: 0, ok: false };
  }
}

async function checkLinks(absoluteLinks, addLog) {
  const issues = [];
  const BATCH = 10;

  addLog(`Checking ${absoluteLinks.length} link(s)...`);

  for (let i = 0; i < absoluteLinks.length; i += BATCH) {
    const batch = absoluteLinks.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (link) => {
      const { status, ok } = await checkUrl(link);
      if (!ok) {
        return {
          severity: 'major',
          type: 'broken_link',
          message: `Broken link${status ? ` (HTTP ${status})` : ' (unreachable)'}: ${link}`,
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
