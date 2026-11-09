/* Read-only DOM adapter. Deliberately never uses message_html/message_bbcode,
   document.cookie, page fetch, MAIN-world injection, DOM attributes as markers,
   or the complete document HTML. Only selected metadata and rendered main text.

   Adapters:
   - discuz_visible_dom_v1   classic thread-<tid>-1-1.html pages (#postmessage_<pid>)
   - next_visible_dom_v1     /home/thread/<tid> pages with dehydrated thread metadata
   - interview_visible_dom_v1 /interview/thread/<tid> pages (client-rendered; the main
     post id is NOT observable in the DOM, so source_post_id is null and must be
     resolved downstream; the structured classification line IS observable).
   - interview_guide_v1       /interview/guides/<slug> editorial guides (the site's blog). */
(() => {
  'use strict';
  const G = globalThis.GE;
  const ROOTS = '.bbcode-container, [id^="postmessage_"]';
  const CRUMBS = '#pt a, nav[aria-label*="breadcrumb" i] a, [aria-label*="面包屑"] a, [itemtype$="BreadcrumbList"] a, [data-testid*="breadcrumb" i] a';
  const RESTRICT = /本帖隐藏的内容|您需要登录才可以|需要.*(?:积分|大米).*才能|权限不足|无权访问|回复.*(?:可见|查看)|购买.*(?:可见|查看)|内容已隐藏|hidden content|insufficient (?:permission|credits)|login to (?:view|read)/i;
  const SCHEMA = 'ge.browser_capture.v2';
  function visible(el) {
    if (!el || !el.isConnected || el.closest('[hidden], [aria-hidden="true"]')) return false;
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || Number(s.opacity) === 0) return false;
    }
    return el.getClientRects().length > 0;
  }
  function nextData(doc) {
    try {
      const node = doc.querySelector('#__NEXT_DATA__');
      if (!node || node.textContent.length > 8000000) return null;
      return JSON.parse(node.textContent);
    } catch { return null; }
  }
  function metadata(doc, tid) {
    // Only the known, matching query is inspected; message/auth fields are never read or exported.
    try {
      const json = nextData(doc);
      const queries = json?.props?.pageProps?.dehydratedState?.queries || [];
      for (const q of queries) {
        const t = q?.state?.data?.thread;
        if (t && String(t.tid) === tid) {
          const fid = t.fid ?? t.forum?.fid ?? q.state.data.forum?.fid;
          const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
          return {tid, pid: /^\d+$/.test(String(t.pid)) ? String(t.pid) : null,
            fid: /^\d+$/.test(String(fid)) ? String(fid) : null,
            title: typeof t.subject === 'string' ? t.subject.slice(0, 1000) : '',
            published: unixDate(t.dateline),
            // Observed thread metadata (no message fields): used downstream for update time, coverage and category.
            meta: {sortid: t.sortid == null ? null : String(t.sortid).slice(0, 20), typeid: t.typeid == null ? null : String(t.typeid).slice(0, 20),
              forum_name: typeof t.forum_name === 'string' ? t.forum_name.slice(0, 60) : null,
              tags: Array.isArray(t.tags) ? t.tags.slice(0, 20).map(x => String(typeof x === 'object' && x ? (x.displayname ?? x.name ?? x.tagname ?? x.tag ?? JSON.stringify(x)) : x).slice(0, 60)) : null,
              replies: num(t.replies), views: num(t.views), lastpost_utc: unixDate(t.lastpost), anonymous: t.anonymous == null ? null : Boolean(Number(t.anonymous)),
              company_widget: t.widget?.company && typeof t.widget.company === 'object' ? {
                name: typeof t.widget.company.name === 'string' ? t.widget.company.name.slice(0, 120) : null,
                company_id: t.widget.company.bbs_company_id == null ? null : String(t.widget.company.bbs_company_id).slice(0, 20),
                industry: typeof t.widget.company.industry === 'string' ? t.widget.company.industry.slice(0, 120) : null,
                region: typeof t.widget.company.region === 'string' ? t.widget.company.region.slice(0, 120) : null,
              } : null}};
        }
      }
    } catch { /* Unsupported/malformed metadata is not a reason to export the raw script. */ }
    return null;
  }
  function viewerLoggedIn(doc) {
    // Boolean only. The account record itself is never copied or exported.
    try {
      const json = nextData(doc);
      const queries = json?.props?.pageProps?.trpcState?.json?.queries || json?.props?.pageProps?.dehydratedState?.queries || [];
      const me = queries.find(q => JSON.stringify(q?.queryKey || '').includes('"me"'));
      return me ? Number(me?.state?.data?.uid) > 0 : null;
    } catch { return null; }
  }
  function unixDate(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 946684800 || n > 4102444800) return null;
    return new Date(n * 1000).toISOString();
  }
  // /home/thread after client-side navigation: __NEXT_DATA__ still describes the first page, so forum, author and
  // time are read from the thread card header ("<author> · <time> · 发布于<forum>版"). The main post id is not visible there.
  function homeHeader(doc, roots, href) {
    const root = roots.find(x => x.matches('.bbcode-container'));
    const card = root?.closest('.bg-card');
    if (!root || !card) return null;
    const link = [...card.querySelectorAll('a[href*="/home/forum/"]')].filter(visible)
      .find(a => (a.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING) && /版$/.test(G.normalizeText(a.innerText || '')));
    const fid = link ? G.forumId(link.getAttribute('href'), href) : null;
    if (!fid) return null;
    const line = link.closest('div.flex') || link.parentElement;
    const time = line?.querySelector('time');
    const timeText = time ? G.normalizeText(time.innerText || '').slice(0, 40) : null;
    const parts = G.normalizeText(line?.innerText || '').split(/\s*·\s*|\n/).map(s => s.trim()).filter(Boolean);
    const author = parts[0] && parts[0] !== timeText && !/^发布于/.test(parts[0]) ? parts[0].slice(0, 120) : null;
    return {fid, author, time_display: timeText, root};
  }
  function breadcrumbs(doc, url) {
    const out = [];
    for (const a of doc.querySelectorAll(CRUMBS)) {
      if (!visible(a)) continue;
      const fid = G.forumId(a.getAttribute('href'), url);
      if (fid) out.push({forum_id: fid, label: G.normalizeText(a.innerText).slice(0, 100)});
    }
    return out.slice(0, 12);
  }
  function blocked(doc, hasBody) {
    const title = doc.title || '';
    const blocker = [...doc.querySelectorAll('#challenge-running, #challenge-stage, #cf-challenge-running, #messagetext, [role="alert"], [role="dialog"]')]
      .filter(visible).map(x => (x.innerText || '').slice(0, 4000)).join('\n');
    const text = title + '\n' + blocker + (!hasBody ? (doc.body?.innerText || '').slice(0, 6000) : '');
    if (/Just a moment|Performing security verification|Verify you are human|Checking your browser|请完成.{0,8}验证|人机验证|安全验证/i.test(text)) return 'human_verification';
    if (/too many requests|请求过于频繁|访问过于频繁|操作过于频繁|请求频繁/i.test(text)) return 'rate_limited';
    if (/account.{0,20}(?:suspended|disabled)|账号.{0,12}(?:封禁|停用)|账户.{0,12}(?:封禁|停用)|您的IP地址不在允许范围/i.test(text)) return 'account_blocked';
    if (!hasBody && /请先登录|您需要登录|登录后.{0,6}查看|sign in to continue|login required/i.test(text)) return 'login_required';
    return null;
  }
  // Site-injected promo blocks inside the post body (e.g. the ByteByteGo card) are not the author's text.
  const PROMO = /bytebytego\.com|使用论坛独家优惠码|Ace Every Stage of Your Next Technical Interview/i;
  // textContent has no line breaks, so each promo sentence is matched on its own (never "to end of line").
  const PROMO_LINES = /💡?\s*看图就懂系统设计[^。]{0,60}。?|点击查看 ?ByteByteGo[^。]{0,60}。?|使用折扣码[^!！]{0,60}[!！]?|System Design · Coding · Behavioral · Machine Learning Interviews|Ace Every Stage of Your Next Technical Interview|bytebytego\.com|💡?\s*使用论坛独家优惠码[^!！]{0,80}[!！]?/gi;
  function isPromo(el) {
    if (el === undefined || el === null) return false;
    const text = el.textContent || '';
    if (text.length > 800) return false;
    const hasPromo = PROMO.test(text) || [...el.querySelectorAll('a[href]')].some(a => /bytebytego/i.test(a.getAttribute('href') || ''));
    if (!hasPromo) return false;
    // Only a block that is (almost) nothing but the promo card is skipped; a short post wrapping the card keeps its own text.
    const residual = text.replace(PROMO_LINES, '').replace(/[\s💡]+/g, '');
    return residual.length < 2;
  }
  function renderedText(root, {tableCells = false} = {}) {
    const parts = [];
    // Text nodes only: no reading of inputs, textarea values, scripts or hidden descendants.
    function walk(n) {
      if (n.nodeType === Node.TEXT_NODE) { parts.push(n.nodeValue); return; }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|INPUT|TEXTAREA|SELECT|BUTTON|IFRAME|OBJECT|EMBED)$/.test(n.tagName) || !visible(n)) return;
      if (n !== root && isPromo(n)) return;
      if (n.tagName === 'BR') { parts.push('\n'); return; }
      const block = /^(P|DIV|LI|UL|OL|H[1-6]|PRE|BLOCKQUOTE|TABLE|TR|SECTION|ARTICLE)$/.test(n.tagName);
      if (block) parts.push('\n');
      // Opt-in so existing adapters keep byte-identical bodies (and fingerprints): guides carry
      // data tables whose cells would otherwise run together ("列1列2").
      if (tableCells && /^(TD|TH)$/.test(n.tagName) && n.previousElementSibling) parts.push(' | ');
      for (const child of n.childNodes) walk(child);
      if (block) parts.push('\n');
    }
    walk(root);
    return G.normalizeText(parts.join(''));
  }
  function cleanObservedURL(href) {
    const u = new URL(href); u.hash='';
    for(const k of [...u.searchParams.keys()]) if(!['mod','tid','page'].includes(k))u.searchParams.delete(k);
    return u.href;
  }
  function completenessFlags(root, text, doc) {
    const flags = [];
    if (RESTRICT.test(text) || [...root.querySelectorAll('.locked, .showhide, .hidepay, [data-restricted]')].some(visible)) flags.push('access_restriction_visible');
    if ([...root.querySelectorAll('img, canvas, svg, video, audio, iframe')].some(visible)) flags.push('non_text_media_not_captured');
    if ([...root.querySelectorAll('button, a, [role="button"]')].filter(visible).some(x => /^(?:展开全文|查看全文|显示更多|read more|show more)$/i.test(G.normalizeText(x.innerText)))) flags.push('expand_control_visible');
    // Clipping inside the post (overflow/line-clamp on the body or its descendants) hides text we would miss.
    // Ancestors are site layout containers (scroll areas), so only line-clamp counts for them.
    const inner = [root, ...root.querySelectorAll('*')].filter(visible);
    const clipped = inner.some(p => { const s = getComputedStyle(p); return Number(s.webkitLineClamp) > 0 || (/(hidden|clip)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 3); });
    let ancestorClamp = false;
    for (let p = root.parentElement; p && p !== doc.body; p = p.parentElement) if (Number(getComputedStyle(p).webkitLineClamp) > 0) ancestorClamp = true;
    if (clipped || ancestorClamp) flags.push('body_css_clipped');
    return flags;
  }
  function baseCapture(id, href, adapter) {
    return {
      schema_version: SCHEMA, source: '1point3acres', capture_surface: 'source_direct',
      capture_method: 'chrome_readonly_extension', collector_version: G.VERSION, adapter,
      source_thread_id: id.tid, canonical_url: id.canonical_url, observed_url: cleanObservedURL(href),
      body_format: 'text', capture_scope: 'main_post_visible_text',
      source_section: null, author_name: null, company_name: null, category_track: null, classification: null,
      published_at_display: null, published_at_utc_inferred: null, time_zone_basis: null,
      viewer_logged_in: null, extract_duration_ms: 0, thread_meta: null, problem: null, post_meta: null, guide: null,
    };
  }
  // ---- /interview/thread/<tid> (client-rendered React page) ----
  function classification(node) {
    if (!node) return null;
    const leaves = [...node.querySelectorAll('span')].filter(s => s.children.length === 0 && visible(s));
    const text = t => G.normalizeText(t).replace(/^\|\s*/, '').trim();
    const c = {period: null, track: null, degree: null, job_type: null, company: null, result: null, applicant_status: null, raw_text: G.normalizeText(node.innerText).slice(0, 300)};
    const plain = [];
    for (const s of leaves) {
      const cls = s.classList, t = text(s.innerText);
      if (!t || t === '@') continue;
      if (cls.contains('text-green')) c.track = t;
      else if (cls.contains('text-orange')) c.company = t;
      else if (cls.contains('text-blue-500')) c.job_type = t;
      else if ([...cls].some(k => /^text-purple/.test(k))) c.result = t;
      else if (cls.contains('text-muted-foreground') && /^\d{4}/.test(t)) c.period = t;
      else if (cls.contains('font-bold') && cls.contains('ml-1')) c.degree = t;
      else plain.push(t);
    }
    if (plain.length) c.applicant_status = plain[plain.length - 1].slice(0, 40);
    for (const k of Object.keys(c)) if (typeof c[k] === 'string') c[k] = c[k].slice(0, 120);
    return c;
  }
  function displayedTime(node) {
    const raw = G.normalizeText(node?.getAttribute('title') || node?.textContent || '');
    const m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return {display: raw || null, utc: null};
    // The site renders the viewer's local time; the browser's zone is the only honest basis.
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
    return {display: raw, utc: Number.isFinite(d.getTime()) ? d.toISOString() : null};
  }
  function inspectInterview(doc, href, id, allowedIds, started, canonicalStale = false) {
    const bodies = [...doc.querySelectorAll('.bbcode-container')].filter(visible);
    const diagnostic = {thread_id: id.tid, forum_id: null, visible_body_roots: bodies.length, adapter: 'interview_visible_dom_v1'};
    if (!allowedIds.includes('interview')) return {state: 'not_target', reason: 'forum_not_allowed', ...diagnostic};
    const root = bodies[0] || null;
    if (!root) return {state: 'waiting', reason: 'main_post_not_ready_or_unsupported', ...diagnostic};
    let container = root;
    while (container && container !== doc.body && !(container.matches('div.mx-auto.w-full.max-w-3xl') && container.querySelector('time'))) container = container.parentElement;
    if (!container || container === doc.body) { container = root; while (container.parentElement && container.parentElement !== doc.body && !container.querySelector('time')) container = container.parentElement; }
    const header = container.querySelector('div.border-b') || container;
    const titleNode = [...container.querySelectorAll('div.text-lg.font-medium')].find(visible);
    // The rendered header is the title; document.title (site-generated SEO string) is only a fallback.
    const title = (G.normalizeText(titleNode?.innerText || '') || G.normalizeText((doc.title || '').split(' - ')[0]) || `thread ${id.tid}`).slice(0, 1000);
    const text = renderedText(root);
    if (!text) return {state: 'waiting', reason: 'visible_body_empty', ...diagnostic};
    if (text.length > G.MAX_BODY) return {state: 'unsupported', reason: 'body_size_limit_no_truncation', ...diagnostic};
    const flags = completenessFlags(root, text, doc);  // clipping only marks the record partial; it never blocks saving
    const time = displayedTime(header?.querySelector('time'));
    const meta = [...container.querySelectorAll('div.text-muted-foreground.mb-4')].find(visible) || null;
    const card = container.querySelector('div.rounded-lg.border.bg-card div.font-semibold');
    const cls = classification(meta);
    const capture = {
      ...baseCapture(id, href, 'interview_visible_dom_v1'),
      source_post_id: null, forum_id: null, source_section: 'interview',
      source_pointer: '.bbcode-container:first-visible',
      title, body_text: text,
      completeness: flags.length ? 'partial' : 'complete_visible', completeness_flags: flags,
      source_published_at: time.utc, breadcrumbs: [],
      identity_evidence: canonicalStale ? 'url_interview_thread_visible_dom_no_main_pid;head_canonical_stale' : 'url_interview_thread_visible_dom_no_main_pid',
      author_name: G.normalizeText(header?.querySelector('div.font-semibold')?.innerText || '').slice(0, 120) || null,
      company_name: G.normalizeText(card?.innerText || '').slice(0, 120) || null,
      category_track: cls?.track || null, classification: cls,
      published_at_display: time.display, published_at_utc_inferred: time.utc,
      time_zone_basis: time.utc ? `site displays viewer local time; converted with browser zone ${Intl.DateTimeFormat().resolvedOptions().timeZone}` : null,
      viewer_logged_in: viewerLoggedIn(doc),
      extract_duration_ms: Math.max(0, Math.round(performance.now() - started)),
      captured_at: new Date().toISOString(),
    };
    return {state: 'ready', reason: flags.length ? 'partial_visible_main_post' : 'visible_main_post_ready', ...diagnostic, capture};
  }
  // ---- /interview/problems/company/<company>/<slug> (question bank entry, not a thread) ----
  function jsonLd(doc, url) {
    // The QAPage JSON-LD is re-rendered on client-side navigation (unlike __NEXT_DATA__); only trust the one whose url is this page.
    for (const node of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const j = JSON.parse(node.textContent);
        const me = j?.mainEntity;
        if (j?.['@type'] === 'QAPage' && me && typeof me === 'object' && String(me.url || '').replace(/\/$/, '') === url) return me;
      } catch { /* ignore malformed */ }
    }
    return null;
  }
  function companyFromTitle(title) {
    const m = String(title || '').match(/—\s*(.+?)\s+Interview Question/);
    return m ? m[1] : null;
  }
  function inspectProblem(doc, href, pid, allowedIds, started) {
    const diagnostic = {thread_id: null, forum_id: null, visible_body_roots: doc.querySelectorAll('article').length, adapter: 'interview_problem_v1'};
    if (!allowedIds.includes('interview')) return {state: 'not_target', reason: 'forum_not_allowed', ...diagnostic};
    const key = `${pid.company}/${pid.slug}`;  // identity is the URL; the question-bank ULID is only visible on a fresh page load
    const json = nextData(doc);
    const pp = json?.props?.pageProps || {};
    const queries = pp?.trpcState?.json?.queries || [];
    const data = queries.find(q => JSON.stringify(q?.queryKey || '').includes('getQbankQuestion'))?.state?.data;
    // After in-site (client-side) navigation __NEXT_DATA__ still describes the page that was loaded first, so use it only when it is this page's.
    const fresh = data?.question && typeof data.question === 'object' && String(data.question.slug) === pid.slug && String(data.bank?.company || pp.company) === pid.company;
    const q = fresh ? data.question : {}, bank = fresh ? data.bank : null;
    const qid = fresh && /^[0-9a-z]{16,40}$/.test(String(q.id || '')) ? String(q.id) : null;
    const ld = jsonLd(doc, pid.url);
    const article = [...doc.querySelectorAll('article')].find(visible);
    if (!article && !fresh) return {state: 'waiting', reason: 'main_post_not_ready_or_unsupported', ...diagnostic};
    const body = fresh ? G.normalizeText(String(q.body || '')) : '';
    const rendered = article ? renderedText(article) : '';
    const text = body || rendered;
    if (!text) return {state: 'waiting', reason: 'visible_body_empty', ...diagnostic};
    if (text.length > G.MAX_BODY) return {state: 'unsupported', reason: 'body_size_limit_no_truncation', ...diagnostic};
    const str = v => (typeof v === 'string' ? v.slice(0, 200) : v == null ? null : String(v).slice(0, 200));
    const list = v => (Array.isArray(v) ? v.slice(0, 40).map(x => String(typeof x === 'object' && x ? (x.displayname ?? x.name ?? x.tagname ?? JSON.stringify(x)) : x).slice(0, 80)) : null);
    const sources = Array.isArray(q.sources) ? q.sources.slice(0, 100).map(x => ({tid: /^\d+$/.test(String(x?.tid)) ? String(x.tid) : null, url: str(x?.url), title: str(x?.title), badge: str(x?.badge)})) : [];
    const h1 = G.normalizeText(String(doc.querySelector('h1')?.innerText || ''));
    const keywords = typeof ld?.keywords === 'string' ? ld.keywords.split(',').map(x => x.trim()).filter(Boolean).slice(0, 40) : null;
    const problem = {
      id: qid, id_source: qid ? 'next_data' : 'unobservable_after_client_navigation', slug: pid.slug, company: pid.company,
      company_display: str(bank?.display_name || (fresh ? pp.bankName : null) || companyFromTitle(doc.title)),
      category: str(q.category || (fresh ? pp.category : null) || (keywords && keywords.find(k => /^(coding|system-design|system design|behavioral|ml|sql)$/i.test(k))) || null),
      frequency: str(q.frequency), status: str(q.status),
      reported_from: str(q.reported_from), reported_to: str(q.reported_to), last_asked: str(q.last_asked),
      duration_minutes: Number.isFinite(Number(q.duration_minutes)) && q.duration_minutes !== null ? Number(q.duration_minutes) : null,
      overview: typeof q.overview === 'string' ? q.overview.slice(0, 2000) : null,
      roles: list(q.roles), stages: list(q.stages), tags: list(q.tags) || keywords, page_tags: fresh ? list(pp.tags) : keywords, page_roles: fresh ? list(pp.roles) : null,
      source_count: Number.isFinite(Number(q.source_count)) ? Number(q.source_count) : (fresh && Number.isFinite(Number(pp.sourceCount)) ? Number(pp.sourceCount) : null),
      sources, is_locked: q.is_locked == null ? (fresh ? null : (ld && typeof ld.isAccessibleForFree === 'boolean' ? !ld.isAccessibleForFree : null)) : Boolean(q.is_locked),
      is_public: q.is_public == null ? null : Boolean(q.is_public), is_new: q.is_new == null ? null : Boolean(q.is_new),
      body_markup: body ? 'markdown' : 'rendered_text', rendered_text_chars: rendered.length,
    };
    const flags = [];
    if (problem.is_locked) flags.push('access_restriction_visible');
    if (article && [...article.querySelectorAll('img, canvas, svg, video, audio, iframe')].some(visible)) flags.push('non_text_media_not_captured');
    return {state: 'ready', reason: flags.length ? 'partial_visible_main_post' : 'visible_main_post_ready', ...diagnostic, thread_id: key, capture: {
      ...baseCapture({tid: key, canonical_url: pid.url}, href, 'interview_problem_v1'),
      source_post_id: null, forum_id: null, source_section: 'interview_problem',
      source_pointer: 'article', title: G.normalizeText(String(q.title || (fresh ? pp.questionTitle : '') || ld?.name || h1 || '')).slice(0, 1000) || `problem ${key}`,
      body_text: text, completeness: flags.length ? 'partial' : 'complete_visible', completeness_flags: flags,
      source_published_at: null, breadcrumbs: [], identity_evidence: fresh ? 'url_problem_slug_matching_page_question_data' : 'url_problem_slug_matching_page_jsonld_and_visible_article',
      company_name: problem.company_display, category_track: problem.category, classification: null, problem,
      viewer_logged_in: viewerLoggedIn(doc), extract_duration_ms: Math.max(0, Math.round(performance.now() - started)),
      captured_at: new Date().toISOString(),
    }};
  }
  // ---- /interview/post/<id> (write-up imported from outside the forum; no tid, no classification line) ----
  function inspectPost(doc, href, pid, allowedIds, started) {
    const root = doc.querySelector('.intro-thread-detail');
    const diagnostic = {thread_id: pid.id, forum_id: null, visible_body_roots: root ? 1 : 0, adapter: 'interview_post_v1'};
    if (!allowedIds.includes('interview')) return {state: 'not_target', reason: 'forum_not_allowed', ...diagnostic};
    const container = root && ([...root.querySelectorAll('div.mx-auto.w-full.max-w-3xl')].find(visible) || root);
    const header = container && [...container.children].find(c => c.matches('div.border-b'));
    const bodyNode = container && [...container.children].find(c => c !== header && visible(c) && renderedText(c).length > 0);
    if (!container || !bodyNode) return {state: 'waiting', reason: 'main_post_not_ready_or_unsupported', ...diagnostic};
    const text = renderedText(bodyNode);
    if (!text) return {state: 'waiting', reason: 'visible_body_empty', ...diagnostic};
    if (text.length > G.MAX_BODY) return {state: 'unsupported', reason: 'body_size_limit_no_truncation', ...diagnostic};
    // Page data is only this page's on a full load (client-side navigation keeps the first page's __NEXT_DATA__).
    const pp = nextData(doc)?.props?.pageProps || {};
    const fresh = String(pp.tid || '') === pid.id;
    const tr = fresh ? (pp.trpcState?.json?.queries || []).find(q => JSON.stringify(q?.queryKey || '').includes('getTranslation'))?.state?.data : null;
    const titleNode = header && [...header.querySelectorAll('div')].find(d => /text-3xl|font-bold/.test(d.className) && visible(d));
    const title = (G.normalizeText(titleNode?.innerText || '') || G.normalizeText(String(tr?.subject || '')) || G.normalizeText((doc.title || '').split(' - ')[0])).slice(0, 1000) || `post ${pid.id}`;
    // Header meta line: "<company> · <author> · <MM-DD>" (the site shows no year here; nothing is inferred).
    const metaLine = header ? G.normalizeText(header.innerText || '').split('\n').map(s => s.trim()).filter(s => s && s !== title).find(s => s.includes(' · ')) : null;
    const parts = metaLine ? metaLine.split(' · ').map(s => s.trim()) : [];
    const dateDisplay = parts.find(s => /^\d{4}-\d{2}-\d{2}$|^\d{2}-\d{2}$/.test(s)) || null;
    const company = parts[0] && parts[0] !== dateDisplay ? parts[0] : null;
    const author = parts.length >= 2 && parts[1] !== dateDisplay ? parts[1] : null;
    const flags = [];
    if ([...bodyNode.querySelectorAll('img, canvas, svg, video, audio, iframe')].some(visible)) flags.push('non_text_media_not_captured');
    return {state: 'ready', reason: flags.length ? 'partial_visible_main_post' : 'visible_main_post_ready', ...diagnostic, capture: {
      ...baseCapture({tid: pid.id, canonical_url: pid.url}, href, 'interview_post_v1'),
      source_post_id: null, forum_id: null, source_section: 'interview_post',
      source_pointer: '.intro-thread-detail > .max-w-3xl > :nth-child(2)', title, body_text: text,
      completeness: flags.length ? 'partial' : 'complete_visible', completeness_flags: flags,
      source_published_at: null, breadcrumbs: [], identity_evidence: fresh ? 'url_interview_post_id_matching_page_data' : 'url_interview_post_id_visible_dom',
      author_name: author ? author.slice(0, 120) : null, company_name: (String(tr?.company || '') || company || '').slice(0, 120) || null,
      category_track: null, classification: null,
      published_at_display: dateDisplay, published_at_utc_inferred: null, time_zone_basis: null,
      post_meta: {source: 'nonbbs', description: typeof tr?.description === 'string' ? tr.description.slice(0, 1000) : null,
                  has_translation: typeof tr?.hasTranslation === 'boolean' ? tr.hasTranslation : null, meta_line: metaLine ? metaLine.slice(0, 300) : null},
      viewer_logged_in: viewerLoggedIn(doc), extract_duration_ms: Math.max(0, Math.round(performance.now() - started)),
      captured_at: new Date().toISOString(),
    }};
  }
  // ---- /interview/guides/<slug> (editorial guide; rendered markdown article, no author floor) ----
  function guideData(doc, slug) {
    // Only the blog query for THIS slug is read. The same page data also carries the viewer's own
    // account (user.me); that query is never touched, let alone exported.
    const queries = nextData(doc)?.props?.pageProps?.trpcState?.json?.queries || [];
    for (const q of queries) {
      const key = q?.queryKey;
      if (!Array.isArray(key) || !Array.isArray(key[0]) || key[0][0] !== 'blog' || key[0][1] !== 'getBlogPostBySlug') continue;
      const d = q?.state?.data;
      // After in-site navigation __NEXT_DATA__ still describes the first page loaded: trust it only when it is this slug.
      if (d && typeof d === 'object' && String(d.slug) === slug) return d;
    }
    return null;
  }
  function inspectGuide(doc, href, gid, allowedIds, started) {
    const bodyNode = [...doc.querySelectorAll('article .markdown-body')].find(visible) || null;
    const diagnostic = {thread_id: gid.slug, forum_id: null, visible_body_roots: bodyNode ? 1 : 0, adapter: 'interview_guide_v1'};
    if (!allowedIds.includes('interview')) return {state: 'not_target', reason: 'forum_not_allowed', ...diagnostic};
    if (!bodyNode) return {state: 'waiting', reason: 'main_post_not_ready_or_unsupported', ...diagnostic};
    const text = renderedText(bodyNode, {tableCells: true});
    if (!text) return {state: 'waiting', reason: 'visible_body_empty', ...diagnostic};
    if (text.length > G.MAX_BODY) return {state: 'unsupported', reason: 'body_size_limit_no_truncation', ...diagnostic};
    const d = guideData(doc, gid.slug);
    const str = (v, n = 200) => (typeof v === 'string' && v.trim() ? v.slice(0, n) : null);
    const iso = v => { const t = typeof v === 'string' ? new Date(v) : null; return t && Number.isFinite(t.getTime()) ? t.toISOString() : null; };
    const h1 = [...doc.querySelectorAll('h1')].find(visible);
    // The rendered heading is what the reader saw (the page data may hold another locale's title).
    const title = (G.normalizeText(h1?.innerText || '') || G.normalizeText(String(d?.title || '')) || G.normalizeText((doc.title || '').split(' | ')[0])).slice(0, 1000);
    if (!title) return {state: 'waiting', reason: 'title_missing', ...diagnostic};
    const timeNode = [...doc.querySelectorAll('article time')].find(visible) || null;
    const published = iso(d?.published_at) || iso(timeNode?.getAttribute('datetime'));
    const tags = Array.isArray(d?.meta?.tags) ? d.meta.tags.slice(0, 40).map(x => String(typeof x === 'object' && x ? (x.name ?? x.displayname ?? JSON.stringify(x)) : x).slice(0, 80)) : null;
    const flags = completenessFlags(bodyNode, text, doc);
    if (d?.isLocked === true && !flags.includes('access_restriction_visible')) flags.unshift('access_restriction_visible');
    const guide = {
      slug: gid.slug, data_source: d ? 'next_data' : 'unobservable_after_client_navigation',
      source_title: d ? str(d.title, 1000) : null, description: d ? str(d.description, 1000) : null, category: d ? str(d.category, 60) : null,
      tags, published_at: d ? iso(d.published_at) : null, updated_at: d ? iso(d.updated_at) : null,
      is_locked: d && typeof d.isLocked === 'boolean' ? d.isLocked : null, rendered_text_chars: text.length,
    };
    return {state: 'ready', reason: flags.length ? 'partial_visible_main_post' : 'visible_main_post_ready', ...diagnostic, capture: {
      ...baseCapture({tid: gid.slug, canonical_url: gid.url}, href, 'interview_guide_v1'),
      source_post_id: null, forum_id: null, source_section: 'interview_guide',
      source_pointer: 'article .markdown-body', title, body_text: text,
      completeness: flags.length ? 'partial' : 'complete_visible', completeness_flags: flags,
      source_published_at: published, breadcrumbs: [],
      identity_evidence: d ? 'url_guide_slug_matching_page_blog_data' : 'url_guide_slug_visible_dom',
      published_at_display: timeNode ? (G.normalizeText(timeNode.innerText || '').slice(0, 120) || null) : null,
      published_at_utc_inferred: published, time_zone_basis: null, guide,
      viewer_logged_in: viewerLoggedIn(doc), extract_duration_ms: Math.max(0, Math.round(performance.now() - started)),
      captured_at: new Date().toISOString(),
    }};
  }
  function inspect(doc = document, href = location.href, allowedIds = ['145']) {
    const started = performance.now();
    const post = G.postIdentity(href);
    if (post) {
      const stopEarly = blocked(doc, !!doc.querySelector('.intro-thread-detail'));
      if (stopEarly) return {state: 'blocked', reason: stopEarly};
      return inspectPost(doc, href, post, allowedIds, started);
    }
    const guide = G.guideIdentity(href);
    if (guide) {
      const stopEarly = blocked(doc, !!doc.querySelector('article .markdown-body'));
      if (stopEarly) return {state: 'blocked', reason: stopEarly};
      return inspectGuide(doc, href, guide, allowedIds, started);
    }
    const prob = G.problemIdentity(href);
    if (prob) {
      const stopEarly = blocked(doc, doc.querySelectorAll('article').length > 0);
      if (stopEarly) return {state: 'blocked', reason: stopEarly};
      return inspectProblem(doc, href, prob, allowedIds, started);
    }
    const id = G.identity(href);
    const roots = [...doc.querySelectorAll(ROOTS)].filter(visible);
    const stop = blocked(doc, roots.length > 0);
    if (stop) return {state: 'blocked', reason: stop};
    if (!id) return {state: 'not_target', reason: 'not_a_thread'};
    if (id.page !== 1) return {state: 'not_target', reason: 'main_post_scope_page_1_only', thread_id: id.tid};
    const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
    let canonicalStale = false;
    if (canonical) {
      const c = G.identity(new URL(canonical, href).href);
      canonicalStale = Boolean(c && c.tid !== id.tid);
    }
    // On the SPA interview pages the <head> canonical link lags behind client-side navigation; the URL is the identity.
    if (/^\/interview\/thread\/\d+\/?$/.test(new URL(href).pathname)) return inspectInterview(doc, href, id, allowedIds, started, canonicalStale);
    if (canonicalStale) return {state: 'waiting', reason: 'canonical_identity_mismatch', thread_id: id.tid};
    const meta = metadata(doc, id.tid);
    const crumbs = breadcrumbs(doc, href);
    // Metadata wins. Breadcrumb fallback only uses the deepest explicit forum link, not sidebar links.
    const home = !meta && /^\/home\/thread\/\d+/.test(new URL(href).pathname) ? homeHeader(doc, roots, href) : null;
    const crumbId = crumbs.at(-1)?.forum_id || home?.fid || null;
    if (meta?.fid && crumbId && meta.fid !== crumbId) return {state: 'waiting', reason: 'forum_identity_conflict', thread_id: id.tid};
    const fid = meta?.fid || crumbId;
    const diagnostic = {thread_id: id.tid, forum_id: fid, visible_body_roots: roots.length,
      adapter: meta ? 'next_visible_dom_v1' : (home ? 'home_visible_dom_v1' : 'discuz_visible_dom_v1')};
    if (!fid) return {state: 'waiting', reason: 'forum_identity_missing', ...diagnostic};
    if (!allowedIds.includes(fid)) return {state: 'not_target', reason: 'forum_not_allowed', ...diagnostic};
    let root = null, pid = meta?.pid || null;
    if (pid) root = doc.querySelector(`#postmessage_${pid}`) || doc.querySelector(`#post-${pid} .bbcode-container`) || doc.querySelector(`#post_${pid} .bbcode-container`);
    if (!root && !meta) {
      root = roots.find(x => /^postmessage_\d+$/.test(x.id));
      if (root) pid = root.id.replace('postmessage_', '');
    }
    if (!root && meta?.pid) root = roots.find(x => x.matches('.bbcode-container'));
    if (!root && home) root = home.root;  // main post id unobservable here: keyed thread:<tid>:main, merged server-side later
    if (!root || !visible(root) || (!pid && !home)) return {state: 'waiting', reason: 'main_post_not_ready_or_unsupported', ...diagnostic};
    const heading = [...doc.querySelectorAll('#thread_subject, h1')].find(visible);
    const title = G.normalizeText(heading?.innerText || meta?.title || '').slice(0, 1000);
    if (!title) return {state: 'waiting', reason: 'title_missing', ...diagnostic};
    // For modern layouts the heading and hydration metadata must not disagree during SPA transitions.
    if (meta?.title && heading && G.normalizeText(heading.innerText) !== G.normalizeText(meta.title))
      return {state: 'waiting', reason: 'title_identity_mismatch', ...diagnostic};
    const text = renderedText(root);
    if (!text) return {state: 'waiting', reason: 'visible_body_empty', ...diagnostic};
    if (text.length > G.MAX_BODY) return {state: 'unsupported', reason: 'body_size_limit_no_truncation', ...diagnostic};
    const flags = completenessFlags(root, text, doc);  // clipping/collapse only marks the record partial; a later fuller capture overwrites it
    return {state: 'ready', reason: flags.length ? 'partial_visible_main_post' : 'visible_main_post_ready', ...diagnostic,
      capture: {
        ...baseCapture(id, href, diagnostic.adapter),
        source_post_id: pid, forum_id: fid, source_section: 'forum',
        source_pointer: root.id ? `#${root.id}` : '.bbcode-container:first-visible',
        title, body_text: text,
        completeness: flags.length ? 'partial' : 'complete_visible', completeness_flags: flags,
        source_published_at: meta?.published || null, breadcrumbs: crumbs,
        identity_evidence: meta ? 'url_matching_next_thread_and_visible_dom' : (home ? 'url_home_thread_card_header_stale_page_data' : 'url_breadcrumb_discuz_post_id'),
        published_at_utc_inferred: meta?.published || null,
        published_at_display: home?.time_display || null, author_name: home?.author || null,
        thread_meta: meta?.meta || null,
        company_name: meta?.meta?.company_widget?.name || null,
        viewer_logged_in: viewerLoggedIn(doc),
        extract_duration_ms: Math.max(0, Math.round(performance.now() - started)),
        captured_at: new Date().toISOString()
      }};
  }
  globalThis.GEExtractor = Object.freeze({inspect, renderedText, visible, classification});
})();
