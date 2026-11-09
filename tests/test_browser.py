"""Actual Chromium + loaded MV3 extension, routed synthetic pages only.
Requires playwright + pytest for development tests; runtime has no pip dependencies.
"""
import copy
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import time
import pytest
playwright = pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'bridge'))
from collector import Store,Server

TITLE='合成测试：数据工程面经'
URL='https://www.1point3acres.com/bbs/thread-990000001-1-1.html'
TEXT='这是合成测试正文，不是真实面经。第一轮讨论 SQL 和 Python，第二轮讨论数据库与系统设计。'

def interview_fixture_html(tid='990000001',body=TEXT):
    return ('<!doctype html><html><head><meta charset="utf-8"><title>'+TITLE+' - amazon interview question | 1Point3Acres</title></head><body>'
        '<div id="__NEXT_DATA__" hidden></div><main><div class="mx-auto w-full max-w-3xl"><div class="border-b pb-2"><div class="text-lg font-medium text-card-foreground">'+TITLE+'</div>'
        '<div class="mt-3 flex items-center"><div class="ml-2 flex-1"><div class="font-semibold">地里匿名用户TEST</div><div class="text-muted-foreground flex items-center"><time title="2026-09-12 02:13">2026-09-12 02:13</time></div></div></div></div>'
        '<div class="pt-4 text-base"><div class="text-muted-foreground mb-4 text-sm"><span class="flex flex-wrap items-center"><span class="text-muted-foreground">2025(1-3月)</span>'
        '<span><span class="text-green font-bold">数据科学</span><span class="ml-1 font-bold">硕士</span><span class="ml-1 font-bold text-blue-500">全职</span><span class="mx-0.5">@</span><span class="text-orange font-bold">amazon</span></span>'
        '<span class="font-bold text-purple-600">| Pass</span><span>| 其他</span></span></div><div class="bbcode-container">'+body+'</div>'
        '<div class="mt-4 flex flex-col"><div class="rounded-lg border bg-card"><div class="font-semibold lg:text-lg">Amazon</div></div></div></div></div></main></body></html>')

def fixture_html(tid='990000001',fid='145',body=TEXT,modern=False):
    crumb=f'<nav id="pt"><a href="/home/forum/{fid}">海外面经</a></nav>'
    metadata=''
    if modern:
        data={'props':{'pageProps':{'dehydratedState':{'queries':[{'state':{'data':{'thread':{
            'tid':tid,'pid':'880000001','fid':fid,'subject':TITLE,'dateline':1750000000,
            'message_bbcode':'PRIVATE_HYDRATION_CONTENT_MUST_NOT_LEAK',
            'message_html':'HIDDEN_SERVER_BODY_MUST_NOT_LEAK'}}}}]}}}}
        metadata='<script id="__NEXT_DATA__" type="application/json">'+json.dumps(data,ensure_ascii=False)+'</script>'
    root='<div class="bbcode-container">' if modern else '<div id="postmessage_880000001">'
    return '<!doctype html><html><head><meta charset="utf-8"><title>'+TITLE+'</title></head><body>'+crumb+'<h1 id="thread_subject">'+TITLE+'</h1>'+root+body+'</div>'+metadata+'</body></html>'

@pytest.fixture
def chromium():
    with sync_playwright() as p:
        executable=os.environ.get('CHROMIUM_PATH') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
        browser=p.chromium.launch(headless=True,executable_path=executable,args=['--no-sandbox'])
        yield browser
        browser.close()

@pytest.mark.parametrize('case',[
 'classic','modern','interview','interview_not_allowed','other_forum','sidebar_not_breadcrumb','hidden_dom','restricted',
 'image_partial','clipped_refused','child_clipped_refused','challenge','page2','no_body','canonical_conflict','tracking_query_stripped'
])
def test_readonly_extractor(chromium,case):
    page=chromium.new_page()
    href=URL;html=fixture_html()
    if case=='modern':html=fixture_html(modern=True)
    if case in ('interview','interview_not_allowed'):html=interview_fixture_html();href='https://www.1point3acres.com/interview/thread/990000001'
    if case=='other_forum':html=fixture_html(fid='999')
    if case=='sidebar_not_breadcrumb':html=fixture_html(fid='999').replace('id="pt"','id="sidebar"')
    if case=='hidden_dom':html=fixture_html(body=TEXT+'<span style="display:none">SECRET_HIDDEN_DOM</span><input value="SECRET_INPUT"><textarea>SECRET_FORM</textarea>')
    if case=='restricted':html=fixture_html(body=TEXT+'<div class="locked">本帖隐藏的内容需要积分才能查看</div>')
    if case=='image_partial':html=fixture_html(body=TEXT+'<canvas width="30" height="30"></canvas>')
    if case=='clipped_refused':html=fixture_html(body='<div style="height:500px">'+TEXT+'</div>').replace('id="postmessage_880000001"','id="postmessage_880000001" style="height:20px;overflow:hidden"')
    if case=='child_clipped_refused':html=fixture_html(body=TEXT+'<div style="height:10px;overflow:hidden"><p style="height:500px">SECRET_CLIPPED_TEXT</p></div>')
    if case=='challenge':html='<html><head><title>Just a moment...</title></head><body>Verify you are human</body></html>'
    if case=='page2':href=URL.replace('-1-1.html','-2-1.html')
    if case=='no_body':html=fixture_html().replace('postmessage_880000001','unknown_body')
    if case=='canonical_conflict':html=fixture_html().replace('</head>','<link rel="canonical" href="https://www.1point3acres.com/bbs/thread-2-1-1.html"></head>')
    if case=='tracking_query_stripped':href+='?token=SECRET_QUERY&tracking=123'
    page.set_content(html)
    page.add_script_tag(path=str(ROOT/'extension/common.js'))
    page.add_script_tag(path=str(ROOT/'extension/extractor.js'))
    before=page.content()
    allowed='["145"]' if case=='interview_not_allowed' else '["145","interview"]'
    result=page.evaluate('(url)=>GEExtractor.inspect(document,url,'+allowed+')',href)
    assert page.content()==before,'extractor mutated page DOM'
    if case=='interview':
        assert result['state']=='ready' and result['capture']['adapter']=='interview_visible_dom_v1'
        c=result['capture'];assert c['source_post_id'] is None and c['forum_id'] is None and c['source_section']=='interview'
        assert c['classification']['company']=='amazon' and c['classification']['result']=='Pass' and c['company_name']=='Amazon'
        assert c['published_at_display']=='2026-09-12 02:13' and c['published_at_utc_inferred']
    elif case=='interview_not_allowed':assert result['state']=='not_target' and result['reason']=='forum_not_allowed'
    elif case in ['classic','modern','hidden_dom','tracking_query_stripped']:
        assert result['state']=='ready' and result['capture']['completeness']=='complete_visible'
        raw=json.dumps(result,ensure_ascii=False)
        assert all(s not in raw for s in ['SECRET_','PRIVATE_HYDRATION','HIDDEN_SERVER_BODY'])
    elif case=='other_forum':assert result['state']=='not_target'
    elif case=='sidebar_not_breadcrumb':assert result['reason']=='forum_identity_missing'
    elif case in ['restricted','image_partial']:assert result['capture']['completeness']=='partial'
    elif case in ['clipped_refused','child_clipped_refused']:assert result['state']=='ready' and 'body_css_clipped' in result['capture']['completeness_flags'] and result['capture']['completeness']=='partial'
    elif case=='challenge':assert result['state']=='blocked' and 'capture' not in result
    elif case=='page2':assert result['state']=='not_target'
    elif case=='no_body':assert result['state']=='waiting'
    elif case=='canonical_conflict':assert result['reason']=='canonical_identity_mismatch'
    page.close()

def wait_for(fn,predicate,timeout=15):
    end=time.time()+timeout
    while time.time()<end:
        value=fn()
        if predicate(value):return value
        time.sleep(.25)
    raise AssertionError('Timed out; last value: '+str(value))

@pytest.mark.skipif(os.environ.get('GE_REAL_EXTENSION_TEST') != '1', reason='Full extension loading requires an unmanaged local Chromium; this container administrator disables unpacked extensions.')
def test_loaded_extension_end_to_end(tmp_path):
    with sync_playwright() as p:
        executable=os.environ.get('CHROMIUM_PATH') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
        ext=ROOT/'extension'
        ctx=p.chromium.launch_persistent_context(str(tmp_path/'profile'),headless=True,executable_path=executable,channel='chromium',ignore_default_args=['--disable-extensions'],
            args=[f'--disable-extensions-except={ext}',f'--load-extension={ext}','--no-sandbox'])
        ctx.set_default_timeout(8000)
        print('E2E: browser launched',flush=True)
        worker=ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
        print('E2E: extension worker loaded',flush=True)
        eid=worker.url.split('/')[2]
        token=secrets.token_urlsafe(32)
        store=Store(tmp_path/'capture-data/captures.sqlite3',{'145'})
        server=Server(('127.0.0.1',18765),store,token,eid)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        current={'html':fixture_html(modern=True)}
        ctx.route('https://www.1point3acres.com/**',lambda route:route.fulfill(status=200,content_type='text/html; charset=utf-8',body=current['html']))
        source=ctx.new_page();source.goto(URL)
        print('E2E: fixture loaded',flush=True)
        ui=ctx.new_page();ui.goto(f'chrome-extension://{eid}/popup.html')
        print('E2E: UI loaded',flush=True)
        def msg(kind,**kw):return ui.evaluate('(m)=>chrome.runtime.sendMessage(m)',{'type':kind,**kw})
        try:
            assert msg('GE_SETTINGS',settings={'allowedForumIds':'145','token':token,'maxItems':300})['ok']
            print('E2E: settings saved',flush=True)
            assert msg('GE_HEALTH')['ok']
            print('E2E: receiver paired',flush=True)
            source.bring_to_front()
            result=msg('GE_START');assert result['ok'],result
            print('E2E: capture armed',flush=True)
            status=wait_for(lambda:msg('GE_STATUS'),lambda s:s.get('last',{}).get('state')=='saved')
            assert status['armed']['completed']==1 and status['pending']==0
            assert store.stats()['complete_visible_threads']==1
            print('E2E: first record committed',flush=True)
            body=store.db.execute('SELECT payload_json FROM capture').fetchone()[0]
            assert 'PRIVATE_HYDRATION' not in body and 'HIDDEN_SERVER_BODY' not in body
            # Sensitive local storage is not exposed to website content scripts.
            result=worker.evaluate('async(tabId)=> (await chrome.scripting.executeScript({target:{tabId},world:"ISOLATED",func:async()=>{try{return await chrome.storage.local.get("settings")}catch(e){return {denied:true}}}}))[0].result',status['armed']['tabId'])
            assert 'settings' not in result
            # Popup remains usable; screenshot is synthetic test UI only.
            ui.bring_to_front();ui.set_viewport_size({'width':420,'height':930})
            ui.screenshot(path=str(tmp_path/'popup.png'),full_page=True)
            source.bring_to_front();assert msg('GE_CHECK')['ok']
            wait_for(lambda:msg('GE_STATUS'),lambda s:s.get('last',{}).get('state')=='duplicate')
            assert store.stats()['capture_versions']==1
            print('E2E: dedup passed',flush=True)
            # Same-origin SPA navigation with no reload.
            current['html']=fixture_html(tid='990000002',modern=True)
            source.evaluate('(html)=>{history.pushState({},"","/bbs/thread-990000002-1-1.html");const d=new DOMParser().parseFromString(html,"text/html");document.body.replaceChildren(...d.body.childNodes);}',current['html'])
            # Page code simulates a SPA replacement; the extension itself remains read-only.
            msg('GE_CHECK')
            wait_for(lambda:store.stats(),lambda s:s['threads']==2)
            print('E2E: SPA passed',flush=True)
            # Non-target board cannot save; sidebar links do not widen the allowlist.
            current['html']=fixture_html(tid='990000003',fid='999',modern=True)
            source.goto(URL.replace('990000001','990000003'))
            wait_for(lambda:msg('GE_STATUS'),lambda s:s.get('last',{}).get('state')=='not_target')
            assert store.stats()['threads']==2
            print('E2E: non-target passed',flush=True)
            # A second tab is never implicitly armed.
            current['html']=fixture_html(tid='990000004',modern=True)
            other=ctx.new_page();other.goto(URL.replace('990000001','990000004'));time.sleep(2)
            assert store.stats()['threads']==2
            other.close();source.bring_to_front()
            print('E2E: single-tab passed',flush=True)
            # Blocker immediately pauses instead of saving the verification page.
            current['html']='<html><head><title>Just a moment...</title></head><body>Verify you are human</body></html>'
            source.goto(URL)
            paused=wait_for(lambda:msg('GE_STATUS'),lambda s:s.get('armed',{}).get('enabled') is False)
            assert paused['armed']['reason']=='human_verification'
            assert store.stats()['threads']==2
            print('E2E: challenge pause passed',flush=True)
            # Re-arm after manual recovery; receiver outage persists an outbox item.
            current['html']=fixture_html(tid='990000005',modern=True)
            source.goto(URL.replace('990000001','990000005'))
            assert msg('GE_START')['ok']
            server.shutdown();server.server_close()
            pending=wait_for(lambda:msg('GE_STATUS'),lambda s:s.get('pending')==1 and s.get('armed',{}).get('enabled') is False)
            assert pending['last']['state']=='pending'
            print('E2E: outbox pause passed',flush=True)
            # Restart receiver, resend exactly the stored delivery, no re-opening source page.
            server=Server(('127.0.0.1',18765),store,token,eid)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            assert msg('GE_RETRY')['ok']
            assert msg('GE_STATUS')['pending']==0
            assert store.stats()['threads']==3
            print('E2E: outbox replay passed',flush=True)
            # Target count: one new complete-visible thread stops this new run.
            assert msg('GE_SETTINGS',settings={'allowedForumIds':'145','token':token,'maxItems':1})['ok']
            current['html']=fixture_html(tid='990000006',modern=True)
            source.goto(URL.replace('990000001','990000006'));assert msg('GE_START')['ok']
            reached=wait_for(lambda:msg('GE_STATUS'),lambda s:s.get('armed',{}).get('reason')=='target_reached')
            assert reached['armed']['completed']==1
            # Target completion leaves the database intact; real browser restart is a manual acceptance step.
            assert store.stats()['threads']==4
            assert msg('GE_STOP_UI')['ok']
        finally:
            server.shutdown();server.server_close();store.close();ctx.close()


def test_rendered_dom_to_real_http_sqlite(chromium,tmp_path):
    """Real Chromium extraction -> real HTTP -> actual SQLite; Chrome runtime is not involved."""
    import urllib.request
    import subprocess
    import uuid
    from collector import fingerprint
    page=chromium.new_page()
    page.set_content(fixture_html(modern=True))
    page.add_script_tag(path=str(ROOT/'extension/common.js'))
    page.add_script_tag(path=str(ROOT/'extension/extractor.js'))
    result=page.evaluate('(url)=>GEExtractor.inspect(document,url,["145"])',URL)
    assert result['state']=='ready'
    payload=result['capture']
    payload.update(delivery_id=str(uuid.uuid4()),run_id=str(uuid.uuid4()),page_instance=str(uuid.uuid4()),document_id=None)
    # Cross-language hashing is verified, not merely duplicated in Python.
    js = "require(process.argv[1]); const p=JSON.parse(require('node:fs').readFileSync(0,'utf8')); GE.sha256(JSON.stringify([p.source,p.source_thread_id,p.source_post_id,p.forum_id,p.capture_scope,p.title,p.body_text,p.completeness,[...p.completeness_flags].sort()])).then(x=>process.stdout.write(x));"
    payload['capture_id']=subprocess.run(['node','-e',js,str(ROOT/'extension/common.js')],input=json.dumps(payload,ensure_ascii=False),text=True,capture_output=True,check=True).stdout.strip()
    assert payload['capture_id']==fingerprint(payload)
    store=Store(tmp_path/'captures.sqlite3',{'145'})
    token=secrets.token_urlsafe(32)
    server=Server(('127.0.0.1',0),store,token,'a'*32)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/v1/captures',data=json.dumps(payload,ensure_ascii=False).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token,'Origin':'chrome-extension://'+'a'*32})
        with urllib.request.urlopen(req,timeout=5) as response:ack=json.loads(response.read())
        assert ack['durable'] is True and ack['capture_id']==payload['capture_id']
        assert store.stats()['complete_visible_threads']==1
        saved=store.db.execute('SELECT payload_json FROM capture').fetchone()[0]
        assert 'PRIVATE_HYDRATION_CONTENT' not in saved
    finally:server.shutdown();server.server_close();store.close();page.close()
