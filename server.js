'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path'); // still needed for express.static
const { crawlSite, scanSinglePage, normalizeUrl } = require('./src/crawler');
const { checkLinks } = require('./src/checks/links');
const { checkImageSizes } = require('./src/checks/images');
const { checkWordPressSecurity } = require('./src/checks/wp-security');
const { analyzeScreenshot } = require('./src/checks/visual');
const { buildReport } = require('./src/reporter');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory screenshot store: "scanId/fname" → Buffer
const screenshotStore = new Map();
const scans = new Map();

// Serve screenshots from memory (no disk writes)
app.get('/screenshots/:scanId/:fname', (req, res) => {
  const key = `${req.params.scanId}/${req.params.fname}`;
  const buf = screenshotStore.get(key);
  if (!buf) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(buf);
});

// ── API ──────────────────────────────────────────────────────────────────────

app.post('/api/scan', (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try { new URL(url); } catch {
    return res.status(400).json({ error: 'Invalid URL — include the protocol (https://...)' });
  }

  const id = crypto.randomUUID();
  scans.set(id, {
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
      crawl:     'pending',
      links:     'pending',
      images:    'pending',
      ai:        'pending',
      wordpress: 'pending',
    },
  });

  res.json({ id });

  runScan(id, url).catch(err => {
    const s = scans.get(id);
    if (s) { s.status = 'error'; addLog(s, `Fatal: ${err.message}`); }
    console.error('[scan error]', err);
  });
});

app.get('/api/scan/:id', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  // Strip internal-only fields
  const { _visitedUrls, _remainingQueue, ...pub } = scan;
  res.json({
    ...pub,
    pages: scan.pages.map(({ _desktopBase64, imageUrls, ...rest }) => rest),
  });
});

// ── Continue scan (next batch of pages) ──────────────────────────────────────
app.post('/api/scan/:id/continue', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  if (scan.status === 'running') return res.status(400).json({ error: 'Scan already running' });
  if (!scan._remainingQueue?.length) return res.status(400).json({ error: 'No more pages to scan' });

  res.json({ ok: true });

  runAnalysis(scan.id, [], { isContinuation: true }).catch(err => {
    const s = scans.get(scan.id);
    if (s) { s.status = 'error'; addLog(s, `Fatal: ${err.message}`); }
    console.error('[continue error]', err);
  });
});

// ── Export: standalone HTML report ──────────────────────────────────────────

app.get('/api/scan/:id/export', (req, res) => {
  const scan = scans.get(req.params.id);
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

// ── Re-scan a single page ────────────────────────────────────────────────────

app.post('/api/scan/:id/rescan', async (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });

  const { pageUrl } = req.body || {};
  if (!pageUrl) return res.status(400).json({ error: 'pageUrl required' });

  const pageIndex = scan.pages.findIndex(p => p.url === pageUrl);
  if (pageIndex === -1) return res.status(404).json({ error: 'Page not found in scan' });

  res.json({ ok: true });

  try {
    const fresh = await scanSinglePage(pageUrl, scan.id, screenshotStore, pageIndex);

    // AI visual check
    if (fresh._desktopBase64) {
      const aiIssues = await analyzeScreenshot(fresh._desktopBase64, pageUrl);
      fresh.issues.push(...aiIssues);
      delete fresh._desktopBase64;
    }

    // Image size audit
    if (fresh.imageUrls?.length) {
      const origin = new URL(pageUrl).origin;
      const abs = fresh.imageUrls.map(u => {
        try { return new URL(u, origin).href; } catch { return null; }
      }).filter(Boolean);
      const imgIssues = await checkImageSizes(abs, pageUrl);
      fresh.issues.push(...imgIssues);
    }

    delete fresh.imageUrls;
    scan.pages[pageIndex] = fresh;
    scan.report = buildReport(scan.pages);
  } catch (err) {
    console.error('[rescan error]', err);
  }
});

// ── Orchestration ─────────────────────────────────────────────────────────────

function ts() { return new Date().toLocaleTimeString(); }
function addLog(scan, msg) { scan.log.push(`[${ts()}] ${msg}`); }

function setPhase(scan, phase, state) {
  scan.phases[phase] = state;
}

async function runScan(scanId, url) {
  const scan = scans.get(scanId);
  const log = (msg) => addLog(scan, msg);

  log(`Starting scan of ${url}`);
  if (!process.env.GOOGLE_API_KEY) log('Warning: GOOGLE_API_KEY not set — AI analysis skipped');

  // ── Phase 1: Crawl first batch ────────────────────────────────────────────
  setPhase(scan, 'crawl', 'running');
  let crawlResult;
  try {
    crawlResult = await crawlSite(url, scanId, screenshotStore, (msg, pct) => {
      log(msg); scan.progress = pct;
    });
  } catch (err) {
    setPhase(scan, 'crawl', 'error');
    log(`Crawl failed: ${err.message}`);
    scan.status = 'error';
    return;
  }

  scan.pages.push(...crawlResult.pages);
  scan._remainingQueue = crawlResult.remainingQueue;
  scan._visitedUrls    = crawlResult.visitedUrls;
  scan.hasMore         = crawlResult.remainingQueue.length > 0;
  scan.remainingCount  = crawlResult.remainingQueue.length;

  scan.progress = 58;
  setPhase(scan, 'crawl', 'done');
  log(`Crawl batch done — ${crawlResult.pages.length} page(s) scanned.${scan.hasMore ? ` ${scan.remainingCount} page(s) queued.` : ''}`);

  await runAnalysis(scanId, crawlResult.pages);
}

// ── Shared analysis phases (links, images, AI, WP) ───────────────────────────
// newPages = only the pages from the latest crawl batch (for AI/image)
// isContinuation = true when called from /continue endpoint (crawls next batch first)
async function runAnalysis(scanId, newPages, { isContinuation = false } = {}) {
  const scan = scans.get(scanId);
  const url  = scan.url;
  const log  = (msg) => addLog(scan, msg);

  if (isContinuation) {
    // Crawl the next batch, then run analysis on those pages
    scan.status = 'running';
    scan.progress = 0;
    scan.phases = { crawl: 'pending', links: 'pending', images: 'pending', ai: 'pending', wordpress: 'pending' };

    setPhase(scan, 'crawl', 'running');
    let crawlResult;
    try {
      crawlResult = await crawlSite(url, scanId, screenshotStore, (msg, pct) => {
        log(msg); scan.progress = pct;
      }, {
        resumeQueue:  scan._remainingQueue,
        visitedUrls:  scan._visitedUrls,
        pageOffset:   scan.pages.length,
      });
    } catch (err) {
      setPhase(scan, 'crawl', 'error');
      log(`Crawl failed: ${err.message}`);
      scan.status = 'error';
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
  }

  scan.status = 'analyzing';

  // ── Links ─────────────────────────────────────────────────────────────────
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
  const linksToCheck = [...linkSources.keys()]
    .filter(u => !crawledNorms.has(normalizeUrl(u))).slice(0, 200);
  const linkIssues = await checkLinks(linksToCheck, log);
  for (const issue of linkIssues) {
    const src = linkSources.get(issue.url) ?? newPages[0];
    if (src) src.issues.push(issue);
  }
  scan.progress = 65;
  setPhase(scan, 'links', 'done');
  log(`Link check done — ${linkIssues.length} broken link(s).`);

  // ── Image sizes ───────────────────────────────────────────────────────────
  setPhase(scan, 'images', 'running');
  log('Auditing image file sizes...');
  const origin = new URL(url).origin;
  let totalImgIssues = 0;
  for (const page of newPages) {
    if (!page.imageUrls?.length) continue;
    const absUrls = page.imageUrls.map(u => { try { return new URL(u, origin).href; } catch { return null; } }).filter(Boolean);
    const imgIssues = await checkImageSizes(absUrls, page.url);
    page.issues.push(...imgIssues);
    totalImgIssues += imgIssues.length;
    delete page.imageUrls;
  }
  scan.progress = 70;
  setPhase(scan, 'images', 'done');
  log(`Image audit done — ${totalImgIssues} oversized image(s).`);

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
  }
  setPhase(scan, 'ai', 'done');

  // ── WordPress security (only on first batch or if newly detected) ─────────
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

  // ── Report ─────────────────────────────────────────────────────────────────
  scan.report   = buildReport(scan.pages);
  scan.status   = 'done';
  scan.progress = 100;
  log(`Batch done — ${scan.report.totalIssues} issue(s) across ${scan.report.totalPages} page(s) so far.${scan.hasMore ? ` (${scan.remainingCount} pages remaining)` : ' All pages complete!'}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PILL_LABELS = {
  placeholder: 'Placeholder', broken_image: 'Broken Image', image: 'Image',
  button: 'Button', dead_link: 'Dead Link', form: 'Form', html: 'HTML',
  visual: 'Visual', broken_link: 'Broken Link', missing_resource: 'Missing File',
  js_error: 'JS Error', http_error: 'HTTP Error', load_failure: 'Load Fail',
  performance: 'Performance', security: 'Security', wp_security: 'WP Security',
};
function pillLabel(t) { return PILL_LABELS[t] || t; }
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`QA Agent → http://localhost:${PORT}`));
