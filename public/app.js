'use strict';

(function () {
  let pollTimer = null;
  let lastLogLen = 0;
  let currentScanId = null;
  let isContinuation = false;
  let prevPageCount = 0;

  const form      = document.getElementById('scan-form');
  const urlInput  = document.getElementById('url-input');
  const startBtn  = document.getElementById('start-btn');
  const progCard  = document.getElementById('progress-card');
  const progBar   = document.getElementById('prog-bar');
  const progTitle = document.getElementById('prog-title');
  const chip      = document.getElementById('status-chip');
  const log       = document.getElementById('log');
  const results   = document.getElementById('results');
  const pages     = document.getElementById('pages');
  const newBtn    = document.getElementById('new-btn');
  const exportBtn = document.getElementById('export-btn');

  // ── Events ────────────────────────────────────────────────────────────────
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (url) await startScan(url);
  });

  newBtn.addEventListener('click', () => resetUI());

  exportBtn.addEventListener('click', () => {
    if (currentScanId) {
      window.location.href = `/api/scan/${currentScanId}/export`;
    }
  });

  // Screenshot tab switching
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const wrap = tab.closest('.shots-wrap');
    if (!wrap) return;
    const vp = tab.dataset.vp;
    wrap.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    wrap.querySelectorAll('.shot-img').forEach(img => img.classList.remove('active'));
    tab.classList.add('active');
    wrap.querySelector(`.shot-img[data-vp="${vp}"]`)?.classList.add('active');
  });

  // ── Scan ──────────────────────────────────────────────────────────────────
  async function startScan(url) {
    resetUI(false);
    lastLogLen = 0;
    currentScanId = null;

    startBtn.disabled = true;
    startBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="animation:spin 1s linear infinite"><path d="M12 2a10 10 0 1 0 10 10"/></svg> Scanning…`;

    progCard.classList.remove('hidden');
    progTitle.textContent = 'Scanning: ' + url;
    setChip('running');
    updateSteps({});

    let id;
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Server error');
      id = body.id;
      currentScanId = id;
    } catch (err) {
      logLine('Error: ' + err.message, true);
      setChip('error');
      resetBtn();
      return;
    }

    pollTimer = setInterval(() => poll(id), 2000);
    poll(id);
  }

  async function poll(id) {
    try {
      const res = await fetch('/api/scan/' + id);
      if (!res.ok) return;
      const scan = await res.json();

      progBar.style.width = scan.progress + '%';
      setChip(scan.status);
      if (scan.phases) updateSteps(scan.phases);
      scan.log.slice(lastLogLen).forEach(l => logLine(l));
      lastLogLen = scan.log.length;

      if (scan.status === 'done' || scan.status === 'error') {
        clearInterval(pollTimer); pollTimer = null;
        resetBtn();
        progCard.classList.add('hidden');
        if (scan.status === 'done') {
          if (isContinuation) {
            appendNewPages(scan);
          } else {
            renderResults(scan);
          }
          isContinuation = false;
        }
      }
    } catch { /* network blip */ }
  }

  // ── Steps UI ──────────────────────────────────────────────────────────────
  function updateSteps(phases) {
    document.querySelectorAll('.step[data-phase]').forEach(el => {
      const phase = el.dataset.phase;
      const state = phases[phase] || 'pending';
      el.dataset.state = state;

      // Also colour the line after this step if done
      const line = el.nextElementSibling;
      if (line?.classList.contains('step-line')) {
        line.style.background = (state === 'done') ? '#22c55e' : '';
      }
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function renderResults(scan) {
    const r = scan.report;

    document.getElementById('s-total').textContent    = r.totalIssues;
    document.getElementById('s-pages').textContent    = r.totalPages;
    document.getElementById('s-affected').textContent = r.pagesWithIssues;

    // Average load time
    const loadTimes = scan.pages.map(p => p.loadTimeMs).filter(Boolean);
    if (loadTimes.length) {
      const avg = loadTimes.reduce((a, b) => a + b, 0) / loadTimes.length;
      document.getElementById('s-avgload').textContent = (avg / 1000).toFixed(1) + 's';
    } else {
      document.getElementById('s-avgload').textContent = '—';
    }

    // Category breakdown
    const bd = document.getElementById('breakdown');
    if (r.byType && Object.keys(r.byType).length) {
      const tags = Object.entries(r.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([label, n]) => `<span class="cat-tag">${esc(label)}: <b>${n}</b></span>`)
        .join('');
      bd.innerHTML = `<h3>Issues by Category</h3><div class="cat-tags">${tags}</div>`;
      bd.classList.remove('hidden');
    } else {
      bd.classList.add('hidden');
    }

    // Export button
    exportBtn.classList.remove('hidden');

    // Pages — worst first
    pages.innerHTML = '';
    prevPageCount = 0;
    const sorted = [...scan.pages].sort((a, b) =>
      (b.issues || []).length - (a.issues || []).length
    );
    sorted.forEach(p => pages.appendChild(buildPage(p, scan.id)));

    updateContinueBtn(scan);

    results.classList.remove('hidden');
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function appendNewPages(scan) {
    // Update summary numbers
    const r = scan.report;
    document.getElementById('s-total').textContent    = r.totalIssues;
    document.getElementById('s-pages').textContent    = r.totalPages;
    document.getElementById('s-affected').textContent = r.pagesWithIssues;
    const loadTimes = scan.pages.map(p => p.loadTimeMs).filter(Boolean);
    if (loadTimes.length) {
      const avg = loadTimes.reduce((a, b) => a + b, 0) / loadTimes.length;
      document.getElementById('s-avgload').textContent = (avg / 1000).toFixed(1) + 's';
    }

    // Update breakdown
    const bd = document.getElementById('breakdown');
    if (r.byType && Object.keys(r.byType).length) {
      const tags = Object.entries(r.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([label, n]) => `<span class="cat-tag">${esc(label)}: <b>${n}</b></span>`)
        .join('');
      bd.innerHTML = `<h3>Issues by Category</h3><div class="cat-tags">${tags}</div>`;
      bd.classList.remove('hidden');
    }

    // Append only the new pages (slice from prevPageCount)
    const newPages = scan.pages.slice(prevPageCount);
    newPages.forEach(p => pages.appendChild(buildPage(p, scan.id)));

    updateContinueBtn(scan);

    // Scroll to first new card
    const allCards = pages.querySelectorAll('.page-card');
    allCards[prevPageCount]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    prevPageCount = scan.pages.length;
  }

  function updateContinueBtn(scan) {
    let btn = document.getElementById('continue-btn');
    if (scan.hasMore && scan.remainingCount > 0) {
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'continue-btn';
        btn.className = 'btn-continue';
        document.querySelector('.bottom-bar').prepend(btn);
        btn.addEventListener('click', () => startContinue(scan.id));
      }
      btn.textContent = `Scan Next 12 Pages (${scan.remainingCount} remaining)`;
      btn.disabled = false;
    } else if (btn) {
      btn.remove();
    }
  }

  async function startContinue(id) {
    const btn = document.getElementById('continue-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }

    isContinuation = true;
    prevPageCount = document.querySelectorAll('.page-card').length;
    lastLogLen = 0;

    // Show progress card above results
    log.innerHTML = '';
    progBar.style.width = '0%';
    setChip('running');
    updateSteps({});
    progCard.classList.remove('hidden');
    progCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
      const res = await fetch(`/api/scan/${id}/continue`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'Server error');
      }
    } catch (err) {
      logLine('Error: ' + err.message, true);
      setChip('error');
      isContinuation = false;
      if (btn) { btn.disabled = false; btn.textContent = `Scan Next 12 Pages`; }
      return;
    }

    pollTimer = setInterval(() => poll(id), 2000);
    poll(id);
  }

  function buildPage(page, scanId) {
    const issues = page.issues || [];
    const card = document.createElement('div');
    card.className = 'page-card';

    const countHtml = issues.length > 0
      ? `<span class="issue-count">${issues.length} issue${issues.length > 1 ? 's' : ''}</span>`
      : `<span class="issue-count ok">✓ Clean</span>`;

    const timeHtml = page.loadTimeMs
      ? `<span class="page-time">${(page.loadTimeMs / 1000).toFixed(1)}s</span>` : '';

    card.innerHTML = `
      <div class="page-head">
        <span class="chevron">&#9654;</span>
        <span class="page-url" title="${esc(page.url)}">${esc(page.url)}</span>
        <div class="page-right">${timeHtml}${countHtml}</div>
      </div>
      <div class="page-body">
        ${buildIssues(issues)}
        ${buildShots(page.screenshots)}
        <div class="rescan-row">
          <button class="btn-rescan" data-url="${esc(page.url)}" data-scanid="${esc(scanId)}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Re-scan Page
          </button>
        </div>
      </div>`;

    card.querySelector('.page-head').addEventListener('click', () => card.classList.toggle('open'));
    card.querySelector('.btn-rescan').addEventListener('click', (e) => rescanPage(e, card, page));
    if (issues.length > 0) card.classList.add('open');

    return card;
  }

  async function rescanPage(e, card, page) {
    const btn = e.currentTarget;
    const scanId = btn.dataset.scanid;
    btn.disabled = true;
    btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="animation:spin 1s linear infinite"><path d="M12 2a10 10 0 1 0 10 10"/></svg> Scanning…`;

    try {
      await fetch(`/api/scan/${scanId}/rescan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageUrl: page.url }),
      });

      // Poll until the rescan updates
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        if (attempts > 60) { clearInterval(interval); resetRescanBtn(btn); return; }
        try {
          const res = await fetch(`/api/scan/${scanId}`);
          const scan = await res.json();
          const updated = scan.pages.find(p => p.url === page.url);
          if (updated) {
            clearInterval(interval);
            const newCard = buildPage(updated, scanId);
            if (updated.issues?.length) newCard.classList.add('open');
            card.replaceWith(newCard);

            // Update summary stats
            const r = scan.report;
            if (r) {
              document.getElementById('s-total').textContent    = r.totalIssues;
              document.getElementById('s-affected').textContent = r.pagesWithIssues;
            }
          }
        } catch { /* retry */ }
      }, 3000);
    } catch {
      resetRescanBtn(btn);
    }
  }

  function resetRescanBtn(btn) {
    btn.disabled = false;
    btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Re-scan Page`;
  }

  function buildIssues(issues) {
    if (!issues.length) return '<p class="no-issues">✓ No issues found on this page</p>';

    return `<ul class="issue-list">${issues.map(i => `
      <li class="issue-item">
        <span class="type-pill type-${esc(i.type)}">${esc(pillLabel(i.type))}</span>
        <span class="issue-msg">${esc(i.message)}</span>
      </li>`).join('')}
    </ul>`;
  }

  function buildShots(shots) {
    if (!shots) return '';

    const tabs = [
      shots.annotated ? { k: 'annotated', l: '🔍 Issues View', cls: 'issues-tab' } : null,
      shots.desktop   ? { k: 'desktop',   l: 'Desktop',  cls: '' } : null,
      shots.tablet    ? { k: 'tablet',    l: 'Tablet',   cls: '' } : null,
      shots.mobile    ? { k: 'mobile',    l: 'Mobile',   cls: '' } : null,
    ].filter(Boolean);

    if (!tabs.length) return '';

    const tabHtml = tabs.map((t, i) =>
      `<button class="tab ${t.cls}${i === 0 ? ' active' : ''}" data-vp="${t.k}">${t.l}</button>`
    ).join('');

    const imgHtml = tabs.map((t, i) =>
      `<img class="shot-img${i === 0 ? ' active' : ''}" data-vp="${t.k}" src="${esc(shots[t.k])}" loading="lazy" alt="${t.k}">`
    ).join('');

    const legend = shots.annotated
      ? `<div class="shots-legend">🔴 Red outline = broken/empty element &nbsp;&nbsp; 🟠 Orange = dead link / disconnected form &nbsp;&nbsp; 🟡 Yellow = placeholder text</div>`
      : '';

    return `<div class="shots-wrap">${legend}<div class="tab-bar">${tabHtml}</div>${imgHtml}</div>`;
  }

  const PILL_LABELS = {
    placeholder: 'Placeholder', broken_image: 'Broken Image', image: 'Image',
    button: 'Button', dead_link: 'Dead Link', seo_heading: 'SEO Heading',
    form: 'Form', html: 'HTML', visual: 'Visual', broken_link: 'Broken Link',
    missing_resource: 'Missing File', js_error: 'JS Error', http_error: 'HTTP Error',
    load_failure: 'Load Fail', performance: 'Performance', security: 'Security',
    wp_security: 'WP Security',
  };
  function pillLabel(t) { return PILL_LABELS[t] || t; }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function logLine(text, err = false) {
    const d = document.createElement('div');
    d.className = 'log-line';
    if (err) d.style.color = '#f87171';
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  function setChip(s) { chip.textContent = s; chip.className = 'chip ' + s; }

  function resetBtn() {
    startBtn.disabled = false;
    startBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg> Scan Site`;
  }

  function resetUI(clearUrl = true) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    progCard.classList.add('hidden');
    results.classList.add('hidden');
    exportBtn.classList.add('hidden');
    document.getElementById('continue-btn')?.remove();
    log.innerHTML = '';
    progBar.style.width = '0%';
    isContinuation = false;
    prevPageCount = 0;
    resetBtn();
    updateSteps({});
    if (clearUrl) { urlInput.value = ''; currentScanId = null; }
    lastLogLen = 0;
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  const style = document.createElement('style');
  style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
})();
