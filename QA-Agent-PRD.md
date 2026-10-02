
# Product Requirements Document
## AI-Powered Website QA Agent

**Owner:** Hunain
**Status:** Draft v1.0
**Date:** July 2026

---

## 1. Overview

A locally-run, browser-based tool that automatically QA-tests a website (local dev site or live URL) by driving a real browser, crawling pages, running automated checks, and using Claude (vision) to catch visual/layout issues a script can't. The user enters a URL in a web dashboard, the tool crawls the site in a real Chromium browser, and returns a structured, severity-ranked report with screenshots.

Built for someone who both designs/builds WordPress sites and writes code for them — so it needs to handle `localhost` dev environments as easily as live production URLs.

---

## 2. Problem Statement

Manual QA of a website (checking every page on every device size, every link, every form, every image) is slow and easy to do inconsistently, especially across many client sites. There's no single tool today that combines:
- Real browser automation (not just a static HTML linter)
- Multi-viewport visual checks
- AI-level visual judgment (not just rule-based checks)
- Works equally well on `localhost` and live domains

---

## 3. Goals

- One-click QA scan of any website given a URL (local or live)
- Catch functional issues: broken links, broken forms, JS errors, failed page loads
- Catch visual issues: layout breaks, overlapping elements, responsiveness problems across mobile/tablet/desktop
- Catch on-page SEO basics: missing titles/meta descriptions/H1s, missing alt text
- Present results as a clear, severity-ranked report (Critical / Major / Minor) with screenshots as evidence
- Run entirely on the user's machine so local dev sites are reachable

## 3.1 Non-Goals (v1)

- Not a full accessibility audit tool (e.g., not WCAG-certifying)
- Not a performance/Lighthouse replacement (no deep Core Web Vitals scoring in v1)
- Not a cross-browser engine comparison (Chromium only in v1; Firefox/WebKit later)
- Not multi-user / cloud-hosted in v1 — single user, local tool
- Does not auto-fix issues, only reports them

---

## 4. Target User

- Primary: Hunain — content strategist + WordPress/code builder who needs to QA client sites (local dev + live) repeatedly
- Secondary (future): other Creative Squad team members QA-ing client deliverables before handoff

---

## 5. User Flow

1. User runs the tool locally (`npm start`) → dashboard opens at `localhost:4000`
2. User pastes a URL e.g. `http://localhost:8888/clientsite` and sets max pages to crawl
3. User clicks **Start Scan**
4. Dashboard shows a live progress log: pages being visited, checks running, AI review in progress
5. On completion, user sees:
   - Summary: total pages scanned, total issues by severity
   - Per-page breakdown: issues list + screenshots (mobile/tablet/desktop)
6. User can filter by severity/type, expand a page to see full screenshots, and re-run a scan

---

## 6. Functional Requirements

### 6.1 Crawling
- Given a starting URL, crawl same-origin pages via discovered `<a href>` links
- Configurable max pages per scan (default 12, cap 40 for v1)
- Skip already-visited URLs; normalize URLs (strip hash fragments)
- Must work against `http://localhost:*` and any public domain

### 6.2 Functional Checks (per page)
- HTTP status code; flag 4xx/5xx as Critical
- Page load failures/timeouts → Critical
- JavaScript console errors and page errors → Major
- Broken links (internal + external, sampled up to 120 per scan) → Major

### 6.3 Visual/Responsive Checks
- Full-page screenshots at 3 breakpoints: mobile (390×844), tablet (820×1180), desktop (1440×900)
- Desktop screenshot sent to Claude for AI visual review
- AI flags: overlapping elements, broken/misaligned layout, clipped text or images, inconsistent spacing, low-contrast/unreadable text, broken or placeholder images
- AI must return structured JSON only (severity + message), no false-positive padding — return empty if page looks fine

### 6.4 SEO/Content Checks (per page)
- Missing/empty `<title>` → Major; title >60 chars → Minor
- Missing meta description → Minor
- Missing H1 → Major; multiple H1s → Minor
- Images missing `alt` attribute → Minor (accessibility)

### 6.5 Reporting
- Each issue tagged with: severity (`critical` / `major` / `minor`), type (e.g. `seo`, `visual`, `broken_link`, `console_error`), message, and source URL
- Top-level summary: total pages, total issues, counts per severity
- Issues sorted critical → major → minor
- Screenshots viewable inline per page, per viewport

### 6.6 Dashboard UI
- URL input + max-pages input + Start Scan button
- Live status/progress indicator with scrolling log of current activity
- Results view: summary cards (severity counts) + collapsible per-page sections
- Severity shown with consistent color coding throughout

---

## 7. Non-Functional Requirements

- Runs locally via Node.js; no external hosting required
- Must not require the user's Anthropic API key to be hardcoded — read from `.env`
- Scan of ~12 pages should complete in a reasonable time (target: under ~5 minutes depending on site size and network)
- Tool should degrade gracefully: a single page failing to load should not crash the whole scan
- No data leaves the user's machine except: page screenshots sent to the Anthropic API for visual analysis

---

## 8. Technical Architecture

| Layer | Technology |
|---|---|
| Browser automation | Playwright (Chromium) |
| Backend/API | Node.js + Express |
| AI visual analysis | Claude API (`claude-sonnet-4-6`), vision input |
| Frontend | Vanilla HTML/CSS/JS dashboard, polling-based status updates |
| Data store | In-memory (per scan session); no DB in v1 |

**Flow:** Dashboard → `POST /api/scan {url, maxPages}` → background crawl job → Playwright visits each page (screenshots, console listeners, DOM extraction) → link-check pass → per-page screenshot sent to Claude for visual QA → results aggregated → `GET /api/scan/:id` polled by dashboard until `status: done`.

---

## 9. Data Model (per scan)

```
Scan {
  id, url, status: running|analyzing|done|error,
  progress: 0-100,
  log: string[],
  pages: PageResult[],
  report: { totalPages, totalIssues, counts, issues[] }
}

PageResult {
  url, status (HTTP code),
  issues: Issue[],
  screenshots: { mobile, tablet, desktop } (base64),
  seo: { title, desc, h1s, totalImages, imgsWithoutAlt, links[] }
}

Issue {
  severity: critical|major|minor,
  type: seo|visual|accessibility|broken_link|console_error|http_error|load_failure,
  message, details?, url
}
```

---

## 10. Success Metrics

- Time to QA a 10–15 page client site reduced from manual hours to a single automated scan
- Critical/major issues (broken links, broken layouts, missing SEO basics) caught before client handoff, not after
- Tool reliably runs against both `localhost` dev sites and live domains without configuration changes

---

## 11. Phased Roadmap

**Phase 1 (MVP — this build)**
- Single-domain crawl, functional + SEO + visual AI checks, severity-ranked report, local dashboard

**Phase 2**
- PDF/exportable report (for sharing with clients)
- Form-submission testing (auto-fill and submit test forms safely)
- Configurable check rules per client (e.g. brand-specific banned words, required footer elements)
- Scan history (persist past scans, compare over time)

**Phase 3**
- Multi-browser support (Firefox/WebKit via Playwright)
- Performance/Core Web Vitals scoring
- Scheduled recurring scans for live client sites
- Multi-user mode for the Creative Squad team

---

## 12. Risks / Open Questions

- AI visual review cost scales with number of pages/screenshots sent to Claude — needs sensible page caps (handled via `maxPages`)
- Sites requiring login/auth aren't crawlable in v1
- Single-page apps with client-side routing may need a "wait for navigation" strategy beyond `networkidle`
- False positives from AI visual review should be monitored and prompt-tuned over time
