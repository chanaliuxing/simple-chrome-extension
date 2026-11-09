/* Pure projection of one read-only page capture (ge.browser_capture.v2) onto the canonical
   capture envelope that /internal/v1/collector/ingest accepts. No network, no page access.

   This is a line-for-line port of services/collector/hr_collector/browser_projection.py
   (project_browser_capture + ingest_entry), so the cloud extension pushes exactly what the
   local receiver -> spool -> uploader chain would have uploaded. The payload hash is the
   server's: sha256 of json.dumps(payload, ensure_ascii=False, sort_keys=True,
   separators=(",", ":")). services/api/tests/test_cloud_extension_contract.py runs this file
   under node and asserts both the envelope and the hash equal the Python ones byte for byte.

   Loaded with importScripts() in the service worker, and with require() in tests. */
(() => {
  'use strict';
  const SOURCE_KEY = '1point3acres';
  const EXPORT_VERSION = 'capture-v1';
  const POLICY_VERSION = 'browser-extension-v1';
  const CAPTURE_SURFACE = 'source_direct';
  const CAPTURE_METHOD = 'chrome_readonly_extension';
  const ACCESS_SCOPE_REF = 'browser-extension-session';
  const SUPPORTED_SCHEMAS = new Set(['ge.browser_capture.v2']);
  const CAPTURE_UID_NAMESPACE = '2f4b7c0a-9d31-4e8b-b6e2-7a1d5c3f9e02';
  const PROBLEM_ADAPTER = 'interview_problem_v1';
  const POST_ADAPTER = 'interview_post_v1';
  const GUIDE_ADAPTER = 'interview_guide_v1';
  const EXTENSION_FIELDS = [
    'adapter', 'capture_method', 'collector_version', 'source_section', 'forum_id', 'observed_url', 'source_pointer',
    'completeness', 'completeness_flags', 'breadcrumbs', 'identity_evidence', 'author_name', 'company_name',
    'category_track', 'classification', 'published_at_display', 'published_at_utc_inferred', 'time_zone_basis',
    'viewer_logged_in', 'extract_duration_ms', 'capture_id', 'run_id', 'page_instance', 'captured_at', 'problem', 'post_meta', 'guide',
  ];
  // Python's whitespace (str.isspace(), and what \s matches in a str pattern). JS \s differs by
  // U+FEFF (JS only) and U+001C-001F, U+0085 (Python only), so the class is spelled out.
  const PY_SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
  // The site-injected ByteByteGo promo card (same pattern as PROMO_BLOCK in browser_projection.py;
  // the u flag makes the emoji one code point, as it is in Python).
  const PROMO_BLOCK = new RegExp((
    String.raw`\n*System Design · Coding · Behavioral · Machine Learning Interviews\s*\n+` +
    String.raw`Ace Every Stage of Your Next Technical Interview\s*\n+bytebytego\.com\s*\n+[^\n]*使用论坛独家优惠码[^\n]*\n*` +
    String.raw`|\n*💡?\s*看图就懂系统设计[^\n]*ByteByteGo[^\n]*(?:\n+点击查看 ?ByteByteGo[^\n]*)?(?:\n+使用折扣码[^\n]*)?\n*`
  ).replaceAll(String.raw`\s`, PY_SPACE), 'gu');

  class ProjectionError extends Error {}

  // Python str.strip(): its whitespace at both ends.
  const PY_STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, 'gu');
  const pyStrip = s => String(s).replace(PY_STRIP, '');

  function stripPromo(text) {
    let cleaned = String(text).replace(PROMO_BLOCK, '\n\n');
    cleaned = pyStrip(cleaned.replace(/\n{3,}/g, '\n\n'));
    return [cleaned, cleaned !== pyStrip(text)];
  }

  /* ---- canonical JSON, exactly as the server hashes it ------------------------------------ */

  function pyFloat(n) {
    // Python repr: shortest round-trip digits, exponent form below 1e-4 (two-digit exponent).
    const [mantissa, exponent] = n.toExponential().split('e');
    const exp = Number(exponent);
    if (exp < -4) return `${mantissa}e-${String(-exp).padStart(2, '0')}`;
    return String(n);
  }
  function codePointCompare(a, b) {
    const x = Array.from(a), y = Array.from(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const d = x[i].codePointAt(0) - y[i].codePointAt(0);
      if (d) return d;
    }
    return x.length - y.length;
  }
  function canonicalJSON(value) {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new ProjectionError('non-finite number');
      if (Number.isInteger(value)) {
        if (!Number.isSafeInteger(value)) throw new ProjectionError('integer outside the safe range');
        return String(value);
      }
      return pyFloat(value);
    }
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
    if (typeof value === 'object') {
      const keys = Object.keys(value).filter(k => value[k] !== undefined).sort(codePointCompare);
      return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
    }
    throw new ProjectionError(`unsupported value ${typeof value}`);
  }
  // A lone surrogate is valid JS but not valid UTF-8: the server would fail to hash it. Replace
  // it with U+FFFD everywhere before anything is fingerprinted or sent.
  function wellFormed(value) {
    if (typeof value === 'string') {
      return typeof value.toWellFormed === 'function' ? value.toWellFormed()
        : value.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
    }
    if (Array.isArray(value)) return value.map(wellFormed);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [wellFormed(k), wellFormed(v)]));
    return value;
  }

  /* ---- hashing and ids ------------------------------------------------------------------------- */

  const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || require('node:crypto').webcrypto.subtle;
  const hex = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
  async function sha256Hex(text) {
    return hex(await subtle().digest('SHA-256', new TextEncoder().encode(text)));
  }
  async function uuid5(namespace, name) {
    const ns = namespace.replace(/-/g, '').match(/../g).map(h => parseInt(h, 16));
    const bytes = new Uint8Array([...ns, ...new TextEncoder().encode(name)]);
    const digest = new Uint8Array(await subtle().digest('SHA-1', bytes)).slice(0, 16);
    digest[6] = (digest[6] & 0x0f) | 0x50;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    const h = hex(digest);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  function captureUidFor(collectorId, tid, captureId) {
    return uuid5(CAPTURE_UID_NAMESPACE, `browser:${collectorId}:${tid}:${captureId}`);
  }
  /** The capture's content fingerprint, the same one the local receiver checks (collector.py fingerprint). */
  function fingerprintText(p) {
    return JSON.stringify([p.source, p.source_thread_id, p.source_post_id, p.forum_id, p.capture_scope,
      p.title, p.body_text, p.completeness, [...(p.completeness_flags || [])].sort()]);
  }
  /** How much a capture carries (collector.py richness): complete beats partial, then fields, then length. */
  function richness(p) {
    const c = p.classification || {};
    let fields = Object.entries(c).filter(([k, v]) => k !== 'raw_text' && v).length;
    fields += ['author_name', 'company_name', 'published_at_utc_inferred', 'source_post_id'].filter(k => p[k]).length;
    return [p.completeness === 'complete_visible' ? 1 : 0, fields, String(p.body_text || '').length];
  }
  function compareRichness(a, b) {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  }

  /* ---- the envelope ------------------------------------------------------------------------------ */

  async function projectCapture(rawCapture, {collectorId, collectorSequence}) {
    const capture = wellFormed(rawCapture);
    if (!SUPPORTED_SCHEMAS.has(capture.schema_version)) throw new ProjectionError(`unsupported schema ${capture.schema_version}`);
    if (capture.capture_surface !== CAPTURE_SURFACE || capture.capture_method !== CAPTURE_METHOD)
      throw new ProjectionError('capture is not a read-only extension observation of the source');
    if (!Number.isSafeInteger(collectorSequence) || collectorSequence < 1) throw new ProjectionError('invalid collector sequence');
    const tid = String(capture.source_thread_id);
    const problem = capture.adapter === PROBLEM_ADAPTER;
    const imported = capture.adapter === POST_ADAPTER;
    const guide = capture.adapter === GUIDE_ADAPTER;
    const [kind, keyPrefix] = problem ? ['interview_problem', 'problem'] : imported ? ['interview_post', 'interview_post']
      : guide ? ['interview_guide', 'guide'] : ['forum_thread', 'thread'];
    let pid = capture.source_post_id || null;   // the browser has no local evidence to resolve one from
    if (pid !== null && !/^\d+$/.test(String(pid))) throw new ProjectionError('invalid main post id');
    pid = pid ? String(pid) : null;
    if (!pyStrip(capture.body_text || '')) throw new ProjectionError('visible body empty');
    if (capture.body_format !== 'text') throw new ProjectionError('unexpected body format');
    const [bodyText, promoRemoved] = stripPromo(capture.body_text);
    if (!bodyText) throw new ProjectionError('visible body empty after promo removal');
    const flags = [...(capture.completeness_flags || [])];
    const restricted = flags.includes('access_restriction_visible');
    const partial = capture.completeness === 'partial';
    const published = capture.published_at_utc_inferred || capture.source_published_at || null;
    const loggedIn = capture.viewer_logged_in;
    const meta = capture.thread_meta || null;
    const browser = Object.fromEntries(EXTENSION_FIELDS.map(k => [k, capture[k] === undefined ? null : capture[k]]));
    Object.assign(browser, {
      main_post_id_source: capture.source_post_id ? 'page' : 'unobservable',
      body_sha256: await sha256Hex(bodyText),
      promo_block_removed: promoRemoved,
      thread_meta: meta,
    });
    const isMeta = meta && typeof meta === 'object' && !Array.isArray(meta);
    const replies = isMeta ? meta.replies : null;
    const observed = typeof replies === 'number' && replies >= 0 ? Math.trunc(replies) + 1 : null;
    return {
      schema_version: 1,
      capture_uid: await captureUidFor(collectorId, tid, capture.capture_id),
      collector_id: String(collectorId),
      collector_sequence: collectorSequence,
      source_key: SOURCE_KEY,
      document_kind: kind,
      document_key: `${keyPrefix}:${tid}`,
      requested_url: capture.observed_url,
      final_url: capture.observed_url,
      captured_at: capture.captured_at,
      adapter_version: `chrome-readonly-extension:${capture.collector_version}:${capture.adapter}`,
      export_version: EXPORT_VERSION,
      policy_version: POLICY_VERSION,
      access_context: {mode: loggedIn ? 'authenticated' : 'anonymous', scope_ref: ACCESS_SCOPE_REF, identity_confirmed: Boolean(loggedIn)},
      outcome: partial ? 'partial' : 'captured',
      coverage: {
        scope: 'main_only', reply_pagination: 'not_requested',
        source_records_observed: observed, exported_records: 1,
        records_omitted: observed === null ? null : observed - 1, has_more: observed === null ? null : observed > 1,
      },
      request_metrics: {
        navigation_count: 0, active_api_requests: 0, observed_network_requests: null,
        duration_ms: Math.trunc(Number(capture.extract_duration_ms) || 0), http_status: null, challenge_observed: false,
      },
      artifact_kind: 'selected_source_fields',
      thread: {source_thread_id: tid, title: capture.title, source_published_at: published},
      posts: [{
        item_key: pid ? `thread:${tid}:post:${pid}` : `${keyPrefix}:${tid}:main`,
        source_post_id: pid,
        is_main_post: true,
        parent_item_key: null,
        source_floor: 1,
        original_body: bodyText,
        body_format: 'text',
        body_visibility: restricted ? 'mixed' : 'visible',
        source_published_at: published,
        source_updated_at: isMeta ? (meta.lastpost_utc ?? null) : null,
        source_pointer: problem ? 'article' : ((imported || guide) ? capture.source_pointer : (pid ? `#post-${pid}` : '.bbcode-container:first-visible')),
        restriction_reason: restricted ? 'source_access_restriction_detected' : null,
      }],
      extensions: {capture_surface: CAPTURE_SURFACE, browser},
    };
  }

  async function ingestEntry(envelope) {
    return {capture_uid: envelope.capture_uid, payload_sha256: await sha256Hex(canonicalJSON(envelope)), payload: envelope};
  }

  const api = Object.freeze({
    SOURCE_KEY, CAPTURE_UID_NAMESPACE, ProjectionError, canonicalJSON, wellFormed, sha256Hex, uuid5, captureUidFor,
    fingerprintText, richness, compareRichness, stripPromo, projectCapture, ingestEntry,
  });
  globalThis.GEProjection = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
