// Opt-in, real-browser check of the cloud extension: load it unpacked into Chromium, open a
// synthetic /interview/thread page under the real forum origin (served by Playwright, nothing
// reaches the forum), run the worker's capture, and watch both sides:
//   - a fake collector API on 127.0.0.1 receives exactly one ingest whose hash it recomputes;
//   - the page sees no DOM mutation, no new global, and makes no request of its own.
// Run: NODE_PATH=$(npm root -g) node tools/browser-cloud/tests/e2e_chromium.mjs
// Against a real API instead of the fake one: GE_E2E_API=http://127.0.0.1:8000 GE_E2E_TOKEN=gec_... (a
// contributor token registered on that server; only loopback API addresses are accepted by the extension).
// Needs Playwright and a Chromium that may load unpacked extensions (not every managed browser may).
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', 'extensions', 'browser-cloud');
const P = require(path.join(EXT, 'projection.js'));
const COLLECTOR = '5c2d1e0f-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
const URL_UNDER_TEST = 'https://www.1point3acres.com/interview/thread/1189250';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Amazon 面经 - 一亩三分地</title></head><body>
<div class="mx-auto w-full max-w-3xl">
  <div class="border-b"><div class="font-semibold">地里匿名用户</div><time title="2026-09-12 02:13">2026-09-12 02:13</time></div>
  <div class="text-lg font-medium">Amazon coding round 面经</div>
  <div class="text-muted-foreground mb-4"><span class="text-muted-foreground">2025(1-3月)</span>
    <span class="text-green">数据科学</span><span class="font-bold ml-1">硕士</span><span class="text-blue-500">全职</span>
    <span>@</span><span class="text-orange">amazon</span><span class="text-purple-500">| Pass</span><span>| 其他</span></div>
  <div class="bbcode-container">第一轮：Two pointer based leetcode。

第二轮：Binary search modification。</div>
  <div class="rounded-lg border bg-card"><div class="font-semibold">Amazon</div></div>
</div></body></html>`;

const received = [];
const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const reply = (status, data) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== 'Bearer gec_e2e') return reply(403, {detail: 'collector credential rejected'});
    if (req.url === '/internal/v1/collector/me')
      return reply(200, {collector_id: COLLECTOR, label: 'contributor:e2e', credential_kind: 'contributor', capture_surface: 'source_direct',
        last_sequence: 0, quota: {limit: 1000, used: 0, remaining: 1000, window_hours: 24, next_slot_at: null}});
    if (!String(req.headers['x-gradevidence-client'] || '').startsWith('gradevidence-browser-cloud/'))
      return reply(400, {detail: 'the extension did not name itself'});
    if (req.url === '/internal/v1/collector/ingest') {
      const batch = JSON.parse(body);
      received.push(batch);
      const [entry] = batch.captures;
      const hash = createHash('sha256').update(P.canonicalJSON(entry.payload)).digest('hex');
      if (hash !== entry.payload_sha256) return reply(422, {detail: 'payload hash mismatch'});
      return reply(200, {receipts: [{capture_uid: entry.capture_uid, state: 'stored'}], dry_run: false,
        quota: {limit: 1000, used: 1, remaining: 999, window_hours: 24, next_slot_at: null}});
    }
    reply(404, {detail: 'not found'});
  });
});
await new Promise(r => api.listen(0, '127.0.0.1', r));
const port = api.address().port;
const REAL_API = process.env.GE_E2E_API || null;
const TOKEN = REAL_API ? process.env.GE_E2E_TOKEN : 'gec_e2e';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-cloud-e2e-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let failed = false;
const check = (ok, message) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`); if (!ok) failed = true; };
try {
  const pageRequests = [];
  await context.route('https://www.1point3acres.com/**', route => route.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: PAGE}));
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', {timeout: 15000});
  check(worker.url().endsWith('/background.js'), `service worker loaded: ${worker.url()}`);
  // The options tab the extension opens on install is extension UI, not the forum.
  const page = await context.newPage();
  page.on('request', r => pageRequests.push(r.url()));
  await page.goto(URL_UNDER_TEST);
  await page.evaluate(() => {
    window.__mutations = 0;
    new MutationObserver(list => { window.__mutations += list.length; })
      .observe(document, {subtree: true, childList: true, attributes: true, characterData: true});
    window.__before = document.documentElement.outerHTML;
  });
  const requestsBefore = pageRequests.length;
  const result = await worker.evaluate(async ({apiBase, token}) => {
    await chrome.storage.local.set({settings: {token, apiBase, notifications: false}});
    const [tab] = await chrome.tabs.query({url: 'https://www.1point3acres.com/*'});
    return globalThis.__ge.captureTab(tab);
  }, {apiBase: REAL_API || `http://127.0.0.1:${port}`, token: TOKEN});
  check(result.ok && result.state === 'stored', `capture pushed: ${JSON.stringify(result)}`);
  if (REAL_API) {
    const again = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({url: 'https://www.1point3acres.com/*'});
      return globalThis.__ge.captureTab(tab);
    });
    check(again.state === 'duplicate', `a second click spends no quota: ${again.state}`);
  } else {
    check(received.length === 1, `fake API received ${received.length} ingest request(s)`);
    const payload = received[0]?.captures[0].payload;
    check(payload?.document_key === 'thread:1189250' && payload?.collector_id === COLLECTOR && payload?.collector_sequence === 1,
      `envelope identity: ${payload?.document_key} seq ${payload?.collector_sequence}`);
    check(payload?.thread.title === 'Amazon coding round 面经', `title read from the page: ${payload?.thread.title}`);
    check(payload?.extensions.browser.classification?.company === 'amazon', 'classification line read');
  }
  const seen = await page.evaluate(() => ({mutations: window.__mutations, same: window.__before === document.documentElement.outerHTML,
    globals: ['GE', 'GEExtractor', 'GEProjection', 'chrome'].filter(k => k in window && (k !== 'chrome' || window.chrome?.runtime?.id))}));
  check(seen.mutations === 0 && seen.same, `page DOM untouched (mutations=${seen.mutations})`);
  check(seen.globals.length === 0, `no extension global visible to the page: [${seen.globals}]`);
  check(pageRequests.length === requestsBefore, `page made no request during the capture (${pageRequests.length - requestsBefore})`);
  const stored = await worker.evaluate(async () => (await chrome.storage.local.get(['archive_index', 'outbox', 'history'])));
  check(stored.archive_index?.length === 1 && stored.outbox?.length === 0 && stored.history?.['1189250']?.status === 'pushed',
    'kept locally, nothing left queued, history says pushed');
} finally {
  await context.close();
  api.close();
  fs.rmSync(profile, {recursive: true, force: true});
}
process.exit(failed ? 1 : 0);
