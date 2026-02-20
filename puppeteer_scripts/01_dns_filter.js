/**
 * 01_dns_filter.js
 * Design Points:
 *  1) Pipeline: DNS (Low Concurrency) -> Real-time Push to HTTP (Medium Concurrency); Avoid Serial Processing of Two Segments Causing Delays
 *  2) DNS Robustness: Fixed resolver, retries, distinguish NO_A_AAAA; automatic www fallback (apex no A/AAAA)
 *  3) HTTP Robust: HTTPS/HTTP + HEAD/ lightweight GET fallback chain; statistics code and via
 *  4) Secondary re-inspection: Only re-inspect the first round TIMEOUT with low concurrency, high timeout + www fallback; mark as SLOW_RECOVERED if successful
 *  5) Output: valid_sites.csv (header domain), access_log.txt (contains via/code/flags), error_log.txt (contains error types)
 *
 * Example run (10k baseline):
 *   node puppeteer_scripts/01_dns_filter.js \
 *     --input=../input/tranco_top100k.csv --start=0 --limit=10000 \
 *     --dns=1.1.1.1,8.8.8.8 --dnsConcurrency=10 --dnsRetries=2 \
 *     --httpConcurrency=25 --timeout=9000 \
 *     --retryHttpConcurrency=10 --retryTimeout=15000
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const axios = require('axios');
const { Resolver } = require('dns').promises;

// ------------------ Parameter parsing ------------------
const args = Object.fromEntries(
  process.argv.slice(2).map(kv => {
    const [k, v] = kv.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

const INPUT_FILE            = path.resolve(__dirname, args.input || '../input/tranco_top100k.csv');
const OUTPUT_FILE           = path.resolve(__dirname, '../output/valid_sites.csv');
const ACCESS_LOG_FILE       = path.resolve(__dirname, '../logs/access_log.txt');
const ERROR_LOG_FILE        = path.resolve(__dirname, '../logs/error_log.txt');

const START                 = Number(args.start || 0);
const LIMIT                 = Number(args.limit || 10000);

const DNS_SERVERS           = (args.dns || '1.1.1.1,8.8.8.8').split(',').map(s => s.trim()).filter(Boolean);
const DNS_CONCURRENCY       = Number(args.dnsConcurrency || 10);
const DNS_RETRIES           = Number(args.dnsRetries || 2);

const HTTP_CONCURRENCY      = Number(args.httpConcurrency || Number(args.concurrency || 25));
const TIMEOUT_MS            = Number(args.timeout || 9000);

const RETRY_HTTP_CONCURRENCY= Number(args.retryHttpConcurrency || 10);
const RETRY_TIMEOUT_MS      = Number(args.retryTimeout || Math.max(15000, TIMEOUT_MS));

// Directory preparation
for (const d of ['../output', '../logs']) {
  const p = path.resolve(__dirname, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ------------------ Utilities ------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class AsyncQueue {
  constructor() { this.q = []; this.closed = false; this.waiters = []; }
  push(x) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w(x);
    else this.q.push(x);
  }
  async pop() {
    if (this.q.length) return this.q.shift();
    if (this.closed) return null;
    return await new Promise(res => this.waiters.push(res));
  }
  close() {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()(null);
  }
}

// ------------------ DNS robust resolution + www fallback ------------------
const dnsResolver = new Resolver();
dnsResolver.setServers(DNS_SERVERS);

async function resolveAOrAAAA(name) {
  const v4 = await dnsResolver.resolve4(name).catch(() => []);
  const v6 = await dnsResolver.resolve6(name).catch(() => []);
  return { v4, v6, ok: v4.length > 0 || v6.length > 0 };
}

async function resolveStableWithRetries(domain) {
  for (let attempt = 0; attempt <= DNS_RETRIES; attempt++) {
    try {
      // CNAME following (not mandatory)
      let target = domain;
      try {
        const cn = await dnsResolver.resolveCname(domain);
        if (cn && cn.length) target = cn[0];
      } catch (_) {}

      const apex = await resolveAOrAAAA(target);
      if (apex.ok) return { ok: true, finalDomain: domain, usedWWW: false, target, reason: 'DNS_OK' };

      // apex has no A/AAAA, try www fallback
      const wwwName = domain.startsWith('www.') ? domain : `www.${domain}`;
      const www = await resolveAOrAAAA(wwwName);
      if (www.ok) return { ok: true, finalDomain: wwwName, usedWWW: true, target: wwwName, reason: 'DNS_OK' };

      return { ok: false, reason: 'NO_A_AAAA' };
    } catch (e) {
      const code = e.code || 'DNS_ERROR';
      const transient = ['EAI_AGAIN','ETIMEOUT','SERVFAIL','REFUSED'].includes(code);
      if (transient && attempt < DNS_RETRIES) {
        await sleep(200 * (attempt + 1) + Math.random() * 150);
        continue;
      }
      return { ok: false, reason: code };
    }
  }
  return { ok: false, reason: 'DNS_ERROR' };
}

// ------------------ HTTP reachability (fallback chain) ------------------
function agent(isHttps) {
  return isHttps
    ? new https.Agent({ rejectUnauthorized: false, keepAlive: true })
    : new http.Agent({ keepAlive: true });
}

async function httpHead(url, isHttps, timeout) {
  return axios.head(url, {
    timeout,
    maxRedirects: 3,
    validateStatus: () => true,
    httpAgent: isHttps ? undefined : agent(false),
    httpsAgent: isHttps ? agent(true) : undefined
  });
}

// Lightweight GET: stream fetch, immediately abort stream
async function httpLightGet(url, isHttps, timeout) {
  const res = await axios.get(url, {
    timeout,
    maxRedirects: 3,
    responseType: 'stream',
    validateStatus: () => true,
    httpAgent: isHttps ? undefined : agent(false),
    httpsAgent: isHttps ? agent(true) : undefined,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });
  if (res.data && typeof res.data.destroy === 'function') {
    setImmediate(() => { try { res.data.destroy(); } catch (_) {} });
  }
  return res;
}

async function probeReachabilityOnce(domain, timeoutMs) {
  const attempts = [
    { via: 'HTTPS_HEAD', fn: () => httpHead(`https://${domain}`, true, timeoutMs) },
    { via: 'HTTPS_GET',  fn: () => httpLightGet(`https://${domain}`, true, timeoutMs) },
    { via: 'HTTP_HEAD',  fn: () => httpHead(`http://${domain}`, false, timeoutMs) },
    { via: 'HTTP_GET',   fn: () => httpLightGet(`http://${domain}`, false, timeoutMs) }
  ];
  for (const a of attempts) {
    try {
      const res = await a.fn();
      return { status: 'VALID', code: res.status, via: a.via };
    } catch (err) {
      const code = err?.code || null;
      if (code === 'ECONNABORTED') return { status: 'TIMEOUT', code: null, via: a.via };
      if (code === 'ENOTFOUND')     return { status: 'DNS_ERROR', code: null, via: a.via };
      if (['UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_SSL_WRONG_VERSION_NUMBER'].includes(code)) {
        return { status: 'SSL_ERROR', code: null, via: a.via };
      }
      // Try next fallback
    }
  }
  return { status: 'OTHER_ERROR', code: null, via: 'FALLBACK_EXHAUSTED' };
}

// Secondary re-inspection: timeout sites with more conservative params + www fallback once (if www not used in first pass)
async function probeWithRetry(domain, firstPassUsedWWW) {
  // First retry current domain with longer timeout
  let r = await probeReachabilityOnce(domain, RETRY_TIMEOUT_MS);
  if (r.status === 'VALID') return { ...r, recovered: true, usedWWW: firstPassUsedWWW };

  // If www not used in first pass, try www
  if (!firstPassUsedWWW) {
    const wwwDomain = domain.startsWith('www.') ? domain : `www.${domain}`;
    r = await probeReachabilityOnce(wwwDomain, RETRY_TIMEOUT_MS);
    if (r.status === 'VALID') return { ...r, recovered: true, usedWWW: true, wwwFallbackOnRetry: true };
  }
  return { ...r, recovered: false, usedWWW: firstPassUsedWWW };
}

// ------------------ Main process (pipeline) ------------------
(async () => {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`Input file does not exist: ${INPUT_FILE}`);
    process.exit(1);
  }

  // Read CSV (compatible with/without header)
  const lines = fs.readFileSync(INPUT_FILE, 'utf-8').split(/\r?\n/).filter(Boolean);
  const slice = lines.slice(START, START + LIMIT);

  const items = [];
  for (let i = 0; i < slice.length; i++) {
    const line = slice[i];
    const parts = line.split(',');
    if (i === 0 && /rank/i.test(parts[0]) && /domain/i.test(parts[1] || '')) continue; // Skip header
    if (parts.length >= 2) items.push({ idx: START + i, domain: (parts[1] || '').trim(), rank: (parts[0] || '').trim() });
    else items.push({ idx: START + i, domain: (parts[0] || '').trim(), rank: '' });
  }

  console.log(`DNS resolvers: ${DNS_SERVERS.join(', ')}  |  DNS concurrency=${DNS_CONCURRENCY} retries=${DNS_RETRIES}`);
  console.log(`Processing range: [${START}, ${START + slice.length})  Actual domain count: ${items.length}`);
  console.log(`HTTP concurrency=${HTTP_CONCURRENCY}  timeout=${TIMEOUT_MS}ms  |  Retry concurrency=${RETRY_HTTP_CONCURRENCY} retry timeout=${RETRY_TIMEOUT_MS}ms`);

  const accessLogs = [];
  const errorLogs  = [];
  const validSet   = new Set();

  // Statistics
  const dnsSummary  = {};
  const httpSummary = {};
  const retrySummary= {};

  // TIMEOUT collection for secondary re-inspection
  const timeoutsFirstPass = [];

  // Use queue to connect DNS -> HTTP (pipeline)
  const httpQueue = new AsyncQueue();

  // HTTP worker
  const httpWorkers = Array.from({ length: HTTP_CONCURRENCY }, () => (async () => {
    while (true) {
      const task = await httpQueue.pop();
      if (task === null) break;
      const { domain, usedWWW } = task;
      const r = await probeReachabilityOnce(domain, TIMEOUT_MS);
      const line = `[HTTP] ${domain},${r.status}${r.code ? ',' + r.code : ''},${r.via}${usedWWW ? ',USED_WWW' : ''}`;
      console.log(line);
      httpSummary[r.status] = (httpSummary[r.status] || 0) + 1;

      if (r.status === 'VALID') {
        validSet.add(domain);
        accessLogs.push(`${domain},VALID,${r.code || ''},${r.via}${usedWWW ? ',USED_WWW' : ''}`);
      } else if (r.status === 'TIMEOUT') {
        timeoutsFirstPass.push({ domain, usedWWW });
        errorLogs.push(`${domain},TIMEOUT,${r.via}${usedWWW ? ',USED_WWW' : ''}`);
      } else {
        errorLogs.push(`${domain},${r.status},${r.via}${usedWWW ? ',USED_WWW' : ''}`);
      }
    }
  })());

  // DNS producer
  console.log('--- Pipeline started: DNS resolution in progress, pushing to HTTP queue on success ---');
  let dnsActive = 0, dnsIdx = 0;

  async function dnsWorker() {
    while (true) {
      const i = dnsIdx++;
      if (i >= items.length) break;
      dnsActive++;
      const domain = items[i].domain;
      const r = await resolveStableWithRetries(domain);
      const tag = r.ok ? 'DNS_OK' : r.reason;
      dnsSummary[tag] = (dnsSummary[tag] || 0) + 1;
      console.log(`[DNS] ${domain},${tag}${r.usedWWW ? ',USED_WWW' : ''}`);

      if (r.ok) {
        httpQueue.push({ domain: r.finalDomain, usedWWW: r.usedWWW });
      } else {
        errorLogs.push(`${domain},${tag},DNS_PHASE`);
      }
      dnsActive--;
    }
  }

  // Start DNS workers
  const dnsWorkers = Array.from({ length: DNS_CONCURRENCY }, () => dnsWorker());

  // Wait for DNS to complete -> close HTTP queue
  await Promise.all(dnsWorkers);
  httpQueue.close();

  // Wait for HTTP to complete
  await Promise.all(httpWorkers);

  // Secondary re-inspection: TIMEOUT only
  console.log('--- Secondary re-inspection: conservative retry + www fallback for TIMEOUT sites ---');
  const retryQueue = [...timeoutsFirstPass];
  let retryActive = 0, retryIdx = 0;

  async function retryWorker() {
    while (true) {
      const i = retryIdx++;
      if (i >= retryQueue.length) break;
      retryActive++;
      const { domain, usedWWW } = retryQueue[i];
      const r = await probeWithRetry(domain, usedWWW);
      const flag = r.recovered ? 'SLOW_RECOVERED' : 'STILL_FAIL';
      const viaStr = `${r.via || ''}${r.usedWWW ? ',USED_WWW' : ''}${r.wwwFallbackOnRetry ? ',WWW_ON_RETRY' : ''}`;
      console.log(`[RETRY] ${domain},${r.status}${r.code ? ',' + r.code : ''},${viaStr},${flag}`);
      retrySummary[flag] = (retrySummary[flag] || 0) + 1;

      if (r.status === 'VALID') {
        validSet.add(domain);
        accessLogs.push(`${domain},VALID,${r.code || ''},${viaStr},${flag}`);
      } else {
        errorLogs.push(`${domain},${r.status},${viaStr},${flag}`);
      }
      retryActive--;
    }
  }

  const retryWorkers = Array.from({ length: RETRY_HTTP_CONCURRENCY }, () => retryWorker());
  await Promise.all(retryWorkers);

  // Write output files
  fs.writeFileSync(OUTPUT_FILE, ['domain', ...Array.from(validSet)].join('\n'), 'utf-8');
  fs.writeFileSync(ACCESS_LOG_FILE, accessLogs.join('\n'), 'utf-8');
  fs.writeFileSync(ERROR_LOG_FILE, errorLogs.join('\n'), 'utf-8');

  // Summary
  const total = items.length;
  console.log('-'.repeat(66));
  console.log(`Done. Valid sites: ${validSet.size} / Total processed: ${total}`);
  console.log('DNS distribution:', dnsSummary);
  console.log('HTTP distribution:', httpSummary);
  console.log('RETRY distribution:', retrySummary);
  console.log(`Output:
  - ${OUTPUT_FILE}
  - ${ACCESS_LOG_FILE}
  - ${ERROR_LOG_FILE}`);
})().catch(e => {
  console.error('Script exception:', e);
  process.exit(1);
});