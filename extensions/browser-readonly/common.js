/* Pure helpers shared by the extension. No page writes, network or secrets. */
(() => {
  'use strict';
  const API = 'http://127.0.0.1:18765';
  const HOSTS = new Set(['www.1point3acres.com', '1point3acres.com']);
  const normalizeText = s => String(s || '').replace(/\r/g, '').replace(/[\t \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  function sourceURL(raw) {
    try {
      const u = new URL(raw);
      return u.protocol === 'https:' && HOSTS.has(u.hostname) && !u.username && !u.password && !u.port ? u : null;
    } catch { return null; }
  }
  function problemIdentity(raw) {
    const u = sourceURL(raw);
    const m = u && u.pathname.match(/^\/interview\/problems\/company\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/);
    return m ? {company: m[1], slug: m[2], url: `https://www.1point3acres.com/interview/problems/company/${m[1]}/${m[2]}`} : null;
  }
  function postIdentity(raw) {
    // /interview/post/<id>: a write-up imported from outside the forum ("nonbbs"); its id is not a thread tid.
    const u = sourceURL(raw);
    const m = u && u.pathname.match(/^\/interview\/post\/(\d+)\/?$/);
    return m ? {id: m[1], url: `https://www.1point3acres.com/interview/post/${m[1]}`} : null;
  }
  function guideIdentity(raw) {
    // /interview/guides/<slug>: an editorial guide (the site's blog), named by its slug. The slug must
    // contain a letter so a guide key can never read as a numeric thread id.
    const u = sourceURL(raw);
    const m = u && u.pathname.match(/^\/interview\/guides\/([a-z0-9][a-z0-9-]{0,119})\/?$/);
    return m && /[a-z]/.test(m[1]) ? {slug: m[1], url: `https://www.1point3acres.com/interview/guides/${m[1]}`} : null;
  }
  function identity(raw) {
    const u = sourceURL(raw);
    if (!u) return null;
    let match = u.pathname.match(/(?:^|\/)thread-(\d+)-(\d+)-\d+\.html$/);
    let tid = match?.[1] || null;
    let page = match ? Number(match[2]) : Number(u.searchParams.get('page') || 1);
    const modern = u.pathname.match(/(?:^|\/)thread\/(\d+)(?:\/|$)/);
    if (modern) tid = modern[1];
    const queryTid = u.searchParams.get('tid');
    if (queryTid && /^\d+$/.test(queryTid)) {
      if (tid && tid !== queryTid) return null;
      if (u.pathname.endsWith('/forum.php') && u.searchParams.get('mod') === 'viewthread') tid = queryTid;
    }
    if (!tid || !Number.isSafeInteger(page) || page < 1 || page > 100000) return null;
    return {tid, page, canonical_url: `https://www.1point3acres.com/bbs/thread-${tid}-1-1.html`};
  }
  function forumId(raw, base) {
    try {
      const u = sourceURL(new URL(raw, base).href);
      if (!u) return null;
      const m = u.pathname.match(/(?:^|\/)forum-(\d+)-\d+\.html$/) || u.pathname.match(/\/home\/forum\/(\d+)(?:\/|$)/);
      const id = m?.[1] || (u.searchParams.get('mod') === 'forumdisplay' ? u.searchParams.get('fid') : null);
      return /^\d+$/.test(id || '') ? id : null;
    } catch { return null; }
  }
  function validateSettings(input) {
    const ids = [...new Set(String(input.allowedForumIds || '').split(/[，,\s]+/).filter(Boolean))];
    if (!ids.length || ids.length > 30 || ids.some(x => !/^(?:\d{1,8}|interview)$/.test(x))) throw new Error('版块 ID 必须是数字（或 interview），用逗号分隔。');
    const token = String(input.token || '').trim();
    if (!/^[A-Za-z0-9_-]{32,200}$/.test(token)) throw new Error('请填写本地接收器生成的配对 Token。');
    const maxItems = Number(input.maxItems || 300);
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 5000) throw new Error('目标数量应为 1–5000。');
    return {allowedForumIds: ids, token, maxItems};
  }
  async function sha256(text) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
  }
  globalThis.GE = Object.freeze({API, HOSTS, normalizeText, sourceURL, identity, problemIdentity, postIdentity, guideIdentity, forumId, validateSettings, sha256,
    VERSION: '0.3.3', MAX_BODY: 180000, MAX_PAYLOAD: 700000, MAX_PENDING: 8});
})();
