#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
库库会员领取执行服务 (claim-api)
================================
实现参考系统的 claim-api 契约, 供 Node 后端转发调用:

    POST /api/v1/sms/send      {phone, kami}                      → {ok, retry_time}
    POST /api/v1/claim/run     {kami, phone, code, country_code}  → {ok}  (异步, 完成后回调)
    GET  /api/v1/claim/status?kami=                              → {ok, status, detail}

执行完成后 POST 回调到 Node: /api/client/claim/callback
    {kami, status: 'success'|'failed', phone, result_msg, member_expire_at}

多账号并发: 按 kami 建会话, ThreadPoolExecutor 独立线程执行。
环境变量:
    CALLBACK_URL   回调地址 (默认 http://127.0.0.1:3000/api/client/claim/callback)
    JFBYM_TOKEN    图鉴打码 Token
    PROXY_ENABLED  是否每次领取换 IP (默认 1)
    CLAIM_MAX_WORKERS  并发数 (默认 5)

启动: uvicorn app:app --host 0.0.0.0 --port 8888
"""

import json
import os
import sys
import threading
import time
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

import re as _re

_PROGRESS = {}          # phone/kami -> 最近一条进度文本
_PROGRESS_ALIAS = {}    # kami -> phone


def _progress_hook(msg, level):
    """kuku_core 每条日志 → 实时进度 (供客户端轮询显示)"""
    try:
        m = _re.match(r"\[(\d{6,})\]", msg)
        if m:
            _PROGRESS[m.group(1)] = msg
        else:
            for ph in list(_PROGRESS.keys()):
                if not _re.match(r"\[", msg):
                    _PROGRESS[ph] = msg
    except Exception:
        pass


from kuku_core import (  # noqa: E402
    Client, KukuBot, SmsLogin, run_flow, judge_account,
    get_working_proxy, log as core_log, JFBYM_TOKEN_DEFAULT,
)

import kuku_core as _kc
_kc.LOG_HANDLER = _progress_hook

JFBYM_TOKEN_ENV = os.environ.get("JFBYM_TOKEN", JFBYM_TOKEN_DEFAULT)
PROXY_ENABLED = os.environ.get("PROXY_ENABLED", "1") == "1"
MAX_WORKERS = int(os.environ.get("CLAIM_MAX_WORKERS", "5"))
CALLBACK_URL = os.environ.get(
    "CALLBACK_URL", "http://127.0.0.1:3000/api/client/claim/callback")
KAMI_DB = os.environ.get(
    "KAMI_DB", str(BASE.parent / "backend" / "server" / "kami.db"))


def get_setting(key: str, default: str = "") -> str:
    """从管理后端的 settings 表读配置 (跨进程 WAL), 每次调用实时读取 → 后台改完即时生效"""
    try:
        import sqlite3
        con = sqlite3.connect(KAMI_DB, timeout=5)
        try:
            row = con.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
            return (row[0] if row and row[0] else default)
        finally:
            con.close()
    except Exception:
        return default


def jfbym_token() -> str:
    return get_setting("jfbym_token", JFBYM_TOKEN_ENV)


def proxy_extract_url() -> str:
    return get_setting("proxy_extract_url", "")

app = FastAPI(title="kuku claim-api", version="2.0.0")
_executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)

# 会话: kami → {phone, client, sms, state, result, created_at}
_SESSIONS = {}
_LOCK = threading.Lock()
SESSION_TTL = 900  # 15 分钟


def _extract_proxy():
    # 开关优先级: 后台设置 > 环境变量
    if get_setting("proxy_enabled", "1" if PROXY_ENABLED else "0") == "0":
        return None
    # 代理提取链接: 后台「IP与打码」设置实时读取
    return get_working_proxy(url=proxy_extract_url())


def _get_session(kami: str) -> dict:
    s = _SESSIONS.get(kami)
    if not s:
        raise HTTPException(404, "会话不存在, 请重新获取验证码")
    if time.time() - s["created_at"] > SESSION_TTL:
        _SESSIONS.pop(kami, None)
        raise HTTPException(404, "会话已过期, 请重新获取验证码")
    return s


def client_from_ck(ck_str: str):
    """用存档的 CK 字符串重建会话客户端 (后台重领用)"""
    import http.cookiejar
    client = Client()
    for part in (ck_str or '').split(';'):
        part = part.strip()
        if '=' in part:
            name, _, value = part.partition('=')
            ck = http.cookiejar.Cookie(
                0, name, value, None, False, '.baidu.com', True, False,
                '/', False, False, None, False, None, None, {})
            client.jar.set_cookie(ck)
    return client


# 后台自动重领队列: 领奖被 8001 限流的订单, 用存档 CK 定时重试
_reclaim_queue = []          # [{kami, phone, day, ck_after, attempts, next_ts}]
_reclaim_lock = threading.Lock()
RECLAIM_INTERVAL = 90        # 每 90 秒重试一次
RECLAIM_MAX_ATTEMPTS = 13    # 最多 ~20 分钟


def _estimate_expire(day: int) -> str:
    prize_days = {3: 1, 7: 3, 15: 7, 30: 30}
    est = time.localtime(time.time() + prize_days.get(int(day), 1) * 86400)
    return time.strftime("%Y-%m-%d 23:59", est)


def _reclaim_worker():
    while True:
        time.sleep(10)
        now = time.time()
        with _reclaim_lock:
            due = [e for e in _reclaim_queue if now >= e["next_ts"]]
            for e in due:
                _reclaim_queue.remove(e)
        for e in due:
            kami, phone, day = e["kami"], e["phone"], e["day"]
            try:
                bot = KukuBot(client_from_ck(e["ck_after"]), dry_run=False)
                e["attempts"] += 1
                core_log(f"[{phone}] 后台重领 day={day} (第{e['attempts']}次)", "INFO")
                if bot.claim_reward(int(day)):
                    time.sleep(10)
                    pan = bot.pan_membership()
                    expire = pan.get("expire_str") or _estimate_expire(day)
                    avatar = pan.get("avatar", "")
                    uname = pan.get("uname", "")
                    core_log(f"[{phone}] 后台重领成功 → 会员到账 {expire}", "OK")
                    _callback({"kami": kami, "status": "success", "phone": phone,
                               "result_msg": "会员开通成功", "member_expire_at": expire,
                               "avatar": avatar, "username": uname,
                               "ck_before": "", "ck_after": e["ck_after"]})
                    continue   # 成功, 出队
                if e["attempts"] >= RECLAIM_MAX_ATTEMPTS:
                    core_log(f"[{phone}] 后台重领 {e['attempts']} 次仍失败 → 判失败", "WARN")
                    _callback({"kami": kami, "status": "failed", "phone": phone,
                               "result_msg": "奖励领取未完成, 请联系客服",
                               "member_expire_at": "", "avatar": "", "username": "",
                               "ck_before": "", "ck_after": e["ck_after"]})
                    continue
                e["next_ts"] = time.time() + RECLAIM_INTERVAL
                with _reclaim_lock:
                    _reclaim_queue.append(e)
            except Exception as ex:
                core_log(f"[{phone}] 后台重领异常: {ex}", "ERR")
                if e["attempts"] >= RECLAIM_MAX_ATTEMPTS:
                    _callback({"kami": kami, "status": "failed", "phone": phone,
                               "result_msg": "奖励领取未完成, 请联系客服",
                               "member_expire_at": "", "avatar": "", "username": "",
                               "ck_before": "", "ck_after": e["ck_after"]})
                    continue
                e["next_ts"] = time.time() + RECLAIM_INTERVAL
                with _reclaim_lock:
                    _reclaim_queue.append(e)


threading.Thread(target=_reclaim_worker, daemon=True).start()


def jar_to_str(client) -> str:
    """把 CookieJar 序列化成字符串 (兑换记录存档用)"""
    try:
        items = [f'{ck.name}={ck.value}' for ck in client.jar]
        if not items:
            # 备用: 直接读 jar 内部结构
            for domain in getattr(client.jar, '_cookies', {}).values():
                for path in domain.values():
                    for name, ck in path.items():
                        if hasattr(ck, 'value'):
                            items.append(f'{ck.name}={ck.value}')
                        elif isinstance(ck, dict):
                            items.append(f'{name}={ck.get("value", "")}')
        return '; '.join(items)
    except Exception:
        return ''


def _callback(payload: dict):
    """把执行结果回调给 Node 后端"""
    try:
        req = urllib.request.Request(
            CALLBACK_URL, data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            r.read()
        core_log(f"[callback] {payload.get('kami')} → {payload.get('status')}", "OK")
    except Exception as e:
        core_log(f"[callback] 失败 (Node 的对账器会兜底): {e}", "WARN")


# ---------------------------------------------------------------- 模型
class SmsSendReq(BaseModel):
    phone: str
    kami: Optional[str] = None


class ClaimRunReq(BaseModel):
    kami: str
    phone: str
    code: str
    country_code: Optional[str] = "86"


# ---------------------------------------------------------------- 接口
@app.get("/api/health")
def health():
    return {"ok": True, "sessions": len(_SESSIONS), "workers": MAX_WORKERS}


@app.post("/api/v1/sms/send")
def sms_send(req: SmsSendReq):
    """发送短信验证码 (①~⑤: 预热→getapi→cap→viewlog→senddpass, 图形码自动打码)"""
    if not req.phone or not (req.phone.isdigit() and len(req.phone) == 11):
        return {"ok": False, "msg": "手机号格式不正确"}

    # 代理不在此处提取: 由 do_send 每轮调一次提取链接拿一个新 IP
    client = Client(proxy_extractor=_extract_proxy if PROXY_ENABLED else None)
    client.reset_on_rotate = True   # 登录阶段: 换 IP 必清 Cookie
    sms = SmsLogin(client, jfbym_token=jfbym_token())

    with _LOCK:
        now = time.time()
        for k in [k for k, v in _SESSIONS.items() if now - v["created_at"] > SESSION_TTL]:
            _SESSIONS.pop(k, None)
        _SESSIONS[req.phone] = {
            "phone": req.phone, "client": client, "sms": sms, "kami": req.kami or "",
            "state": "ready", "result": None, "created_at": now,
        }
    s = _SESSIONS[req.phone]

    err = []

    def do_send():
        # ⚠️ 一单从头到尾锁定同一条 IP: 首轮选定后立即 proxy_locked,
        #    后续重试只在同一 IP 上重发请求, 绝不换线 (换线=会话与IP错配→风控)
        # ⚠️ 提取失败严禁直连: 服务器机房IP直连必触发库库风控 (烧号)
        for attempt in range(3):
            if s["client"].proxy_extractor and not s["client"].proxy:
                proxy = get_working_proxy(max_tries=8)   # 黑名单过滤后需更多抽取机会
                if not proxy:
                    core_log(f"[{req.phone}] 第{attempt + 1}轮: 代理暂不可用, 6 秒后再试", "WARN")
                    err.clear()
                    err.append("代理线路繁忙, 请稍后重试")
                    s["state"] = "send_failed"
                    time.sleep(6)
                    continue
                s["client"].set_proxy(proxy)
                s["client"].reset_on_rotate = True
                s["client"].proxy_locked = True   # 🔒 整单锁定这一条 IP
                core_log(f"[{req.phone}] 第{attempt + 1}轮选定并锁定 IP: "
                         f"{proxy.split('@')[-1]} (本单不再更换)", "INFO")
            try:
                sms.login_send_sms(req.phone)
                s["state"] = "sms_sent"
                return
            except Exception as e:
                core_log(f"[{req.phone}] 短信发送异常 (第{attempt + 1}轮): {e}", "ERR")
                err.clear()
                err.append(str(e)[:120])
                s["state"] = "send_failed"
                time.sleep(1)

    t = threading.Thread(target=do_send)
    t.start()
    t.join(timeout=180)
    if t.is_alive():
        return {"ok": False, "msg": "发送超时, 请稍后重试"}
    if s["state"] != "sms_sent":
        return {"ok": False, "msg": (err[0] if err else "发送失败, 请稍后重试")}
    return {"ok": True, "session_id": req.phone, "retry_time": 60}


@app.post("/api/v1/claim/run")
def claim_run(req: ClaimRunReq):
    """提交短信码 → 后台线程执行 登录→签到→资格判断→补签→领奖 → 完成后回调"""
    s = _SESSIONS.get(req.phone) or _SESSIONS.get(req.kami)
    if not s:
        raise HTTPException(404, "会话不存在, 请重新获取验证码")
    if time.time() - s["created_at"] > SESSION_TTL:
        raise HTTPException(404, "会话已过期, 请重新获取验证码")
    if s["state"] != "sms_sent":
        return {"ok": False, "msg": f"会话状态异常: {s['state']}, 请重新获取验证码"}
    s["state"] = "running"
    kami = req.kami
    phone = req.phone
    with _LOCK:
        _SESSIONS[kami] = s   # kami 别名绑定 (Node 轮询 status 用 kami)
    _PROGRESS_ALIAS[kami] = phone
    _PROGRESS[kami] = "准备中..."

    def worker():
        result_msg = ""
        member_expire_at = ""
        status = "failed"
        avatar = ""
        username = ""
        ck_before = ""
        ck_after = ""
        try:
            client = s["client"]
            ck_before = jar_to_str(client)   # 未转换 CK (登录前的会话 Cookie)
            # ⑥⑦ 登录 + 跨域同步 (硬超时 15 秒: 正常1~3秒返回, 15秒无响应=死透)
            import threading as _th
            _login_done = _th.Event()
            _login_err = []
            def _do_login():
                try:
                    s["sms"].login_finish(phone, req.code)
                except Exception as lex:
                    core_log(f"[{phone}] 登录线程异常: {lex}", "WARN")
                    _login_err.append(lex)
                finally:
                    _login_done.set()
            _lt = _th.Thread(target=_do_login, daemon=True)
            _lt.start()
            if not _login_done.wait(15):
                core_log(f"[{phone}] 登录请求 15 秒无响应, 判定失败", "ERR")
                raise RuntimeError("登录请求超时, 请重新获取验证码")
            if _login_err:
                raise _login_err[0]   # 真实原因立即上抛 (不再干等15秒报超时)
            # 🔒 保持 proxy_locked: 登录/判定/签到/补签/领奖全程同一条 IP
            #    reset_on_rotate 保持 True (登录阶段语义), 但 rotate 已被锁拒绝
            ck_after = jar_to_str(client)    # 已转换 CK (登录后的网盘/库库 Cookie)
            core_log(f"[{phone}] CK捕获: 转换前{len(ck_before)}字符 转换后{len(ck_after)}字符", "INFO")
            s["state"] = "logged_in"
            # 真假判断: 只走库库活动页 (judge_account)
            bot = KukuBot(client, dry_run=False)
            home = bot.homepage()
            judge = judge_account(home)
            if not judge["valid"]:
                core_log(f"[{phone}] 库库判定: {judge['reason']} → 失败, 卡密不核销", "WARN")
                username = bot.vip_remain().get("uname", "")
                status = "failed"
                result_msg = "该账号已领取过会员, 此卡无法使用"
                member_expire_at = ""
                avatar = ""
                s["state"] = "failed"
                s["result"] = {"status": "failed", "result_msg": result_msg,
                               "member_expire_at": member_expire_at, "avatar": avatar,
                               "username": username, "ck_before": ck_before,
                               "ck_after": ck_after}
                _callback({"kami": kami, "status": "failed", "phone": phone,
                           "result_msg": result_msg, "member_expire_at": "",
                           "avatar": "", "username": username,
                           "ck_before": ck_before, "ck_after": ck_after})
                return
            # 签到 → 逐里程碑补签推进 → 领取 (8001 自动重试)
            flow = run_flow(bot)
            claimed = flow.get("claimed") or []     # 服务端确认已领取
            pending = flow.get("pending") or []     # 未完成
            vip = bot.vip_remain()
            username = vip.get("uname", "")
            avatar = ""
            pan = bot.pan_membership()
            if not username:
                username = pan.get("uname", "")
            if pan.get("avatar"):
                avatar = pan["avatar"]

            if pan.get("is_svip") and pan.get("expire_str"):
                status = "success"
                member_expire_at = pan["expire_str"]
                result_msg = "会员开通成功"
            elif claimed:
                # 服务端确认领取成功, 网盘侧同步可能有延迟 → 等 12 秒复核一次
                time.sleep(12)
                pan2 = bot.pan_membership()
                if pan2.get("avatar"):
                    avatar = pan2["avatar"]
                if pan2.get("username") and not username:
                    username = pan2["username"]
                if pan2.get("is_svip") and pan2.get("expire_str"):
                    member_expire_at = pan2["expire_str"]
                else:
                    # 按已领最大里程碑估算到期时间 (day3=1天 / day7=3天 / day15=7天 / day30=30天)
                    prize_days = {3: 1, 7: 3, 15: 7, 30: 30}
                    dmax = max(claimed)
                    est = time.localtime(time.time() + prize_days.get(dmax, 1) * 86400)
                    member_expire_at = time.strftime("%Y-%m-%d 23:59", est)
                status = "success"
                result_msg = "会员开通成功"
            elif pending:
                # 8001 限流未领到 → 入后台自动重领队列 (用存档CK, 最多20分钟)
                # 订单保持 running, 客户端继续等待; 成功/最终失败都回调
                day = int(pending[0])
                with _reclaim_lock:
                    _reclaim_queue.append({"kami": kami, "phone": phone, "day": day,
                                           "ck_after": ck_after, "attempts": 0,
                                           "next_ts": time.time() + 60})
                core_log(f"[{phone}] day={day} 未领到 → 入队自动重领 (最多20分钟)", "WARN")
                result_msg = "奖励待发放, 系统自动重试领取中"
                member_expire_at = _estimate_expire(day)
                status = "success"
                # 先按受理成功回显 (后台重领失败会再回调改失败)
                # 注意: Node 侧 status IN ('pending','running') 才接受回调,
                #       这里先报 success 会核销卡密 → 改为报 running, 由重领结果决定终态
                status = "running"
                s["state"] = "running"
                s["result"] = {"status": "running", "result_msg": result_msg,
                               "member_expire_at": member_expire_at, "avatar": avatar,
                               "username": username, "ck_before": ck_before,
                               "ck_after": ck_after}
                core_log(f"[{phone}] 已按受理中回执, 等待后台重领结果", "INFO")
                return
        except Exception as e:
            core_log(f"[{phone}] 执行异常: {e}", "ERR")
            emsg = str(e)
            if '400704' in emsg or '安全验证' in emsg:
                result_msg = "操作过于频繁, 请稍后或换号重试"
            elif 'err_no=4' in emsg or '验证码错误' in emsg:
                result_msg = "验证码错误或已过期, 请重新获取验证码"
            elif '会话' in emsg and '过期' in emsg:
                result_msg = "会话已过期, 请重新获取验证码"
            else:
                result_msg = f"开通失败: {emsg[:80]}"
        s["state"] = status
        if status == "failed":
            result_msg = result_msg if result_msg != "开通失败, 请联系客服" else (str(s.get("_last_err") or result_msg))
        s["result"] = {"status": status, "result_msg": result_msg,
                       "member_expire_at": member_expire_at, "avatar": avatar,
                       "username": username, "ck_before": ck_before,
                       "ck_after": ck_after}
        _callback({"kami": kami, "status": status, "phone": phone,
                   "result_msg": result_msg, "member_expire_at": member_expire_at,
                   "avatar": avatar, "username": username,
                   "ck_before": ck_before, "ck_after": ck_after})

    _executor.submit(worker)
    return {"ok": True}


@app.get("/api/v1/claim/status")
def claim_status(kami: str):
    s = _SESSIONS.get(kami)
    if not s:
        # 会话不在内存 (重启/过期) → 交由 Node 的对账器兜底判终态
        return {"ok": True, "status": "unknown", "detail": None,
                "progress": _PROGRESS.get(kami) or _PROGRESS.get(
                    _PROGRESS_ALIAS.get(kami, ""), "")}
    progress = _PROGRESS.get(kami) or _PROGRESS.get(
        _PROGRESS_ALIAS.get(kami, ""), "")
    detail = None
    if s.get("result"):
        detail = {"result_msg": s["result"].get("result_msg", ""),
                  "member_expire_at": s["result"].get("member_expire_at", ""),
                  "avatar": s["result"].get("avatar", ""),
                  "username": s["result"].get("username", ""),
                  "ck_before": s["result"].get("ck_before", ""),
                  "ck_after": s["result"].get("ck_after", ""),
                  "progress": _PROGRESS.get(kami) or _PROGRESS.get(
                      _PROGRESS_ALIAS.get(kami, ""), "")}
    # 注意: sms_sent/ready 不能归为 pending, 否则 Node 的"上一次还在处理中"检查会误拦截充值
    norm = {"ready": "ready", "sms_sent": "sent", "send_failed": "failed",
            "running": "running", "logged_in": "running",
            "success": "success", "failed": "failed"}.get(s["state"], s["state"])
    return {"ok": True, "status": norm, "detail": detail}


@app.get("/api/v1/logs")
def api_logs(lines: int = 300):
    """管理端查看协议执行日志 (kuku_bot.log 尾部, 只读)"""
    try:
        with open(_kc.LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
        n = max(1, min(int(lines), 3000))
        return {"ok": True, "lines": all_lines[-n:]}
    except Exception as e:
        return {"ok": False, "lines": [f"读取日志失败: {e}"]}
