'use strict';
/* GradEvidence cloud capture: one click = read the page you already have open, keep a copy in the
   browser, push it straight to the GradEvidence collector API. No local service to start.

   Reading is exactly the local-only extension's (tools/browser-readonly): common.js and
   extractor.js are copied unchanged, injected into the ISOLATED world only when you click, and
   they only read what is already rendered. Nothing is written to the page, nothing is clicked
   or scrolled, no request goes to the forum, no cookie is read. The push is made from this
   service worker to the API host, which the page cannot see.

   What changed against the local-only version is only where a capture goes:
   1. the browser itself (chrome.storage.local): an archive of what you captured, a history of
      what was pushed, and an outbox that survives restarts;
   2. the cloud: projected onto the canonical envelope (projection.js) and sent to
      POST /internal/v1/collector/ingest with your personal token;
   3. optionally the old local receiver (127.0.0.1:18765), when "also save to the local
      receiver" is switched on in the options page. */
importScripts('projection.js');

const P = globalThis.GEProjection;
const DEFAULT_API = 'https://api.gradevidence.click';
// Sent on every API request: the server refuses any token that is not a contributor's from this
// client, so an internal collector token pasted in by mistake cannot work here.
const CLIENT = `gradevidence-browser-cloud/${chrome.runtime.getManifest?.().version || 'unknown'}`;
const LOCAL_RECEIVER = 'http://127.0.0.1:18765';
const SITE = 'https://gradevidence.click';
// What cannot change for a capture once it is so: a capture with no text to show, a parsed
// one with no post stays that, and a capture this token did not send is not answered. Not asked
// about again until the page is pushed anew. Everything else can be reversed on the server (a
// reviewer's approval, scripts/contributor restore, a corrected teaser) and is asked again.
const SETTLED = new Set(['incomplete', 'no_page', 'not_found']);
// Asked about in this order: what is still on its way, then what is online, then the rest.
const OFFLINE = new Set(['hidden', 'teaser', 'mirror_evidence', 'not_validated', 'cancelled', 'parse_failed', 'sender_revoked',
  'withdrawn', 'source_disabled']);
const REFRESH_LIMIT = 500;
const ALLOWED = ['145', 'interview'];
const HOSTS = new Set(['www.1point3acres.com', '1point3acres.com']);
const RUN_ID = '00000000-0000-4000-8000-000000000002';
const MAX_OUTBOX = 300;
const HISTORY_LIMIT = 5000;
const FLUSH_ALARM = 'ge-cloud-flush';
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];
// A 403 about the token itself, as opposed to one capture being outside its scope.
const TOKEN_REFUSED = /credential rejected|cannot submit|bearer token required|submits page captures only|not a contributor token/;
const DEFAULT_SETTINGS = {token: '', apiBase: DEFAULT_API, collectorId: null, credentialKind: null, label: null, quota: null,
  localArchive: true, localReceiver: false, notifications: true, paused: null, sequence: 0};

/* ---- storage ------------------------------------------------------------------------------------ */

const store = {
  async get(key, fallback) { const r = await chrome.storage.local.get(key); return r[key] === undefined ? fallback : r[key]; },
  set(key, value) { return chrome.storage.local.set({[key]: value}); },
  remove(keys) { return chrome.storage.local.remove(keys); },
};
// Ask Chrome to keep storage away from content scripts (it may honour this only for session
// storage). Either way the injected reader never touches storage and the page cannot reach it.
try { chrome.storage.local.setAccessLevel?.({accessLevel: 'TRUSTED_CONTEXTS'})?.catch?.(() => {}); } catch {}

async function settings() { return {...DEFAULT_SETTINGS, ...(await store.get('settings', {}))}; }
async function updateSettings(patch) { const next = {...(await settings()), ...patch}; await store.set('settings', next); return next; }

function apiBase(s) {
  // Only the production API or a local development API; anything else has no host permission anyway.
  const raw = String(s.apiBase || DEFAULT_API).replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' && u.hostname === 'api.gradevidence.click' && !u.port) return u.origin;
    if (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)) return u.origin;
  } catch {}
  return DEFAULT_API;
}

// One writer at a time for the outbox/sequence/history keys (clicks and the retry alarm overlap).
let chain = Promise.resolve();
function locked(fn) { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; }

/* ---- feedback (browser UI only; the page never sees any of it) -------------------------------- */

async function badge(ok, title, s) {
  const text = ok ? '✓' : '!';
  await chrome.action.setBadgeText({text});
  await chrome.action.setBadgeBackgroundColor({color: ok ? '#0a8f2f' : '#d0021b'});
  await chrome.action.setTitle({title: String(title).slice(0, 200)});
  await chrome.action.setIcon({path: ok ? 'icon-ok.png' : 'icon-err.png'}).catch(() => {});
  setTimeout(() => { chrome.action.setBadgeText({text: ''}).catch(() => {}); chrome.action.setIcon({path: 'icon.png'}).catch(() => {}); }, 2500);
  if ((s || await settings()).notifications) {
    try {
      chrome.notifications.create(`ge-${Date.now()}`, {type: 'basic', iconUrl: chrome.runtime.getURL('icon.png'),
        title: ok ? 'GradEvidence 已保存' : 'GradEvidence 未完成', message: String(title).slice(0, 180), priority: 1}, () => void chrome.runtime.lastError);
    } catch {}
  }
}

/* ---- the server ----------------------------------------------------------------------------------- */

async function api(path, {method = 'GET', body, s}) {
  s = s || await settings();
  const response = await fetch(apiBase(s) + path, {method, credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: {'Authorization': `Bearer ${s.token}`, 'X-GradEvidence-Client': CLIENT,
      ...(body ? {'Content-Type': 'application/json'} : {})},
    body: body ? JSON.stringify(body) : undefined});
  const data = await response.json().catch(() => ({}));
  return {status: response.status, ok: response.ok, data, retryAfter: Number(response.headers.get('Retry-After')) || null};
}

/** A token this extension may use: a contributor's, on the direct surface, with a ceiling. */
function contributorToken(me) {
  return me && me.credential_kind === 'contributor' && me.capture_surface === 'source_direct'
    && me.quota && Number.isInteger(me.quota.limit) && me.quota.limit > 0;
}

/** Check a token, learn the collector id every payload must carry, and the remaining quota. */
async function whoami(s) {
  s = s || await settings();
  if (!s.token) throw new Error('还没有填写 token');
  const r = await api('/internal/v1/collector/me', {s});
  const detail = typeof r.data.detail === 'string' ? r.data.detail : '';
  if ((r.status === 403 && /not a contributor token/.test(detail)) || (r.ok && !contributorToken(r.data))) {
    // Never use it: forget any identity learned before, and stop pushing until a token is fixed.
    await updateSettings({collectorId: null, credentialKind: null, label: null, quota: null,
      paused: '此 token 不是贡献者 token，扩展不会用它推送'});
    throw new Error(`此 token 不是贡献者 token${r.ok ? `（类型：${r.data.credential_kind || '未知'}）` : ''}，请使用我们发给你的 gec_ 开头的贡献者 token`);
  }
  if (r.status === 401 || r.status === 403) throw new Error('token 无效或已被停用（' + r.status + '）');
  if (!r.ok) throw new Error(`服务器 ${r.status}: ${r.data.detail || '无法连接'}`);
  const next = await updateSettings({collectorId: r.data.collector_id, credentialKind: r.data.credential_kind,
    label: r.data.label, quota: r.data.quota,
    // After a reinstall the local counter restarts at 0; never reuse a number the server has seen.
    sequence: Math.max(s.sequence || 0, Number(r.data.last_sequence) || 0), paused: null});
  return {...r.data, settings: next};
}

/* ---- local archive and history ----------------------------------------------------------------- */

async function archive(capture, s) {
  if (!s.localArchive) return;
  const index = await store.get('archive_index', []);
  if (!index.includes(capture.capture_id)) {
    index.push(capture.capture_id);
    await store.set(`cap:${capture.capture_id}`, {...capture, saved_at: new Date().toISOString()});
    await store.set('archive_index', index);
  }
}

async function history() { return store.get('history', {}); }
async function remember(capture, patch) {
  const all = await history();
  const key = capture.source_thread_id;
  all[key] = {...(all[key] || {}), title: capture.title, url: capture.observed_url, adapter: capture.adapter,
    at: new Date().toISOString(), ...patch};
  const keys = Object.keys(all);
  if (keys.length > HISTORY_LIMIT) {
    keys.sort((a, b) => String(all[a].at).localeCompare(String(all[b].at)));
    for (const old of keys.slice(0, keys.length - HISTORY_LIMIT)) delete all[old];
  }
  await store.set('history', all);
  return all[key];
}

/** Do not spend quota on what the server already has, or on a poorer copy of it. */
async function pushDecision(capture) {
  const seen = (await history())[capture.source_thread_id];
  if (!seen || !seen.pushed_capture_id) return {push: true};
  if (seen.pushed_capture_id === capture.capture_id) return {push: false, why: 'duplicate'};
  if (seen.pushed_richness && P.compareRichness(P.richness(capture), seen.pushed_richness) < 0) return {push: false, why: 'kept_existing'};
  return {push: true};
}

/* ---- outbox -------------------------------------------------------------------------------------------- */

async function enqueue(capture, s) {
  const outbox = await store.get('outbox', []);
  const queued = outbox.find(e => e.capture_id === capture.capture_id);
  if (queued) return queued;
  if (outbox.length >= MAX_OUTBOX) throw new Error(`待推送队列已满（${MAX_OUTBOX} 条），请先联网推送或检查 token`);
  const sequence = (s.sequence || 0) + 1;
  await updateSettings({sequence});
  const envelope = await P.projectCapture(capture, {collectorId: s.collectorId, collectorSequence: sequence});
  const entry = {...await P.ingestEntry(envelope), capture_id: capture.capture_id, tid: capture.source_thread_id,
    title: capture.title, richness: P.richness(capture), queued_at: new Date().toISOString(), attempts: 0, next_try_at: 0, last_error: null};
  outbox.push(entry);
  // The raw capture stays until delivery even with the local archive off: a retry under a new
  // token or sequence number has to be rebuilt from it.
  if (!(await store.get(`cap:${capture.capture_id}`, null))) await store.set(`cap:${capture.capture_id}`, capture);
  await store.set('outbox', outbox);
  return entry;
}

async function reproject(entry, capture, collectorId) {
  const sequence = ((await settings()).sequence || 0) + 1;
  await updateSettings({sequence});
  const envelope = await P.projectCapture(capture, {collectorId, collectorSequence: sequence});
  return {...entry, ...await P.ingestEntry(envelope)};
}

async function rebuild(entry, capture, s) {
  // Only after the server said the sequence number collides: same capture_uid, next number.
  const fresh = await whoami(s);
  return reproject(entry, capture, fresh.settings.collectorId);
}

async function replaceInOutbox(entry, remove = false) {
  const outbox = (await store.get('outbox', [])).filter(e => e.capture_id !== entry.capture_id);
  if (!remove) outbox.push(entry);
  await store.set('outbox', outbox);
  // Done with it: drop the raw copy unless it is part of the local archive.
  if (remove && !(await store.get('archive_index', [])).includes(entry.capture_id)) await store.remove(`cap:${entry.capture_id}`);
}

/** Send one queued capture. Returns {state, message}; states: stored, duplicate, queued, rejected, paused. */
async function deliver(entry, s, capture = null) {
  if (s.collectorId && entry.payload.collector_id !== s.collectorId) {
    // Queued under a token that has since been replaced: the payload names the old identity.
    capture = capture || await store.get(`cap:${entry.capture_id}`, null);
    if (!capture) {
      await replaceInOutbox(entry, true);
      return {state: 'rejected', message: '换了 token，而这条的本地副本已被清空，无法改用新 token 推送'};
    }
    entry = await reproject(entry, capture, s.collectorId);
    await replaceInOutbox(entry);
  }
  let r;
  try {
    r = await api('/internal/v1/collector/ingest', {method: 'POST', s,
      body: {captures: [{capture_uid: entry.capture_uid, payload_sha256: entry.payload_sha256, payload: entry.payload}]}});
  } catch (e) {
    return backoff(entry, `网络错误：${e.message || e}`);
  }
  const detail = typeof r.data.detail === 'string' ? r.data.detail : JSON.stringify(r.data.detail || '');
  if (r.ok) {
    const receipt = (r.data.receipts || [])[0] || {};
    await replaceInOutbox(entry, true);
    if (r.data.quota) await updateSettings({quota: r.data.quota});
    // Stored, then online on the next worker tick and reviewed there - a partial capture (a
    // locked question, a page with an image, folded text) too, while it has text to show.
    const partial = entry.payload.outcome !== 'captured';
    await remember({source_thread_id: entry.tid, title: entry.title, observed_url: entry.payload.final_url, adapter: entry.payload.extensions.browser.adapter},
      {status: 'pushed', pushed_capture_id: entry.capture_id, pushed_richness: entry.richness, server_capture_id: receipt.server_capture_id ?? null,
       ...freshSite(entry)});
    const left = r.data.quota ? `，今日还可推 ${r.data.quota.remaining} 篇` : '';
    return {state: 'stored', partial, message: partial
      ? `已推送，几分钟内上线并进入人工审核（这页标记为不完整：锁定、含图片或被折叠）${left}`
      : `已推送，几分钟内上线并进入人工审核${left}`};
  }
  if (r.status === 409 && /already has a different hash/.test(detail)) {
    // The server holds this exact capture already (sent before a reinstall, under another number).
    await replaceInOutbox(entry, true);
    await remember({source_thread_id: entry.tid, title: entry.title, observed_url: entry.payload.final_url, adapter: entry.payload.extensions.browser.adapter},
      {status: 'pushed', pushed_capture_id: entry.capture_id, pushed_richness: entry.richness, ...freshSite(entry)});
    return {state: 'duplicate', message: '云端已有这条，未重复推送'};
  }
  if (r.status === 409 && !entry.rebuilt && (capture = capture || await store.get(`cap:${entry.capture_id}`, null))) {
    // The sequence number collides with one the server already holds: renumber once and resend.
    const next = await rebuild({...entry, rebuilt: true}, capture, s);
    await replaceInOutbox(next);
    return deliver(next, await settings(), null);
  }
  if (r.status === 429) {
    const wait = r.retryAfter ? r.retryAfter * 1000 : 3600 * 1000;
    await replaceInOutbox({...entry, next_try_at: Date.now() + wait, last_error: detail});
    await updateSettings({quota: {...(s.quota || {}), remaining: 0}});
    await arm();
    return {state: 'queued', message: `今日推送额度已用完（24 小时内最多 ${(s.quota && s.quota.limit) || 1000} 篇），已排队，额度恢复后自动推送`};
  }
  if (r.status === 403 && /collector_id is outside token scope/.test(detail) && !entry.rebuilt
      && (capture = capture || await store.get(`cap:${entry.capture_id}`, null))) {
    // The token now belongs to another identity than the one this capture was built for.
    const next = await rebuild({...entry, rebuilt: true}, capture, s);
    await replaceInOutbox(next);
    return deliver(next, await settings(), null);
  }
  if (r.status === 401 || (r.status === 403 && TOKEN_REFUSED.test(detail))) {
    // The token itself is refused (wrong, rotated or taken down): stop sending anything.
    await replaceInOutbox({...entry, last_error: detail});
    await updateSettings({paused: `token 被拒绝（${r.status}）：${detail}`.slice(0, 200)});
    return {state: 'paused', message: `token 无效或已停用（${r.status}），已存本地并排队；请在扩展选项检查 token`};
  }
  if (r.status === 422 || r.status === 413 || r.status === 409 || r.status === 403) {
    // This capture is refused (identity, size, scope); the token is fine for the others.
    await replaceInOutbox(entry, true);
    await remember({source_thread_id: entry.tid, title: entry.title, observed_url: entry.payload.final_url, adapter: entry.payload.extensions.browser.adapter},
      {status: 'rejected', error: detail.slice(0, 200)});
    return {state: 'rejected', message: `云端拒收（${r.status}）：${detail}`.slice(0, 200)};
  }
  return backoff(entry, `服务器 ${r.status}: ${detail}`);
}

/** What the site shows is now about this capture: nothing known about it yet but whether it is whole. */
function freshSite(entry) {
  return {capture_uid: entry.capture_uid, site_state: 'queued',
    content_id: null, site_url: null, site_checked_at: null};
}

async function backoff(entry, message) {
  const attempts = (entry.attempts || 0) + 1;
  const minutes = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
  await replaceInOutbox({...entry, attempts, next_try_at: Date.now() + minutes * 60000, last_error: message.slice(0, 200)});
  await arm();
  return {state: 'queued', message: `${message.slice(0, 120)}；已存本地并排队，${minutes} 分钟后自动重试`};
}

async function arm() {
  const outbox = await store.get('outbox', []);
  if (outbox.length) chrome.alarms.create(FLUSH_ALARM, {periodInMinutes: 5});
  else chrome.alarms.clear(FLUSH_ALARM);
}

/** Retry everything that is due. Stops at the first quota or token refusal. */
function flush({force = false} = {}) {
  return locked(async () => {
    let s = await settings();
    const summary = {sent: 0, duplicate: 0, rejected: 0, left: 0, stopped: null};
    const stop = async reason => {
      summary.left = (await store.get('outbox', [])).length;
      summary.stopped = reason;
      return summary;
    };
    if (!s.token) return stop('no_token');
    if (s.paused && !force) return stop(s.paused);
    if (!s.collectorId || s.credentialKind !== 'contributor') {
      // Not yet known to be a contributor's token (e.g. an identity cached by 1.0): check it now,
      // so a queue waiting since before the update is delivered rather than stuck.
      try { s = (await whoami(s)).settings; } catch (e) { return stop(String(e.message || e)); }
    }
    for (const entry of await store.get('outbox', [])) {
      if (!force && entry.next_try_at > Date.now()) continue;
      const result = await deliver(entry, await settings());
      if (result.state === 'stored') summary.sent += 1;
      else if (result.state === 'duplicate') summary.duplicate += 1;
      else if (result.state === 'rejected') summary.rejected += 1;
      else { summary.stopped = result.message; break; }
    }
    summary.left = (await store.get('outbox', [])).length;
    await arm();
    return summary;
  });
}

/* ---- what became of what was pushed ------------------------------------------------------------------ */

/**
 * Ask the server where each push stands: online, waiting, or kept off the site and why.
 *
 * A settled state does not change on its own; everything else is asked again, what is still on
 * its way first (then what is online, which a reviewer can still take down), newest first, up
 * to REFRESH_LIMIT per run in requests of 100. A push the server does not answer for was sent
 * under another identity than this token's: it is marked, not asked about forever.
 */
function refreshStatuses() {
  return locked(async () => {
    const s = await settings();
    if (!s.token || s.credentialKind !== 'contributor') return {checked: 0, stopped: 'no_token'};
    const all = await history();
    const rank = h => OFFLINE.has(h.site_state) ? 2 : h.site_state === 'published' || h.site_state === 'published_other_version' ? 1 : 0;
    // Settled only once the server said so: 1.2.0 stored 'incomplete' itself for every partial
    // push, and those pages are published now.
    const due = Object.entries(all).filter(([, h]) => h.capture_uid && !(SETTLED.has(h.site_state) && h.site_checked_at))
      .sort((a, b) => (rank(a[1]) - rank(b[1])) || String(b[1].at).localeCompare(String(a[1].at)))
      .slice(0, REFRESH_LIMIT);
    if (!due.length) return {checked: 0};
    const now = new Date().toISOString();
    let checked = 0, live = 0, stopped;
    for (let start = 0; start < due.length; start += 100) {
      const batch = due.slice(start, start + 100);
      let r;
      try {
        r = await api(`/internal/v1/collector/captures?ids=${encodeURIComponent(batch.map(([, h]) => h.capture_uid).join(','))}`, {s});
      } catch (e) { stopped = `网络错误：${e.message || e}`; break; }
      if (r.status === 401 || r.status === 403) {
        // The token is refused (taken down or rotated): what was pushed can no longer be asked
        // about with it. Pause pushing too, as deliver does, and say so instead of a bare code.
        const detail = typeof r.data.detail === 'string' ? r.data.detail : '';
        if (r.status === 401 || TOKEN_REFUSED.test(detail)) {
          await updateSettings({paused: `token 被拒绝（${r.status}）：${detail}`.slice(0, 200)});
          stopped = `token 无效或已停用（${r.status}），无法查询上线状态；已推送的内容是否还在网站上以网站为准`;
          break;
        }
      }
      if (!r.ok) { stopped = `服务器 ${r.status}`; break; }
      const byUid = Object.fromEntries((r.data.captures || []).map(c => [c.capture_uid, c]));
      for (const [key, h] of batch) {
        const c = byUid[h.capture_uid];
        all[key] = c
          ? {...h, site_state: c.state, content_id: c.content_id, site_url: c.public && c.content_id ? `${SITE}/content/${c.content_id}` : null, site_checked_at: now}
          : {...h, site_state: 'not_found', content_id: null, site_url: null, site_checked_at: now};
        if (c && c.public) live += 1;
      }
      checked += batch.length;
    }
    await store.set('history', all);
    return {checked, online: live, ...(stopped ? {stopped} : {})};
  });
}

/* ---- one click -------------------------------------------------------------------------------------- */

function sourceURL(raw) {
  try { const u = new URL(raw); return u.protocol === 'https:' && HOSTS.has(u.hostname) ? u : null; } catch { return null; }
}

async function captureTab(tab, mode = 'any') {
  const path = (() => { try { return new URL(tab?.url || '').pathname; } catch { return ''; } })();
  try {
    if (!tab?.id) throw new Error('没有活动标签页');
    if (tab.url && !sourceURL(tab.url)) throw new Error('请在一亩三分地的帖子页点击');
    if (mode === 'home' && !/^\/home\/thread\/\d+/.test(path)) throw new Error('这个快捷键只用于 /home/thread/ 页面');
    if (mode === 'problem' && !/^\/interview\/problems\/company\//.test(path)) throw new Error('这个快捷键只用于 /interview/problems/ 题目页');
    // Read-only, ISOLATED world, only now: the same two files the local-only extension injects.
    await chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'ISOLATED', files: ['common.js', 'extractor.js']});
    const [{result}] = await chrome.scripting.executeScript({
      target: {tabId: tab.id}, world: 'ISOLATED',
      func: allowed => globalThis.GEExtractor.inspect(document, location.href, allowed), args: [ALLOWED],
    });
    if (!result || result.state !== 'ready') throw new Error(`未保存：${result?.reason || 'no_result'}${result?.adapter ? ' [' + result.adapter + ' bodies=' + result.visible_body_roots + ']' : ''}`);
    const p = P.wellFormed(result.capture);
    const capture = {...p, capture_id: await P.sha256Hex(P.fingerprintText(p)), delivery_id: crypto.randomUUID(),
      run_id: RUN_ID, page_instance: crypto.randomUUID(), document_id: null};
    return await locked(() => saveAndPush(capture));
  } catch (e) {
    const message = String(e.message || e);
    await badge(false, message);
    return {ok: false, error: message};
  }
}

async function saveAndPush(capture) {
  let s = await settings();
  await archive(capture, s);
  let local = '';
  if (s.localReceiver) local = await toLocalReceiver(capture);
  const where = s.localArchive ? '已存本地' : '';
  if (!s.token) {
    await remember(capture, {status: 'local_only'});
    await badge(false, `${where}；还没有填写 token，未推送云端（右键图标 → 选项）${local}`, s);
    return {ok: false, state: 'no_token'};
  }
  if (!s.collectorId || s.credentialKind !== 'contributor') {   // also a cache from before 1.1, which never checked
    try { s = (await whoami(s)).settings; } catch (e) {
      await remember(capture, {status: 'local_only'});
      await badge(false, `${where}；${e.message}${local}`, s);
      return {ok: false, state: 'no_identity'};
    }
  }
  const decision = await pushDecision(capture);
  if (!decision.push) {
    const why = decision.why === 'duplicate' ? '这条已经推送过，内容没有变化' : '这条之前推送过更完整的版本，这次不重复推送';
    await badge(true, `${where}；${why} ${capture.source_thread_id}${local}`, s);
    return {ok: true, state: decision.why, thread_id: capture.source_thread_id};
  }
  const entry = await enqueue(capture, s);
  await remember(capture, {status: 'queued'});
  if (s.paused) {
    await badge(false, `${where}并排队；推送已暂停：${s.paused}${local}`, s);
    return {ok: false, state: 'paused'};
  }
  const result = await deliver(entry, await settings(), capture);
  await badge(result.state === 'stored' || result.state === 'duplicate', `${result.message} · ${capture.source_thread_id}${local}`);
  return {ok: result.state === 'stored' || result.state === 'duplicate', state: result.state, thread_id: capture.source_thread_id};
}

async function toLocalReceiver(capture) {
  try {
    const response = await fetch(LOCAL_RECEIVER + '/v1/captures', {method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify(capture)});
    const ack = await response.json().catch(() => ({}));
    return response.ok && ack.durable === true ? ' · 本机接收器已保存' : ` · 本机接收器 ${response.status}`;
  } catch { return ' · 本机接收器未启动'; }
}

/* ---- wiring ------------------------------------------------------------------------------------------- */

chrome.action.onClicked.addListener(tab => { captureTab(tab); });
chrome.commands.onCommand.addListener(async (command, tab) => {
  const mode = {save_home_thread: 'home', save_problem: 'problem'}[command];
  if (!mode) return;
  const target = tab || (await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0];
  captureTab(target, mode);
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === FLUSH_ALARM) flush(); });
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  arm();
});
chrome.runtime.onStartup?.addListener(() => { arm(); });
// The options page talks to the worker; nothing else may (no externally_connectable).
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || (sender.tab && !String(sender.url || '').startsWith(chrome.runtime.getURL('')))) return false;
  const handlers = {
    whoami: () => locked(() => whoami()),
    flush: () => flush({force: true}),
    refresh: () => refreshStatuses(),
    status: async () => ({settings: {...await settings(), token: undefined, hasToken: Boolean((await settings()).token)},
      outbox: (await store.get('outbox', [])).map(({payload, ...rest}) => ({...rest, url: payload.final_url})),
      history: await history(), archived: (await store.get('archive_index', [])).length}),
  };
  const run = handlers[message?.type];
  if (!run) return false;
  run().then(value => reply({ok: true, value}), error => reply({ok: false, error: String(error.message || error)}));
  return true;
});

globalThis.__ge = {captureTab, saveAndPush, flush, refreshStatuses, whoami, deliver, settings, updateSettings, store}; // test hooks (service-worker scope only)
