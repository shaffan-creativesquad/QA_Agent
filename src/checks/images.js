'use strict';

async function checkImageSizes(imageUrls, pageUrl, thresholdBytes = 200 * 1024) {
  const issues = [];

  await Promise.all(imageUrls.slice(0, 40).map(async (imgUrl) => {
    try {
      const res = await fetch(imgUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'QA-Agent/1.0' },
      });
      const len = parseInt(res.headers.get('content-length') || '0', 10);
      if (!len || len <= thresholdBytes) return;

      const kb = Math.round(len / 1024);
      const sizeStr = kb >= 1000 ? `${(kb / 1024).toFixed(1)}MB` : `${kb}KB`;
      let shortUrl = imgUrl;
      try { shortUrl = new URL(imgUrl).pathname; } catch {}

      issues.push({
        type: 'performance',
        message: `Large image (${sizeStr}) — compress before deploying: ${shortUrl}`,
        url: pageUrl,
      });
    } catch { /* skip unreachable images */ }
  }));

  return issues;
}

module.exports = { checkImageSizes };
