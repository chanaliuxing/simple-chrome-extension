"""Synthetic data only. These tests never access the forum or production."""
import copy
import importlib.util
import json
from pathlib import Path
import secrets
import sqlite3
import sys
import threading
import uuid
import urllib.request
import urllib.error
import pytest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'bridge'))
from collector import Store, Server, fingerprint, validate, url_identity, main

def sample(**changes):
    p={'schema_version':'ge.browser_capture.v2','source':'1point3acres','capture_surface':'source_direct',
       'capture_method':'chrome_readonly_extension','collector_version':'0.1.0','source_thread_id':'990000001',
       'source_post_id':'880000001','forum_id':'145',
       'canonical_url':'https://www.1point3acres.com/bbs/thread-990000001-1-1.html',
       'observed_url':'https://www.1point3acres.com/bbs/thread-990000001-1-1.html',
       'source_pointer':'#postmessage_880000001','title':'合成测试：数据工程面试',
       'body_text':'这是完全合成的测试数据。第一轮讨论 SQL 与 Python，第二轮讨论系统设计。',
       'body_format':'text','capture_scope':'main_post_visible_text','completeness':'complete_visible',
       'completeness_flags':[],'source_published_at':None,'breadcrumbs':[{'forum_id':'145','label':'海外面经'}],
       'identity_evidence':'test_fixture','captured_at':'2026-09-22T00:00:00Z',
       'delivery_id':str(uuid.uuid4()),'run_id':str(uuid.uuid4()),'page_instance':str(uuid.uuid4()),'document_id':None,
       'adapter':'discuz_visible_dom_v1','source_section':'forum','author_name':None,'company_name':None,'category_track':None,
       'classification':None,'published_at_display':None,'published_at_utc_inferred':None,'time_zone_basis':None,
       'viewer_logged_in':None,'extract_duration_ms':12,'thread_meta':None,'problem':None,'post_meta':None,'guide':None}
    p.update(changes);p['capture_id']=fingerprint(p);return p

def interview_sample(**changes):
    return sample(adapter='interview_visible_dom_v1',source_section='interview',forum_id=None,source_post_id=None,
        observed_url='https://www.1point3acres.com/interview/thread/990000001',source_pointer='.bbcode-container:first-visible',
        breadcrumbs=[],identity_evidence='url_interview_thread_visible_dom_no_main_pid',author_name='地里匿名用户TEST',company_name='Amazon',
        category_track='数据科学',classification={'period':'2025(1-3月)','track':'数据科学','degree':'硕士','job_type':'全职','company':'amazon',
        'result':'Pass','applicant_status':'其他','raw_text':'2025(1-3月) 数据科学硕士全职@amazon | Pass | 其他'},
        published_at_display='2026-09-12 02:13',published_at_utc_inferred='2026-09-12T06:13:00.000Z',
        time_zone_basis='site displays viewer local time; converted with browser zone America/New_York',viewer_logged_in=True,**changes)

@pytest.fixture
def store(tmp_path):
    s=Store(tmp_path/'captures.sqlite3',{'145','interview'})
    yield s
    s.close()

def test_commit_survives_reopen(tmp_path):
    s=Store(tmp_path/'captures.sqlite3',{'145'});p=sample();r=s.save(p);s.close()
    assert r['durable'] is True and r['status']=='saved'
    s=Store(tmp_path/'captures.sqlite3',{'145'})
    assert s.stats()['complete_visible_threads']==1
    assert s.save(p)==r
    s.close()

def test_duplicate_does_not_count_twice(store):
    p=sample();a=store.save(p)
    q=copy.deepcopy(p);q['delivery_id']=str(uuid.uuid4());b=store.save(q)
    assert a['run_completed']==b['run_completed']==1
    assert b['status']=='duplicate' and store.stats()['capture_versions']==1

def test_idempotency_key_collision_rejected(store):
    p=sample();store.save(p);p['title']='变更后的标题';p['capture_id']=fingerprint(p)
    with pytest.raises(ValueError,match='delivery_id_reused'):store.save(p)
    assert store.stats()['capture_versions']==1

def test_partial_upgrade_and_no_downgrade(store):
    p=sample(completeness='partial',completeness_flags=['access_restriction_visible'])
    assert store.save(p)['run_completed']==0
    q=sample(run_id=p['run_id']);assert store.save(q)['run_completed']==1
    r=sample(run_id=p['run_id'],completeness='partial',completeness_flags=['non_text_media_not_captured'])
    store.save(r)
    assert store.stats()['complete_visible_threads']==1
    best=store.db.execute('SELECT best_capture_id FROM source_record').fetchone()[0]
    assert best==q['capture_id']

def test_other_forum_rejected(store):
    with pytest.raises(ValueError,match='forum_not_allowed'):store.save(sample(forum_id='999'))

def test_identity_mismatch_rejected(store):
    with pytest.raises(ValueError,match='observed_url_identity_mismatch'):
        store.save(sample(observed_url='https://www.1point3acres.com/bbs/thread-1-1-1.html'))

def test_hidden_flags_cannot_claim_complete(store):
    with pytest.raises(ValueError,match='completeness_flags_conflict'):
        store.save(sample(completeness_flags=['access_restriction_visible']))

def test_unknown_fields_rejected(store):
    p=sample();p['cookies']='NEVER_ACCEPT'
    with pytest.raises(ValueError,match='schema_fields'):store.save(p)

def test_hash_tampering_rejected(store):
    p=sample();p['body_text']='changed'
    with pytest.raises(ValueError,match='fingerprint_mismatch'):store.save(p)

def test_failed_transaction_has_no_success_ack(store):
    store.db.execute("CREATE TRIGGER fail_receipt BEFORE INSERT ON delivery_receipt BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END")
    with pytest.raises(sqlite3.Error):store.save(sample())
    assert store.stats()['threads']==store.stats()['capture_versions']==0

def test_export_one_best_record_per_thread(store,tmp_path):
    p=sample();store.save(p)
    q=sample(run_id=p['run_id'],body_text=p['body_text']+' Updated synthetic content with more detail');store.save(q)  # richer version wins
    out=tmp_path/'data.jsonl'
    assert main(['--data-dir',str(tmp_path),'export','--out',str(out)])==0
    rows=[json.loads(line) for line in out.read_text().splitlines()]
    assert len(rows)==1 and rows[0]['capture_id']==q['capture_id']

def test_partial_not_exported_by_default(store,tmp_path):
    store.save(sample(completeness='partial',completeness_flags=['access_restriction_visible']))
    out=tmp_path/'partial.jsonl'
    main(['--data-dir',str(tmp_path),'export','--out',str(out)])
    assert out.read_text()==''

@pytest.mark.parametrize('url',[
 'https://www.1point3acres.com.evil.test/bbs/thread-1-1-1.html',
 'http://www.1point3acres.com/bbs/thread-1-1-1.html',
 'https://name:password@www.1point3acres.com/bbs/thread-1-1-1.html',
 'https://www.1point3acres.com/bbs/thread-1-1-1.html?tid=2'])
def test_url_rejects_untrusted_identity(url): assert url_identity(url) is None

def test_http_auth_origin_host_and_cors(store):
    token=secrets.token_urlsafe(32);eid='a'*32
    server=Server(('127.0.0.1',0),store,token,eid)
    t=threading.Thread(target=server.serve_forever,daemon=True);t.start()
    url=f'http://127.0.0.1:{server.server_port}/v1/health'
    def req(headers,method='GET'):
        try:
            with urllib.request.urlopen(urllib.request.Request(url,headers=headers,method=method),timeout=5) as r:return r.status,r.headers,json.loads(r.read() or b'{}')
        except urllib.error.HTTPError as e:return e.code,e.headers,json.loads(e.read())
    try:
        assert req({})[0]==401
        auth={'Authorization':'Bearer '+token}
        assert req(auth)[0]==200
        assert req({**auth,'Origin':'https://www.1point3acres.com'})[0]==403
        assert req({**auth,'Host':'evil.test'})[0]==403
        origin='chrome-extension://'+eid
        code,headers,_=req({**auth,'Origin':origin})
        assert code==200 and headers['Access-Control-Allow-Origin']==origin
        assert req({'Origin':origin,'Access-Control-Request-Headers':'Authorization, Content-Type'},'OPTIONS')[0]==204
    finally:server.shutdown();server.server_close()


def test_interview_capture_without_main_pid_is_accepted_when_section_allowed(store):
    r=store.save(interview_sample())
    assert r['durable'] is True and r['status']=='saved'
    saved=json.loads(store.db.execute('SELECT payload_json FROM capture').fetchone()[0])
    assert saved['source_post_id'] is None and saved['classification']['company']=='amazon'

def test_interview_capture_rejected_without_section_allowlist(tmp_path):
    s=Store(tmp_path/'only145.sqlite3',{'145'})
    try:
        with pytest.raises(ValueError,match='forum_not_allowed'):s.save(interview_sample())
    finally:s.close()

def test_classic_capture_cannot_omit_post_id(store):
    with pytest.raises(ValueError,match='invalid_identity'):store.save(sample(source_post_id=None))

def test_classification_shape_is_validated(store):
    bad=interview_sample();bad['classification']={'company':'x'};bad['capture_id']=fingerprint(bad)
    with pytest.raises(ValueError,match='invalid_classification'):store.save(bad)


def test_simple_local_mode_needs_no_token(store):
    server=Server(('127.0.0.1',0),store)
    t=threading.Thread(target=server.serve_forever,daemon=True);t.start()
    url=f'http://127.0.0.1:{server.server_port}/v1/health'
    try:
        with urllib.request.urlopen(urllib.request.Request(url,headers={'Origin':'chrome-extension://'+'b'*32}),timeout=5) as r:
            assert r.status==200 and r.headers['Access-Control-Allow-Origin']=='chrome-extension://'+'b'*32
        try: urllib.request.urlopen(urllib.request.Request(url,headers={'Origin':'https://www.1point3acres.com'}),timeout=5); assert False
        except urllib.error.HTTPError as e: assert e.code==403
    finally:server.shutdown();server.server_close()

def test_richer_recapture_overwrites_and_poorer_one_is_kept_as_version(store):
    first=interview_sample();a=store.save(first)
    assert a['status']=='saved' and a['best'] is True
    shorter=interview_sample(run_id=first['run_id'],body_text='短');b=store.save(shorter)
    assert b['status']=='kept_existing' and b['best'] is False
    assert store.db.execute('SELECT best_capture_id FROM source_record').fetchone()[0]==first['capture_id']
    richer=interview_sample(run_id=first['run_id'],body_text=first['body_text']+'\n补充了更多内容');richer['source_post_id']='880000001';richer['capture_id']=fingerprint(richer);c=store.save(richer)
    assert c['status']=='updated' and c['best'] is True
    assert store.db.execute('SELECT best_capture_id FROM source_record').fetchone()[0]==richer['capture_id']
    assert store.stats()['capture_versions']==3

def problem_sample(**changes):
    pr={'id':'01krwktxmwe8c2y8v7b218qyzz','id_source':'next_data','slug':'in-memory-sql-engine','company':'microsoft','company_display':'Microsoft','category':'coding',
        'frequency':'medium','status':'confirmed','reported_from':'2026-03-23','reported_to':'2026-05-28','last_asked':'2026-05-28','duration_minutes':60,
        'overview':'Build a single-table in-memory database','roles':['mle','swe'],'stages':['onsite-coding'],'tags':['sql','hard'],'page_tags':['sql'],'page_roles':['swe'],
        'source_count':5,'sources':[{'tid':'1175275','url':'https://www.1point3acres.com/bbs/thread-1175275-1-1.html','title':'MAI VO','badge':'🔑'}],
        'is_locked':False,'is_public':False,'is_new':False,'body_markup':'markdown','rendered_text_chars':3402}
    return sample(adapter='interview_problem_v1',source_section='interview_problem',source_thread_id='microsoft/in-memory-sql-engine',source_post_id=None,forum_id=None,
        canonical_url='https://www.1point3acres.com/interview/problems/company/microsoft/in-memory-sql-engine',
        observed_url='https://www.1point3acres.com/interview/problems/company/microsoft/in-memory-sql-engine',source_pointer='article',
        title='In-Memory SQL Engine',body_text='## Requirements\n\nImplement a small class…',breadcrumbs=[],identity_evidence='url_problem_slug_matching_page_question_data',
        company_name='Microsoft',category_track='coding',problem=pr,**changes)

def test_interview_problem_is_accepted_and_keyed_by_question_id(store):
    r=store.save(problem_sample())
    assert r['status']=='saved'
    row=store.db.execute("SELECT thread_id FROM source_record").fetchone()[0]
    assert row=='microsoft/in-memory-sql-engine'
    # the same problem captured after in-site navigation (no ULID visible) lands on the same record
    spa=problem_sample();spa['problem']=dict(spa['problem'],id=None,id_source='unobservable_after_client_navigation');spa['delivery_id']=str(uuid.uuid4());spa['capture_id']=fingerprint(spa)
    assert store.save(spa)['status'] in ('duplicate','kept_existing','updated')
    assert store.db.execute("SELECT COUNT(*) FROM source_record").fetchone()[0]==1

def post_sample(**changes):
    return sample(adapter='interview_post_v1',source_section='interview_post',source_thread_id='8273079',source_post_id=None,forum_id=None,
        canonical_url='https://www.1point3acres.com/interview/post/8273079',observed_url='https://www.1point3acres.com/interview/post/8273079',
        source_pointer='.intro-thread-detail > .max-w-3xl > :nth-child(2)',title='Microsoft SDE2 Interview Experience',body_text='Hi LC,\n\nR1: OA…',
        breadcrumbs=[],identity_evidence='url_interview_post_id_matching_page_data',company_name='Microsoft',author_name='anonymous user',
        published_at_display='05-19',classification=None,
        post_meta={'source':'nonbbs','description':'Detailed Microsoft SDE2 interview experience','has_translation':True,'meta_line':'Microsoft · anonymous user · 05-19'},**changes)

def test_imported_interview_post_is_accepted_and_keyed_by_its_own_id(store):
    assert store.save(post_sample())['status']=='saved'
    assert store.db.execute("SELECT thread_id FROM source_record").fetchone()[0]=='8273079'
    moved=post_sample();moved['observed_url']=moved['canonical_url']='https://www.1point3acres.com/interview/post/1';moved['capture_id']=fingerprint(moved)
    with pytest.raises(ValueError,match='observed_url_identity_mismatch'):store.save(moved)
    nometa=post_sample();nometa['post_meta']=None;nometa['capture_id']=fingerprint(nometa)
    with pytest.raises(ValueError,match='invalid_post_meta'):store.save(nometa)
    thread=sample();thread['post_meta']=post_sample()['post_meta'];thread['capture_id']=fingerprint(thread)
    with pytest.raises(ValueError,match='invalid_post_meta'):store.save(thread)

def test_home_thread_after_client_navigation_saves_without_main_post_id(store):
    p=sample(adapter='home_visible_dom_v1',source_post_id=None,forum_id='145',source_section='forum',
             canonical_url='https://www.1point3acres.com/bbs/thread-990000001-1-1.html',observed_url='https://www.1point3acres.com/home/thread/990000001',
             identity_evidence='url_home_thread_card_header_stale_page_data',author_name='sjc1',published_at_display='1 小时前')
    p['capture_id']=fingerprint(p)
    assert store.save(p)['status']=='saved'
    nofid=sample(adapter='home_visible_dom_v1',source_post_id=None,forum_id=None,source_section='forum',observed_url='https://www.1point3acres.com/home/thread/990000001')
    nofid['capture_id']=fingerprint(nofid)
    with pytest.raises(ValueError,match='invalid_identity'):store.save(nofid)

def test_interview_problem_identity_checks(store):
    moved=problem_sample();moved['observed_url']=moved['canonical_url']='https://www.1point3acres.com/interview/problems/company/google/other';moved['capture_id']=fingerprint(moved)
    with pytest.raises(ValueError,match='observed_url_identity_mismatch'):store.save(moved)
    bad=problem_sample();bad['problem']=dict(bad['problem'],id='zzz');bad['capture_id']=fingerprint(bad)
    with pytest.raises(ValueError,match='invalid_problem'):store.save(bad)
    half=problem_sample();half['problem']=dict(half['problem'],id=None);half['capture_id']=fingerprint(half)
    with pytest.raises(ValueError,match='invalid_problem'):store.save(half)
    numeric=problem_sample();numeric['source_thread_id']='1189250';numeric['capture_id']=fingerprint(numeric)
    with pytest.raises(ValueError,match='invalid_identity'):store.save(numeric)

def guide_sample(**changes):
    slug='meta-interview-trend-2026q2'
    return sample(adapter='interview_guide_v1',source_section='interview_guide',source_thread_id=slug,source_post_id=None,forum_id=None,
        canonical_url='https://www.1point3acres.com/interview/guides/'+slug,observed_url='https://www.1point3acres.com/interview/guides/'+slug,
        source_pointer='article .markdown-body',title='合成测试：Meta 面试趋势指南',body_text='总体趋势\n\n轮次 | 形式\nCoding | AI 辅助',
        breadcrumbs=[],identity_evidence='url_guide_slug_matching_page_blog_data',classification=None,
        source_published_at='2026-05-04T14:51:20.368Z',published_at_utc_inferred='2026-05-04T14:51:20.368Z',published_at_display='May 4, 2026',
        guide={'slug':slug,'data_source':'next_data','source_title':'Synthetic guide title','description':'synthetic','category':'interview',
               'tags':['meta'],'published_at':'2026-05-04T14:51:20.368Z','updated_at':'2026-05-04T14:51:20.368Z','is_locked':False,'rendered_text_chars':30},**changes)

def test_interview_guide_is_accepted_and_keyed_by_its_slug(store):
    assert url_identity('https://www.1point3acres.com/interview/guides/meta-interview-trend-2026q2')==('guide:meta-interview-trend-2026q2',1)
    assert url_identity('https://www.1point3acres.com/interview/guides/12345') is None  # an all-digit slug could read as a thread id
    assert store.save(guide_sample())['status']=='saved'
    assert store.db.execute("SELECT thread_id FROM source_record").fetchone()[0]=='meta-interview-trend-2026q2'

def test_interview_guide_identity_and_shape_checks(store):
    moved=guide_sample();moved['observed_url']=moved['canonical_url']='https://www.1point3acres.com/interview/guides/other-guide';moved['capture_id']=fingerprint(moved)
    with pytest.raises(ValueError,match='observed_url_identity_mismatch'):store.save(moved)
    numeric=guide_sample();numeric['source_thread_id']='12345';numeric['capture_id']=fingerprint(numeric)
    with pytest.raises(ValueError,match='invalid_identity'):store.save(numeric)
    nometa=guide_sample();nometa['guide']=None;nometa['capture_id']=fingerprint(nometa)
    with pytest.raises(ValueError,match='invalid_guide'):store.save(nometa)
    mismatched=guide_sample();mismatched['guide']=dict(mismatched['guide'],slug='other-guide');mismatched['capture_id']=fingerprint(mismatched)
    with pytest.raises(ValueError,match='invalid_guide'):store.save(mismatched)
    extra=guide_sample();extra['guide']=dict(extra['guide'],email='x@example.com');extra['capture_id']=fingerprint(extra)
    with pytest.raises(ValueError,match='invalid_guide'):store.save(extra)  # only the fixed guide keys; nothing else rides along
    thread=sample(guide=guide_sample()['guide'])
    with pytest.raises(ValueError,match='invalid_guide'):store.save(thread)

def test_capture_from_extension_older_than_guide_adapter_is_still_accepted(store):
    legacy=sample();del legacy['guide']
    assert store.save(legacy)['status']=='saved'
    with pytest.raises(ValueError,match='capture_schema_fields_mismatch'):validate(legacy,{'145'})  # only save() upgrades
