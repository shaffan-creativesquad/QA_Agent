'use strict';

async function checkWordPressSecurity(siteUrl) {
  const issues = [];
  const origin = new URL(siteUrl).origin;

  async function probe(path) {
    try {
      const res = await fetch(`${origin}${path}`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'QA-Agent/1.0' },
      });
      return res.status;
    } catch { return null; }
  }

  const [xmlrpc, readme, license, wpLogin] = await Promise.all([
    probe('/xmlrpc.php'),
    probe('/readme.html'),
    probe('/license.txt'),
    probe('/wp-login.php'),
  ]);

  if (xmlrpc === 200 || xmlrpc === 405) {
    issues.push({
      type: 'wp_security',
      message: `xmlrpc.php is publicly accessible (HTTP ${xmlrpc}) — a common WordPress brute-force and DDoS attack vector. Disable it via .htaccess or a security plugin.`,
      url: `${origin}/xmlrpc.php`,
    });
  }

  if (readme === 200) {
    issues.push({
      type: 'wp_security',
      message: `readme.html is accessible — reveals the exact WordPress version to attackers. Delete this file or block it via .htaccess.`,
      url: `${origin}/readme.html`,
    });
  }

  if (license === 200) {
    issues.push({
      type: 'wp_security',
      message: `license.txt is accessible — can expose WordPress version information. Delete or block it.`,
      url: `${origin}/license.txt`,
    });
  }

  if (wpLogin === 200) {
    issues.push({
      type: 'wp_security',
      message: `Default WordPress login page /wp-login.php is accessible — consider changing the login URL using a plugin (e.g. WPS Hide Login) to reduce brute-force attacks.`,
      url: `${origin}/wp-login.php`,
    });
  }

  return issues;
}

module.exports = { checkWordPressSecurity };
