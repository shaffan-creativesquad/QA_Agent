'use strict';

(function () {
  // ── Technical scan state ──────────────────────────────────────────────────
  let pollTimer = null;
  let lastLogLen = 0;
  let currentScanId = null;
  let isContinuation = false;
  let prevPageCount = 0;

  // ── Content scan state ────────────────────────────────────────────────────
  let contentPollTimer = null;
  let contentLogLen = 0;
  let currentContentScanId = null;

  // ── Technical scan elements ───────────────────────────────────────────────
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

  // ── Content scan elements ─────────────────────────────────────────────────
  const contentForm      = document.getElementById('content-scan-form');
  const contentUrlInput  = document.getElementById('content-url-input');
  const contentStartBtn  = document.getElementById('content-start-btn');
  const contentProgCard  = document.getElementById('content-progress-card');
  const contentProgBar   = document.getElementById('content-prog-bar');
  const contentProgTitle = document.getElementById('content-prog-title');
  const contentChip      = document.getElementById('content-status-chip');
  const contentLog       = document.getElementById('content-log');
  const contentResults   = document.getElementById('content-results');
  const contentPages     = document.getElementById('content-pages');
  const contentNewBtn    = document.getElementById('content-new-btn');

  // ── Main tab switching ────────────────────────────────────────────────────
  document.querySelectorAll('.main-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      document.getElementById('tab-technical').classList.toggle('hidden', target !== 'technical');
      document.getElementById('tab-content').classList.toggle('hidden', target !== 'content');
      exportBtn.classList.add('hidden');
    });
  });

  // ── Technical scan events ─────────────────────────────────────────────────
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (url) await startScan(url);
  });
  newBtn.addEventListener('click', () => resetUI());
  exportBtn.addEventListener('click', () => {
    if (currentScanId) window.location.href = `/api/scan/${currentScanId}/export`;
  });

  // ── Content scan events ───────────────────────────────────────────────────
  contentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = contentUrlInput.value.trim();
    if (url) await startContentScan(url);
  });
  contentNewBtn.addEventListener('click', () => resetContentUI());

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

  // Content vs Technical issue tab switching
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.issue-tab');
    if (!tab) return;
    const container = tab.closest('.issue-tabs');
    if (!container) return;
    const name = tab.dataset.tab;
    container.querySelectorAll('.issue-tab').forEach(t => t.classList.remove('active'));
    container.querySelectorAll('.issue-tab-pane').forEach(p => p.classList.add('hidden'));
    tab.classList.add('active');
    container.querySelector(`.issue-tab-pane[data-tab="${name}"]`)?.classList.remove('hidden');
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

  const CONTENT_TYPES = new Set(['proofreading', 'ai_content']);

  function buildPage(page, scanId) {
    const issues = page.issues || [];
    const techIssues    = issues.filter(i => !CONTENT_TYPES.has(i.type));
    const contentIssues = issues.filter(i => CONTENT_TYPES.has(i.type));
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
        ${buildIssuesTabs(techIssues, contentIssues)}
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
    if (issues.length > 0) {
      card.classList.add('open', 'has-issues');
    } else {
      card.classList.add('clean');
    }

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

  function buildIssuesTabs(techIssues, contentIssues) {
    const hasTech    = techIssues.length > 0;
    const hasContent = contentIssues.length > 0;

    if (!hasTech && !hasContent) {
      return '<p class="no-issues">✓ No issues found on this page</p>';
    }

    // No content issues — just show technical list directly, no tabs needed
    if (!hasContent) return buildIssueList(techIssues);

    // Has content issues — always show both tabs
    const techLabel    = `Technical${hasTech ? ` <span class="itab-count">${techIssues.length}</span>` : ''}`;
    const contentLabel = `Content <span class="itab-count content">${contentIssues.length}</span>`;

    return `<div class="issue-tabs">
      <div class="issue-tab-bar">
        <button class="issue-tab${hasTech ? ' active' : ''}" data-tab="tech">${techLabel}</button>
        <button class="issue-tab${!hasTech ? ' active' : ''}" data-tab="content">${contentLabel}</button>
      </div>
      <div class="issue-tab-pane${hasTech ? '' : ' hidden'}" data-tab="tech">
        ${hasTech ? buildIssueList(techIssues) : '<p class="no-issues">✓ No technical issues</p>'}
      </div>
      <div class="issue-tab-pane${hasTech ? ' hidden' : ''}" data-tab="content">
        ${buildIssueList(contentIssues)}
      </div>
    </div>`;
  }

  function buildIssueList(issues) {
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
    wp_security: 'WP Security', proofreading: 'Proofreading', ai_content: 'AI Content',
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

  // ══════════════════════════════════════════════════════════════════════════
  // CONTENT SCAN
  // ══════════════════════════════════════════════════════════════════════════

  async function startContentScan(url) {
    resetContentUI(false);
    contentLogLen = 0;
    currentContentScanId = null;

    contentStartBtn.disabled = true;
    contentStartBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="animation:spin 1s linear infinite"><path d="M12 2a10 10 0 1 0 10 10"/></svg> Analysing…`;

    contentProgCard.classList.remove('hidden');
    contentProgTitle.textContent = 'Analysing: ' + url;
    setContentChip('running');
    updateContentSteps({});

    let id;
    try {
      const res = await fetch('/api/content-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Server error');
      id = body.id;
      currentContentScanId = id;
    } catch (err) {
      contentLogLine('Error: ' + err.message, true);
      setContentChip('error');
      resetContentBtn();
      return;
    }

    contentPollTimer = setInterval(() => pollContent(id), 2000);
    pollContent(id);
  }

  async function pollContent(id) {
    try {
      const res = await fetch('/api/content-scan/' + id);
      if (!res.ok) return;
      const scan = await res.json();

      contentProgBar.style.width = scan.progress + '%';
      setContentChip(scan.status);
      if (scan.phases) updateContentSteps(scan.phases);
      scan.log.slice(contentLogLen).forEach(l => contentLogLine(l));
      contentLogLen = scan.log.length;

      if (scan.status === 'done' || scan.status === 'error') {
        clearInterval(contentPollTimer); contentPollTimer = null;
        resetContentBtn();
        contentProgCard.classList.add('hidden');
        if (scan.status === 'done') renderContentResults(scan);
      }
    } catch { /* network blip */ }
  }

  function renderContentResults(scan) {
    const r = scan.report;

    document.getElementById('cs-total').textContent    = r.totalIssues;
    document.getElementById('cs-pages').textContent    = r.totalPages;
    document.getElementById('cs-affected').textContent = r.pagesWithIssues;

    const avgEl = document.getElementById('cs-proof');
    if (scan.avgAiScore !== null && scan.avgAiScore !== undefined) {
      avgEl.textContent = scan.avgAiScore + '%';
      avgEl.style.color = scoreColor(scan.avgAiScore);
    } else {
      avgEl.textContent = '—';
    }

    contentPages.innerHTML = '';

    // If no scores were computed at all, API key is likely missing or invalid
    const hasAnyScores = scan.pages.some(p => p.aiScore !== null && p.aiScore !== undefined);
    if (!hasAnyScores) {
      const banner = document.createElement('div');
      banner.className = 'api-error-banner';
      banner.innerHTML = `
        <div class="api-error-icon">⚠️</div>
        <div>
          <strong>AI detection could not run</strong>
          <p>Gemini API was busy or returned an error for all pages. This is usually temporary — wait 30 seconds and try scanning again.</p>
        </div>`;
      contentPages.appendChild(banner);
    }

    const sorted = [...scan.pages].sort((a, b) => (b.aiScore ?? -1) - (a.aiScore ?? -1));
    sorted.forEach(p => contentPages.appendChild(buildContentPage(p)));

    // "Scan More Pages" button
    let moreBtn = document.getElementById('cs-more-btn');
    if (moreBtn) moreBtn.remove();
    if (scan.hasMore && scan.remainingCount > 0) {
      moreBtn = document.createElement('button');
      moreBtn.id = 'cs-more-btn';
      moreBtn.className = 'btn-secondary';
      moreBtn.style.cssText = 'margin:1.5rem auto;display:block;padding:.75rem 2rem;font-size:.95rem;';
      moreBtn.textContent = `Scan Next 2 Pages (${scan.remainingCount} remaining)`;
      moreBtn.onclick = async () => {
        moreBtn.disabled = true;
        moreBtn.textContent = 'Scanning…';
        contentProgCard.classList.remove('hidden');
        contentLogLen = scan.log.length;
        const r = await fetch('/api/content-scan/' + scan.id + '/more', { method: 'POST' });
        if (!r.ok) { moreBtn.disabled = false; moreBtn.textContent = 'Retry'; return; }
        contentPollTimer = setInterval(() => pollContent(scan.id), 2000);
      };
      contentPages.appendChild(moreBtn);
    }

    contentResults.classList.remove('hidden');
    contentResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function scoreColor(score) {
    if (score <= 20) return '#15803d';
    if (score <= 40) return '#16a34a';
    if (score <= 60) return '#b45309';
    if (score <= 80) return '#c2410c';
    return '#b91c1c';
  }

  function scoreLabel(score) {
    if (score === null || score === undefined) return { text: 'No data', cls: 'verdict-none' };
    if (score <= 15) return { text: 'Human Written',  cls: 'verdict-human' };
    if (score <= 35) return { text: 'Mostly Human',   cls: 'verdict-mostly-human' };
    if (score <= 55) return { text: 'Mixed',           cls: 'verdict-mixed' };
    if (score <= 75) return { text: 'Likely AI',       cls: 'verdict-likely-ai' };
    return             { text: 'AI Generated',         cls: 'verdict-ai' };
  }

  function buildContentPage(page) {
    const issues      = page.issues || [];
    const proofIssues = issues.filter(i => i.type === 'proofreading');
    const aiIssues    = issues.filter(i => i.type === 'ai_content');
    const score       = page.aiScore ?? null;
    const hasScore    = score !== null;
    const verdict     = page.aiVerdict || (hasScore ? scoreLabel(score).text : null);
    const { cls }     = scoreLabel(score);
    const hasIssues   = proofIssues.length > 0 || aiIssues.length > 0;

    const card = document.createElement('div');
    card.className = 'page-card content-page-card'
      + (hasIssues || (hasScore && score > 40) ? ' has-issues' : (hasScore ? ' clean' : ''));

    const scoreHtml = hasScore
      ? `<span class="verdict-badge ${esc(cls)}">${esc(verdict)}</span>
         <span class="ai-score-num" style="color:${scoreColor(score)}">${score}%</span>`
      : `<span class="verdict-badge verdict-none">No score</span>`;

    card.innerHTML = `
      <div class="page-head">
        <span class="chevron">&#9654;</span>
        <span class="page-url" title="${esc(page.url)}">${esc(page.url)}</span>
        <div class="page-right">${scoreHtml}</div>
      </div>
      <div class="page-body">
        ${buildAiScoreBar(score, verdict, cls)}
        ${buildContentIssueGroups(proofIssues, aiIssues, hasScore)}
      </div>`;

    card.querySelector('.page-head').addEventListener('click', () => card.classList.toggle('open'));
    if (hasIssues || (hasScore && score > 20)) card.classList.add('open');
    return card;
  }

  function buildAiScoreBar(score, verdict, cls) {
    if (score === null || score === undefined) {
      return `<div class="grm-panel grm-error">
        <span class="grm-error-icon">⚠️</span>
        <div class="grm-error-text">
          <strong>AI Detection Could Not Run</strong>
          <p>The Gemini API was temporarily unavailable (high demand or rate limit). This page's text was not analysed — try scanning again in a moment.</p>
        </div>
      </div>`;
    }

    const color    = scoreColor(score);
    const humanPct = 100 - score;
    // Semicircle arc: center (70,78), radius 56 → left (14,78) right (126,78)
    const circ   = parseFloat((Math.PI * 56).toFixed(1));   // ≈ 175.9
    const offset = parseFloat((circ * (1 - score / 100)).toFixed(1));

    return `<div class="grm-panel">
      <p class="grm-headline">${score}% of this text appears to be AI-generated</p>
      <div class="grm-gauge-wrap">
        <svg viewBox="0 0 140 88" class="grm-gauge-svg" aria-hidden="true">
          <path d="M 14 78 A 56 56 0 0 1 126 78"
            fill="none" stroke="#e2e8f0" stroke-width="13" stroke-linecap="round"/>
          <path d="M 14 78 A 56 56 0 0 1 126 78"
            fill="none" stroke="${color}" stroke-width="13" stroke-linecap="round"
            stroke-dasharray="${circ}" stroke-dashoffset="${offset}"/>
          <text x="70" y="67" text-anchor="middle"
            font-size="24" font-weight="800" fill="${color}"
            font-family="Inter,-apple-system,sans-serif">${score}%</text>
        </svg>
      </div>
      <div class="grm-legend">
        <div class="grm-legend-row">
          <span class="grm-dot" style="background:${color}"></span>
          <span class="grm-legend-label">Resembles AI text</span>
          <b class="grm-legend-val">${score}%</b>
        </div>
        <div class="grm-legend-row">
          <span class="grm-dot" style="background:#22c55e"></span>
          <span class="grm-legend-label">No AI text patterns found</span>
          <b class="grm-legend-val">${humanPct}%</b>
        </div>
      </div>
    </div>`;
  }

  function buildContentIssueGroups(proofIssues, aiIssues, hasScore = false) {
    if (!proofIssues.length && !aiIssues.length) {
      // gauge / error panel already handles the messaging
      return '';
    }

    let html = '';

    if (proofIssues.length) {
      html += `<div class="content-group">
        <div class="content-group-header">
          <span class="cgroup-icon">✏️</span> Proofreading
          <span class="cgroup-count">${proofIssues.length}</span>
        </div>
        ${buildIssueList(proofIssues)}
      </div>`;
    }

    if (aiIssues.length) {
      const sentenceCards = aiIssues.map(i => {
        const text   = i._text   || i._quote || null;
        const reason = i._reason || i._signal || 'AI Pattern';
        const fix    = i._fix    || i._suggestion || null;
        return `<div class="ai-sentence-card">
          ${text ? `<div class="ai-sentence-text">${esc(text)}</div>` : ''}
          <div class="ai-sentence-meta">
            <span class="ai-reason-tag">${esc(reason)}</span>
          </div>
          ${fix ? `<div class="ai-sentence-fix"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> ${esc(fix)}</div>` : ''}
        </div>`;
      }).join('');

      html += `<div class="content-group">
        <div class="content-group-header">
          <span class="cgroup-icon">🤖</span> AI-Written Sentences
          <span class="cgroup-count ai">${aiIssues.length} detected</span>
        </div>
        <div class="ai-sentence-list">${sentenceCards}</div>
      </div>`;
    }

    return html;
  }

  function updateContentSteps(phases) {
    document.querySelectorAll('#content-scan-steps .step[data-phase]').forEach(el => {
      const state = phases[el.dataset.phase] || 'pending';
      el.dataset.state = state;
      const line = el.nextElementSibling;
      if (line?.classList.contains('step-line')) {
        line.style.background = (state === 'done') ? '#22c55e' : '';
      }
    });
  }

  function setContentChip(s) { contentChip.textContent = s; contentChip.className = 'chip ' + s; }

  function resetContentBtn() {
    contentStartBtn.disabled = false;
    contentStartBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg> Analyse Content`;
  }

  function resetContentUI(clearUrl = true) {
    if (contentPollTimer) { clearInterval(contentPollTimer); contentPollTimer = null; }
    contentProgCard.classList.add('hidden');
    contentResults.classList.add('hidden');
    contentLog.innerHTML = '';
    contentProgBar.style.width = '0%';
    resetContentBtn();
    updateContentSteps({});
    if (clearUrl) { contentUrlInput.value = ''; currentContentScanId = null; }
    contentLogLen = 0;
  }

  function contentLogLine(text, err = false) {
    const d = document.createElement('div');
    d.className = 'log-line';
    if (err) d.style.color = '#f87171';
    d.textContent = text;
    contentLog.appendChild(d);
    contentLog.scrollTop = contentLog.scrollHeight;
  }

  // ══════════════════════════════════════════════════════════════════════════

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  const style = document.createElement('style');
  style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
})();
