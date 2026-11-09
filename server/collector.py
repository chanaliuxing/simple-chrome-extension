#!/usr/bin/env python3
"""Loopback-only, paired-extension capture receiver. Python 3.10+, stdlib only.
No website requests, AWS writes, existing spool migrations, or shell execution.
"""
from __future__ import annotations
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

DEFAULT_DATA = Path.home() / '.gradevidence-browser-capture'
MAX_PAYLOAD = 700000
SCHEMA = '''
CREATE TABLE IF NOT EXISTS capture (
 capture_id TEXT PRIMARY KEY, source TEXT NOT NULL, thread_id TEXT NOT NULL,
 completeness TEXT NOT NULL, payload_json TEXT NOT NULL, received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_record (
 source TEXT NOT NULL, thread_id TEXT NOT NULL, best_capture_id TEXT NOT NULL,
 complete_seen INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(source, thread_id), FOREIGN KEY(best_capture_id) REFERENCES capture(capture_id)
);
CREATE TABLE IF NOT EXISTS delivery_receipt (
 delivery_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, response_json TEXT NOT NULL,
 received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_success (
 run_id TEXT NOT NULL, source TEXT NOT NULL, thread_id TEXT NOT NULL,
 PRIMARY KEY(run_id, source, thread_id)
);
'''
FIELDS = {'schema_version','source','capture_surface','capture_method','collector_version',
 'source_thread_id','source_post_id','forum_id','canonical_url','observed_url','source_pointer',
 'title','body_text','body_format','capture_scope','completeness','completeness_flags',
 'source_published_at','breadcrumbs','identity_evidence','captured_at','capture_id',
 'delivery_id','run_id','page_instance','document_id',
 # v2: page shape + classification observed on /interview/thread pages
 'adapter','source_section','author_name','company_name','category_track','classification',
 'published_at_display','published_at_utc_inferred','time_zone_basis','viewer_logged_in','extract_duration_ms','thread_meta','problem','post_meta','guide'}
THREAD_META_KEYS = {'sortid','typeid','forum_name','tags','replies','views','lastpost_utc','anonymous','company_widget'}
ADAPTERS = {'discuz_visible_dom_v1','next_visible_dom_v1','home_visible_dom_v1','interview_visible_dom_v1','interview_problem_v1','interview_post_v1','interview_guide_v1'}
POST_META_KEYS = {'source','description','has_translation','meta_line'}
PROBLEM_KEYS = {'id','id_source','slug','company','company_display','category','frequency','status','reported_from','reported_to','last_asked',
 'duration_minutes','overview','roles','stages','tags','page_tags','page_roles','source_count','sources','is_locked','is_public','is_new',
 'body_markup','rendered_text_chars'}
GUIDE_KEYS = {'slug','data_source','source_title','description','category','tags','published_at','updated_at','is_locked','rendered_text_chars'}
#: A guide slug must contain a letter, so guide:<slug> can never be read as a numeric thread id.
GUIDE_SLUG = re.compile(r'(?=[a-z0-9-]*[a-z])[a-z0-9][a-z0-9-]{0,119}')
CLASSIFICATION_KEYS = {'period','track','degree','job_type','company','result','applicant_status','raw_text'}
SECTION_TOKEN = 'interview'
FLAGS = {'access_restriction_visible','non_text_media_not_captured','expand_control_visible','body_css_clipped'}

def compact(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(',',':'), allow_nan=False)

def now() -> str:
    return datetime.now(timezone.utc).isoformat()

def url_identity(raw: str) -> tuple[str, int] | None:
    try:
        u = urlsplit(raw)
        if u.scheme != 'https' or u.hostname not in {'www.1point3acres.com','1point3acres.com'} or u.username or u.password or u.port:
            return None
        q = parse_qs(u.query)
        m = re.search(r'(?:^|/)thread-(\d+)-(\d+)-\d+\.html$', u.path)
        problem = re.fullmatch(r'/interview/problems/company/([a-z0-9-]+)/([a-z0-9-]+)/?', u.path)
        if problem:
            return ('problem:'+problem[1]+'/'+problem[2], 1)
        guide = re.fullmatch(r'/interview/guides/([a-z0-9][a-z0-9-]{0,119})/?', u.path)
        if guide:
            return ('guide:'+guide[1], 1) if GUIDE_SLUG.fullmatch(guide[1]) else None
        post = re.fullmatch(r'/interview/post/(\d+)/?', u.path)
        if post:
            return ('interview_post:'+post[1], 1)
        modern = re.search(r'(?:^|/)thread/(\d+)(?:/|$)',u.path)
        tid = m[1] if m else (modern[1] if modern else None)
        page = int(m[2]) if m else int(q.get('page',['1'])[0])
        qt = q.get('tid',[None])[0]
        if tid and qt and tid != qt:
            return None
        if u.path.endswith('/forum.php') and q.get('mod',[''])[0] == 'viewthread' and qt and qt.isdecimal():
            tid = qt
        return (tid,page) if tid and page >= 1 else None
    except (ValueError, TypeError, AttributeError):
        return None

def richness(p: dict) -> tuple:
    """How much information a capture carries. Higher wins; ties keep the newer capture."""
    c = p.get('classification') or {}
    fields = sum(1 for k, v in c.items() if k != 'raw_text' and v)
    fields += sum(1 for k in ('author_name','company_name','published_at_utc_inferred','source_post_id') if p.get(k))
    return (1 if p['completeness'] == 'complete_visible' else 0, fields, len(p['body_text']))

def fingerprint(p: dict) -> str:
    fields = [p['source'],p['source_thread_id'],p['source_post_id'],p['forum_id'],p['capture_scope'],
              p['title'],p['body_text'],p['completeness'],sorted(p['completeness_flags'])]
    return hashlib.sha256(compact(fields).encode('utf-8')).hexdigest()

def upgrade_legacy(p):
    """An extension older than the guide adapter sends no 'guide' key; it means exactly guide=None."""
    if isinstance(p,dict) and 'guide' not in p and set(p) == FIELDS - {'guide'}:
        return {**p, 'guide': None}
    return p

def validate(p: dict, allowed: set[str]) -> None:
    if not isinstance(p,dict) or set(p) != FIELDS:
        raise ValueError('capture_schema_fields_mismatch')
    expected = {'schema_version':'ge.browser_capture.v2','source':'1point3acres',
        'capture_surface':'source_direct','capture_method':'chrome_readonly_extension',
        'body_format':'text','capture_scope':'main_post_visible_text'}
    if any(p.get(k) != v for k,v in expected.items()):
        raise ValueError('unsupported_source_or_scope')
    if p['adapter'] not in ADAPTERS:
        raise ValueError('unsupported_adapter')
    interview = p['adapter'] == 'interview_visible_dom_v1'
    problem = p['adapter'] == 'interview_problem_v1'
    imported = p['adapter'] == 'interview_post_v1'
    home = p['adapter'] == 'home_visible_dom_v1'  # /home/thread after in-site navigation: forum known, main post id not
    guide = p['adapter'] == 'interview_guide_v1'
    if guide:
        if not isinstance(p['source_thread_id'],str) or not GUIDE_SLUG.fullmatch(p['source_thread_id']):
            raise ValueError('invalid_identity')
        if p['source_post_id'] is not None or p['forum_id'] is not None or p['source_section'] != 'interview_guide' or p['classification'] is not None:
            raise ValueError('invalid_identity')
        if SECTION_TOKEN not in allowed:
            raise ValueError('forum_not_allowed_by_receiver')
        g = p['guide']
        if not isinstance(g,dict) or set(g) != GUIDE_KEYS or g['slug'] != p['source_thread_id'] \
                or g['data_source'] not in ('next_data','unobservable_after_client_navigation') or g['is_locked'] not in (True,False,None) \
                or any(g[k] is not None and (not isinstance(g[k],str) or len(g[k])>1000) for k in ('source_title','description','category','published_at','updated_at')) \
                or (g['tags'] is not None and (not isinstance(g['tags'],list) or len(g['tags'])>40 or any(not isinstance(t,str) or len(t)>80 for t in g['tags']))) \
                or not isinstance(g['rendered_text_chars'],int) or isinstance(g['rendered_text_chars'],bool) or g['rendered_text_chars'] < 0:
            raise ValueError('invalid_guide')
        if url_identity(p['observed_url']) != ('guide:'+p['source_thread_id'],1) or p['canonical_url'] != p['observed_url']:
            raise ValueError('observed_url_identity_mismatch')
    elif imported:
        if not isinstance(p['source_thread_id'],str) or not re.fullmatch(r'[0-9]{1,20}',p['source_thread_id']):
            raise ValueError('invalid_identity')
        if p['source_post_id'] is not None or p['forum_id'] is not None or p['source_section'] != 'interview_post' or p['classification'] is not None:
            raise ValueError('invalid_identity')
        if SECTION_TOKEN not in allowed:
            raise ValueError('forum_not_allowed_by_receiver')
        pm = p['post_meta']
        if not isinstance(pm,dict) or set(pm) != POST_META_KEYS or pm['source'] != 'nonbbs' or pm['has_translation'] not in (True,False,None) \
                or any(pm[k] is not None and (not isinstance(pm[k],str) or len(pm[k])>1000) for k in ('description','meta_line')):
            raise ValueError('invalid_post_meta')
        if url_identity(p['observed_url']) != ('interview_post:'+p['source_thread_id'],1) or p['canonical_url'] != p['observed_url']:
            raise ValueError('observed_url_identity_mismatch')
    elif problem:
        if not isinstance(p['source_thread_id'],str) or not re.fullmatch(r'[a-z0-9-]{1,80}/[a-z0-9-]{1,120}',p['source_thread_id']):
            raise ValueError('invalid_identity')
        if p['source_post_id'] is not None or p['forum_id'] is not None or p['source_section'] != 'interview_problem':
            raise ValueError('invalid_identity')
        if SECTION_TOKEN not in allowed:
            raise ValueError('forum_not_allowed_by_receiver')
        pr = p['problem']
        if not isinstance(pr,dict) or set(pr) != PROBLEM_KEYS or str(pr.get('company'))+'/'+str(pr.get('slug')) != p['source_thread_id']:
            raise ValueError('invalid_problem')
        if pr['id'] is not None and not (isinstance(pr['id'],str) and re.fullmatch(r'[0-9a-z]{16,40}',pr['id'])):
            raise ValueError('invalid_problem')
        if pr['id_source'] not in ('next_data','unobservable_after_client_navigation') or (pr['id'] is None) != (pr['id_source'] != 'next_data'):
            raise ValueError('invalid_problem')
        ident = url_identity(p['observed_url'])
        if not ident or ident[0] != 'problem:'+p['source_thread_id']:
            raise ValueError('observed_url_identity_mismatch')
        if p['canonical_url'] != p['observed_url']:
            raise ValueError('canonical_url_mismatch')
        if not isinstance(pr['sources'],list) or len(pr['sources'])>100 or any(not isinstance(x,dict) or set(x)-{'tid','url','title','badge'} for x in pr['sources']):
            raise ValueError('invalid_problem_sources')
    elif not isinstance(p['source_thread_id'],str) or not re.fullmatch(r'[0-9]{1,20}',p['source_thread_id']):
        raise ValueError('invalid_identity')
    for k in ('source_post_id','forum_id'):
        v = p[k]
        if v is None:
            if not (interview or problem or imported or guide or (home and k == 'source_post_id')): raise ValueError('invalid_identity')
        elif not isinstance(v,str) or not re.fullmatch(r'[0-9]{1,20}',v):
            raise ValueError('invalid_identity')
    if problem or imported or guide:
        pass
    elif interview:
        if p['source_section'] != SECTION_TOKEN or p['forum_id'] is not None:
            raise ValueError('invalid_identity')
        if SECTION_TOKEN not in allowed:
            raise ValueError('forum_not_allowed_by_receiver')
    else:
        if p['source_section'] != 'forum' or p['forum_id'] not in allowed:
            raise ValueError('forum_not_allowed_by_receiver')
    for k in ('author_name','company_name','category_track','published_at_display','time_zone_basis'):
        if p[k] is not None and (not isinstance(p[k],str) or not p[k].strip() or len(p[k])>300):
            raise ValueError('invalid_text_field_'+k)
    if p['viewer_logged_in'] not in (True,False,None):
        raise ValueError('invalid_viewer_flag')
    if not isinstance(p['extract_duration_ms'],int) or isinstance(p['extract_duration_ms'],bool) or p['extract_duration_ms'] < 0 or p['extract_duration_ms'] > 600000:
        raise ValueError('invalid_extract_duration')
    m = p['thread_meta']
    if m is not None and (not isinstance(m,dict) or set(m) != THREAD_META_KEYS):
        raise ValueError('invalid_thread_meta')
    c = p['classification']
    if c is not None:
        if not isinstance(c,dict) or set(c) != CLASSIFICATION_KEYS or any(v is not None and (not isinstance(v,str) or len(v)>300) for v in c.values()):
            raise ValueError('invalid_classification')
    if p['post_meta'] is not None and not imported:
        raise ValueError('invalid_post_meta')
    if p['guide'] is not None and not guide:
        raise ValueError('invalid_guide')
    if not (problem or imported or guide):
        if p['canonical_url'] != f"https://www.1point3acres.com/bbs/thread-{p['source_thread_id']}-1-1.html":
            raise ValueError('canonical_url_mismatch')
        if url_identity(p['observed_url']) != (p['source_thread_id'],1):
            raise ValueError('observed_url_identity_mismatch')
    if p['problem'] is not None and not problem:
        raise ValueError('invalid_problem')
    for k,limit in [('title',1000),('body_text',180000),('source_pointer',200),('collector_version',30),('identity_evidence',100)]:
        if not isinstance(p[k],str) or not p[k].strip() or len(p[k]) > limit:
            raise ValueError('invalid_text_field_'+k)
    if p['completeness'] not in ('complete_visible','partial'):
        raise ValueError('invalid_completeness')
    flags = p['completeness_flags']
    if not isinstance(flags,list) or any(not isinstance(x,str) or x not in FLAGS for x in flags) or len(set(flags)) != len(flags):
        raise ValueError('invalid_completeness_flags')
    if (p['completeness']=='complete_visible') != (len(flags)==0):
        raise ValueError('completeness_flags_conflict')
    if not isinstance(p['breadcrumbs'],list) or len(p['breadcrumbs']) > 12:
        raise ValueError('invalid_breadcrumbs')
    for crumb in p['breadcrumbs']:
        if not isinstance(crumb,dict) or set(crumb) != {'forum_id','label'} or not re.fullmatch(r'[0-9]{1,20}',str(crumb['forum_id'])) or not isinstance(crumb['label'],str) or len(crumb['label'])>100:
            raise ValueError('invalid_breadcrumb')
    for k in ('delivery_id','run_id','page_instance'):
        try:
            if str(uuid.UUID(p[k])) != p[k]: raise ValueError()
        except (ValueError,TypeError,AttributeError):
            raise ValueError('invalid_uuid') from None
    for k in ('captured_at','source_published_at','published_at_utc_inferred'):
        if p[k] is None and k!='captured_at': continue
        try:
            d=datetime.fromisoformat(p[k].replace('Z','+00:00'))
            if d.tzinfo is None: raise ValueError()
        except (ValueError,TypeError,AttributeError):
            raise ValueError('invalid_timestamp') from None
    if p['document_id'] is not None and (not isinstance(p['document_id'],str) or len(p['document_id'])>100):
        raise ValueError('invalid_document_id')
    if not isinstance(p['capture_id'],str) or not hmac.compare_digest(p['capture_id'],fingerprint(p)):
        raise ValueError('capture_fingerprint_mismatch')

class Store:
    def __init__(self, path: Path, allowed: set[str]):
        self.path=Path(path)
        self.allowed=allowed
        self.lock=threading.Lock()
        self.path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.db=sqlite3.connect(str(self.path),check_same_thread=False,isolation_level=None,timeout=10)
        os.chmod(self.path,0o600)
        self.db.row_factory=sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript(SCHEMA)
    def close(self):
        with self.lock: self.db.close()
    def save(self,p:dict) -> dict:
        p=upgrade_legacy(p)
        validate(p,self.allowed)
        payload=compact(p)
        payload_hash=hashlib.sha256(payload.encode()).hexdigest()
        ts=now()
        with self.lock:
            try:
                self.db.execute('BEGIN IMMEDIATE')
                old=self.db.execute('SELECT * FROM delivery_receipt WHERE delivery_id=?',(p['delivery_id'],)).fetchone()
                if old:
                    if not hmac.compare_digest(old['payload_hash'],payload_hash):
                        raise ValueError('delivery_id_reused_with_different_payload')
                    result=json.loads(old['response_json'])
                    self.db.execute('COMMIT')
                    return result
                record=self.db.execute('SELECT * FROM source_record WHERE source=? AND thread_id=?',(p['source'],p['source_thread_id'])).fetchone()
                existing=self.db.execute('SELECT 1 FROM capture WHERE capture_id=?',(p['capture_id'],)).fetchone()
                complete=p['completeness']=='complete_visible'
                self.db.execute('INSERT OR IGNORE INTO capture VALUES(?,?,?,?,?,?)',
                    (p['capture_id'],p['source'],p['source_thread_id'],p['completeness'],payload,ts))
                # Smarter overwrite: the richer capture becomes the thread's current version; a poorer re-capture is kept only as a version.
                best=True
                if record:
                    old_payload=json.loads(self.db.execute('SELECT payload_json FROM capture WHERE capture_id=?',(record['best_capture_id'],)).fetchone()[0])
                    best=richness(p) >= richness(old_payload)
                if not record:
                    self.db.execute('INSERT INTO source_record VALUES(?,?,?,?,?,?)',
                        (p['source'],p['source_thread_id'],p['capture_id'],int(complete),ts,ts))
                elif best:
                    self.db.execute('UPDATE source_record SET best_capture_id=?,complete_seen=?,updated_at=? WHERE source=? AND thread_id=?',
                        (p['capture_id'],int(complete or record['complete_seen']),ts,p['source'],p['source_thread_id']))
                if complete and (not record or not record['complete_seen']):
                    self.db.execute('INSERT OR IGNORE INTO run_success VALUES(?,?,?)',(p['run_id'],p['source'],p['source_thread_id']))
                n=self.db.execute('SELECT COUNT(*) FROM run_success WHERE run_id=?',(p['run_id'],)).fetchone()[0]
                if existing: status='duplicate' if complete else 'partial_duplicate'
                elif not record: status='saved' if complete else 'partial_saved'
                elif best: status='updated'
                else: status='kept_existing'
                response={'durable':True,'status':status,'best':bool(best and (not existing or record is None or record['best_capture_id']==p['capture_id'])),
                    'capture_id':p['capture_id'],'delivery_id':p['delivery_id'],'run_completed':n,'received_at':ts}
                self.db.execute('INSERT INTO delivery_receipt VALUES(?,?,?,?)',(p['delivery_id'],payload_hash,compact(response),ts))
                self.db.execute('COMMIT')
                return response # Returned only after successful commit.
            except Exception:
                if self.db.in_transaction: self.db.execute('ROLLBACK')
                raise
    def best_payload(self,source:str,thread_id:str) -> dict|None:
        with self.lock:
            row=self.db.execute('SELECT c.payload_json FROM source_record r JOIN capture c ON c.capture_id=r.best_capture_id WHERE r.source=? AND r.thread_id=?',(source,thread_id)).fetchone()
        return json.loads(row[0]) if row else None
    def stats(self) -> dict:
        with self.lock:
            row=self.db.execute('SELECT COUNT(*) AS n,COALESCE(SUM(complete_seen),0) AS c FROM source_record').fetchone()
            captures=self.db.execute('SELECT COUNT(*) FROM capture').fetchone()[0]
            return {'threads':row['n'],'complete_visible_threads':row['c'],'partial_only_threads':row['n']-row['c'],'capture_versions':captures}

class Server(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self,address,store:Store,token:str|None=None,extension_id:str|None=None,spool_sync=None):
        self.store=store; self.token=token; self.spool_sync=spool_sync
        self.allowed_origin=('chrome-extension://'+extension_id) if extension_id else None
        super().__init__(address,Handler)

class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version='HTTP/1.1'
    def setup(self):
        super().setup(); self.connection.settimeout(10)
    def log_message(self,*args):
        pass # Avoid logging titles, request bodies, tokens or URLs by default.
    def reply(self,status:int,data:dict):
        raw=compact(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(raw)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Connection','close')
        origin=self.headers.get('Origin')
        if origin and self.origin_ok(origin):
            self.send_header('Access-Control-Allow-Origin',origin)
            self.send_header('Vary','Origin')
        self.end_headers(); self.wfile.write(raw); self.close_connection=True
    def origin_ok(self,origin:str) -> bool:
        # Simple local mode: any Chrome extension on this machine; paired mode: exactly one ID.
        if self.server.allowed_origin: return origin==self.server.allowed_origin
        return origin.startswith('chrome-extension://')
    def validate_origin(self) -> bool:
        host=self.headers.get('Host','')
        if host != f'127.0.0.1:{self.server.server_port}':
            self.reply(403,{'error':'host_not_allowed'}); return False
        origin=self.headers.get('Origin')
        # No-Origin requests are local CLI clients.
        if origin and not self.origin_ok(origin):
            self.reply(403,{'error':'origin_not_allowed'}); return False
        return True
    def authorized(self) -> bool:
        if not self.validate_origin(): return False
        if self.server.token is None: return True
        supplied=self.headers.get('Authorization','')
        if not hmac.compare_digest(supplied,'Bearer '+self.server.token):
            self.reply(401,{'error':'invalid_pairing_token'}); return False
        return True
    def do_OPTIONS(self):
        if not self.validate_origin(): return
        requested={x.strip().lower() for x in self.headers.get('Access-Control-Request-Headers','').split(',') if x.strip()}
        origin=self.headers.get('Origin','')
        if not self.origin_ok(origin) or not requested <= {'authorization','content-type'}:
            self.reply(403,{'error':'preflight_not_allowed'}); return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin',origin)
        self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers','Authorization, Content-Type')
        self.send_header('Access-Control-Max-Age','300')
        self.send_header('Content-Length','0')
        self.send_header('Connection','close')
        self.end_headers(); self.close_connection=True
    def do_GET(self):
        if not self.authorized(): return
        if self.path=='/v1/health':
            self.reply(200,{'ok':True,'service':'gradevidence-readonly-receiver','version':'0.3.0',
                'allowed_forum_ids':sorted(self.server.store.allowed),'stats':self.server.store.stats()})
        else: self.reply(404,{'error':'not_found'})
    def do_POST(self):
        if not self.authorized(): return
        if self.path=='/v1/events':
            try:
                length=int(self.headers.get('Content-Length','0')); raw=self.rfile.read(max(0,min(length,4000)))
                ev=json.loads(raw.decode('utf-8'))
                print(json.dumps({'event':str(ev.get('event',''))[:40],'reason':str(ev.get('reason',''))[:200],'path':str(ev.get('path',''))[:120],'at':now()},ensure_ascii=False),flush=True)
            except Exception as e:
                print(json.dumps({'event':'bad_event','reason':str(e)[:100],'at':now()}),flush=True)
            self.reply(200,{'ok':True}); return
        if self.path!='/v1/captures': self.reply(404,{'error':'not_found'}); return
        if self.headers.get('Transfer-Encoding'): self.reply(400,{'error':'transfer_encoding_not_supported'}); return
        if self.headers.get('Content-Type','').split(';')[0].strip()!='application/json':
            self.reply(415,{'error':'json_required'}); return
        try: length=int(self.headers.get('Content-Length','0'))
        except ValueError: length=0
        if length <= 0 or length > MAX_PAYLOAD: self.reply(413,{'error':'payload_size_limit'}); return
        try:
            data=self.rfile.read(length)
            if len(data)!=length: raise ValueError('incomplete_request_body')
            payload=json.loads(data.decode('utf-8'),parse_constant=lambda _: (_ for _ in ()).throw(ValueError('invalid_json_number')))
            ack=self.server.store.save(payload)
            if self.server.spool_sync is not None and ack.get('status') in ('saved','updated','partial_saved','kept_existing','duplicate','partial_duplicate'):
                # duplicates are re-offered too: sync is idempotent and repairs a spool that was rebuilt or cleared
                # Always try to spool the thread's best version: a sibling page (e.g. /home/thread) may have just supplied the post id.
                best=self.server.store.best_payload(payload['source'],payload['source_thread_id']) or payload
                try: ack['pipeline']=self.server.spool_sync(best)
                except Exception as e: ack['pipeline']={'stored':False,'reason':'spool_sync_failed: '+str(e)[:120]}
                print(json.dumps({'thread_id':payload.get('source_thread_id'),'receiver':ack['status'],'pipeline':ack['pipeline']},ensure_ascii=False),flush=True)
            self.reply(200,ack)
        except (ValueError,TypeError,KeyError,UnicodeError) as e:
            print(json.dumps({'event':'capture_rejected','reason':str(e)[:120],'at':now()},ensure_ascii=False),flush=True)
            self.reply(422,{'error':str(e)[:120]})
        except sqlite3.Error:
            self.reply(503,{'error':'sqlite_write_failed_no_ack'})

def allowed_ids(raw:str) -> set[str]:
    ids={x.strip() for x in raw.split(',') if x.strip()}
    if not ids or len(ids)>30 or any(not re.fullmatch(r'[0-9]{1,8}|interview',x) for x in ids):
        raise ValueError('allowed forums must be comma-separated numeric IDs (or the interview section token)')
    return ids

def read_stats(path:Path) -> dict:
    if not path.exists(): return {'threads':0,'complete_visible_threads':0,'partial_only_threads':0,'capture_versions':0}
    db=sqlite3.connect(f'file:{path.resolve()}?mode=ro',uri=True)
    try:
        n,c=db.execute('SELECT COUNT(*),COALESCE(SUM(complete_seen),0) FROM source_record').fetchone()
        return {'threads':n,'complete_visible_threads':c,'partial_only_threads':n-c,'capture_versions':db.execute('SELECT COUNT(*) FROM capture').fetchone()[0]}
    finally: db.close()

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir',type=Path,default=DEFAULT_DATA)
    commands=parser.add_subparsers(dest='command',required=True)
    serve=commands.add_parser('serve',help='run a local paired receiver')
    serve.add_argument('--extension-id',default=None,help='optional: pair to one extension ID and require a token (default: simple local mode, no pairing)')
    serve.add_argument('--allowed-forums',default='145,interview')
    serve.add_argument('--spool',type=Path,default=None,help='EdgeSpool sqlite: also store each capture in the canonical pipeline (needs hr_collector on PYTHONPATH)')
    serve.add_argument('--collector-id',default=None,help='collector identity for --spool (default: per-machine extension id)')
    commands.add_parser('status',help='read local capture counts, no network')
    export=commands.add_parser('export',help='export portable JSONL (NOT the AWS ingest wire format)')
    export.add_argument('--out',type=Path,required=True)
    export.add_argument('--include-partial',action='store_true')
    args=parser.parse_args(argv)
    args.data_dir=args.data_dir.expanduser().resolve()
    path=args.data_dir / 'captures.sqlite3'
    if args.command=='status': print(json.dumps(read_stats(path),ensure_ascii=False,indent=2)); return 0
    if args.command=='export':
        if not path.exists(): parser.error('no captures database exists yet')
        out=args.out.expanduser().resolve()
        if out.exists(): parser.error('output exists; choose a new file (no overwrite)')
        if not out.parent.exists(): parser.error('output directory does not exist')
        db=sqlite3.connect(f'file:{path}?mode=ro',uri=True)
        try:
            sql='SELECT c.payload_json FROM source_record r JOIN capture c ON c.capture_id=r.best_capture_id'
            if not args.include_partial: sql+=' WHERE r.complete_seen=1'
            sql+=' ORDER BY r.created_at,r.thread_id'
            with out.open('x',encoding='utf-8') as f:
                os.chmod(out,0o600)
                count=0
                for (raw,) in db.execute(sql): f.write(raw+'\n'); count+=1
            print(f'Exported {count} records to {out}; ge.browser_capture.v2, not AWS ingest format.')
        finally: db.close()
        return 0
    try: allowed=allowed_ids(args.allowed_forums)
    except ValueError as e: parser.error(str(e))
    args.data_dir.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.chmod(args.data_dir,0o700)
    token=None
    if args.extension_id:
        if not re.fullmatch(r'[a-p]{32}',args.extension_id): parser.error('extension ID must be the 32-letter Chrome extension ID')
        config_path=args.data_dir/'pairing.json'
        if config_path.exists():
            config=json.loads(config_path.read_text())
            if config.get('extension_id')!=args.extension_id:
                parser.error('this data directory is paired to another extension ID; use a new --data-dir')
            token=config['token']
        else:
            token=secrets.token_urlsafe(32)
            with config_path.open('x',encoding='utf-8') as f:
                os.chmod(config_path,0o600)
                f.write(compact({'extension_id':args.extension_id,'token':token}))
    store=Store(path,allowed)
    spool_sync=None
    if args.spool:
        try:
            from hr_collector import browser_spool
            from hr_collector.browser_projection import DEFAULT_PID_SOURCES, PostIdResolver
        except ImportError:
            parser.error("--spool requires the hr_collector package which is not installed in standalone mode")
        collector_id=args.collector_id or browser_spool.default_collector_id()
        resolver=PostIdResolver([str(path)]+list(DEFAULT_PID_SOURCES))  # the receiver's own captures first (sibling page observations)
        browser_spool.open_spool(args.spool,collector_id).close()  # fail early if the spool is unusable
        def spool_sync(capture,_spool=str(args.spool)):
            spool=browser_spool.open_spool(_spool,collector_id)
            try: return browser_spool.sync_capture(spool,capture,collector_id,resolver)
            finally: spool.close()
        print('管道：每条记录自动写入 EdgeSpool '+str(args.spool)+'，collector_id '+collector_id)
    try: server=Server(('127.0.0.1',18765),store,token,args.extension_id,spool_sync)
    except OSError as e:
        store.close(); parser.error(f'cannot bind 127.0.0.1:18765: {e}; no other process was stopped')
    print('本地接收器已启动，仅监听 127.0.0.1:18765。')
    if token: print('配对 Token（粘贴到扩展设置；不要提交到 Git）：'+token)
    else: print('简单本机模式：无需配对，本机任何 Chrome 扩展点击即可保存。')
    print('数据库：'+str(path))
    print('允许的版块 ID：'+','.join(sorted(allowed)))
    print('Ctrl+C 停止；数据保留。不抓网页，不上传 AWS。',flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close(); store.close()
    return 0

if __name__=='__main__':
    sys.exit(main())
