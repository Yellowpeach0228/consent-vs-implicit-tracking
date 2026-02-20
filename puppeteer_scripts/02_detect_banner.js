/**
 * 02_detect_banner.js
 * ------------------------------------
 * Minimal + Fast + Robust timeout handling (no longer throws site timeouts to top level causing Fatal).
 * Key updates (compared to V1.0):
 *  - Site task timeout (TASK_TIMEOUT) is gracefully captured and written to disk, won't trigger process-level Fatal.
 *  - page can be closed in finally on timeout/exception, avoiding handle leaks.
 *  - Added lightweight preflight (favicon HEAD/GET, 2.5s) to sort URL variants, reducing blind timeouts.
 *  - Still maintains "single fast render + strong signal matching" to maximize throughput.
 *
 * Run example:
 *   node 02_detect_banner_simple.js --input=./output/valid_sites.csv --concurrency=12
 */

const fs = require('fs');
const path = require('path');

// -------- CLI --------
function parseArgv() {
  const args = process.argv.slice(2);
  const out = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--no-')) out[a.slice(5)] = false;
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  const num = k => (k in out ? Number(out[k]) : undefined);
  const bool = (k, d) => (k in out ? (String(out[k]).toLowerCase() !== 'false') : d);
  const str = (k, d) => (k in out ? String(out[k]) : d);

  return {
    input: str('input', ''),
    urls: str('urls', ''),
    output: str('output', path.resolve('./output/simple_results.csv')),
    suspects: str('suspects', path.resolve('./output/simple_suspects.csv')),
    concurrency: num('concurrency') || 12,
    navTimeout: num('navTimeout') || 15000,
    maxTaskTime: num('maxTaskTime') || 45000,
    headless: str('headless', 'new'),
    blockHeavy: bool('blockHeavy', true),
    locale: str('locale', 'en-US'),
    timezoneId: str('timezoneId', 'Europe/Amsterdam'),
  };
}
const argv = parseArgv();
for (const d of [path.dirname(argv.output), path.dirname(argv.suspects)]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// -------- CSV --------
function csvEscape(v) { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function appendCsv(file, obj, headerOrder) {
  const needHeader = !fs.existsSync(file);
  const cols = headerOrder || Object.keys(obj);
  if (needHeader) fs.appendFileSync(file, cols.join(',') + '\n', 'utf-8');
  const row = cols.map(k => csvEscape(obj[k])).join(',') + '\n';
  fs.appendFileSync(file, row, 'utf-8');
}

// -------- Puppeteer --------
let puppeteer;
try { puppeteer = require('puppeteer'); } catch(_) {
  try { puppeteer = require('puppeteer-core'); } catch(e) {
    console.error('Please install "puppeteer" or "puppeteer-core".');
    process.exit(1);
  }
}

// -------- Utils --------
function unique(arr) { return Array.from(new Set(arr)); }
function runWithTaskTimeout(taskFactory, label, ms) {
  let id;
  const timeout = new Promise((_, rej) => {
    id = setTimeout(() => { const e = new Error(`Task timeout for ${label}`); e.code='TASK_TIMEOUT'; rej(e); }, ms);
  });
  const task = (async () => taskFactory())();
  return Promise.race([task, timeout]).finally(() => clearTimeout(id));
}
function buildVariants(raw) {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    const bare = u.hostname.replace(/^www\./, '');
    return unique([`https://${bare}/`,`https://www.${bare}/`,`http://${bare}/`,`http://www.${bare}/`]);
  } catch {
    const host = url.replace(/^https?:\/\//,'').split('/')[0];
    const bare = host.replace(/^www\./,'');
    return unique([`https://${bare}/`,`http://${bare}/`]);
  }
}
// Lightweight preflight: 2.5s HEAD/GET favicon
async function preflight(variants, timeoutMs = 2500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (const base of variants) {
      const target = (base.endsWith('/') ? base : base + '/') + 'favicon.ico';
      try {
        const res = await fetch(target, { method: 'HEAD', signal: controller.signal });
        if ((res && res.status) ? res.status < 500 : false) { return { ok: true, first: base }; }
      } catch {
        try {
          const res2 = await fetch(target, { method: 'GET', signal: controller.signal });
          if ((res2 && res2.status) ? res2.status < 500 : false) { return { ok: true, first: base }; }
        } catch {}
      }
    }
    return { ok: false };
  } finally { try { clearTimeout(id); } catch {} }
}

// Simple interception (block image/media/font)
const _blocker = new WeakMap();
async function enableLightBlock(page, { blockHeavy = true } = {}) {
  if (!blockHeavy || _blocker.has(page)) return;
  const handler = req => {
    try {
      const t = req.resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return req.abort();
      return req.continue();
    } catch { try { req.continue(); } catch {} }
  };
  try { await page.setRequestInterception(true); } catch { try { await page.setRequestInterception(true); } catch {} }
  page.on('request', handler);
  _blocker.set(page, handler);
}
async function disableLightBlock(page) {
  const h = _blocker.get(page);
  if (!h) return;
  try { page.off('request', h); } catch {}
  _blocker.delete(page);
  try { await page.setRequestInterception(false); } catch {}
}

// -------- Ultra-simple detection --------
const CONTEXT_WORDS = ['cookie','cookies','consent','gdpr','privacy','privacy policy','we use cookies','your cookie','use cookies','privacy','privacy policy','by agreeing','by continuing'];
const ACTION_WORDS = ['accept','accept all','agree','allow','ok','okay','got it','continue','yes','reject','decline','agree','accept','allow','i understand','continue','ok','reject'];
const CMP_SELECTORS = ['#onetrust-banner-sdk','#onetrust-consent-sdk','#CybotCookiebotDialog','.qc-cmp2-container','#truste-consent-content','[id*="consent"]','[class*="consent"]','[id*="cookie"]','[class*="cookie"]','[data-cookiebanner]','[aria-label*="cookie" i]'];

function norm(s){ return (s||'').replace(/\s+/g,' ').trim(); }
function visible(el){
  const st = window.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return !(!el || st.visibility==='hidden' || st.display==='none' || Number(st.opacity)===0 || r.width<=0 || r.height<=0);
}
async function quickDetect(page){
  return await page.evaluate(({CONTEXT_WORDS, ACTION_WORDS, CMP_SELECTORS}) => {
    const body = document.body || document.documentElement;
    const text = (body.innerText || '').toLowerCase();
    const contextHit = CONTEXT_WORDS.some(w => text.includes(String(w).toLowerCase()));
    const hasTCF = typeof window.__tcfapi === 'function';
    const cmpHit = CMP_SELECTORS.some(sel => !!document.querySelector(sel));

    let btns = 0;
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
    for (const el of nodes) {
      try {
        if (!visible(el)) continue;
        const t = norm(el.innerText || el.getAttribute('aria-label') || el.value || '').toLowerCase();
        if (!t || t.length > 40) continue;
        if (ACTION_WORDS.some(w => t.includes(String(w).toLowerCase()))) btns++;
      } catch {}
    }
    const consentBased = hasTCF || cmpHit || (contextHit && btns > 0);
    return { consentBased, btns, contextHit, hasTCF, cmpHit };
  }, {CONTEXT_WORDS, ACTION_WORDS, CMP_SELECTORS});
}

// -------- Single site task (graceful timeout capture + page cleanup) --------
async function processSite(browser, rawUrl, idx) {
  const row = { index: idx, url: rawUrl, model: 'implicit', banner: 0, btns: 0, context_hit: 0, tcf: 0, cmp: 0, error: '', final_url: '', notes: '' };
  let page;
  try {
    page = await browser.newPage();
    // Full site workflow + task timeout
    const result = await runWithTaskTimeout(async () => {
      try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
        try { await page.emulateTimezone(argv.timezoneId); } catch {}
        try { await page.setExtraHTTPHeaders({ 'Accept-Language': argv.locale + ',en;q=0.9' }); } catch {}
        if (argv.blockHeavy) await enableLightBlock(page, { blockHeavy: true });
        if (typeof page.setDefaultNavigationTimeout === 'function') page.setDefaultNavigationTimeout(argv.navTimeout);

        const variants = buildVariants(rawUrl);
        const pf = await preflight(variants, 2500);
        const ordered = pf.ok ? [pf.first, ...variants.filter(v => v !== pf.first)] : variants;

        let ok = false; let finalUrl = '';
        for (const v of ordered) {
          try { await page.goto(v, { waitUntil: 'domcontentloaded', timeout: argv.navTimeout }); ok = true; finalUrl = v; break; } catch {}
        }
        if (!ok) { row.error = 'NAV_FAIL'; return row; }
        row.final_url = finalUrl;

        const res = await quickDetect(page);
        row.btns = res.btns;
        row.context_hit = res.contextHit ? 1 : 0;
        row.tcf = res.hasTCF ? 1 : 0;
        row.cmp = res.cmpHit ? 1 : 0;
        if (res.consentBased) { row.model = 'consent-based'; row.banner = 1; }
        return row;
      } catch (e) {
        row.error = (e && e.code) ? e.code : (e && e.message) ? e.message : 'ERROR';
        return row;
      }
    }, rawUrl, argv.maxTaskTime);
    return result;
  } catch (e) {
    // Task timeout / other exceptions: gracefully write to disk, don't throw to top level
    row.error = (e && e.code) ? e.code : 'TASK_ERROR';
    return row;
  } finally {
    try { await page?.close(); } catch {}
  }
}

// -------- Concurrency pool --------
async function asyncPool(limit, arr, iter) {
  const ret = []; const executing = new Set();
  for (const item of arr) {
    const p = Promise.resolve().then(() => iter(item, ret.length + 1));
    ret.push(p); executing.add(p);
    p.finally(() => executing.delete(p));
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.all(ret);
}

// -------- Input --------
function loadTargets() {
  const out = [];
  if (argv.urls) out.push(...argv.urls.split(',').map(s => s.trim()).filter(Boolean));
  if (argv.input && fs.existsSync(argv.input)) {
    const raw = fs.readFileSync(argv.input, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.split(',')[0].trim();
      if (t && t !== 'url' && !t.startsWith('#')) out.push(t);
    }
  }
  return unique(out);
}

// -------- Main process --------
(async () => {
  const targets = loadTargets();
  if (targets.length === 0) { console.error('No targets. Use --urls or --input'); process.exit(1); }

  const browser = await puppeteer.launch({
    headless: argv.headless,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--ignore-certificate-errors'],
    defaultViewport: { width: 1280, height: 800 },
  });

  console.log(`SimpleFast v1.1: ${targets.length} sites | headless=${argv.headless} | CONC=${argv.concurrency} | NAV_TIMEOUT=${argv.navTimeout} | MAX=${argv.maxTaskTime}`);

  const header = ['index','url','model','banner','btns','context_hit','tcf','cmp','error','final_url','notes'];
  const start = Date.now();

  const results = await asyncPool(argv.concurrency, targets, async (u, i) => {
    const r = await processSite(browser, u, i);
    appendCsv(argv.output, r, header);
    const mark = r.error ? '[X]' : (r.banner ? '[OK]' : '[-]');
    console.log(`[${i}/${targets.length}] ${mark} ${u} - ${r.error || r.model}`);
    if (r.error) appendCsv(argv.suspects, { url: u, reason: r.error }, ['url','reason']);
    return r;
  });

  await browser.close();
  const elapsed = ((Date.now() - start)/1000).toFixed(1);
  const ok = results.filter(r => !r.error).length;
  const cb = results.filter(r => r.banner === 1).length;
  console.log(`Done in ${elapsed}s. OK=${ok}/${targets.length}, consent-based=${cb}.`);
  console.log(`CSV: ${argv.output}`);
})().catch(e => {
  // Top level no longer exits, only prints (avoids single site timeout causing overall interruption)
  console.error('Non-fatal top-level error:', e && e.message ? e.message : e);
});