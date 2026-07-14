'use strict';

// Unified storage — uses Upstash Redis when env vars are set, falls back to in-memory for local dev.

const SCAN_TTL = 86400;       // 24 hours
const SS_TTL   = 21600;       // 6 hours (screenshots)

// ── In-memory fallback (local dev) ────────────────────────────────────────────
const memScans       = new Map();
const memScreenshots = new Map();

// ── Upstash Redis ─────────────────────────────────────────────────────────────
let _redis = null;
function getRedis() {
  if (!_redis) {
    const { Redis } = require('@upstash/redis');
    _redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return _redis;
}

const hasRedis = () =>
  !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

// Set → Array before JSON serialise, reverse on deserialise
function pack(scan) {
  const d = { ...scan };
  if (d._visitedUrls instanceof Set) {
    d._visitedUrlsArr = [...d._visitedUrls];
    delete d._visitedUrls;
  }
  // Strip large temporary fields before persisting
  d.pages = (d.pages || []).map(({ _desktopBase64, ...rest }) => rest);
  return d;
}

function unpack(d) {
  if (!d) return null;
  if (d._visitedUrlsArr) {
    d._visitedUrls = new Set(d._visitedUrlsArr);
    delete d._visitedUrlsArr;
  }
  return d;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getScan(id) {
  if (hasRedis()) return unpack(await getRedis().get(`scan:${id}`));
  return memScans.get(id) ?? null;
}

async function setScan(id, scan) {
  if (hasRedis()) {
    await getRedis().set(`scan:${id}`, pack(scan), { ex: SCAN_TTL });
    return;
  }
  memScans.set(id, scan);
}

async function getScreenshot(key) {
  if (hasRedis()) {
    const b64 = await getRedis().get(`ss:${key}`);
    return b64 ? Buffer.from(b64, 'base64') : null;
  }
  return memScreenshots.get(key) ?? null;
}

async function setScreenshot(key, buf) {
  if (hasRedis()) {
    await getRedis().set(`ss:${key}`, buf.toString('base64'), { ex: SS_TTL });
    return;
  }
  memScreenshots.set(key, buf);
}

module.exports = { getScan, setScan, getScreenshot, setScreenshot };
