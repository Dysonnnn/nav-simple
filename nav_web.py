#!/usr/bin/env python3
"""nav_web.py — 个人导航页 Python + jQuery 版（stdlib 单文件后端）。

零第三方依赖。静态前端在 static/，数据在 config.json。
编辑（PUT /api/config）与反馈（/api/feedback）直接写回文件：
加锁串行 + 原子写（mkstemp+os.replace）+ 自动备份（保留 10 份）。

用法:
    nav_web.py run    [--bind 127.0.0.1] [--port 18081]   前台运行（供 runit 托管）
    nav_web.py start  [同上]                              daemon 化启动
    nav_web.py stop | restart | status
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE, "config.json")
STATIC_DIR = os.path.join(BASE, "static")
RUNTIME_DIR = os.path.join(BASE, "runtime")
BACKUP_DIR = os.path.join(RUNTIME_DIR, "backups")
FEEDBACK_PATH = os.path.join(RUNTIME_DIR, "feedback.json")
PID_FILE = os.path.join(RUNTIME_DIR, "nav-py.pid")
LOG_FILE = os.path.join(RUNTIME_DIR, "nav-py.log")

DEFAULT_PORT = 18081
MAX_BODY = 1024 * 1024          # 1MB 请求体上限
FEEDBACK_MAX = 500              # 反馈条数上限，超出轮转删除最旧
BACKUP_KEEP = 10

_CFG_LOCK = threading.Lock()
_FB_LOCK = threading.Lock()

_TAG_RE = re.compile(r"<[^>]*>")


# ---------------------------------------------------------------- utilities

def strip_tags(v):
    """去掉 HTML 标签只留文本（反馈入库前净化，防标签源码污染与 XSS）。"""
    if v is None:
        return None
    return _TAG_RE.sub("", str(v)).strip()


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def read_json(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def atomic_write_json(path: str, data) -> None:
    """同目录临时文件 + os.replace，避免写一半崩溃留下残缺 JSON。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------- config

def validate_config(data) -> str | None:
    """返回错误消息；None 表示通过。对齐 React 版 isValidConfig 的必填骨架。"""
    if not isinstance(data, dict):
        return "顶层必须是对象"
    if not isinstance(data.get("title"), str) or not data["title"]:
        return "title 必须是非空字符串"
    groups = data.get("groups")
    if not isinstance(groups, list):
        return "groups 必须是数组"
    for g in groups:
        if not isinstance(g, dict):
            return "分组必须是对象"
        if not isinstance(g.get("id"), str) or not isinstance(g.get("name"), str):
            return "分组缺少 id/name"
        sites = g.get("sites")
        if not isinstance(sites, list):
            return f"分组 {g.get('name')} 的 sites 必须是数组"
        for s in sites:
            if not isinstance(s, dict):
                return "站点必须是对象"
            if not (isinstance(s.get("id"), str)
                    and isinstance(s.get("name"), str)
                    and isinstance(s.get("url"), str)):
                return f"分组 {g.get('name')} 存在缺少 id/name/url 的站点"
    return None


def backup_config() -> str | None:
    """写回前把当前 config.json 复制为时间戳备份，轮转保留 BACKUP_KEEP 份。"""
    if not os.path.exists(CONFIG_PATH):
        return None
    os.makedirs(BACKUP_DIR, exist_ok=True)
    name = datetime.now().strftime("config.json.%Y%m%d-%H%M%S.bak")
    dst = os.path.join(BACKUP_DIR, name)
    shutil.copy2(CONFIG_PATH, dst)
    olds = sorted(
        f for f in os.listdir(BACKUP_DIR) if f.startswith("config.json.") and f.endswith(".bak")
    )
    for old in olds[: max(0, len(olds) - BACKUP_KEEP)]:
        try:
            os.unlink(os.path.join(BACKUP_DIR, old))
        except OSError:
            pass
    return dst


# ---------------------------------------------------------------- feedback

def _clean_feedback(entry: dict) -> dict:
    entry["content"] = strip_tags(entry.get("content")) or ""
    if entry.get("author"):
        entry["author"] = strip_tags(entry["author"])[:128]
    if entry.get("contact"):
        entry["contact"] = strip_tags(entry["contact"])[:256]
    if entry.get("context"):
        entry["context"] = strip_tags(entry["context"])[:256]
    if entry.get("reply"):
        entry["reply"] = strip_tags(entry["reply"])
    return entry


def feedback_list(status: str | None):
    items = read_json(FEEDBACK_PATH, [])
    if not isinstance(items, list):
        items = []
    if status and status not in ("all", "", None):
        items = [i for i in items if i.get("status") == status]
    items.sort(key=lambda i: i.get("id", 0), reverse=True)      # 新在前
    items.sort(key=lambda i: 0 if i.get("status") == "open" else 1)  # 未处理置顶（稳定排序）
    return items


def feedback_counts() -> dict:
    items = read_json(FEEDBACK_PATH, [])
    if not isinstance(items, list):
        items = []
    open_n = sum(1 for i in items if i.get("status") == "open")
    return {"open": open_n, "resolved": len(items) - open_n, "total": len(items)}


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "nav-web/1.0"

    # ---- 低层响应 ------------------------------------------------------

    def log_message(self, fmt, *args):  # 简化访问日志
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, status: int, ctype: str, body: bytes, cache: str = "no-store"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_json(self, payload, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, "application/json; charset=utf-8", body)

    def send_ok(self, data=None, status: int = 200):
        self.send_json({"ok": True, "data": data}, status)

    def send_err(self, code: str, msg: str, status: int = 400):
        self.send_json({"ok": False, "error": {"code": code, "msg": msg}}, status)

    def send_page(self, rel: str, status: int = 200):
        path = os.path.join(STATIC_DIR, rel)
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            return self.send_err("not_found", "文件不存在: " + rel, 404)
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
            ".json": "application/json; charset=utf-8",
        }.get(os.path.splitext(rel)[1], "application/octet-stream")
        cache = "max-age=86400" if rel.startswith("vendor/") else "no-store"
        self._send(status, ctype, body, cache)

    def read_body_json(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None, ("bad_request", "Content-Length 非法", 400)
        if n <= 0:
            return None, ("bad_request", "缺少请求体", 400)
        if n > MAX_BODY:
            return None, ("too_large", f"请求体超过 {MAX_BODY // 1024}KB 上限", 413)
        try:
            raw = self.rfile.read(n)
            return json.loads(raw.decode("utf-8")), None
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None, ("bad_json", "请求体不是合法 JSON", 400)

    # ---- 路由 ----------------------------------------------------------

    def do_GET(self):
        u = urlparse(self.path)
        path, qs = u.path, parse_qs(u.query)
        if path == "/":
            return self.send_page("index.html")
        if path == "/api/health":
            return self.send_ok({"time": now_str()})
        if path == "/api/config":
            with _CFG_LOCK:
                cfg = read_json(CONFIG_PATH, None)
            if cfg is None:
                return self.send_err("config_missing", "config.json 缺失或损坏", 500)
            return self.send_ok(cfg)
        if path == "/api/feedback":
            status = (qs.get("status") or ["all"])[0]
            # 宽容处理：未知值视为 all（device_manage issue 029 教训，严格校验会 422 打断整页）
            if status not in ("open", "resolved"):
                status = "all"
            items = feedback_list(None if status == "all" else status)
            return self.send_ok({"items": items, "counts": feedback_counts()})
        if path.startswith("/static/"):
            rel = os.path.normpath(path[len("/static/"):]).lstrip("/")
            real = os.path.realpath(os.path.join(STATIC_DIR, rel))
            if not real.startswith(os.path.realpath(STATIC_DIR) + os.sep):
                return self.send_err("forbidden", "路径越界", 403)
            return self.send_page(rel)
        return self.send_err("not_found", "未知路径: " + path, 404)

    def do_PUT(self):
        u = urlparse(self.path)
        if u.path != "/api/config":
            return self.send_err("not_found", "未知路径: " + u.path, 404)
        data, e = self.read_body_json()
        if e:
            return self.send_err(*e)
        msg = validate_config(data)
        if msg:
            return self.send_err("invalid_config", "校验失败: " + msg, 400)
        with _CFG_LOCK:
            backup_config()
            try:
                atomic_write_json(CONFIG_PATH, data)
            except OSError as ex:
                return self.send_err("write_failed", "写回失败: " + ex, 500)
        return self.send_ok({"saved": now_str()})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/api/feedback":
            return self.send_err("not_found", "未知路径: " + u.path, 404)
        data, e = self.read_body_json()
        if e:
            return self.send_err(*e)
        if not isinstance(data, dict) or not (data.get("content") or "").strip():
            return self.send_err("invalid_feedback", "content 不能为空", 400)
        with _FB_LOCK:
            items = read_json(FEEDBACK_PATH, [])
            if not isinstance(items, list):
                items = []
            new_id = max((i.get("id", 0) for i in items), default=0) + 1
            entry = _clean_feedback({
                "id": new_id,
                "content": data.get("content", ""),
                "author": data.get("author") or None,
                "contact": data.get("contact") or None,
                "context": data.get("context") or None,
                "status": "open",
                "reply": None,
                "created_at": now_str(),
                "updated_at": None,
            })
            if not entry["content"]:
                return self.send_err("invalid_feedback", "content 净化后为空", 400)
            items.append(entry)
            items = items[-FEEDBACK_MAX:]  # 轮转：只留最近 N 条
            try:
                atomic_write_json(FEEDBACK_PATH, items)
            except OSError as ex:
                return self.send_err("write_failed", "写回失败: " + ex, 500)
        return self.send_ok(entry, 201)

    def do_PATCH(self):
        u = urlparse(self.path)
        m = re.fullmatch(r"/api/feedback/(\d+)", u.path)
        if not m:
            return self.send_err("not_found", "未知路径: " + u.path, 404)
        fid = int(m.group(1))
        data, e = self.read_body_json()
        if e:
            return self.send_err(*e)
        if not isinstance(data, dict):
            return self.send_err("bad_request", "请求体必须是对象", 400)
        with _FB_LOCK:
            items = read_json(FEEDBACK_PATH, [])
            if not isinstance(items, list):
                items = []
            target = next((i for i in items if i.get("id") == fid), None)
            if target is None:
                return self.send_err("not_found", f"反馈 #{fid} 不存在", 404)
            if "reply" in data:
                target["reply"] = strip_tags(data["reply"]) or None
            if data.get("status") in ("open", "resolved"):
                target["status"] = data["status"]
            target["updated_at"] = now_str()
            target = _clean_feedback(target)
            try:
                atomic_write_json(FEEDBACK_PATH, items)
            except OSError as ex:
                return self.send_err("write_failed", "写回失败: " + ex, 500)
        return self.send_ok(target)


# ---------------------------------------------------------------- daemon

def write_pid():
    os.makedirs(RUNTIME_DIR, exist_ok=True)
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))


def read_pid() -> int | None:
    try:
        with open(PID_FILE) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def serve(bind: str, port: int):
    httpd = ThreadingHTTPServer((bind, port), Handler)

    def _term(signum, frame):
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _term)
    signal.signal(signal.SIGINT, _term)
    print(f"[{now_str()}] nav-py listening on http://{bind}:{port}", flush=True)
    httpd.serve_forever()
    httpd.server_close()


def cmd_start(args):
    pid = read_pid()
    if pid_alive(pid):
        print(f"已在运行, pid={pid}, 端口={args.port}")
        return 0
    proc = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "run",
         "--bind", args.bind, "--port", str(args.port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
    )
    time.sleep(1.0)
    pid = read_pid()
    if pid_alive(pid):
        print(f"已启动, pid={pid}, http://{args.bind}:{args.port}")
        return 0
    if proc.poll() is None:
        print(f"已启动, pid={proc.pid}, http://{args.bind}:{args.port}")
        return 0
    print("启动失败, 详见 " + LOG_FILE)
    return 1


def cmd_stop(_):
    pid = read_pid()
    if not pid_alive(pid):
        print("未在运行")
        try:
            os.unlink(PID_FILE)
        except OSError:
            pass
        return 0
    os.kill(pid, signal.SIGTERM)
    for _ in range(30):
        if not pid_alive(pid):
            break
        time.sleep(0.1)
    else:
        os.kill(pid, signal.SIGKILL)
    try:
        os.unlink(PID_FILE)
    except OSError:
        pass
    print(f"已停止 (pid={pid})")
    return 0


def cmd_status(args):
    pid = read_pid()
    if pid_alive(pid):
        try:
            with socket.create_connection(("127.0.0.1", args.port), timeout=1):
                http = "HTTP 可达"
        except OSError:
            http = "HTTP 未响应"
        print(f"状态: 运行中  pid={pid}  端口={args.port}  {http}")
        print(f"日志: {LOG_FILE}")
    else:
        print("状态: 已停止")
    return 0


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="个人导航页（Python + jQuery 版）")
    ap.add_argument("command", nargs="?", default="run",
                    choices=["run", "start", "stop", "restart", "status"])
    ap.add_argument("--bind", default="127.0.0.1",
                    help="监听地址（默认 127.0.0.1；0.0.0.0 会暴露写接口，慎用）")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = ap.parse_args()

    if args.command == "run":
        if args.bind == "0.0.0.0":
            print("警告: 绑定 0.0.0.0 会把无鉴权的编辑/反馈接口暴露到局域网", flush=True)
        write_pid()
        serve(args.bind, args.port)
    elif args.command == "start":
        sys.exit(cmd_start(args))
    elif args.command == "stop":
        sys.exit(cmd_stop(args))
    elif args.command == "restart":
        cmd_stop(args)
        sys.exit(cmd_start(args))
    elif args.command == "status":
        sys.exit(cmd_status(args))


if __name__ == "__main__":
    main()
