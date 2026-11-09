#!/usr/bin/env python3
"""Show what the Chrome extension captured into local SQLite storage.

Usage:
  python3 scripts/show.py              # Show last 5 captures
  python3 scripts/show.py --last 20    # Show last 20 captures
  python3 scripts/show.py <tid>        # Show full content of a specific thread id
  python3 scripts/show.py --watch      # Watch real-time captures as they arrive
  python3 scripts/show.py --detail     # Include structured metadata (classification, tags, etc.)
"""
import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path


def find_db():
    env_dir = os.environ.get("BROWSER_CAPTURE_DATA")
    candidates = []
    if env_dir:
        candidates.append(Path(env_dir) / "captures.sqlite3")
    candidates.append(Path.home() / ".gradevidence-browser-capture" / "captures.sqlite3")
    candidates.append(Path.home() / "Library/Application Support/HRCollector/browser-capture" / "captures.sqlite3")
    for c in candidates:
        if c.exists():
            return c
    return candidates[0] if candidates else Path.home() / ".gradevidence-browser-capture" / "captures.sqlite3"


DB_PATH = find_db()


def db():
    return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)


def simple(p, received):
    body = p.get("body_text", "")
    print("=" * 100)
    print(f"【{p.get('title', '无标题')}】  ID: {p.get('source_thread_id')}  {received[:19].replace('T', ' ')}  正文 {len(body)} 字符")
    print("-" * 100)
    print(body)
    print()


def full(p, received):
    c = p.get("classification") or {}
    m = p.get("thread_meta") or {}
    print("=" * 100)
    print(f"帖子/题目: {p.get('source_thread_id')}  {p.get('title')}")
    print(f"来源 URL: {p.get('observed_url')}   适配器: {p.get('adapter')}   抓取时间: {received[:19]}Z")
    print(f"作者: {p.get('author_name') or '-'}   公司: {p.get('company_name') or '-'}   发布: {p.get('published_at_display') or p.get('source_published_at') or '-'}")
    if c:
        print(f"结构分类: 时期={c.get('period')} 方向={c.get('track')} 学历={c.get('degree')} 类型={c.get('job_type')} 公司={c.get('company')} 结果={c.get('result')}")
    if m:
        print(f"元数据: 标签={m.get('tags')} 回复={m.get('replies')} 浏览={m.get('views')} 更新={m.get('lastpost_utc')}")
    print(f"完整性: {p.get('completeness')}  标记: {p.get('completeness_flags') or []}")
    body = p.get("body_text", "")
    print(f"--- 正文（{len(body)} 字符，{body.count(chr(10)) + 1} 行）---")
    print(body)
    print("=" * 100)


def load_recent(limit):
    return db().execute("SELECT payload_json, received_at FROM capture ORDER BY received_at DESC LIMIT ?", (limit,)).fetchall()


def load_thread(tid):
    return db().execute("SELECT payload_json, received_at FROM capture WHERE thread_id=? ORDER BY received_at DESC", (tid,)).fetchall()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tid", nargs="?", help="thread ID to show in full")
    ap.add_argument("--last", type=int, default=5, help="number of recent captures to display")
    ap.add_argument("--watch", action="store_true", help="watch in real-time as captures land")
    ap.add_argument("--detail", action="store_true", help="display all fields and metadata")
    a = ap.parse_args()

    show = full if a.detail else simple

    if not DB_PATH.exists():
        sys.exit(f"尚未检测到抓取数据库：{DB_PATH}\n请先启动服务并使用 Chrome 扩展抓取页面。")

    if a.tid:
        rows = load_thread(a.tid)
        if not rows:
            sys.exit(f"未找到 ID 为 {a.tid} 的记录")
        show(json.loads(rows[0][0]), rows[0][1])
        if len(rows) > 1:
            print(f"（该 ID 共有 {len(rows)} 个历史版本，以上为最新版本）")
        return

    if a.watch:
        seen = {r[0] for r in db().execute("SELECT capture_id FROM capture")}
        print(f"正在监视 {DB_PATH} ... 捕获新页面时将自动输出（Ctrl+C 停止）")
        while True:
            for cid, raw, received in db().execute("SELECT capture_id, payload_json, received_at FROM capture ORDER BY received_at"):
                if cid not in seen:
                    seen.add(cid)
                    show(json.loads(raw), received)
            time.sleep(1.5)

    recent = list(reversed(load_recent(a.last)))
    if not recent:
        print(f"数据库存在但目前为空（{DB_PATH}）")
        return
    for raw, received in recent:
        show(json.loads(raw), received)
    print(f"（最近 {len(recent)} 条记录；查看单条: python3 scripts/show.py <ID>；实时监听: --watch；详细信息: --detail）")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
