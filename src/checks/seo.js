'use strict';

const PLACEHOLDER_IMG_HOSTS = [
  'placeholder.com', 'via.placeholder.com', 'placehold.it', 'placeimg.com',
  'picsum.photos', 'lorempixum.com', 'dummyimage.com', 'fillmurray.com',
  'placekitten.com', 'loremflickr.com', 'baconmockup.com',
];

async function checkPage(page, pageUrl) {
  const issues = [];

  const data = await page.evaluate((placeholderHosts) => {
    function hidden(el) {
      const s = getComputedStyle(el);
      return s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0' || el.hidden;
    }
    function hasHandler(el) {
      return !!(el.onclick || el.getAttribute('onclick') ||
        el.getAttribute('data-action') || el.getAttribute('data-href') ||
        el.getAttribute('data-toggle') || el.getAttribute('data-target') ||
        el.getAttribute('data-modal') || el.getAttribute('data-bs-toggle') ||
        el.getAttribute('data-bs-target') || el.getAttribute('v-on:click') ||
        el.getAttribute('@click') || el.getAttribute('ng-click'));
    }
    function parentHasHandler(el, depth = 4) {
      let node = el.parentElement;
      for (let i = 0; i < depth && node; i++, node = node.parentElement) {
        if (hasHandler(node)) return true;
      }
      return false;
    }
    function visText(el) {
      return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // ── Placeholder / dummy text ────────────────────────────────────────────
    const loremIssues = [];
    const LOREM_PATTERNS = [/lorem ipsum/i, /dolor sit amet/i, /\[placeholder\]/i,
      /your text here/i, /insert content here/i, /dummy text/i, /sample text/i];
    const WP_DEFAULTS = [/^hello world[!.]?$/i, /just another wordpress site/i, /^sample page$/i];

    document.querySelectorAll('p, li, h1, h2, h3, h4, td, div, span').forEach(el => {
      if (hidden(el) || el.querySelectorAll('p, div').length > 0) return; // skip containers
      const t = visText(el);
      if (t.length < 4) return;
      for (const pat of LOREM_PATTERNS) {
        if (pat.test(t)) { loremIssues.push(t.slice(0, 100)); break; }
      }
    });
    // WP defaults in title or body
    const pageTitle = document.title || '';
    const bodyText = (document.body?.textContent || '');
    for (const pat of WP_DEFAULTS) {
      if (pat.test(pageTitle) || pat.test(bodyText)) {
        loremIssues.push(`Default WordPress content: "${pageTitle || '(body text)'}`);
      }
    }

    // ── Images ─────────────────────────────────────────────────────────────
    const brokenImgs = [];
    const placeholderImgs = [];
    const missingAlt = [];

    document.querySelectorAll('img').forEach(img => {
      if (hidden(img)) return;
      const src = (img.getAttribute('src') || img.src || '').toLowerCase();
      if (!src || src.startsWith('data:')) return;

      const isPlaceholder = placeholderHosts.some(h => src.includes(h));
      const isBroken = img.complete && img.naturalWidth === 0;

      if (isBroken) brokenImgs.push(src.slice(0, 120));
      else if (isPlaceholder) placeholderImgs.push(src.slice(0, 120));
      if (!img.hasAttribute('alt')) missingAlt.push(src.slice(0, 80));
    });

    // ── Buttons ────────────────────────────────────────────────────────────
    const emptyBtns = [];
    const deadBtns = [];

    document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]').forEach(btn => {
      if (hidden(btn)) return;
      const text = (btn.textContent || btn.value || '').trim();
      const label = btn.getAttribute('aria-label') || btn.getAttribute('title') || '';
      const hasIcon = !!(btn.querySelector('svg, img, i[class], span[class*="icon"]'));

      if (!text && !label && !hasIcon) {
        emptyBtns.push(btn.tagName.toLowerCase());
        return;
      }

      // Detect disconnected: has action text, no handler, not in form, no data-* attributes
      const actionRx = /^(submit|send|save|buy|order|add|delete|confirm|cancel|apply|search|download|upload|login|sign up|register|get started|contact|book|reserve)/i;
      const hasDataAttr = [...btn.attributes].some(a => a.name.startsWith('data-')) ||
        parentHasHandler(btn, 8);
      if (text && actionRx.test(text) && !hasHandler(btn) && !hasDataAttr && !btn.closest('form')) {
        deadBtns.push(text.slice(0, 60));
      }
    });

    // ── Links ──────────────────────────────────────────────────────────────
    const deadLinks = [];
    const emptyLinks = [];
    const allHrefs = [];

    document.querySelectorAll('a').forEach(a => {
      if (hidden(a)) return;
      const href = a.getAttribute('href') || '';
      const text = visText(a);
      const ariaLabel = a.getAttribute('aria-label') || '';

      // Collect all hrefs for link-checking
      if (href && !href.startsWith('#') && !href.startsWith('mailto:') &&
          !href.startsWith('tel:') && !href.startsWith('javascript:') && !href.startsWith('data:')) {
        allHrefs.push(href);
      }

      // Dead link — only flag if clearly unintentional
      const isDead = href === '#' || href === '' ||
        href === 'javascript:void(0)' || href === 'javascript:;' || href === 'javascript:void(0);';
      if (isDead && text.length > 1) {
        // Skip: inside nav/menu (JS routing is intentional there)
        const inNav = !!(a.closest('nav, [role="navigation"], .menu, .nav, .navigation, .navbar, .wp-menu-item, header'));
        if (inNav) return;

        // Skip: element or any ancestor has data-* attribute (JS framework pattern)
        function hasDataAttr(el, depth = 6) {
          let node = el;
          for (let i = 0; i < depth && node && node !== document.body; i++, node = node.parentElement) {
            if ([...node.attributes].some(a => a.name.startsWith('data-'))) return true;
          }
          return false;
        }
        if (hasDataAttr(a)) return;

        // Skip: parent chain has a JS handler (check deeper — event delegation)
        if (hasHandler(a) || parentHasHandler(a, 8)) return;

        deadLinks.push(text.slice(0, 60));
      }

      // Invisible link
      if (!isDead && href && !text && !ariaLabel && !a.querySelector('img[alt]:not([alt=""])')) {
        emptyLinks.push(href.slice(0, 80));
      }
    });

    // ── Forms ──────────────────────────────────────────────────────────────
    const formProblems = [];
    document.querySelectorAll('form').forEach((form, idx) => {
      const fields = [...form.querySelectorAll(
        'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, select'
      )];
      if (!fields.length) return;

      const hasSubmit = !!form.querySelector('[type=submit], button:not([type=button]):not([type=reset])');
      const hasAction = !!(form.getAttribute('action') && form.getAttribute('action') !== '#');
      const hasJsHandler = !!(form.onsubmit || form.getAttribute('onsubmit') ||
        form.getAttribute('@submit') || form.getAttribute('data-ajax'));
      const unlabelled = fields.filter(f => {
        if (f.getAttribute('aria-label') || f.getAttribute('aria-labelledby')) return false;
        if (f.id && document.querySelector(`label[for="${f.id}"]`)) return false;
        if (f.closest('label')) return false;
        return true;
      }).length;

      formProblems.push({
        index: idx + 1,
        fields: fields.length,
        hasSubmit,
        disconnected: hasSubmit && !hasAction && !hasJsHandler,
        noSubmit: !hasSubmit,
        unlabelled,
      });
    });

    // ── HTML ───────────────────────────────────────────────────────────────
    const allIds = [...document.querySelectorAll('[id]')].map(e => e.id).filter(Boolean);
    const dupIds = [...new Set(allIds.filter((id, i) => allIds.indexOf(id) !== i))];

    const consoleOnly = [...document.querySelectorAll('div[onclick], span[onclick]')].filter(el => {
      const role = el.getAttribute('role') || '';
      return !role || role === 'none' || role === 'presentation';
    }).length;

    // ── WordPress detection ────────────────────────────────────────────────
    const generatorMeta = document.querySelector('meta[name="generator"]');
    const generatorContent = generatorMeta ? (generatorMeta.getAttribute('content') || '') : '';
    const wpDetected = /wordpress/i.test(generatorContent);
    const wpVersion = wpDetected ? (generatorContent.match(/WordPress\s*([\d.]+)/i)?.[1] || '') : '';

    // ── Image URLs for size audit ──────────────────────────────────────────
    const imageUrls = [];
    document.querySelectorAll('img[src]').forEach(img => {
      const src = img.getAttribute('src') || '';
      if (src && !src.startsWith('data:')) imageUrls.push(src);
    });

    return {
      loremIssues: [...new Set(loremIssues)].slice(0, 6),
      brokenImgs, placeholderImgs,
      missingAlt: missingAlt.length,
      emptyBtns, deadBtns: deadBtns.slice(0, 8),
      deadLinks: deadLinks.slice(0, 10), emptyLinks: emptyLinks.slice(0, 5),
      formProblems, dupIds: dupIds.slice(0, 6), consoleOnly,
      links: [...new Set(allHrefs)],
      wpDetected, wpVersion,
      imageUrls: [...new Set(imageUrls)].slice(0, 50),
    };
  }, PLACEHOLDER_IMG_HOSTS);

  // ── Build issues (no severity) ─────────────────────────────────────────────

  for (const t of data.loremIssues) {
    issues.push({ type: 'placeholder', message: `Placeholder text found: "${t}"`, url: pageUrl });
  }

  for (const src of data.brokenImgs) {
    issues.push({ type: 'broken_image', message: `Broken image — file not loading: ${src}`, url: pageUrl });
  }
  for (const src of data.placeholderImgs) {
    issues.push({ type: 'placeholder', message: `Placeholder image from dummy service: ${src}`, url: pageUrl });
  }
  if (data.missingAlt > 0) {
    issues.push({ type: 'image', message: `${data.missingAlt} image(s) missing alt text`, url: pageUrl });
  }

  if (data.emptyBtns.length > 0) {
    issues.push({ type: 'button', message: `${data.emptyBtns.length} button(s) have no text, label, or icon — blank clickable area`, url: pageUrl });
  }
  for (const text of data.deadBtns) {
    issues.push({ type: 'button', message: `Button "${text}" looks like an action button but has no click handler or form connection`, url: pageUrl });
  }

  for (const text of data.deadLinks) {
    issues.push({ type: 'dead_link', message: `Dead link with no destination: "${text}" (href="#" or empty, no JS handler)`, url: pageUrl });
  }
  if (data.emptyLinks.length > 0) {
    issues.push({ type: 'dead_link', message: `${data.emptyLinks.length} invisible link(s) — has href but no text (broken anchor)`, url: pageUrl });
  }

  for (const f of data.formProblems) {
    if (f.disconnected) {
      issues.push({ type: 'form', message: `Form ${f.index}: Submit button exists but form has no action URL and no JS handler — clicking submit does nothing`, url: pageUrl });
    }
    if (f.noSubmit) {
      issues.push({ type: 'form', message: `Form ${f.index}: ${f.fields} input field(s) but no submit button`, url: pageUrl });
    }
    if (f.unlabelled > 0) {
      issues.push({ type: 'form', message: `Form ${f.index}: ${f.unlabelled} input field(s) have no label`, url: pageUrl });
    }
  }

  if (data.dupIds.length > 0) {
    issues.push({ type: 'html', message: `Duplicate element IDs (breaks JS/CSS selectors): ${data.dupIds.map(i => '#' + i).join(', ')}`, url: pageUrl });
  }
  if (data.consoleOnly > 0) {
    issues.push({ type: 'html', message: `${data.consoleOnly} clickable div/span without role="button" (not keyboard-accessible, may not fire in all browsers)`, url: pageUrl });
  }

  if (data.wpDetected) {
    const versionMsg = data.wpVersion
      ? `WordPress version ${data.wpVersion} exposed in page source via generator meta tag — remove it to reduce targeted attack risk.`
      : 'WordPress generator meta tag is publicly visible — remove it to avoid version fingerprinting.';
    issues.push({ type: 'security', message: versionMsg, url: pageUrl });
  }

  return { links: data.links, issues, wpDetected: data.wpDetected, imageUrls: data.imageUrls };
}

module.exports = { checkSEO: checkPage };
