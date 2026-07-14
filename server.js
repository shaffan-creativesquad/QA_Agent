'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const { crawlSite, scanSinglePage, normalizeUrl } = require('./src/crawler');
const { checkLinks } = require('./src/checks/links');
const { checkImageSizes } = require('./src/checks/images');
const { checkWordPressSecurity } = require('./src/checks/wp-security');
const { analyzeScreenshot } = require('./src/checks/visual');
const { buildReport } = require('./src/reporter');
const store = require('./src/store');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Screenshots ───────────────────────────────────────────────────────────────

app.get('/screenshots/:scanId/:fname', async (req, res) => {
  const key = `${req.params.scanId}/${req.params.fname}`;
  const buf = await store.getScreenshot(key);
  if (!buf) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(buf);
});

// ── POST /api/scan ────────────────────────────────────────────────────────────

app.post('/api/scan', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try { new URL(url); } catch {
    return res.status(400).json({ error: 'Invalid URL — include the protocol (https://...)' });
  }

  const id = crypto.randomUUID();
  const scan = {
    id, url,
    status: 'running',
    progress: 0,
    log: [],
    pages: [],
    report: null,
    startedAt: new Date().toISOString(),
    hasMore: false,
    remainingCount: 0,
    phases: {
      crawl: 'pending', links: 'pending', images: 'pending',
      ai: 'pending', wordpress: 'pending',
    },
  };

  await store.setScan(id, scan);
  res.json({ id });

  if (process.env.VERCEL) {
    // Serverless: delegate to QStash so the scan runs in a separate invocation
    const { Client } = require('@upstash/qstash');
    const client = new Client({ token: process.env.QSTASH_TOKEN });
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `https://${req.headers.host}`;

    client.publishJSON({
      url: `${baseUrl}/api/internal/process`,
      body: { scanId: id, url },
      timeout: 800,
    }).catch(async err => {
      console.error('[QStash publish error]', err);
      const s = await store.getScan(id);
      if (s) { s.status = 'error'; addLog(s, `Failed to queue scan: ${err.message}`); await store.setScan(id, s); }
    });
  } else {
    // Local dev: fire-and-forget (server stays alive)
    runScan(id, url).catch(async err => {
      console.error('[scan error]', err);
      const s = await store.getScan(id);
      if (s) { s.status = 'error'; addLog(s, `Fatal: ${err.message}`); await store.setScan(id, s); }
    });
  }
});

// ── GET /api/scan/:id ─────────────────────────────────────────────────────────

app.get('/api/scan/:id', async (req, res) => {
  const scan = await store.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  const { _visitedUrls, _remainingQueue, ...pub } = scan;
  res.json({
    ...pub,
    pages: (scan.pages || []).map(({ _desktopBase64, imageUrls, ...rest }) => rest),
  });
});

// ── POST /api/internal/process  (QStash webhook — runs the actual scan) ───────
// Vercel calls this endpoint from QStash. maxDuration: 800 keeps it alive.

app.post('/api/internal/process', async (req, res) => {
  const { scanId, url } = req.body || {};
  if (!scanId) return res.status(400).json({ error: 'Missing scanId' });

  try {
    await runScan(scanId, url);
    res.json({ ok: true });
  } catch (err) {
    console.error('[process error]', err);
    const s = await store.getScan(scanId);
    if (s) { s.status = 'error'; addLog(s, `Fatal: ${err.message}`); await store.setScan(scanId, s); }
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/internal/continue  (QStash webhook — continues next batch) ──────

app.post('/api/internal/continue', async (req, res) => {
  const { scanId } = req.body || {};
  if (!scanId) return res.status(400).json({ error: 'Missing scanId' });

  try {
    await runAnalysis(scanId, [], { isContinuation: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('[continue process error]', err);
    const s = await store.getScan(scanId);
    if (s) { s.status = 'error'; addLog(s, `Fatal: ${err.message}`); await store.setScan(scanId, s); }
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/scan/:id/continue ───────────────────────────────────────────────

app.post('/api/scan/:id/continue', async (req, res) => {
  const scan = await store.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  if (scan.status === 'running') return res.status(400).json({ error: 'Scan already running' });
  if (!scan._remainingQueue?.length) return res.status(400).json({ error: 'No more pages to scan' });

  res.json({ ok: true });

  if (process.env.VERCEL) {
    const { Client } = require('@upstash/qstash');
    const client = new Client({ token: process.env.QSTASH_TOKEN });
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `https://${req.headers.host}`;

    client.publishJSON({
      url: `${baseUrl}/api/internal/continue`,
      body: { scanId: scan.id },
      timeout: 800,
    }).catch(console.error);
  } else {
    runAnalysis(scan.id, [], { isContinuation: true }).catch(async err => {
      console.error('[continue error]', err);
      const s = await store.getScan(scan.id);
      if (s) { s.status = 'error'; addLog(s, `Fatal: ${err.message}`); await store.setScan(scan.id, s); }
    });
  }
});

// ── GET /api/scan/:id/export ──────────────────────────────────────────────────

app.get('/api/scan/:id/export', async (req, res) => {
  const scan = await store.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  if (scan.status !== 'done') return res.status(400).json({ error: 'Scan not complete yet' });

  const r = scan.report;
  const host = new URL(scan.url).host;

  const byTypeRows = Object.entries(r.byType || {})
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `<tr><td>${esc(label)}</td><td>${n}</td></tr>`)
    .join('');

  const pagesHtml = [...scan.pages]
    .map(({ _desktopBase64, imageUrls, ...p }) => p)
    .sort((a, b) => (b.issues || []).length - (a.issues || []).length)
    .map(p => {
      const issues = p.issues || [];
      const issueRows = issues.length
        ? issues.map(i => `<tr><td class="pill pill-${esc(i.type)}">${esc(pillLabel(i.type))}</td><td>${esc(i.message)}</td></tr>`).join('')
        : '<tr><td colspan="2" class="ok">✓ No issues</td></tr>';
      return `
        <div class="page-block">
          <h3>${esc(p.url)} <span class="badge">${issues.length} issue${issues.length !== 1 ? 's' : ''}</span>${p.loadTimeMs ? `<span class="time">${(p.loadTimeMs/1000).toFixed(1)}s</span>` : ''}</h3>
          <table><thead><tr><th>Type</th><th>Detail</th></tr></thead><tbody>${issueRows}</tbody></table>
        </div>`;
    }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>QA Report — ${esc(host)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;color:#1a202c;padding:2rem}
  h1{font-size:1.5rem;margin-bottom:.25rem}
  .meta{color:#718096;font-size:.85rem;margin-bottom:1.5rem}
  .stats{display:flex;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap}
  .stat{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:1rem 1.5rem;text-align:center;min-width:130px}
  .stat-n{display:block;font-size:2rem;font-weight:800;color:#4f46e5}
  .stat-l{font-size:.7rem;font-weight:700;color:#718096;text-transform:uppercase;letter-spacing:.05em}
  table{width:100%;border-collapse:collapse;font-size:.85rem;margin-top:.5rem}
  th{text-align:left;padding:.4rem .6rem;background:#f8fafc;border-bottom:2px solid #e2e8f0;font-size:.75rem;color:#718096;text-transform:uppercase}
  td{padding:.4rem .6rem;border-bottom:1px solid #e2e8f0;vertical-align:top}
  .page-block{background:#fff;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:1rem;overflow:hidden}
  .page-block h3{font-size:.9rem;padding:.75rem 1rem;background:#f8fafc;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
  .badge{background:#fef2f2;color:#dc2626;border:1px solid #fecaca;font-size:.7rem;font-weight:700;padding:.15rem .45rem;border-radius:100px}
  .time{color:#718096;font-size:.75rem;font-weight:400}
  .ok{color:#15803d;font-weight:500;padding:.6rem}
  .pill{font-size:.65rem;font-weight:700;padding:.15rem .45rem;border-radius:100px;white-space:nowrap;border:1px solid;width:1%;padding-right:.5rem}
  .pill-seo_heading{background:#ecfdf5;color:#065f46;border-color:#6ee7b7}
  .pill-security,.pill-wp_security{background:#fff1f2;color:#9f1239;border-color:#fecdd3}
  .pill-placeholder{background:#fef3c7;color:#92400e;border-color:#fde68a}
  .pill-broken_image{background:#fee2e2;color:#991b1b;border-color:#fecaca}
  .pill-button{background:#ede9fe;color:#5b21b6;border-color:#ddd6fe}
  .pill-dead_link{background:#ffedd5;color:#9a3412;border-color:#fed7aa}
  .pill-form{background:#ecfdf5;color:#065f46;border-color:#a7f3d0}
  .pill-html{background:#f0f9ff;color:#075985;border-color:#bae6fd}
  .pill-visual{background:#fdf4ff;color:#7e22ce;border-color:#e9d5ff}
  .pill-js_error,.pill-http_error,.pill-load_failure{background:#fef2f2;color:#b91c1c;border-color:#fecaca}
  .pill-performance{background:#f0fdf4;color:#166534;border-color:#bbf7d0}
  .pill-missing_resource{background:#fef2f2;color:#991b1b;border-color:#fecaca}
  .summary-table{background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:1.5rem}
  .summary-table h2{font-size:.85rem;padding:.75rem 1rem;background:#f8fafc;border-bottom:1px solid #e2e8f0;color:#718096;text-transform:uppercase;letter-spacing:.05em}
</style>
</head>
<body>
<h1>QA Report — ${esc(host)}</h1>
<p class="meta">Scanned: ${esc(scan.url)} &nbsp;|&nbsp; ${new Date(scan.startedAt).toLocaleString()} &nbsp;|&nbsp; Generated by QA Agent</p>
<div class="stats">
  <div class="stat"><span class="stat-n">${r.totalIssues}</span><span class="stat-l">Total Issues</span></div>
  <div class="stat"><span class="stat-n">${r.totalPages}</span><span class="stat-l">Pages Scanned</span></div>
  <div class="stat"><span class="stat-n">${r.pagesWithIssues}</span><span class="stat-l">Affected Pages</span></div>
</div>
<div class="summary-table">
  <h2>Issues by Category</h2>
  <table><tbody>${byTypeRows}</tbody></table>
</div>
${pagesHtml}
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="qa-report-${host}-${Date.now()}.html"`);
  res.send(html);
});

// ── POST /api/scan/:id/rescan ─────────────────────────────────────────────────

app.post('/api/scan/:id/rescan', async (req, res) => {
  const scan = await store.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });

  const { pageUrl } = req.body || {};
  if (!pageUrl) return res.status(400).json({ error: 'pageUrl required' });

  const pageIndex = (scan.pages || []).findIndex(p => p.url === pageUrl);
  if (pageIndex === -1) return res.status(404).json({ error: 'Page not found in scan' });

  res.json({ ok: true });

  // Single-page rescan is short enough (~30s) to run inline on both local + Vercel Pro
  try {
    const fresh = await scanSinglePage(pageUrl, scan.id, pageIndex);

    if (fresh._desktopBase64) {
      const aiIssues = await analyzeScreenshot(fresh._desktopBase64, pageUrl);
      fresh.issues.push(...aiIssues);
      delete fresh._desktopBase64;
    }

    if (fresh.imageUrls?.length) {
      const origin = new URL(pageUrl).origin;
      const abs = fresh.imageUrls
        .map(u => { try { return new URL(u, origin).href; } catch { return null; } })
        .filter(Boolean);
      const imgIssues = await checkImageSizes(abs, pageUrl);
      fresh.issues.push(...imgIssues);
    }

    delete fresh.imageUrls;

    // Reload scan before writing (may have changed during async work)
    const latest = await store.getScan(scan.id);
    if (latest) {
      latest.pages[pageIndex] = fresh;
      latest.report = buildReport(latest.pages);
      await store.setScan(scan.id, latest);
    }
  } catch (err) {
    console.error('[rescan error]', err);
  }
});

// ── Orchestration ─────────────────────────────────────────────────────────────

function ts() { return new Date().toLocaleTimeString(); }
function addLog(scan, msg) { scan.log.push(`[${ts()}] ${msg}`); }
function setPhase(scan, phase, state) { scan.phases[phase] = state; }

async function runScan(scanId, url) {
  const scan = await store.getScan(scanId);
  const log = msg => addLog(scan, msg);

  log(`Starting scan of ${url}`);
  if (!process.env.GOOGLE_API_KEY) log('Warning: GOOGLE_API_KEY not set — AI analysis skipped');

  setPhase(scan, 'crawl', 'running');
  await store.setScan(scanId, scan);

  let crawlResult;
  try {
    crawlResult = await crawlSite(url, scanId, (msg, pct) => {
      log(msg); scan.progress = pct;
    });
  } catch (err) {
    setPhase(scan, 'crawl', 'error');
    log(`Crawl failed: ${err.message}`);
    scan.status = 'error';
    await store.setScan(scanId, scan);
    return;
  }

  // crawlResult.pages still have _desktopBase64 in memory — store.setScan strips them automatically
  scan.pages.push(...crawlResult.pages);
  scan._remainingQueue = crawlResult.remainingQueue;
  scan._visitedUrls    = crawlResult.visitedUrls;
  scan.hasMore         = crawlResult.remainingQueue.length > 0;
  scan.remainingCount  = crawlResult.remainingQueue.length;
  scan.progress = 58;
  setPhase(scan, 'crawl', 'done');
  log(`Crawl batch done — ${crawlResult.pages.length} page(s) scanned.${scan.hasMore ? ` ${scan.remainingCount} page(s) queued.` : ''}`);
  await store.setScan(scanId, scan);

  // Pass in-memory pages (with _desktopBase64) for AI analysis
  await runAnalysis(scanId, crawlResult.pages, {}, scan);
}

async function runAnalysis(scanId, newPages, { isContinuation = false } = {}, _scanObj = null) {
  const scan = _scanObj || await store.getScan(scanId);
  const url  = scan.url;
  const log  = msg => addLog(scan, msg);

  if (isContinuation) {
    scan.status   = 'running';
    scan.progress = 0;
    scan.phases   = { crawl: 'pending', links: 'pending', images: 'pending', ai: 'pending', wordpress: 'pending' };
    await store.setScan(scanId, scan);

    setPhase(scan, 'crawl', 'running');
    let crawlResult;
    try {
      crawlResult = await crawlSite(url, scanId, (msg, pct) => {
        log(msg); scan.progress = pct;
      }, {
        resumeQueue: scan._remainingQueue,
        visitedUrls: scan._visitedUrls,
        pageOffset:  scan.pages.length,
      });
    } catch (err) {
      setPhase(scan, 'crawl', 'error');
      log(`Crawl failed: ${err.message}`);
      scan.status = 'error';
      await store.setScan(scanId, scan);
      return;
    }

    scan.pages.push(...crawlResult.pages);
    scan._remainingQueue = crawlResult.remainingQueue;
    scan._visitedUrls    = crawlResult.visitedUrls;
    scan.hasMore         = crawlResult.remainingQueue.length > 0;
    scan.remainingCount  = crawlResult.remainingQueue.length;
    newPages = crawlResult.pages;
    scan.progress = 58;
    setPhase(scan, 'crawl', 'done');
    log(`Crawl batch done — ${newPages.length} more page(s). ${scan.hasMore ? `${scan.remainingCount} still queued.` : 'All pages discovered!'}`);
    await store.setScan(scanId, scan);
  }

  scan.status = 'analyzing';

  // ── Links ──────────────────────────────────────────────────────────────────
  setPhase(scan, 'links', 'running');
  const crawledNorms = new Set(scan.pages.map(p => normalizeUrl(p.url)));
  const linkSources  = new Map();
  for (const page of newPages) {
    for (const href of (page.seo?.links ?? [])) {
      try {
        const abs = new URL(href, page.url).href;
        if (!linkSources.has(abs)) linkSources.set(abs, page);
      } catch { /* skip */ }
    }
  }
  const linksToCheck  = [...linkSources.keys()].filter(u => !crawledNorms.has(normalizeUrl(u))).slice(0, 200);
  const referersByUrl = {};
  for (const [href, page] of linkSources) referersByUrl[href] = page.url;
  const linkIssues = await checkLinks(linksToCheck, log, referersByUrl);
  for (const issue of linkIssues) {
    const src = linkSources.get(issue.url) ?? newPages[0];
    if (src) src.issues.push(issue);
  }
  scan.progress = 65;
  setPhase(scan, 'links', 'done');
  log(`Link check done — ${linkIssues.length} broken link(s).`);
  await store.setScan(scanId, scan);

  // ── Image sizes ───────────────────────────────────────────────────────────
  setPhase(scan, 'images', 'running');
  log('Auditing image file sizes...');
  const origin = new URL(url).origin;
  let totalImgIssues = 0;
  for (const page of newPages) {
    if (!page.imageUrls?.length) continue;
    const absUrls = page.imageUrls
      .map(u => { try { return new URL(u, origin).href; } catch { return null; } })
      .filter(Boolean);
    const imgIssues = await checkImageSizes(absUrls, page.url);
    page.issues.push(...imgIssues);
    totalImgIssues += imgIssues.length;
    delete page.imageUrls;
  }
  scan.progress = 70;
  setPhase(scan, 'images', 'done');
  log(`Image audit done — ${totalImgIssues} oversized image(s).`);
  await store.setScan(scanId, scan);

  // ── AI visual analysis ────────────────────────────────────────────────────
  setPhase(scan, 'ai', 'running');
  log('Running AI visual analysis...');
  for (let i = 0; i < newPages.length; i++) {
    const page = newPages[i];
    log(`AI reviewing (${i + 1}/${newPages.length}): ${page.url}`);
    const aiIssues = await analyzeScreenshot(page._desktopBase64, page.url);
    page.issues.push(...aiIssues);
    if (aiIssues.length > 0) log(`  → ${aiIssues.length} visual issue(s)`);
    delete page._desktopBase64;
    scan.progress = 70 + Math.round(((i + 1) / newPages.length) * 20);
    await store.setScan(scanId, scan);
  }
  setPhase(scan, 'ai', 'done');

  // ── WordPress security ────────────────────────────────────────────────────
  const isWP = scan.pages.some(p => p.wpDetected);
  const wpAlreadyChecked = scan.phases.wordpress === 'done' || scan.phases.wordpress === 'error';
  if (isWP && !wpAlreadyChecked) {
    setPhase(scan, 'wordpress', 'running');
    log('WordPress detected — running security checks...');
    try {
      const wpIssues = await checkWordPressSecurity(url);
      if (scan.pages.length > 0) scan.pages[0].issues.push(...wpIssues);
      setPhase(scan, 'wordpress', 'done');
      log(`WordPress security check done — ${wpIssues.length} issue(s).`);
    } catch (err) {
      setPhase(scan, 'wordpress', 'error');
      log(`WordPress check error: ${err.message}`);
    }
  } else if (!isWP) {
    setPhase(scan, 'wordpress', 'skipped');
  }

  // ── Final report ──────────────────────────────────────────────────────────
  scan.report   = buildReport(scan.pages);
  scan.status   = 'done';
  scan.progress = 100;
  log(`Batch done — ${scan.report.totalIssues} issue(s) across ${scan.report.totalPages} page(s) so far.${scan.hasMore ? ` (${scan.remainingCount} pages remaining)` : ' All pages complete!'}`);
  await store.setScan(scanId, scan);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PILL_LABELS = {
  placeholder: 'Placeholder', broken_image: 'Broken Image', image: 'Image',
  button: 'Button', dead_link: 'Dead Link', seo_heading: 'SEO Heading',
  form: 'Form', html: 'HTML', visual: 'Visual', broken_link: 'Broken Link',
  missing_resource: 'Missing File', js_error: 'JS Error', http_error: 'HTTP Error',
  load_failure: 'Load Fail', performance: 'Performance', security: 'Security',
  wp_security: 'WP Security',
};
function pillLabel(t) { return PILL_LABELS[t] || t; }
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Start server or export for Vercel ────────────────────────────────────────

if (process.env.VERCEL) {
  module.exports = app;
} else {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`QA Agent → http://localhost:${PORT}`));
}
