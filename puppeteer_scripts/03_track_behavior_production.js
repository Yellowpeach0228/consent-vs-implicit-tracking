/**
 * 03_track_behavior_production.js
 * Design principles:
 *  1) Three interaction scenarios: CBT-Accept, CBT-Reject, Implicit-Baseline
 *  2) Fixed time windows: pre-window (0-5s), post-window (30s after interaction)
 *  3) Collect network traces, dependency graphs, and execution events
 *  4) Output: per-site trace files, aggregated metrics, error logs
 *
 * Usage example:
 *   node 03_track_behavior_production.js \
 *     --input=./output/valid_sites.csv \
 *     --concurrency=8 \
 *     --preWindow=5000 \
 *     --postWindow=30000
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// ------------------ Argument parsing ------------------
const args = Object.fromEntries(
  process.argv.slice(2).map(kv => {
    const [k, v] = kv.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

const INPUT_FILE = path.resolve(__dirname, args.input || '../output/valid_sites.csv');
const OUTPUT_DIR = path.resolve(__dirname, '../traces');
const METRICS_FILE = path.resolve(__dirname, '../output/behavior_metrics.csv');
const ERROR_LOG_FILE = path.resolve(__dirname, '../logs/behavior_errors.txt');

const CONCURRENCY = Number(args.concurrency || 8);
const PRE_WINDOW = Number(args.preWindow || 5000);
const POST_WINDOW = Number(args.postWindow || 30000);
const NAV_TIMEOUT = Number(args.navTimeout || 15000);
const TASK_TIMEOUT = Number(args.taskTimeout || 120000);

// Create directories
for (const d of [OUTPUT_DIR, path.dirname(METRICS_FILE), path.dirname(ERROR_LOG_FILE)]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ------------------ Utility functions ------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function buildVariants(rawUrl) {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    const bare = u.hostname.replace(/^www\./, '');
    return Array.from(new Set([
      `https://${bare}/`,
      `https://www.${bare}/`,
      `http://${bare}/`,
      `http://www.${bare}/`
    ]));
  } catch {
    const host = url.replace(/^https?:\/\//, '').split('/')[0];
    const bare = host.replace(/^www\./, '');
    return Array.from(new Set([`https://${bare}/`, `http://${bare}/`]));
  }
}

// ------------------ Banner detection and interaction ------------------
const CONTEXT_WORDS = ['cookie', 'cookies', 'consent', 'gdpr', 'privacy', 'we use cookies'];
const ACTION_WORDS = ['accept', 'accept all', 'agree', 'allow', 'ok', 'continue', 'reject', 'decline'];

async function detectBanner(page) {
  return await page.evaluate(({ CONTEXT_WORDS, ACTION_WORDS }) => {
    const body = document.body || document.documentElement;
    const text = (body.innerText || '').toLowerCase();
    const contextHit = CONTEXT_WORDS.some(w => text.includes(w.toLowerCase()));
    const hasTCF = typeof window.__tcfapi === 'function';
    
    let acceptBtn = null, rejectBtn = null;
    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    
    for (const btn of buttons) {
      try {
        const st = window.getComputedStyle(btn);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        
        const txt = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase().trim();
        if (!txt || txt.length > 40) continue;
        
        if (/accept.*all|agree|allow/i.test(txt)) acceptBtn = btn;
        if (/reject|decline|necessary.*only/i.test(txt)) rejectBtn = btn;
      } catch {}
    }
    
    const hasConsent = contextHit || hasTCF || (acceptBtn && rejectBtn);
    return {
      hasConsent,
      hasTCF,
      contextHit,
      hasAccept: !!acceptBtn,
      hasReject: !!rejectBtn
    };
  }, { CONTEXT_WORDS, ACTION_WORDS });
}

async function clickButton(page, action) {
  const selector = action === 'accept' 
    ? 'button, a, [role="button"]'
    : 'button, a, [role="button"]';
  
  return await page.evaluate((sel, act) => {
    const buttons = Array.from(document.querySelectorAll(sel));
    const pattern = act === 'accept' 
      ? /accept.*all|agree|allow/i 
      : /reject|decline|necessary.*only/i;
    
    for (const btn of buttons) {
      try {
        const st = window.getComputedStyle(btn);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        
        const txt = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase();
        if (pattern.test(txt)) {
          btn.click();
          return { success: true, text: txt.slice(0, 50) };
        }
      } catch {}
    }
    return { success: false, text: '' };
  }, selector, action);
}

// ------------------ Instrumentation ------------------
async function instrumentPage(page) {
  const traces = {
    network: [],
    dependency: [],
    execution: [],
    errors: []
  };
  
  // Network interception
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (req.resourceType() === 'script') {
      traces.network.push({
        timestamp: Date.now(),
        url: req.url(),
        initiator: req.initiator()?.url || '',
        type: 'request'
      });
    }
    req.continue();
  });
  
  page.on('response', res => {
    if (res.request().resourceType() === 'script') {
      traces.network.push({
        timestamp: Date.now(),
        url: res.url(),
        status: res.status(),
        type: 'response'
      });
    }
  });
  
  // Runtime instrumentation
  await page.evaluateOnNewDocument(() => {
    window.__traces = {
      execution: [],
      errors: []
    };
    
    // Dynamic code execution
    const origEval = window.eval;
    window.eval = function(...args) {
      window.__traces.execution.push({
        timestamp: Date.now(),
        type: 'eval',
        code: String(args[0]).slice(0, 100)
      });
      return origEval.apply(this, args);
    };
    
    // Error tracking
    window.addEventListener('error', e => {
      window.__traces.errors.push({
        timestamp: Date.now(),
        message: e.message,
        stack: e.error?.stack?.slice(0, 200) || ''
      });
    });
    
    window.addEventListener('unhandledrejection', e => {
      window.__traces.errors.push({
        timestamp: Date.now(),
        message: String(e.reason),
        type: 'unhandled_promise'
      });
    });
  });
  
  return traces;
}

async function collectTraces(page, traces) {
  try {
    const clientTraces = await page.evaluate(() => window.__traces || { execution: [], errors: [] });
    traces.execution.push(...clientTraces.execution);
    traces.errors.push(...clientTraces.errors);
  } catch {}
  return traces;
}

// ------------------ Main measurement function ------------------
async function measureSite(browser, domain, scenario) {
  let page;
  const result = {
    domain,
    scenario,
    success: false,
    error: '',
    traces: null
  };
  
  try {
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    
    const traces = await instrumentPage(page);
    const startTime = Date.now();
    
    // Navigate
    const variants = buildVariants(domain);
    let navigated = false;
    for (const url of variants) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        navigated = true;
        break;
      } catch {}
    }
    
    if (!navigated) {
      result.error = 'NAV_FAILED';
      return result;
    }
    
    // Pre-window: wait and detect
    await sleep(PRE_WINDOW);
    const preTraces = await collectTraces(page, traces);
    
    const detection = await detectBanner(page);
    
    // Interaction based on scenario
    let interactionTime = Date.now();
    if (scenario === 'cbt-accept' && detection.hasAccept) {
      const click = await clickButton(page, 'accept');
      if (!click.success) result.error = 'CLICK_FAILED';
      interactionTime = Date.now();
    } else if (scenario === 'cbt-reject' && detection.hasReject) {
      const click = await clickButton(page, 'reject');
      if (!click.success) result.error = 'CLICK_FAILED';
      interactionTime = Date.now();
    }
    // For implicit-baseline: no interaction
    
    // Post-window: wait and collect
    await sleep(POST_WINDOW);
    const postTraces = await collectTraces(page, traces);
    
    result.success = true;
    result.traces = {
      startTime,
      preWindowEnd: startTime + PRE_WINDOW,
      interactionTime,
      postWindowEnd: interactionTime + POST_WINDOW,
      detection,
      network: postTraces.network,
      execution: postTraces.execution,
      errors: postTraces.errors
    };
    
  } catch (e) {
    result.error = e.message?.slice(0, 100) || 'UNKNOWN_ERROR';
  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
  }
  
  return result;
}

// ------------------ Concurrent processing ------------------
async function asyncPool(limit, items, iterator) {
  const results = [];
  const executing = new Set();
  
  for (const item of items) {
    const promise = Promise.resolve().then(() => iterator(item));
    results.push(promise);
    executing.add(promise);
    promise.finally(() => executing.delete(promise));
    
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  
  return Promise.all(results);
}

// ------------------ Main entry point ------------------
(async () => {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ Input file not found: ${INPUT_FILE}`);
    process.exit(1);
  }
  
  // Load domains
  const lines = fs.readFileSync(INPUT_FILE, 'utf-8').split(/\r?\n/).filter(Boolean);
  const domains = lines.slice(1).map(line => line.split(',')[0].trim()).filter(Boolean);
  
  console.log(`🔬 Starting measurement: ${domains.length} domains`);
  console.log(`⚙️  Config: CONCURRENCY=${CONCURRENCY}, PRE=${PRE_WINDOW}ms, POST=${POST_WINDOW}ms`);
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  const scenarios = ['cbt-accept', 'cbt-reject', 'implicit-baseline'];
  const allTasks = [];
  
  for (const domain of domains) {
    for (const scenario of scenarios) {
      allTasks.push({ domain, scenario });
    }
  }
  
  console.log(`📊 Total tasks: ${allTasks.length} (${domains.length} domains × ${scenarios.length} scenarios)`);
  
  const results = await asyncPool(CONCURRENCY, allTasks, async (task) => {
    const result = await measureSite(browser, task.domain, task.scenario);
    
    // Save trace
    if (result.success && result.traces) {
      const traceFile = path.join(OUTPUT_DIR, `${task.domain}_${task.scenario}.json`);
      fs.writeFileSync(traceFile, JSON.stringify(result.traces, null, 2), 'utf-8');
    }
    
    // Log errors
    if (result.error) {
      const errorLine = `${task.domain},${task.scenario},${result.error}\n`;
      fs.appendFileSync(ERROR_LOG_FILE, errorLine, 'utf-8');
    }
    
    const mark = result.success ? '✓' : '✗';
    console.log(`[${allTasks.indexOf(task) + 1}/${allTasks.length}] ${mark} ${task.domain} (${task.scenario})`);
    
    return result;
  });
  
  await browser.close();
  
  // Generate summary metrics
  const summary = results.reduce((acc, r) => {
    const key = r.scenario;
    if (!acc[key]) acc[key] = { total: 0, success: 0, failed: 0 };
    acc[key].total++;
    if (r.success) acc[key].success++;
    else acc[key].failed++;
    return acc;
  }, {});
  
  console.log('═'.repeat(60));
  console.log('📈 Summary:');
  for (const [scenario, stats] of Object.entries(summary)) {
    console.log(`  ${scenario}: ${stats.success}/${stats.total} success (${stats.failed} failed)`);
  }
  console.log(`📁 Traces saved to: ${OUTPUT_DIR}`);
  console.log(`📝 Errors logged to: ${ERROR_LOG_FILE}`);
  
})().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});