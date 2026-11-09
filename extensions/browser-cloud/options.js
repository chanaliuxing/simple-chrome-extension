'use strict';
/* The settings page. It edits chrome.storage.local directly (a trusted extension page) and asks
   the service worker to test the token and to retry the outbox. It never touches the forum. */
const $ = id => document.getElementById(id);
const STATUS = {pushed: '已入库', queued: '排队推送', rejected: '云端拒收', local_only: '只存本地'};
// Where a pushed page stands on the site (GET /internal/v1/collector/captures).
const SITE_STATE = {
  queued: '处理中', parse_failed: '处理失败', cancelled: '已取消', published: '已上线',
  published_other_version: '已上线（网站显示另一版本）', hidden: '已被隐藏', withdrawn: '已下线',
  incomplete: '没有可显示的正文，不会公开', teaser: '只有预告，不公开', mirror_evidence: '不公开', not_current: '有更新的版本',
  waiting: '等待上线（几分钟内）', awaiting_classification: '等待上线', awaiting_operator: '等待运营发布',
  no_page: '已处理，没有可显示的正文', not_validated: '不公开', sender_revoked: 'token 已停用，不会上线',
  not_found: '不是这个 token 推送的', source_disabled: '来源已停用，暂不上线',
};

function show(id, ok, text) {
  const node = $(id);
  node.className = `result ${ok ? 'ok' : 'err'}`;
  node.textContent = text;
}
function ask(type) {
  return new Promise(resolve => chrome.runtime.sendMessage({type}, reply => resolve(reply || {ok: false, error: chrome.runtime.lastError?.message || '无响应'})));
}
async function settings() { return (await chrome.storage.local.get('settings')).settings || {}; }
function cell(text) { const td = document.createElement('td'); td.textContent = text ?? ''; return td; }
function row(cells, head = false) {
  const tr = document.createElement('tr');
  for (const text of cells) { const c = head ? document.createElement('th') : cell(text); if (head) c.textContent = text; tr.append(c); }
  return tr;
}
function quotaText(quota) {
  if (!quota) return '不限额';
  return `24 小时内已推 ${quota.used} / ${quota.limit} 篇，还可推 ${quota.remaining} 篇${quota.next_slot_at ? `（${new Date(quota.next_slot_at).toLocaleString()} 起恢复）` : ''}`;
}

async function load() {
  const s = await settings();
  $('token').value = s.token || '';
  $('apiBase').value = s.apiBase || 'https://api.gradevidence.click';
  $('localArchive').checked = s.localArchive !== false;
  $('localReceiver').checked = Boolean(s.localReceiver);
  $('notifications').checked = s.notifications !== false;
  if (s.label) show('who', !s.paused, `${s.label}\n${quotaText(s.quota)}${s.paused ? `\n推送已暂停：${s.paused}` : ''}`);
  await refresh();
}

async function refresh() {
  const reply = await ask('status');
  if (!reply.ok) { $('outboxSummary').textContent = reply.error; return; }
  const {outbox, history, archived} = reply.value;
  $('outboxSummary').textContent = outbox.length ? `${outbox.length} 条等待推送（断网、额度用完或 token 有问题时会排在这里，恢复后自动推送）` : '没有等待推送的记录。';
  const ob = $('outbox');
  ob.replaceChildren();
  if (outbox.length) ob.append(row(['标题', '编号', '尝试', '下次重试', '原因'], true));
  for (const e of outbox) {
    ob.append(row([e.title, e.tid, e.attempts, e.next_try_at ? new Date(e.next_try_at).toLocaleString() : '现在', e.last_error || '']));
  }
  const entries = Object.entries(history).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
  $('historySummary').textContent = `共 ${entries.length} 个页面，显示最近 50 个。`;
  const table = $('history');
  table.replaceChildren();
  if (entries.length) table.append(row(['时间', '推送', '网站', '标题', '编号'], true));
  for (const [tid, h] of entries.slice(0, 50)) {
    const tr = row([new Date(h.at).toLocaleString(), STATUS[h.status] || h.status, '', '', tid]);
    const site = tr.children[2];
    if (h.site_url) {
      const view = document.createElement('a');
      view.href = h.site_url; view.textContent = SITE_STATE[h.site_state] || h.site_state; view.target = '_blank'; view.rel = 'noreferrer';
      site.append(view);
    } else {
      site.textContent = h.status === 'pushed' ? (SITE_STATE[h.site_state] || '未知') : '—';
    }
    site.className = 'status';
    const link = document.createElement('a');
    link.href = h.url || '#'; link.textContent = h.title || h.url || tid; link.target = '_blank'; link.rel = 'noreferrer';
    tr.children[3].append(link);
    if (h.error) tr.children[1].title = h.error;
    tr.children[1].className = 'status';
    table.append(tr);
  }
  $('archiveSummary').textContent = `浏览器本地保存了 ${archived} 条采集记录。`;
}

$('save').addEventListener('click', async () => {
  const token = $('token').value.trim();
  const apiBase = $('apiBase').value.trim() || 'https://api.gradevidence.click';
  const s = await settings();
  const changed = token !== s.token || apiBase !== s.apiBase;
  await chrome.storage.local.set({settings: {...s, token, apiBase,
    ...(changed ? {collectorId: null, credentialKind: null, label: null, quota: null, paused: null} : {})}});
  if (!token) { show('who', false, '已清除 token；之后只保存到本地。'); return; }
  const reply = await ask('whoami');
  if (!reply.ok) { show('who', false, `连接失败：${reply.error}`); return; }
  show('who', true, `连接成功：${reply.value.label}\n${quotaText(reply.value.quota)}`);
  const flushed = await ask('flush');
  if (flushed.ok && (flushed.value.sent || flushed.value.duplicate)) show('flushResult', true, `已补推 ${flushed.value.sent} 条`);
  await refresh();
});

$('saveOptions').addEventListener('click', async () => {
  const s = await settings();
  await chrome.storage.local.set({settings: {...s, localArchive: $('localArchive').checked,
    localReceiver: $('localReceiver').checked, notifications: $('notifications').checked}});
  show('optionsResult', true, '已保存。');
});

$('refreshStatus').addEventListener('click', async () => {
  const reply = await ask('refresh');
  if (!reply.ok) { show('statusResult', false, reply.error); return; }
  const v = reply.value;
  show('statusResult', !v.stopped, v.stopped ? `没有刷新：${v.stopped === 'no_token' ? '还没有可用的 token' : v.stopped}`
    : `已查询 ${v.checked} 条，其中 ${v.online || 0} 条已上线`);
  await refresh();
});

$('flush').addEventListener('click', async () => {
  const reply = await ask('flush');
  if (!reply.ok) { show('flushResult', false, reply.error); return; }
  const v = reply.value;
  show('flushResult', !v.stopped, `推送 ${v.sent} 条，云端已有 ${v.duplicate} 条，拒收 ${v.rejected} 条，剩余 ${v.left} 条${v.stopped ? `\n停止原因：${v.stopped === 'no_token' ? '还没有可用的 token' : v.stopped}` : ''}`);
  await refresh();
});

$('export').addEventListener('click', async () => {
  const index = (await chrome.storage.local.get('archive_index')).archive_index || [];
  if (!index.length) { show('dataResult', false, '本地还没有记录。'); return; }
  const lines = [];
  for (let i = 0; i < index.length; i += 200) {
    const keys = index.slice(i, i + 200).map(id => `cap:${id}`);
    const chunk = await chrome.storage.local.get(keys);
    for (const key of keys) if (chunk[key]) lines.push(JSON.stringify(chunk[key]));
  }
  const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], {type: 'application/x-ndjson'}));
  const a = document.createElement('a');
  a.href = url; a.download = `gradevidence-captures-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  show('dataResult', true, `已导出 ${lines.length} 条（ge.browser_capture.v2 格式）。`);
});

$('clear').addEventListener('click', async () => {
  if (!confirm('清空浏览器本地保存的全部采集记录？已推送到云端的内容不受影响；待推送队列保留。')) return;
  const {archive_index: index = [], outbox = []} = await chrome.storage.local.get(['archive_index', 'outbox']);
  // A capture still waiting to be pushed keeps its copy: a retry may need to rebuild it.
  const waiting = new Set(outbox.map(e => e.capture_id));
  const drop = index.filter(id => !waiting.has(id));
  await chrome.storage.local.remove(drop.map(id => `cap:${id}`));
  await chrome.storage.local.set({archive_index: index.filter(id => waiting.has(id))});
  show('dataResult', true, `已清空 ${drop.length} 条本地记录${waiting.size ? `（${waiting.size} 条待推送的保留到推送完成）` : ''}。`);
  await refresh();
});

load().then(() => ask('refresh')).then(refresh);
