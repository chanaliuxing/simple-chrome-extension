// The cloud extension's service worker, run for real against mocked Chrome APIs and a fake API.
// node --test tools/browser-cloud/tests/background.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', 'extensions', 'browser-cloud');
const API = 'https://api.gradevidence.click';
const COLLECTOR = '5c2d1e0f-3a4b-4c5d-8e6f-7a8b9c0d1e2f';

/** What GET /collector/me answers for a contributor token. */
function me(changes = {}) {
  return {collector_id: COLLECTOR, label: 'contributor:alice', credential_kind: 'contributor', capture_surface: 'source_direct',
    source_keys: ['1point3acres'], last_sequence: 5,
    quota: {limit: 1000, used: 0, remaining: 1000, window_hours: 24, next_slot_at: null}, ...changes};
}
const meBody = me;

function pageCapture(changes = {}) {
  return {
    schema_version: 'ge.browser_capture.v2', source: '1point3acres', capture_surface: 'source_direct',
    capture_method: 'chrome_readonly_extension', collector_version: '1.0.0-cloud', adapter: 'interview_visible_dom_v1',
    source_thread_id: '1189250', source_post_id: null, forum_id: null, source_section: 'interview',
    canonical_url: 'https://www.1point3acres.com/bbs/thread-1189250-1-1.html',
    observed_url: 'https://www.1point3acres.com/interview/thread/1189250', source_pointer: '.bbcode-container:first-visible',
    title: 'Amazon coding round', body_text: 'Two pointer based leetcode\n\nBinary search', body_format: 'text',
    capture_scope: 'main_post_visible_text', completeness: 'complete_visible', completeness_flags: [],
    source_published_at: '2026-09-12T06:13:00.000Z', breadcrumbs: [], identity_evidence: 'url_interview_thread_visible_dom_no_main_pid',
    author_name: '匿名', company_name: 'Amazon', category_track: '数据科学',
    classification: {period: '2025', track: '数据科学', degree: '硕士', job_type: '全职', company: 'amazon', result: 'Pass', applicant_status: '其他', raw_text: 'x'},
    published_at_display: '2026-09-12 02:13', published_at_utc_inferred: '2026-09-12T06:13:00.000Z', time_zone_basis: 'browser',
    viewer_logged_in: true, extract_duration_ms: 41, captured_at: '2026-09-22T07:00:00.000Z', thread_meta: null, problem: null,
    post_meta: null, guide: null, ...changes,
  };
}

/** A fresh service worker with its own storage, a scripted API and a fake tab. */
function worker({settings = {}, api = {}} = {}) {
  const data = {settings: {...settings}};
  const calls = {fetch: [], scripting: [], alarms: [], notifications: 0, opened: 0};
  let page = pageCapture();
  const listeners = {};
  const on = name => ({addListener: fn => { listeners[name] = fn; }});
  const chrome = {
    runtime: {id: 'ext', getURL: p => `chrome-extension://ext/${p}`, lastError: undefined, openOptionsPage: () => { calls.opened += 1; },
      getManifest: () => ({version: '1.1.0'}),
      onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message')},
    storage: {local: {
      async get(keys) {
        if (keys === null) return structuredClone(data);
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter(k => k in data).map(k => [k, structuredClone(data[k])]));
      },
      async set(items) { for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v); },
      async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
      setAccessLevel: async () => {},
    }},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async ({title}) => { calls.title = title; },
      setIcon: async () => {}, onClicked: on('clicked')},
    notifications: {create: (_id, _o, cb) => { calls.notifications += 1; cb && cb(); }},
    alarms: {create: (name, o) => calls.alarms.push(['create', name, o]), clear: name => calls.alarms.push(['clear', name]), onAlarm: on('alarm')},
    commands: {onCommand: on('command')},
    tabs: {query: async () => [{id: 1, url: page.observed_url}]},
    scripting: {async executeScript(details) {
      calls.scripting.push(details);
      if (details.files) return [];
      return [{result: {state: 'ready', capture: structuredClone(page)}}];
    }},
  };
  const handlers = {
    me: () => ({status: 200, body: me()}),
    ingest: () => ({status: 200, body: {receipts: [{state: 'stored', server_capture_id: 9}], dry_run: false,
      quota: {limit: 1000, used: 1, remaining: 999, window_hours: 24, next_slot_at: null}}}),
    local: () => ({status: 200, body: {durable: true, status: 'saved'}}),
    captures: ({url}) => ({status: 200, body: {captures: new URL(url).searchParams.get('ids').split(',')
      .map(uid => ({capture_uid: uid, state: 'published', public: true, content_id: 42}))}}),
    ...api,
  };
  async function fetch(url, init = {}) {
    calls.fetch.push({url, init, body: init.body ? JSON.parse(init.body) : null});
    const kind = url.startsWith('http://127.0.0.1:18765') ? 'local' : url.endsWith('/collector/me') ? 'me'
      : url.endsWith('/collector/ingest') ? 'ingest' : url.includes('/collector/captures?') ? 'captures' : null;
    if (!kind) throw new Error(`unexpected request to ${url}`);
    const answer = await handlers[kind]({url, init, body: init.body ? JSON.parse(init.body) : null, calls});
    if (answer instanceof Error) throw answer;
    return {status: answer.status, ok: answer.status >= 200 && answer.status < 300,
      headers: {get: name => (answer.headers || {})[name] ?? null}, json: async () => answer.body};
  }
  const context = vm.createContext({chrome, fetch, crypto: globalThis.crypto, TextEncoder, URL, structuredClone, console,
    setTimeout: () => 0, Date, JSON, Math, Promise, Object, Array, String, Number, Boolean, Error, Set, Map, RegExp, Uint8Array});
  context.globalThis = context;
  context.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), context); };
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), context);
  return {
    ge: context.__ge, data, calls, listeners, handlers,
    setPage(changes) { page = pageCapture(changes); },
    click: () => context.__ge.captureTab({id: 1, url: page.observed_url}),
    message: type => new Promise(resolve => listeners.message({type}, {id: 'ext', url: 'chrome-extension://ext/options.html', tab: {id: 2}}, resolve)),
    posts: () => calls.fetch.filter(c => c.url.endsWith('/ingest')),
  };
}

const ready = {token: 'gec_t', collectorId: COLLECTOR, credentialKind: 'contributor', sequence: 5};

function canonical(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

test('without a token the page is kept in the browser and nothing goes to the cloud', async () => {
  const w = worker();
  const result = await w.click();
  assert.equal(result.state, 'no_token');
  assert.equal(w.calls.fetch.length, 0);
  assert.equal(w.data.archive_index.length, 1);
  assert.equal(w.data[`cap:${w.data.archive_index[0]}`].title, 'Amazon coding round');
  assert.equal(w.data.history['1189250'].status, 'local_only');
});

test('reading is the local-only extension: injected on click, ISOLATED world, same two files', async () => {
  const w = worker({settings: ready});
  await w.click();
  assert.deepEqual([...w.calls.scripting[0].files], ['common.js', 'extractor.js']);
  assert.ok(w.calls.scripting.every(d => d.world === 'ISOLATED'));
  const original = fs.readFileSync(path.join(HERE, '..', 'extensions', 'browser-readonly', 'extractor.js'), 'utf8');
  assert.equal(fs.readFileSync(path.join(EXT, 'extractor.js'), 'utf8'), original);
  assert.ok(w.calls.fetch.every(c => !/1point3acres/.test(new URL(c.url).hostname)), 'never a request to the forum');
});

test('a token pushes straight to the collector API with the next sequence and a hash the server recomputes', async () => {
  const w = worker({settings: {token: 'gec_t'}});
  const result = await w.click();
  assert.equal(result.state, 'stored');
  assert.equal(w.calls.fetch[0].url, `${API}/internal/v1/collector/me`);
  const [post] = w.posts();
  assert.equal(post.init.headers.Authorization, 'Bearer gec_t');
  assert.equal(post.init.credentials, 'omit');
  const [entry] = post.body.captures;
  assert.equal(entry.payload.collector_id, COLLECTOR);
  assert.equal(entry.payload.collector_sequence, 6, 'continues after the server last_sequence (5)');
  assert.equal(entry.payload_sha256, createHash('sha256').update(canonical(entry.payload)).digest('hex'));
  assert.equal(entry.payload.document_key, 'thread:1189250');
  assert.deepEqual(w.data.outbox, []);
  assert.equal(w.data.history['1189250'].status, 'pushed');
  assert.equal(w.data.settings.quota.remaining, 999);
  assert.match(w.calls.title, /已推送，几分钟内上线并进入人工审核，今日还可推 999 篇/);
});

test('the same page again, or a poorer copy of it, spends no quota', async () => {
  const w = worker({settings: ready});
  await w.click();
  assert.equal((await w.click()).state, 'duplicate');
  w.setPage({completeness: 'partial', completeness_flags: ['expand_control_visible'], body_text: 'Two pointer'});
  assert.equal((await w.click()).state, 'kept_existing');
  w.setPage({body_text: 'Two pointer based leetcode\n\nBinary search\n\nand a third round'});
  assert.equal((await w.click()).state, 'stored', 'a richer copy is pushed');
  assert.equal(w.posts().length, 2);
  assert.equal(w.posts()[1].body.captures[0].payload.collector_sequence, 7);
});

test('a full quota queues the capture and the retry sends it once a slot frees', async () => {
  let full = true;
  const w = worker({settings: ready, api: {ingest: () => full
    ? {status: 429, headers: {'Retry-After': '120'}, body: {detail: 'daily capture limit reached: 1000 of 1000'}}
    : {status: 200, body: {receipts: [{state: 'stored'}]}}}});
  const result = await w.click();
  assert.equal(result.state, 'queued');
  assert.equal(w.data.outbox.length, 1);
  assert.ok(w.data.outbox[0].next_try_at > Date.now() + 100000);
  assert.deepEqual(w.calls.alarms.at(-1).slice(0, 2), ['create', 'ge-cloud-flush']);
  assert.match(w.calls.title, /额度已用完/);
  const early = await w.ge.flush();
  assert.equal(early.sent, 0, 'not before Retry-After');
  full = false;
  const forced = await w.ge.flush({force: true});
  assert.equal(forced.sent, 1);
  assert.deepEqual(w.data.outbox, []);
  assert.equal(w.posts().at(-1).body.captures[0].payload_sha256, w.posts()[0].body.captures[0].payload_sha256, 'the retry resends the same bytes');
});

test('offline: kept and queued with backoff, delivered by the alarm later', async () => {
  let down = true;
  const w = worker({settings: ready, api: {ingest: () => down ? new Error('Failed to fetch') : {status: 200, body: {receipts: [{state: 'stored'}]}}}});
  assert.equal((await w.click()).state, 'queued');
  assert.equal(w.data.outbox[0].attempts, 1);
  down = false;
  w.data.outbox[0].next_try_at = 0;
  w.listeners.alarm({name: 'ge-cloud-flush'});
  await new Promise(r => setImmediate(r));
  await w.ge.flush();
  assert.deepEqual(w.data.outbox, []);
  assert.equal(w.data.history['1189250'].status, 'pushed');
});

test('a refused token pauses pushing until it is checked again; captures still queue', async () => {
  let valid = false;
  const w = worker({settings: ready, api: {
    ingest: () => valid ? {status: 200, body: {receipts: [{state: 'stored'}]}} : {status: 403, body: {detail: 'collector credential rejected'}}}});
  assert.equal((await w.click()).state, 'paused');
  assert.match(w.data.settings.paused, /403/);
  w.setPage({source_thread_id: '1189251', observed_url: 'https://www.1point3acres.com/interview/thread/1189251',
    canonical_url: 'https://www.1point3acres.com/bbs/thread-1189251-1-1.html'});
  assert.equal((await w.click()).state, 'paused');
  assert.equal(w.posts().length, 1, 'no request while paused');
  assert.equal(w.data.outbox.length, 2);
  valid = true;
  const who = await w.message('whoami');
  assert.equal(who.ok, true);
  assert.equal(w.data.settings.paused, null);
  assert.equal((await w.message('flush')).value.sent, 2);
});

test('the server already holding the capture counts as pushed; a sequence clash is renumbered once', async () => {
  const dup = worker({settings: ready, api: {ingest: () => ({status: 409, body: {detail: 'capture_uid x already has a different hash'}})}});
  assert.equal((await dup.click()).state, 'duplicate');
  assert.deepEqual(dup.data.outbox, []);

  let clashes = 1;
  const clash = worker({settings: ready, api: {
    me: () => ({status: 200, body: me({last_sequence: 40})}),
    ingest: () => (clashes-- > 0 ? {status: 409, body: {detail: 'capture_uid x conflicts with stored evidence'}}
      : {status: 200, body: {receipts: [{state: 'stored'}]}})}});
  assert.equal((await clash.click()).state, 'stored');
  const [first, second] = clash.posts().map(p => p.body.captures[0]);
  assert.equal(first.payload.collector_sequence, 6);
  assert.equal(second.payload.collector_sequence, 41);
  assert.equal(second.capture_uid, first.capture_uid);
});

test('a capture the server rejects is dropped from the queue and recorded', async () => {
  const w = worker({settings: ready, api: {ingest: () => ({status: 422, body: {detail: 'URL does not match the record identity'}})}});
  assert.equal((await w.click()).state, 'rejected');
  assert.deepEqual(w.data.outbox, []);
  assert.equal(w.data.history['1189250'].status, 'rejected');
  assert.match(w.data.history['1189250'].error, /URL does not match/);
});

test('captures queued under an old token are rebuilt for the new one', async () => {
  let down = true;
  const w = worker({settings: ready, api: {ingest: () => down ? new Error('offline') : {status: 200, body: {receipts: [{state: 'stored'}]}}}});
  await w.click();
  const old = w.data.outbox[0];
  w.data.settings = {...w.data.settings, token: 'gec_new', collectorId: '11111111-2222-4333-8444-555555555555'};
  down = false;
  assert.equal((await w.ge.flush({force: true})).sent, 1);
  const sent = w.posts().at(-1).body.captures[0];
  assert.equal(sent.payload.collector_id, '11111111-2222-4333-8444-555555555555');
  assert.notEqual(sent.capture_uid, old.capture_uid);
  assert.equal(w.posts().at(-1).init.headers.Authorization, 'Bearer gec_new');
});

test('the old local receiver gets a copy only when switched on', async () => {
  const off = worker({settings: ready});
  await off.click();
  assert.ok(off.calls.fetch.every(c => !c.url.startsWith('http://127.0.0.1')));
  const on = worker({settings: {...ready, localReceiver: true}});
  await on.click();
  const local = on.calls.fetch.find(c => c.url === 'http://127.0.0.1:18765/v1/captures');
  assert.ok(local, 'posted to the receiver');
  assert.equal(local.body.schema_version, 'ge.browser_capture.v2');
  assert.match(local.body.capture_id, /^[0-9a-f]{64}$/);
});

test('the archive can be switched off; a queued capture keeps its raw copy until delivered', async () => {
  let down = true;
  const w = worker({settings: {...ready, localArchive: false},
    api: {ingest: () => down ? new Error('offline') : {status: 200, body: {receipts: [{state: 'stored'}]}}}});
  await w.click();
  assert.equal(w.data.archive_index, undefined);
  const id = w.data.outbox[0].capture_id;
  assert.ok(w.data[`cap:${id}`], 'kept while queued');
  down = false;
  await w.ge.flush({force: true});
  assert.equal(w.data[`cap:${id}`], undefined, 'dropped once delivered');
});

test('the manifest asks for nothing that reads browsing data or lets a page reach the extension', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  for (const forbidden of ['cookies', 'webRequest', 'debugger', 'history', 'tabs', 'downloads', 'webNavigation'])
    assert.ok(!manifest.permissions.includes(forbidden), forbidden);
  assert.equal(manifest.content_scripts, undefined, 'nothing runs on a page until the icon is clicked');
  assert.equal(manifest.web_accessible_resources, undefined, 'a page cannot probe for the extension');
  assert.equal(manifest.externally_connectable, undefined);
  assert.deepEqual(manifest.host_permissions.filter(h => !/127\.0\.0\.1|localhost/.test(h)),
    ['https://www.1point3acres.com/*', 'https://1point3acres.com/*', 'https://api.gradevidence.click/*']);
});

test('a 403 about one capture refuses that capture only; the token keeps working', async () => {
  let refuse = true;
  const w = worker({settings: ready, api: {ingest: () => refuse
    ? {status: 403, body: {detail: 'source leetcode is outside collector scope'}}
    : {status: 200, body: {receipts: [{state: 'stored'}]}}}});
  assert.equal((await w.click()).state, 'rejected');
  assert.equal(w.data.settings.paused, null, 'not paused');
  assert.deepEqual(w.data.outbox, []);
  refuse = false;
  w.setPage({body_text: 'another page body'});
  assert.equal((await w.click()).state, 'stored');
});

test('a 403 because the token now names another identity rebuilds the capture for it', async () => {
  let me = COLLECTOR;
  const w = worker({settings: ready, api: {
    me: () => ({status: 200, body: meBody({collector_id: me, last_sequence: 9})}),
    ingest: ({body}) => body.captures[0].payload.collector_id === me ? {status: 200, body: {receipts: [{state: 'stored'}]}}
      : {status: 403, body: {detail: 'payload collector_id is outside token scope'}}}});
  me = '11111111-2222-4333-8444-555555555555';      // the token was re-issued server-side
  assert.equal((await w.click()).state, 'stored');
  const [first, second] = w.posts().map(p => p.body.captures[0].payload);
  assert.equal(first.collector_id, COLLECTOR);
  assert.equal(second.collector_id, me);
  assert.equal(w.data.settings.paused, null);
});

test('a refused token pauses: 401, or a 403 that names the credential', async () => {
  for (const [status, detail] of [[401, 'collector bearer token required'], [403, 'collector credential rejected'],
    [403, 'a contributor credential submits page captures only (/ingest)']]) {
    const w = worker({settings: ready, api: {ingest: () => ({status, body: {detail}})}});
    assert.equal((await w.click()).state, 'paused', detail);
    assert.equal(w.data.outbox.length, 1, 'kept for later');
  }
});

test('an internal collector token is refused before anything is pushed', async () => {
  // Pasted in by mistake: the server answers /me (no client guard on an old server), but it is not a contributor's.
  for (const answer of [
    {status: 200, body: me({label: 'mac-focused-sync', credential_kind: 'internal_collector', quota: null})},
    {status: 200, body: me({credential_kind: 'contributor', capture_surface: 'muse_agent'})},
    {status: 200, body: me({quota: null})},
    {status: 403, body: {detail: 'this token is not a contributor token; the cloud extension takes contributor tokens only'}},
  ]) {
    const w = worker({settings: {token: 'internal-token-pasted-by-mistake'}, api: {me: () => answer}});
    const result = await w.click();
    assert.equal(result.state, 'no_identity', JSON.stringify(answer.body));
    assert.equal(w.posts().length, 0, 'nothing pushed');
    assert.match(w.calls.title, /不是贡献者 token/);
    assert.equal(w.data.settings.collectorId, null);
    assert.match(w.data.settings.paused, /不是贡献者 token/);
    assert.equal(w.data.history['1189250'].status, 'local_only', 'still kept in the browser');
  }
});

test('an identity cached by 1.0, which never checked the kind, is checked again before any push', async () => {
  const w = worker({settings: {token: 'internal-token', collectorId: COLLECTOR, sequence: 3},
    api: {me: () => ({status: 200, body: me({credential_kind: 'internal_collector', quota: null})})}});
  assert.equal((await w.click()).state, 'no_identity');
  assert.equal(w.posts().length, 0);
  const flushed = await w.ge.flush({force: true});
  assert.equal(flushed.sent, 0);
});

test('every request names the client, so the server can refuse a non-contributor token', async () => {
  const w = worker({settings: {token: 'gec_t'}});
  await w.click();
  assert.ok(w.calls.fetch.length >= 2);
  for (const call of w.calls.fetch) assert.equal(call.init.headers['X-GradEvidence-Client'], 'gradevidence-browser-cloud/1.1.0');
});

test('a queue left by 1.0 is delivered by the retry after the update, once the token checks out', async () => {
  let down = true;
  const w = worker({settings: ready, api: {ingest: () => down ? new Error('offline') : {status: 200, body: {receipts: [{state: 'stored'}]}}}});
  await w.click();
  assert.equal(w.data.outbox.length, 1);
  // What 1.0 left behind: an identity with no kind recorded.
  w.data.settings = {...w.data.settings, credentialKind: undefined};
  w.data.outbox[0].next_try_at = 0;
  down = false;
  const summary = await w.ge.flush();
  assert.equal(summary.sent, 1);
  assert.equal(w.data.settings.credentialKind, 'contributor');
  assert.ok(w.calls.fetch.some(c => c.url.endsWith('/collector/me')), 'checked with /me first');
});

test('a pushed page says whether it will be public, and the site status can be checked later', async () => {
  const w = worker({settings: ready});
  assert.equal((await w.click()).state, 'stored');
  assert.match(w.calls.title, /几分钟内上线并进入人工审核/);
  assert.equal(w.data.history['1189250'].site_state, 'queued');
  const uid = w.data.history['1189250'].capture_uid;
  assert.match(uid, /^[0-9a-f-]{36}$/);
  const refreshed = await w.ge.refreshStatuses();
  assert.deepEqual({...refreshed}, {checked: 1, online: 1});
  const h = w.data.history['1189250'];
  assert.equal(h.site_state, 'published');
  assert.equal(h.site_url, 'https://gradevidence.click/content/42');
  assert.ok(w.calls.fetch.find(c => c.url.includes(`/collector/captures?ids=${uid}`)));
});

test('a partial page goes online and into review like any other, and says it was flagged', async () => {
  const w = worker({settings: ready});
  w.setPage({completeness: 'partial', completeness_flags: ['non_text_media_not_captured']});
  assert.equal((await w.click()).state, 'stored');
  assert.match(w.calls.title, /几分钟内上线并进入人工审核（这页标记为不完整/);
  assert.equal(w.data.history['1189250'].site_state, 'queued', 'asked about, not settled as never public');
  assert.deepEqual({...await w.ge.refreshStatuses()}, {checked: 1, online: 1});
  assert.equal(w.data.history['1189250'].site_url, 'https://gradevidence.click/content/42');
});

test('a capture the server says has no text to show is settled and not asked about again', async () => {
  const w = worker({settings: ready, api: {captures: ({url}) => ({status: 200, body: {captures: new URL(url).searchParams
    .get('ids').split(',').map(uid => ({capture_uid: uid, state: 'incomplete', public: false, content_id: 3}))}})}});
  assert.equal((await w.click()).state, 'stored');
  await w.ge.refreshStatuses();
  assert.equal(w.data.history['1189250'].site_state, 'incomplete');
  w.calls.fetch.length = 0;
  assert.deepEqual({...await w.ge.refreshStatuses()}, {checked: 0});
});

test('a page pushed again is about the new capture: nothing stale from the last one is shown', async () => {
  const w = worker({settings: ready});
  assert.equal((await w.click()).state, 'stored');
  await w.ge.refreshStatuses();
  assert.equal(w.data.history['1189250'].site_url, 'https://gradevidence.click/content/42');
  const first = w.data.history['1189250'].capture_uid;
  w.setPage({body_text: 'A longer, edited version of the same report.'.repeat(4)});
  assert.equal((await w.click()).state, 'stored');
  const h = w.data.history['1189250'];
  assert.notEqual(h.capture_uid, first);
  assert.deepEqual([h.site_state, h.site_url, h.content_id], ['queued', null, null]);
});

test('a capture the server already holds (409) is tracked under its own id, not the last push\'s state', async () => {
  const w = worker({settings: ready, api: {ingest: () => ({status: 409, body: {detail: 'capture_uid already has a different hash'}})}});
  w.data.history = {'1189250': {status: 'pushed', capture_uid: 'old-uid', site_state: 'incomplete', site_url: null, at: '2026-01-01'}};
  assert.equal((await w.click()).state, 'duplicate');
  const h = w.data.history['1189250'];
  assert.notEqual(h.capture_uid, 'old-uid');
  assert.equal(h.site_state, 'queued', 'asked about again, not left "settled" by the old capture');
  assert.equal((await w.ge.refreshStatuses()).checked, 1);
});

test('refresh asks about every push in batches of 100, what is on its way first; unanswered ones settle', async () => {
  const w = worker({settings: ready, api: {captures: ({url}) => ({status: 200, body: {captures: new URL(url).searchParams.get('ids')
    .split(',').filter(uid => !uid.startsWith('foreign')).map(uid => ({capture_uid: uid, state: 'waiting', public: false, content_id: 7}))}})}});
  const history = {};
  for (let n = 0; n < 150; n++) {
    history[`t${n}`] = {status: 'pushed', capture_uid: `uid-${n}`, site_state: n < 100 ? 'published' : 'queued', at: `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}Z`};
  }
  history.foreign = {status: 'pushed', capture_uid: 'foreign-1', site_state: 'queued', at: '2025-01-01'};
  w.data.history = history;
  const summary = await w.ge.refreshStatuses();
  assert.equal(summary.checked, 151);
  const asked = w.calls.fetch.filter(c => c.url.includes('/collector/captures?')).map(c => new URL(c.url).searchParams.get('ids').split(','));
  assert.deepEqual(asked.map(ids => ids.length), [100, 51]);
  assert.ok(asked[0].slice(0, 51).every(uid => !/^uid-(\d|[1-9]\d)$/.test(uid)), 'pending pushes before online ones');
  assert.equal(w.data.history.foreign.site_state, 'not_found');
  w.calls.fetch.length = 0;
  await w.ge.refreshStatuses();
  assert.ok(!w.calls.fetch.some(c => c.url.includes('foreign-1')), 'a push this token did not send is not asked about again');
});

test('a state the server can reverse is asked about again; only what cannot change is settled', async () => {
  const w = worker({settings: ready, api: {captures: ({url}) => ({status: 200, body: {captures: new URL(url).searchParams.get('ids')
    .split(',').map(uid => ({capture_uid: uid, state: 'published', public: true, content_id: 9}))}})}});
  const reversible = ['hidden', 'cancelled', 'sender_revoked', 'teaser', 'withdrawn', 'source_disabled'];
  w.data.history = Object.fromEntries([...reversible, 'incomplete', 'no_page', 'not_found', 'queued'].map((state, n) =>
    [`t${n}`, {status: 'pushed', capture_uid: `uid-${state}`, site_state: state, site_checked_at: '2026-01-01', at: `2026-01-0${(n % 9) + 1}`}]));
  await w.ge.refreshStatuses();
  const asked = new URL(w.calls.fetch.find(c => c.url.includes('/collector/captures?')).url).searchParams.get('ids').split(',');
  assert.deepEqual(new Set(asked), new Set([...reversible, 'queued'].map(s => `uid-${s}`)));
  assert.equal(asked[0], 'uid-queued', 'what is still on its way first');
  assert.equal(w.data.history.t0.site_url, 'https://gradevidence.click/content/9', 'a restored page shows its link again');
});

test('a refused token on refresh says so and pauses pushing, instead of a bare server code', async () => {
  const w = worker({settings: ready, api: {captures: () => ({status: 403, body: {detail: 'collector credential rejected'}})}});
  w.data.history = {t: {status: 'pushed', capture_uid: 'u', site_state: 'published', at: '2026-01-01'}};
  const summary = await w.ge.refreshStatuses();
  assert.match(summary.stopped, /token 无效或已停用（403）/);
  assert.match(w.data.settings.paused, /403/);
  assert.equal(w.data.history.t.site_state, 'published', 'nothing is guessed about the pushes');
});

test('a partial push 1.2.0 marked "incomplete" itself is asked about again after the upgrade', async () => {
  const w = worker({settings: ready});
  w.data.history = {t: {status: 'pushed', capture_uid: 'old', site_state: 'incomplete', site_checked_at: null, at: '2026-01-01'}};
  assert.equal((await w.ge.refreshStatuses()).checked, 1);
  assert.equal(w.data.history.t.site_state, 'published');
});
