'use strict';
// One click = one capture of the active tab. No settings, no pairing, no polling, no importScripts.
const API = 'http://127.0.0.1:18765';
const ALLOWED = ['145', 'interview'];
const HOSTS = new Set(['www.1point3acres.com', '1point3acres.com']);
function sourceURL(raw) {
  try { const u = new URL(raw); return u.protocol === 'https:' && HOSTS.has(u.hostname) ? u : null; } catch { return null; }
}
async function sha256(text) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
}
async function badge(text, color, title) {
  await chrome.action.setBadgeText({text});
  await chrome.action.setBadgeBackgroundColor({color});
  await chrome.action.setTitle({title: title.slice(0, 200)});
  // The icon itself turns green/red for 2 s (more visible than the badge), then returns to neutral.
  await chrome.action.setIcon({path: text === '✓' ? 'icon-ok.png' : 'icon-err.png'}).catch(() => {});
  setTimeout(() => { chrome.action.setBadgeText({text: ''}).catch(() => {}); chrome.action.setIcon({path: 'icon.png'}).catch(() => {}); }, 2000);
  // A system notification too, so the result is visible even when the icon is not pinned to the toolbar.
  try {
    chrome.notifications.create(`ge-${Date.now()}`, {type: 'basic', iconUrl: chrome.runtime.getURL('icon.png'), title: text === '✓' ? 'GradEvidence 已保存' : 'GradEvidence 未保存',
      message: title.slice(0, 180), priority: 1}, () => { if (chrome.runtime.lastError) report('notify_failed', chrome.runtime.lastError.message, ''); });
  } catch {}
}
async function report(event, reason, path) {
  // Diagnostics only: event name, reason and URL path. Never page content.
  try { await fetch(API + '/v1/events', {method: 'POST', credentials: 'omit', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({event, reason: String(reason).slice(0, 200), path: String(path || '').slice(0, 120)})}); } catch {}
}
async function captureTab(tab, mode = 'any') {
  const path = (() => { try { return new URL(tab?.url || '').pathname; } catch { return ''; } })();
  await report('click', {home: 'shortcut_home', problem: 'shortcut_problem'}[mode] || 'clicked', path);
  try {
    if (!tab?.id) throw new Error('没有活动标签页');
    if (tab.url && !sourceURL(tab.url)) throw new Error('请在一亩三分地的帖子页点击');
    if (mode === 'home' && !/^\/home\/thread\/\d+/.test(path)) throw new Error('⌘⇧H 只用于 /home/thread/ 页面；面经页请用 ⌘⇧S');
    if (mode === 'problem' && !/^\/interview\/problems\/company\//.test(path)) throw new Error('⌘⇧P 只用于 /interview/problems/ 题目页');
    await chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'ISOLATED', files: ['common.js', 'extractor.js']});
    const [{result}] = await chrome.scripting.executeScript({
      target: {tabId: tab.id}, world: 'ISOLATED',
      func: allowed => globalThis.GEExtractor.inspect(document, location.href, allowed), args: [ALLOWED],
    });
    if (!result || result.state !== 'ready') throw new Error(`未保存：${result?.reason || 'no_result'}${result?.adapter ? ' [' + result.adapter + ' bodies=' + result.visible_body_roots + ']' : ''}`);
    const p = result.capture;
    const fingerprint = JSON.stringify([p.source, p.source_thread_id, p.source_post_id, p.forum_id, p.capture_scope,
      p.title, p.body_text, p.completeness, [...(p.completeness_flags || [])].sort()]);
    const payload = {...p, capture_id: await sha256(fingerprint), delivery_id: crypto.randomUUID(),
      run_id: '00000000-0000-4000-8000-000000000001', page_instance: crypto.randomUUID(), document_id: null};
    const response = await fetch(API + '/v1/captures', {method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
    const ack = await response.json().catch(() => ({}));
    if (!response.ok || ack.durable !== true) throw new Error(`本机接收器 ${response.status}: ${ack.error || '保存失败'}`);
    const words = {saved: '已保存', updated: '已更新（信息更多，覆盖旧版）', kept_existing: '内容不如已有记录，保留旧版', duplicate: '重复，已有相同记录',
      partial_saved: '已保存（不完整）', partial_duplicate: '重复的不完整记录'};
    const pipe = ack.pipeline ? (ack.pipeline.stored ? '已进 pipeline' : `pipeline 未写入：${ack.pipeline.reason}`) : '';
    await badge('✓', '#0a8f2f', `${words[ack.status] || ack.status} ${p.source_thread_id}${pipe ? ' · ' + pipe : ''}`);
    return {ok: true, thread_id: p.source_thread_id, status: ack.status, pipeline: ack.pipeline || null};
  } catch (e) {
    await report('failed', e.message || e, path);
    await badge('!', '#d0021b', String(e.message || e));
    return {ok: false, error: String(e.message || e)};
  }
}
chrome.action.onClicked.addListener(tab => { captureTab(tab); });
chrome.commands.onCommand.addListener(async (command, tab) => {
  const mode = {save_home_thread: 'home', save_problem: 'problem'}[command];
  if (!mode) return;
  const target = tab || (await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0];
  captureTab(target, mode);
});
globalThis.__geCaptureTab = captureTab; // test hook (service-worker scope only)
