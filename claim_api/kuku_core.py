#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
百度网盘会员自动签到/补签/兑换脚本
================================
基于对 kuku.baidu.com「库库30天签到」活动 (kukuai30) 的抓包逆向分析。

活动规则: 连续签到 3/7/15/30 天可分别领取
    网盘会员天卡 / 3天卡 / 周卡 / 月卡
漏签日期可通过完成任务(聊天/浏览知识广场/专家对话)补签。

功能:
    1. 短信验证码协议登录 (输入手机号 → [图形码] → 短信码 → 自动登录保存 Cookie)
    2. 每日自动签到
    3. 自动补签所有漏签日期 (自动识别任务类型并完成)
    4. 自动领取签到里程碑奖励 (网盘会员卡)
    5. 状态查询 / VIP 剩余天数查询

用法:
    python3 kuku_bot.py --login        # 短信登录 (手机号→验证码→自动签到)
    python3 kuku_bot.py --login-qr     # 扫码登录 (备用)
    python3 kuku_bot.py                # 完整流程: 签到+补签+领奖
    python3 kuku_bot.py --status       # 仅查看状态
    python3 kuku_bot.py --dry-run      # 演练模式, 不实际执行
    python3 kuku_bot.py --no-makeup    # 跳过补签
    python3 kuku_bot.py --no-claim     # 跳过领奖

依赖: Python3 标准库 + Node.js (moonshadV3 签名桥接, jsbridge/bridge.js)
"""

import argparse
from pathlib import Path
import base64
import hashlib
import http.client
import http.cookiejar
import json
import os
import random
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

# ============================================================================
# 常量 (来自抓包分析)
# ============================================================================
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0")

KUKU_HOST = "https://kuku.baidu.com"
PASSPORT_HOST = "https://passport.baidu.com"
# ⚠️ 不要在这里放任何"全局固定"的设备指纹常量。
#   旧版有个 FUID 常量兜底, 拿不到本单指纹时送它 —— 等于把所有客户账号
#   在百度侧绑成同一台设备 (几百个号共用一个 fuid), 正是批量薅羊毛画像。
#   设备指纹由 bridge.js 按本单 profile 实时算出; 算不出就不传该字段。


def gen_device_profile():
    """生成一单独立的虚拟设备档案 (单内固定, 单间不同)

    真实浏览器同一设备指纹稳定, 但不同客户来自不同设备。
    若所有单共用同一指纹 (固定 fuid/canvas)，大量不同手机号看起来像
    "同一台设备批量登录"，会被百度判定涉诈风险 (err_no=402013)。
    故每单生成独立档案: canvas 指纹 + 屏幕分辨率 + platform。
    """
    w, h = random.choice([(1920, 1080), (1440, 900), (1536, 864),
                          (1366, 768), (1280, 720), (2560, 1440)])
    return {
        # canvas 指纹: 每单随机 (决定 fuid / rinfo.fuid 的关键输入)
        "canvasFp": "data:image/png;base64," + hashlib.md5(
            f"{random.random()}{time.time()}".encode()).hexdigest() + "==",
        "screenW": w, "screenH": h,
        "colorDepth": random.choice([24, 32]),
        "platform": random.choice(["MacIntel", "Win32", "Linux x86_64"]),
        "language": random.choice(["zh-CN", "zh-CN"]),
    }


def gen_dv(profile=None):
    """运行百度官方 dv/g.min.js (Node 桥接) 生成合法设备向量 dv.
    真实浏览器在页面加载时生成一次, 发短信 senddpass 与登录 login 共用同一个值."""
    bridge = os.path.join(SCRIPT_DIR, "jsbridge", "dv_bridge.js")
    if not os.path.exists(bridge):
        return ""
    try:
        out = subprocess.run(["node", bridge, UA, json.dumps(profile or {})],
                             capture_output=True, text=True, timeout=15)
        d = json.loads(out.stdout.strip().splitlines()[-1])
        return d.get("dv", "") if d.get("ok") else ""
    except Exception:
        return ""


def gen_traceid():
    """逆向 loginv5.js: traceID.createTraceID() = headID(6) + flowID(2)
    headID = hex(时间戳毫秒 + 随机两位数).toUpperCase() 末6位, flowID="01"(login)"""
    r = random.randint(10, 99)
    t = int(str(int(time.time() * 1000)) + str(r))
    n = format(t, "x")
    return n[-6:].upper() + "01"


def _rand_base36():
    n = random.randint(0, 2147483647)
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    s = ""
    while n:
        n, r = divmod(n, 36)
        s = chars[r] + s
    return s or "0"


def gen_callback():
    """逆向 loginv5.js 登录回调: "parent.bd__pcbs__" + toString(36)"""
    return "parent.bd__pcbs__" + _rand_base36()


def gen_sd_callback():
    """逆向 senddpass 回调: "bd__cbs__" + toString(36)"""
    return "bd__cbs__" + _rand_base36()

# 签到活动 tid / 抽奖商品 tid / 活动 aid (来自抓包)
TID_SIGN = "291651792210"      # kukuai30 签到活动
TID_LOTTERY = "652831792323"   # 抽奖/商品列表
AID_ACTIVITY = "15459"         # claimreward 的 aid 参数

# 通用查询串 (所有 kuku 接口公共参数)
# ⚠️ version 必须用 1.8.2 —— 真实浏览器抓包就是这个值 (1.7.3 是旧版, 已被判异常)
COMMON_QS = {
    "clienttype": "400",
    "app_id": "123971023",
    "web": "1",
    "channel": "chunlei",
    "version": "1.8.2",
}

# ★ 真实浏览器请求头 (来自活动页抓包 capture.har)
#   缺这些 → 百度风控识别为脚本 → claimreward 返回 8001 (HTJ_ERROR)
BROWSER_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Origin": "https://kuku.baidu.com",
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/156.0.0.0 Safari/537.36"),
    "Sec-Ch-Ua": '"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}

REFERER_APP = "https://kuku.baidu.com/app"
REFERER_ACT = "https://kuku.baidu.com/operation/activitys/kukuPcSignAct/main?utm_source=home2"

# 补签任务类型 -> (任务事件类型, 是否需要会话)
TASK_EVENT_MAP = {
    "CONVERSATION_DAILY_TASK": "chat",       # 与库库聊聊热门话题
    "VIEW_KNOWLEDGE_SQUARE": "browse",       # 浏览10s知识广场
    "EXPERT_CONVERSATION_TASK": "expert",    # 召唤任意专家并发起对话
}

# 聊天话术池 (随机挑选, 模拟真人)
CHAT_POOL = [
    "帮我写一份季度工作总结", "帮我制定一份本周工作计划",
    "推荐几本提升沟通能力的书", "帮我润色一段自我介绍",
    "用通俗的语言解释一下什么是复利", "帮我列一个周末大扫除的清单",
    "给我讲一个冷知识", "如何高效整理电脑里的文件?",
    "最近老是失眠，有什么改善睡眠的方法吗", "帮我想想周末带家人去哪玩",
    "健身新手应该先练哪些部位", "推荐几部最近评分很高的电影",
    "怎么做一份简单又好吃的早餐", "帮我算一下一个月存两千一年有多少",
    "手机电池不耐用了怎么办", "坐火车和坐高铁有什么区别",
    "感冒了多喝水真的有用吗", "怎么把PDF转成Word",
    "帮我起几个好听的花草名字", "学英语背单词有什么窍门",
    "面试的时候怎么自我介绍比较好", "网购退货的流程是怎样的",
    "帮我推荐几本适合睡前看的书", "股票和基金的区别是什么",
    "怎么样才能早起不赖床", "炒菜怎么避免油烟太大",
    "家里WiFi信号不好怎么改善", "帮我写一条朋友圈文案",
    "养多肉植物要注意什么", "坐飞机可以带充电宝吗",
    "孩子上小学前要准备什么", "冬天车玻璃结霜怎么快速处理",
]
EXPERT_CHAT_POOL = [
    "我想研究生成式 AI 对大学生批判性思维的影响，请从研究空白、理论价值和可行性出发提出 3 个选题。",
    "请帮我分析一下新能源汽车行业未来三年的发展趋势和投资逻辑。",
    "帮我设计一个适合初学者的三个月 Python 学习计划。",
    "从宏观经济角度分析一下当前消费市场的复苏态势，给出三个支撑数据维度。",
    "帮我梳理一下跨境电子商务在东南亚市场的进入策略，包括物流、支付和合规三个层面。",
    "想了解下慢性咽炎的日常护理方法，从作息、饮食和用眼习惯方面给点建议。",
    "帮我把一份周报改写成汇报演讲稿的结构，要求开头有结论、中间分点、结尾有行动项。",
    "家里准备装修，帮我对比一下中央空调和分体式空调的优缺点和适用场景。",
    "分析一下短视频平台上知识类内容为什么容易火，从用户心理和算法推荐两个角度。",
    "我是个健身新手，帮我制定一个以减脂为目标的一周训练和饮食框架。",
    "想给父母买份保险，帮我梳理一下医疗险、重疾险和意外险的区别和优先级。",
    "帮我拆解一下'养成系'游戏为什么用户粘性高，有哪些设计机制可以借鉴到学习类产品里。",
    "准备考公务员，帮我对比一下行测和申论的备考策略和时间分配。",
    "从供应链角度讲一下为什么演唱会门票总是秒没，黄牛在其中扮演什么角色。",
    "帮我评估一下开一家社区咖啡店的可行性，从选址、成本和客群三个方面。",
]

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")
CONFIG_DIR = Path(SCRIPT_DIR)
LOG_PATH = os.path.join(SCRIPT_DIR, "kuku_bot.log")

# 日历状态: 0=漏签(可补) 2=未来 3=已签到
CAL_MISSING, CAL_FUTURE, CAL_SIGNED = 0, 2, 3


# ============================================================================
# 日志与工具
# ============================================================================
LOG_HANDLER = None   # GUI 模式下由界面注入回调: fn(msg, level)

# 图鉴(云码)打码平台 Token (可在 config.json 的 jfbym_token 字段覆盖)
JFBYM_TOKEN_DEFAULT = "k3HhgYktdosbQmHewUu_vT87hRGoukybyQPnBXhw0CY"

# 代理提取接口 (星宇代理, 每次登录换 IP 防风控; 可在 config.json 的 proxy_extract_url 覆盖)
PROXY_EXTRACT_URL_DEFAULT = ("http://api.xingyuip.com:6002/api/extract?channel_id=950"
                             "&channel_secret=lfbcig&num=1&auth_mode=password"
                             "&format=txt&dedup=0&sessmin=5&isp=0&sep=0")


def _load_cfg():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def load_jfbym_token():
    return _load_cfg().get("jfbym_token") or JFBYM_TOKEN_DEFAULT


# 百度重点标记的网段 (实测该段登录被 400704 / 发短信 errno=32), 抽到直接重抽
BAD_IP_SEGS = ("218.93.", "218.94.", "116.196.")


def extract_proxy(url=None):
    """从代理提取接口获取一条线路, 返回 http://user:pass@ip:port (失败返回 None)"""
    url = url or _load_cfg().get("proxy_extract_url") or PROXY_EXTRACT_URL_DEFAULT
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode("utf-8", "replace").strip()
        if body.startswith("{"):   # JSON 格式
            d = json.loads(body)
            items = d.get("data") or []
            if items:
                it = items[0]
                ip, port = it.get("proxy_ip"), it.get("proxy_port")
                user, pwd = it.get("username", ""), it.get("password", "")
                if ip.startswith(BAD_IP_SEGS):
                    log(f"抽到黑名单网段 {ip}, 重抽", "WARN")
                    return None
                if user:
                    return f"http://{urllib.parse.quote(user)}:{urllib.parse.quote(pwd)}@{ip}:{port}"
                return f"http://{ip}:{port}"
            log(f"代理提取失败: {body[:120]}", "WARN")
            return None
        for line in body.splitlines():   # TXT: ip:port[:user:pass]
            line = line.strip()
            if not line:
                continue
            parts = line.replace("://", ":").split(":")
            if len(parts) >= 4:
                ip, port, user = parts[0], parts[1], parts[2]
                pwd = ":".join(parts[3:])
                if ip.startswith(BAD_IP_SEGS):
                    log(f"抽到黑名单网段 {ip}, 重抽", "WARN")
                    return None
                return f"http://{urllib.parse.quote(user)}:{urllib.parse.quote(pwd)}@{ip}:{port}"
            if len(parts) == 2:
                if parts[0].startswith(BAD_IP_SEGS):
                    log(f"抽到黑名单网段 {parts[0]}, 重抽", "WARN")
                    return None
                return f"http://{parts[0]}:{parts[1]}"
        log(f"代理提取返回异常: {body[:120]}", "WARN")
    except Exception as ex:
        log(f"代理提取异常: {ex}", "WARN")
    return None


def log(msg, level="INFO"):
    line = time.strftime("[%H:%M:%S] ") + msg
    colors = {"INFO": "\033[0;36m", "OK": "\033[0;32m",
              "WARN": "\033[0;33m", "ERR": "\033[0;31m"}
    reset = "\033[0m"
    if sys.stdout.isatty():
        print(f"{colors.get(level, '')}{line}{reset}")
    else:
        print(line)
    if LOG_HANDLER:
        try:
            LOG_HANDLER(msg, level)
        except Exception:
            pass
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(time.strftime("[%Y-%m-%d %H:%M:%S] ") + f"[{level}] {msg}\n")
    except OSError:
        pass


def rand_v():
    """sendmsg 的 v 字段: 24 位随机 hex"""
    return "".join(random.choices("0123456789abcdef", k=24))


def rand_gid():
    """passport gid"""
    parts = (8, 4, 4, 4, 12)
    chars = "0123456789ABCDEF"
    return "-".join("".join(random.choices(chars, k=n)) for n in parts)


def sleep_jitter(lo=1.5, hi=4.0):
    time.sleep(random.uniform(lo, hi))


# ============================================================================
# HTTP 客户端
# ============================================================================
class Client:
    """原版 urllib 底座 (百度 passport 对 Chrome 指纹会返回 HTML 跳转页;
    urllib 才返回 JSONP + Set-Cookie — 这是原版 GUI 机器人跑通的组合)"""

    def __init__(self, proxy=None, proxy_extractor=None):
        self.jar = http.cookiejar.CookieJar()
        self.proxy = None
        self.proxy_extractor = proxy_extractor   # 网络异常时自动换 IP 的回调
        self.reset_on_rotate = False             # 登录阶段: 换IP清Cookie + 禁止换线
        self.proxy_locked = False                # 一单锁定: True 后整单禁止任何换 IP
        self._ka_stop = None
        self._build_opener(proxy)

    def _build_opener(self, proxy=None):
        handlers = [urllib.request.HTTPCookieProcessor(self.jar)]
        if proxy:
            handlers.append(urllib.request.ProxyHandler(
                {"http": proxy, "https": proxy}))
        self.opener = urllib.request.build_opener(*handlers)
        self.opener.addheaders = [("User-Agent", UA)]
        self.proxy = proxy

    def set_proxy(self, proxy):
        """切换代理 (http://user:pass@ip:port), None=直连"""
        self._build_opener(proxy)
        if proxy:
            log(f"已切换代理: {urllib.parse.urlparse(proxy).hostname}:"
                f"{urllib.parse.urlparse(proxy).port}", "OK")
        else:
            log("已切换为直连", "OK")

    def rotate_proxy(self):
        """换一条代理线路, 成功返回 True
        登录阶段(reset_on_rotate)换 IP 时清空 Cookie: BAIDUID 与 IP 绑定,
        带旧 Cookie 到新 IP 会被 cap 服务判定 Unauthorized Host (100600)"""
        if self.proxy_locked:
            log("IP 已锁定 (单内不换线), 忽略换线请求", "WARN")
            return False
        if not self.proxy_extractor:
            return False
        new_proxy = self.proxy_extractor()
        if not new_proxy:
            return False
        if new_proxy != self.proxy:
            self.set_proxy(new_proxy)
        if self.reset_on_rotate:
            self.jar.clear()
        return True

    def start_keepalive(self, interval=1):
        """已停用: 代理商确认 IP 拿到后 10 分钟内不会闲置失效, 心跳无必要
        (保留接口避免调用方报错)"""
        pass

    def stop_keepalive(self):
        pass

    def test_proxy(self, timeout=8):
        """代理质量预检: 读 kuku 页面前 6KB, 能完整承载 cap/init 的 3KB 响应即可"""
        try:
            st, raw, _ = self.request(
                "https://kuku.baidu.com/app?utm_source=home2",
                headers={"Referer": "https://kuku.baidu.com/"}, timeout=timeout)
            if st != 200:
                return False
            return len(raw) >= 3000
        except Exception:
            return False

    def request(self, url, data=None, headers=None, method=None, timeout=25):
        h = {"Accept": "application/json, text/plain, */*",
             "Accept-Language": "zh-CN,zh;q=0.9",
             "User-Agent": UA}
        if headers:
            h.update(headers)
        req = urllib.request.Request(url, data=data, headers=h, method=method)
        try:
            with self.opener.open(req, timeout=timeout) as resp:
                return resp.status, resp.read(), resp.headers  # 原始字节
        except (urllib.error.URLError, http.client.IncompleteRead,
                ConnectionError, TimeoutError, OSError) as ex:
            # 代理线路不稳定 → 自动换 IP 重试 (保留 Cookie)
            # ⚠️ 登录阶段 (reset_on_rotate) 禁止换线: 百度会话绑定IP, 半路换线必废
            if (self.proxy and self.proxy_extractor
                    and not self.reset_on_rotate and not self.proxy_locked):
                log(f"网络异常 ({type(ex).__name__}), 自动更换代理重试 ...", "WARN")
                for _ in range(3):
                    if self.rotate_proxy():
                        try:
                            req2 = urllib.request.Request(url, data=data,
                                                          headers=h, method=method)
                            with self.opener.open(req2, timeout=timeout) as resp:
                                return resp.status, resp.read(), resp.headers
                        except Exception:
                            continue
            raise

    def get_json(self, url, headers=None, timeout=25):
        st, raw, _ = self.request(url, headers=headers, timeout=timeout)
        return json.loads(self._strip_callback(raw.decode("utf-8", "replace")))

    def post_json(self, url, payload=None, headers=None, timeout=25):
        h = {"Content-Type": "application/json;charset=UTF-8",
             "Origin": KUKU_HOST}
        if headers:
            h.update(headers)
        data = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
        st, raw, _ = self.request(url, data=data, headers=h, timeout=timeout)
        return json.loads(self._strip_callback(raw.decode("utf-8", "replace")))

    def post_form(self, url, form=None, headers=None, timeout=25):
        h = {"Content-Type": "application/x-www-form-urlencoded",
             "Origin": KUKU_HOST}
        if headers:
            h.update(headers)
        data = urllib.parse.urlencode(form or {}).encode("utf-8")
        st, raw, _ = self.request(url, data=data, headers=h, timeout=timeout)
        return json.loads(self._strip_callback(raw.decode("utf-8", "replace")))

    @staticmethod
    def _strip_callback(body):
        """去掉 JSONP 包裹: bd__cbs__xxx({...})"""
        s = body.strip()
        if s.startswith("bd__") or s.startswith("cb"):
            l, r = s.find("("), s.rfind(")")
            if 0 < l < r:
                s = s[l + 1:r]
        return s

    # ------------------------------------------------------------- cookies
    def cookie_header(self):
        return "; ".join(f"{c.name}={c.value}" for c in self.jar)

    def get_cookie(self, name):
        for c in self.jar:
            if c.name == name:
                return c.value
        return None

    def set_cookies_from_dict(self, d):
        """手动注入 cookie (从配置文件恢复)"""
        self.jar.clear()
        for k, v in d.items():
            if not v:
                continue
            ck = http.cookiejar.Cookie(
                version=0, name=k, value=v, port=None, port_specified=False,
                domain=".baidu.com", domain_specified=True, domain_initial_dot=True,
                path="/", path_specified=True, secure=False, expires=None,
                discard=False, comment=None, comment_url=None, rest={}, rfc2109=False)
            self.jar.set_cookie(ck)

    def save_config(self, extra=None):
        cookies = {}
        for name in ("BDUSS", "STOKEN", "BDUSS_BFESS", "STOKEN_BFESS",
                     "BAIDUID", "BAIDUID_BFESS", "BIDUPSID", "PSTM",
                     "PANPSC", "__bid_n"):
            v = self.get_cookie(name)
            if v:
                cookies[name] = v
        # 保留已有的 jfbym_token 等非 Cookie 字段
        prev = {}
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                prev = json.load(f)
        except (OSError, json.JSONDecodeError):
            pass
        cfg = {"cookies": cookies, "saved_at": time.strftime("%Y-%m-%d %H:%M:%S")}
        if prev.get("jfbym_token"):
            cfg["jfbym_token"] = prev["jfbym_token"]
        # ⚠️ 保留代理提取地址等设置 (否则登录成功后配置被覆盖, 回退默认)
        for _k in ("proxy_extract_url", "proxy_enabled",
                   "proxy_keepalive", "proxy_ttl"):
            if prev.get(_k) is not None:
                cfg[_k] = prev[_k]
        if extra:
            cfg.update(extra)
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        os.chmod(CONFIG_PATH, 0o600)
        return cookies

    def load_config(self):
        if not os.path.exists(CONFIG_PATH):
            return False
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                cfg = json.load(f)
            cookies = cfg.get("cookies", {})
            if not cookies.get("BDUSS"):
                return False
            self.set_cookies_from_dict(cookies)
            return True
        except (json.JSONDecodeError, KeyError):
            return False


# ============================================================================
# 扫码登录
# ============================================================================
def get_working_proxy(max_tries=6, url=None):
    """提取并验证一条可用的代理线路 (星宇代理短会话线路质量不稳, 先测再用)"""
    for i in range(max_tries):
        p = extract_proxy(url)
        if not p:
            time.sleep(3)   # 代理商有提取频率限制, 间隔重试
            continue
        c = Client(proxy=p)
        if c.test_proxy():
            return p
        log(f"代理线路不通 ({urllib.parse.urlparse(p).hostname}), 换一条重试 {i + 1}/{max_tries}",
            "WARN")
        time.sleep(2)
    return None

    # ------------------------------------------------------------------ base


class QRLogin:
    def __init__(self, client: Client):
        self.client = client

    def login(self, timeout_sec=180):
        """完整扫码登录流程, 成功后 Cookie 写入 client 并持久化"""
        gid = rand_gid()
        # 1. 申请二维码
        qs = urllib.parse.urlencode({
            "lp": "pc", "qrLoginFrom": "pc", "appid": "498",
            "tpl": "genflowpro", "apiver": "v3", "tt": int(time.time() * 1000),
            "gid": gid, "callback": "bd__cbs__qr",
            "time": int(time.time()), "alg": "v3",
        })
        r = self.client.get_json(f"{PASSPORT_HOST}/v2/api/getqrcode?{qs}",
                                 headers={"Referer": REFERER_APP})
        if r.get("errno") != 0:
            raise RuntimeError(f"获取二维码失败: {r}")
        sign = r["sign"]
        img_path = self._save_qr_image(sign)

        log(f"二维码已生成: {img_path}")
        log("请用【百度 APP】或【手机百度】扫描二维码并确认登录", "WARN")
        try:
            if sys.platform == "darwin":
                subprocess.Popen(["open", img_path])
            elif sys.platform.startswith("linux"):
                subprocess.Popen(["xdg-open", img_path])
        except OSError:
            pass
        log(f"(若图片未自动打开, 可手动打开: {img_path})")

        # 2. 轮询扫码状态 (长轮询)
        deadline = time.time() + timeout_sec
        while time.time() < deadline:
            try:
                tt = int(time.time() * 1000)
                qs = urllib.parse.urlencode({
                    "channel_id": sign, "tpl": "genflowpro", "gid": gid,
                    "apiver": "v3", "tt": tt, "callback": "bd__cbs__uni", "_": tt,
                })
                r = self.client.get_json(
                    f"{PASSPORT_HOST}/channel/unicast?{qs}",
                    headers={"Referer": REFERER_APP}, timeout=35)
            except (urllib.error.URLError, TimeoutError, OSError):
                continue  # 长轮询超时, 继续下一轮

            errno = r.get("errno")
            if errno == 0:
                vcode = (r.get("channel_v") or {}).get("v")
                if not vcode:
                    continue
                log("扫码成功, 正在获取登录凭证 ...")
                return self._finish_login(vcode, gid)
            # errno!=0: 未扫码, 继续轮询
        raise TimeoutError("等待扫码超时, 请重新运行 --login")

    def _save_qr_image(self, sign):
        url = f"{PASSPORT_HOST}/v2/api/qrcode?sign={urllib.parse.quote(sign)}&lp=pc&qrLoginFrom=pc"
        path = os.path.join(SCRIPT_DIR, "qrcode.png")
        st, raw, _ = self.client.request(url, headers={"Referer": REFERER_APP})
        if st == 200 and raw[:4] in (b"\x89PNG", b"GIF8"):
            with open(path, "wb") as f:
                f.write(raw)
        else:
            raise RuntimeError("下载二维码图片失败")
        return path

    def _finish_login(self, vcode, gid):
        """用 vcode 完成登录, 从 Set-Cookie 提取 BDUSS/STOKEN"""
        tt = int(time.time() * 1000)
        qs = urllib.parse.urlencode({
            "loginType": "qr", "vcode": vcode,
            "u": REFERER_APP, "tpl": "genflowpro",
            "apiver": "v3", "tt": tt, "gid": gid,
            "callback": "bd__cbs__login", "time": int(time.time()),
            "alg": "v3", "loginversion": "v5",
        })
        url = f"{PASSPORT_HOST}/v2/api/?login&{qs}"
        h = {"Referer": REFERER_APP, "Origin": PASSPORT_HOST}
        st, raw, _ = self.client.request(url, headers=h)
        body = raw.decode("utf-8", "replace")
        # 登录成功后 cookie 已由 CookieJar 捕获
        bduss = self.client.get_cookie("BDUSS")
        if not bduss:
            if "err_no=0" not in body and '"err_no":0' not in body:
                raise RuntimeError(f"QR 登录失败: {body[:300]}")
        cookies = self.client.save_config()
        log(f"登录成功! Cookie 已保存到 {CONFIG_PATH}", "OK")
        return cookies


# ============================================================================
# 短信验证码协议登录
# ============================================================================
class SmsLogin:
    """纯协议短信登录链路 (全部接口均经抓包逆向 + 实测验证):
    预热Cookie → getapi → cap/init → cap/log → viewlog → senddpass
    → (如需)图形验证码 genimage → 短信发出 → v2/api/?login → BDUSS/STOKEN
    """
    CAP_AK = "1e3f2dd1c81f2075171a547893391274"   # cap 安全模块 ak (kuku 站点固定值)
    STATIC_PAGE = ("https://kuku.baidu.com/m-static/pc-genflow-pro/"
                   "thirdparty/pass_v3_jump.html")
    LOGIN_U = "https://kuku.baidu.com/app?utm_source=home2#/workbench/new-task"

    def __init__(self, client: Client, jfbym_token=""):
        self.c = client
        self.jfbym_token = jfbym_token
        self._dv = ""   # 设备向量 dv: 一次登录会话生成一次, senddpass/login 共用
        # 每单独立虚拟设备档案 (单内固定, 单间不同 → 避免被判定"同设备批量登录")
        self._profile = gen_device_profile()
        self._fuid = ""   # 本单设备指纹 (首次签名时由 bridge.js 算出)
        # ★ 同一单的 profile 必须贯穿全程 (登录 → 领奖)。
        #   登录侧 bridge.js 和领奖侧 htj_bridge.js 用的是同一份, 否则百度侧
        #   会看到"登录是一台设备、领奖是另一台设备"的两台设备画像。
        #   挂在 client 上: client 就是贯穿整单的那个对象。
        client._profile = self._profile

    # ------------------------------------------------------------ 签名工具
    @staticmethod
    def _moonshad_param(phone):
        """senddpass 的 moonshad 参数 = MD5(phone+'Moonshadow') + 固定字符替换"""
        md5 = hashlib.md5((phone + "Moonshadow").encode()).hexdigest()
        for pat, rep in (("o", "ow"), ("d", "do"), ("a", "ad"),
                         ("h", "ha"), ("s", "sh"), ("n", "ns"), ("m", "mo")):
            md5 = re.sub(pat, rep, md5, count=1)
        return md5

    def _moonshad_sign(self, params):
        """moonshadV3 签名 (sig/shaOne/time/alg/elapsed) — 通过 Node 桥接原版 JS"""
        bridge = os.path.join(SCRIPT_DIR, "jsbridge", "bridge.js")
        if not os.path.exists(bridge):
            raise RuntimeError(f"缺少签名组件: {bridge}")
        out = subprocess.run(["node", bridge, json.dumps(params),
                              json.dumps(self._profile)],
                             capture_output=True, text=True, timeout=20)
        if out.returncode != 0:
            raise RuntimeError(f"签名失败: {out.stderr[:200]}")
        d = json.loads(out.stdout)
        # 首次拿到本单设备指纹 (与 moonshad 内部 rinfo.fuid 同源)
        if d.get("fuid") and not self._fuid:
            self._fuid = d["fuid"]
        return d

    # ------------------------------------------------------------ HTTP 工具
    # 统一走 Client.request (内置网络异常自动换代理重试)
    def _get(self, url, raw=False, headers=None):
        h = {"Referer": self.LOGIN_U}
        if headers:
            h.update(headers)
        st, data, _hdr = self.c.request(url, headers=h, timeout=25)
        return data if raw else data.decode("utf-8", "replace")

    def _post(self, url, data):
        # ⚠️ Referer 必带: 缺失会被 cap 服务判定 Unauthorized Host (100600)
        h = {"Content-Type": "application/x-www-form-urlencoded",
             "Origin": "https://kuku.baidu.com",
             "Referer": self.LOGIN_U}
        st, raw, _hdr = self.c.request(url, data=urllib.parse.urlencode(data).encode(),
                                       headers=h, timeout=12)   # 登录链快速失败 (慢线直接弃)
        return raw.decode("utf-8", "replace")

    @staticmethod
    def _jsonp(body):
        m = re.search(r"\((\{.*\})\)", body, re.S)
        return json.loads(m.group(1)) if m else {}

    # ------------------------------------------------------ 打码平台 (图鉴/云码)
    JFBYM_API = "http://api.jfbym.com/api/YmServer/customApi"
    JFBYM_TYPE = "10110"   # 数字字母混合 (百度 passport 图形码为4位字英)

    def _solve_captcha(self, img_bytes):
        """调用图鉴打码平台识别图形验证码; 失败返回空串 (上层回退人工输入)"""
        token = self.jfbym_token
        if not token:
            return ""
        try:
            payload = {"token": token, "type": self.JFBYM_TYPE,
                       "image": base64.b64encode(img_bytes).decode()}
            req = urllib.request.Request(
                self.JFBYM_API, data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                resp = json.loads(r.read().decode())
            if resp.get("code") == 10000:
                code = (resp.get("data") or {}).get("data", "")
                log(f"   打码平台识别成功: {code}", "OK")
                return code.strip()
            log(f"   打码平台返回异常: {resp.get('msg')} (code={resp.get('code')})", "WARN")
        except Exception as ex:
            log(f"   打码平台调用失败: {ex}", "WARN")
        return ""

    # ------------------------------------------------------------ 主流程
    PROXY_TTL = 540   # 代理 IP 有效期 10 分钟 (91HTTP), 留 1 分钟余量

    def login(self, phone, sms_code_provider=None, captcha_fallback=None):
        """两阶段串联 (CLI/GUI 兼容入口):
        sms_code_provider: GUI 回调 fn() -> 短信验证码; captcha_fallback: fn(img_path) -> 图形码"""
        self.login_send_sms(phone, captcha_fallback=captcha_fallback)
        get_sms = sms_code_provider or (lambda: input("📩 请输入收到的短信验证码: ").strip())
        sms_code = str(get_sms()).strip()
        if (self.c.proxy and not self.c.proxy_locked
                and time.time() - self._t0 > self.PROXY_TTL):
            log("⚠️ 代理 IP 即将过期 (10分钟时效), 自动更换新 IP 提交 ...", "WARN")
            self.c.rotate_proxy()
        return self.login_finish(phone, sms_code)

    def login_send_sms(self, phone, captcha_fallback=None):
        """阶段一 (①~⑤): 预热 → getapi → cap → viewlog → senddpass (图形码自动打码)
        会话上下文存 self._ctx, 供 login_finish 使用"""
        self._t0 = time.time()
        self._last_cap_code = ""
        self._dv = gen_dv(self._profile)   # 生成设备向量 (整个登录会话共用)
        if self._dv:
            log(f"设备向量 dv 已生成 ({len(self._dv)} 字符)", "OK")
        gid = rand_gid()
        log("① 预热会话 Cookie ...")
        try:
            self._get(f"{KUKU_HOST}/app?utm_source=home2")
        except Exception:
            pass
        time.sleep(1)

        log("② 获取登录 token (getapi) ...")
        sign_params = {"token": "", "tpl": "genflowpro", "subpro": "", "apiver": "v3",
                       "tt": str(int(time.time() * 1000)), "class": "login", "gid": gid,
                       "loginversion": "v5", "logintype": "dialogLogin"}
        sig = self._moonshad_sign(sign_params)
        body = self._get(f"{PASSPORT_HOST}/v2/api/?getapi&" + urllib.parse.urlencode(
            {**sign_params, "traceid": "", "time": sig["time"], "alg": sig["alg"],
             "sig": sig["sig"], "shaOne": sig["shaOne"], "callback": "bd__cbs__ga"}))
        token = (re.search(r'"token"\s*:\s*"([^"]+)"', body) or [None, ""])[1]
        if not token or "fisrt" in token:
            raise RuntimeError(f"getapi 失败: {body[:200]}")

        log("③ 初始化安全模块 (cap) ...")
        cap_init = None
        last_resp = ""
        for attempt in range(2):
            try:
                r = json.loads(self._post(f"{PASSPORT_HOST}/cap/init", {
                    "_": int(time.time() * 1000), "refer": self.LOGIN_U, "ak": self.CAP_AK,
                    "ver": "2", "scene": "login", "ds": "", "tk": "", "as": "", "reinit": "0"}))
                if r.get("code") == 0 and r.get("data"):
                    cap_init = r["data"]
                    break
                log(f"cap/init 第{attempt + 1}次异常: {str(r)[:120]}", "WARN")
            except Exception as e:
                log(f"cap/init 第{attempt + 1}次异常: {e}", "WARN")
            # 同一 IP 内重试 (换 IP 会导致②的 token 失效, 由外层整链重启负责换 IP)
            time.sleep(1)
        if not cap_init:
            raise RuntimeError(f"cap/init 失败, 服务返回: {last_resp}")

        time.sleep(1)
        cap_log = None
        for attempt in range(2):
            try:
                r = json.loads(self._post(f"{PASSPORT_HOST}/cap/log", {
                    "_": int(time.time() * 1000), "refer": self.LOGIN_U, "ak": self.CAP_AK,
                    "as": cap_init["as"], "scene": "login", "tk": cap_init["tk"], "ver": "2"}))
                if r.get("code") == 0 and r.get("data"):
                    cap_log = r["data"]
                    break
                log(f"cap/log 第{attempt + 1}次异常: {str(r)[:120]}", "WARN")
            except Exception as e:
                log(f"cap/log 第{attempt + 1}次异常: {e}", "WARN")
            time.sleep(2)
        if not cap_log:
            raise RuntimeError("cap/log 连续失败, 请重试")
        time.sleep(1)

        log("④ 获取风控会话 (viewlog) ...")
        vl = None
        for attempt in range(2):
            try:
                body = self._get(
                    f"{PASSPORT_HOST}/viewlog?callback=bd__cbs__vl&ak={self.CAP_AK}&_={int(time.time() * 1000)}")
                d = self._jsonp(body)
                if d.get("data") and d["data"].get("tk"):
                    vl = d["data"]
                    break
                log(f"viewlog 第{attempt + 1}次异常: {str(d)[:120]}", "WARN")
            except Exception as e:
                log(f"viewlog 第{attempt + 1}次异常: {e}", "WARN")
            time.sleep(2)
        if not vl:
            raise RuntimeError("viewlog 连续失败, 请重试")

        # ⑤ 发送短信 (可能需要图形验证码, 最多重试 4 轮)
        #    首次: 完整参数 (含一次性 ds/tk/s/k)
        #    重试: 浏览器重试用的是精简参数集 (vcodestr/vcodesign/verifycode),
        #          复用一次性令牌会被服务端视为重放 → 再次 errno 18
        vcodestr = vcodesign = ""
        sent = False
        for attempt in range(4):
            if attempt == 0:
                log("⑤ 发送短信验证码 ...")
                sp = {"gid": gid, "username": phone, "countrycode": "",
                      "bdstoken": token, "tpl": "genflowpro", "loginVersion": "v5",
                      "flag_code": "0", "client": "", "mkey": "",
                      "moonshad": self._moonshad_param(phone),
                      "ds": vl["ds"], "tk": vl["tk"], "s": cap_log["ds"],
                      "k": cap_init["tk"], "supportdv": "1", "dv": self._dv, "apiver": "v3"}
            else:
                log(f"⑤ 图形码重试 (第 {attempt}/4 轮) ...")
                sp = {"gid": gid, "username": phone, "countrycode": "",
                      "bdstoken": token, "tpl": "genflowpro",
                      "vcodestr": vcodestr, "vcodesign": vcodesign,
                      "verifycode": self._last_cap_code or "",
                      "flag_code": "0", "loginVersion": "v5", "mkey": "",
                      "moonshad": self._moonshad_param(phone), "dv": self._dv}
            sig2 = self._moonshad_sign(sp)
            body = self._get(f"{PASSPORT_HOST}/v2/api/senddpass?" + urllib.parse.urlencode(
                {**sp, "tt": str(int(time.time() * 1000)), "time": sig2["time"],
                 "alg": sig2["alg"], "sig": sig2["sig"], "shaOne": sig2["shaOne"],
                 "elapsed": sig2.get("elapsed", ""), "rinfo": sig2.get("rinfo", ""),
                 "traceid": gen_traceid(), "callback": gen_sd_callback()}))
            d = self._jsonp(body)
            errno = d.get("errno")
            # 完整响应落日志: errno=32"安全风险"可能带 isslide(滑块)/vcodestr(图形码), 需看清再定策略
            log(f"senddpass 响应: errno={errno} isslide={d.get('isslide')} "
                f"vcodestr={bool(d.get('vcodestr'))} | {json.dumps(d, ensure_ascii=False)[:220]}", "INFO")
            # ⚠️ 每次响应都更新签名: 成功响应携带的 vcodestr/vcodesign 才是
            #    本次短信会话的正确签名, 旧的会导致登录 err_no=20 验证码错误
            # null 归一成 "" (真实抓包登录时这两个字段为空串, 不能是字面 "None")
            vcodestr = d.get("vcodestr") or ""
            vcodesign = d.get("vcodesign") or ""
            if errno == 0:
                log("✅ 短信验证码已发送, 请查收", "OK")
                sent = True
                break
            if errno in (18, 20):   # 需要/错误的图形验证码 → 重新取图识别
                if errno == 20:
                    log(f"上一图形码未通过 ({d.get('msg')}), 换一张重试", "WARN")
                img_path = os.path.join(SCRIPT_DIR, "captcha.png")
                img = self._get(f"{PASSPORT_HOST}/cgi-bin/genimage?{vcodestr}", raw=True)
                with open(img_path, "wb") as f:
                    f.write(img)
                code = self._solve_captcha(img)
                if not code:
                    log("打码平台未返回结果, 请手动输入", "WARN")
                    if captcha_fallback:
                        code = str(captcha_fallback(img_path) or "").strip()
                    else:
                        try:
                            if sys.platform == "darwin":
                                subprocess.Popen(["open", img_path])
                        except OSError:
                            pass
                        code = input("   请输入图片中的字符: ").strip()
                self._last_cap_code = code
                if not code:
                    continue
                log(f"   图形码: {code}")
                continue
            else:
                raise RuntimeError(f"senddpass 失败: errno={errno} {d.get('msg')}")
        if not sent:
            raise RuntimeError("图形验证码连续 4 轮未通过, 请稍后重试")

        # 阶段一完成, 保存会话上下文
        self._ctx = {"token": token, "gid": gid,
                     "vcodestr": vcodestr, "vcodesign": vcodesign}
        return True

    def login_finish(self, phone, sms_code):
        """阶段二 (⑥⑦): 提交短信码登录 → auth 跨域同步 → 登录态校验"""
        token = self._ctx["token"]
        gid = self._ctx["gid"]
        vcodestr = self._ctx.get("vcodestr") or ""
        vcodesign = self._ctx.get("vcodesign") or ""
        log("⑥ 提交登录 ...")
        lp = {"staticpage": self.STATIC_PAGE, "charset": "UTF-8", "token": token,
              "tpl": "genflowpro", "subpro": "", "apiver": "v3",
              "tt": str(int(time.time() * 1000)), "u": self.LOGIN_U, "idc": "",
              "isdpass": "1", "gid": gid, "switchuname": "", "smscodestring": "",
              "smsvcodesign": vcodesign, "smsvcodestr": vcodestr,
              "is_voice_sms": "0", "voice_sms_flag": "0", "mkey": "",
              "username": phone, "password": sms_code, "mem_pass": "on",
              "smsisagree": "on", "fp_uid": "", "fp_info": "", "client": "",
              "isupsms": "", "channelid": "", "countrycode": "",
              "loginversion": "v5", "dv": self._dv, "bdint_sync_cookie": "0",
              "traceid": gen_traceid(), "callback": gen_callback()}
        # ★ fuid: 本单设备指纹 (bridge.js 按本单 profile 算出, getapi 阶段已就绪)。
        #   算不出来就不传这个字段 —— 绝不送全局固定值, 否则所有客户账号
        #   在百度侧会被认成同一台设备 (批量薅羊毛画像)。
        if self._fuid:
            lp["fuid"] = self._fuid
        sig4 = self._moonshad_sign(lp)
        body = self._post(f"{PASSPORT_HOST}/v2/api/?login", {
            **lp, "time": sig4["time"], "alg": sig4["alg"], "sig": sig4["sig"],
            "elapsed": sig4.get("elapsed", ""), "shaOne": sig4["shaOne"],
            "rinfo": sig4.get("rinfo", "")})
        bduss = self.c.get_cookie("BDUSS")
        if not bduss:
            m = re.search(r"err_no=(-?\d+)", body)
            err = m.group(1) if m else "?"
            if err == "0":
                # errno=0 + HTML 跳转页: 领取成功但 Cookie 在跳转链里, 必须跟随
                mh = re.search(r'var href\s*=\s*decodeURIComponent\("([^"]+)"\)', body)
                if mh:
                    href = urllib.parse.unquote(mh.group(1))
                    log(f"跳转链接: {href[:180]}")
                    got_ck = False
                    # 尝试1: 原样跟随
                    try:
                        self._get(href)
                        got_ck = True
                    except Exception as ex:
                        log(f"跳转原样跟随失败: {str(ex)[:90]}, 查询串编码后重试", "WARN")
                    # 尝试2: 查询串百分号编码 (空格/中文等 curl 不接受的字符)
                    if not got_ck:
                        try:
                            _sp = urllib.parse.urlsplit(href)
                            _q = urllib.parse.quote(_sp.query,
                                                    safe="=&/%:?;@$,!~*'()[]-._")
                            self._get(urllib.parse.urlunsplit(
                                (_sp.scheme, _sp.netloc, _sp.path, _q, _sp.fragment)))
                            got_ck = True
                        except Exception as ex:
                            log(f"跳转编码重试仍失败: {str(ex)[:90]}", "WARN")
                    if got_ck:
                        bduss = self.c.get_cookie("BDUSS")
            if not bduss:
                msg = {"18": "需要验证码", "20": "验证码错误", "4": "密码/验证码错误",
                       "257": "请输入验证码", "6": "验证码有误"}.get(err, "")
                # 完整响应落日志 (百度真实提示在 HTML/跳转链里, 别再猜)
                log(f"登录失败响应全文({len(body)}字符): {body[:1200]}", "WARN")
                mh2 = re.search(r'var href\s*=\s*decodeURIComponent\("([^"]+)"\)', body)
                if mh2:
                    log(f"失败跳转链: {urllib.parse.unquote(mh2.group(1))[:400]}", "WARN")
                raise RuntimeError(f"登录失败 err_no={err} {msg}; 响应: {body[:200]}")

        # ⑦ 跨域同步 (必须在登录后立即执行: passport 临时 STOKEN 几分钟内失效)
        #    auth 跳转链会在 kuku.baidu.com 域设置正式 STOKEN, 否则 kuku 接口报"未登录"
        log("⑦ 跨域会话同步 (auth) ...")
        auth_url = (f"{PASSPORT_HOST}/v3/login/api/auth/?return_type=5&tpl=genflowpro&u="
                    + urllib.parse.quote("https://kuku.baidu.com/app?utm_source=home2", safe=""))
        try:
            self._get(auth_url)
        except Exception as ex:
            log(f"auth 同步异常: {ex}", "WARN")

        # 真假校验: 以 kuku userreport 实测为准 (URL 形态不可靠)
        time.sleep(1)
        check = self._get(f"{KUKU_HOST}/api/genflowpro/common/userreport?"
                          + urllib.parse.urlencode(COMMON_QS))
        if '"errno":-6' in check:
            raise RuntimeError("登录后校验失败 (kuku 未登录), 请重新登录")
        log("✅ kuku 登录态确认有效", "OK")
        self.c.save_config()
        log(f"✅ 登录成功! Cookie 已保存到 {CONFIG_PATH}", "OK")
        return True



class KukuBot:
    CLAIM_GAP = 30          # 单个账号的领奖最小间隔(秒)
    # ★ 跨账号的领奖最小间隔(秒) —— 必须保留!
    #   实测 (2026-11-04): 完全放开并发后, 百度按【活动维度】聚合检测到
    #   "短时间多账号领奖", 领奖接口批量返回 errno=8043 need check:
    #     09:00-09:49  登录成功 10 / 领奖成功 6  / 8043 = 0
    #     09:49-10:30  登录成功 10 / 领奖成功 1  / 8043 = 10
    #   (登录成功率不变 → 不是代理问题, 是领奖请求密度触发了活动侧风控)
    #   所以: 登录/补签阶段仍然完全并发 (占 90% 耗时), 只有最后"领奖"这一步
    #   跨账号错开 CLAIM_GLOBAL_GAP 秒 —— 既止血, 又几乎不损失吞吐。
    CLAIM_GLOBAL_GAP = 20
    _global_claim_lock = threading.Lock()
    _global_last_claim_ts = 0.0

    def __init__(self, client: Client, dry_run=False):
        self.c = client
        self.dry_run = dry_run
        self.bdstoken = None
        self.uinfo = None
        self.uk = None
        self._js_token = None
        self._jt_token = ""       # xaf.getData().Token (前端 window.jsToken)
        # ★ 本单设备档案: 优先从 client 取 (与登录侧同一份)。
        #   client 上没有时 (例如后台重领队列重建会话) 才自己生成一份。
        self._profile = getattr(client, "_profile", None) or gen_device_profile()
        client._profile = self._profile
        # 本单独立的限速锁 (同单内部仍受 CLAIM_GAP 保护)
        if not hasattr(client, "_claim_lock"):
            client._claim_lock = threading.Lock()
            client._last_claim_ts = 0.0
        self._claim_lock = client._claim_lock

    # ------------------------------------------------------------- helpers
    def _qs(self, extra=None):
        d = dict(COMMON_QS)
        if extra:
            d.update(extra)
        return urllib.parse.urlencode(d)

    def _h(self, referer=REFERER_APP, xhr=False):
        """请求头
        ⚠️ 必须伪装成真实 Chrome: urllib 默认 UA 是 "Python-urllib/3.x",
           百度风控一眼识别 → claimreward 直接返回 8001 (HTJ_ERROR)。
           头字段取自真实浏览器抓包 (活动页 /act/v2/kukuai30/homepage 的请求)。"""
        h = dict(BROWSER_HEADERS)
        h["Referer"] = referer
        if xhr:
            h["X-Requested-With"] = "XMLHttpRequest"
            h["Content-Type"] = "application/json;charset=UTF-8"
        return h

    def js_token(self, refresh=False):
        """活动反作弊 jsToken (getJsToken 接口), makeuptask/taskcomplete/claimreward 必需"""
        if self._js_token and not refresh:
            return self._js_token
        try:
            self._js_token = self.get_js_token()
        except Exception:
            self._js_token = ""
        return self._js_token

    # ------------------------------------------------------------ 1 登录态
    def ensure_login(self):
        """校验登录态并刷新 bdstoken/uinfo/uk"""
        r = self.c.get_json(f"{KUKU_HOST}/api/genflowpro/common/userreport?{self._qs()}",
                            headers=self._h())
        if r.get("errno") != 0 or not r.get("data", {}).get("bdstoken"):
            return False
        d = r["data"]
        self.bdstoken, self.uinfo, self.uk = d["bdstoken"], d.get("uinfo", ""), d.get("uk", "")
        return True

    # ------------------------------------------------------------- 2 签到
    def homepage(self):
        r = self.c.post_json(f"{KUKU_HOST}/act/v2/kukuai30/homepage?tid={TID_SIGN}",
                             headers=self._h(REFERER_ACT, xhr=True))
        if r.get("errno") != 0:
            raise RuntimeError(f"homepage 失败: {r.get('show_msg') or r}")
        return r["data"]

    def signin(self):
        """每日签到 (含反作弊参数 jt/jsToken/hjs/aid/ev, 与 claimreward 一致)"""
        js_token = self.js_token(refresh=True)
        jt = self.gen_jt()
        params = {"uid": self.uk, "tid": TID_SIGN, "hjs": "1", "aid": AID_ACTIVITY,
                  "ev": "sign", "jt": jt, "js_env": "h5", "app": "universe"}
        if js_token:
            params["jsToken"] = js_token
        qs = urllib.parse.urlencode(params)
        r = self.c.post_form(f"{KUKU_HOST}/act/v2/kukuai30/signin?{qs}",
                             headers=self._h(REFERER_APP))
        return r

    # ------------------------------------------------------------- 3 补签
    def get_makeup_task(self, date):
        qs = urllib.parse.urlencode({"tid": TID_SIGN, "date": date, "platform": "web"})
        r = self.c.post_json(f"{KUKU_HOST}/act/v2/kukuai30/makeuptask?{qs}&jsToken={self.js_token()}",
                             headers=self._h(REFERER_ACT, xhr=True))
        if r.get("errno") != 0:
            return None, r
        return r["data"].get("task"), r

    def alloc_session(self):
        """申请会话 id (idallochstr gen_type=3)"""
        qs = self._qs({"bdstoken": "0"})
        r = self.c.post_json(f"{KUKU_HOST}/wenchain/genflow/idallochstr?{qs}",
                             payload={"channel": "kuku_web_genflowpro_v1", "gen_type": 3},
                             headers=self._h(REFERER_APP))
        d = r.get("data") or {}
        if r.get("status", {}).get("code") != 0 or not d.get("chat_id"):
            raise RuntimeError(f"申请会话失败: {r}")
        return d["chat_id"], d["query_id"]

    def sendmsg(self, session_id, reply_id, text, expert=None):
        """发送聊天消息 (普通/专家)"""
        show_experts = []
        if expert:
            show_experts = [dict(expert, display_name="科研专家",
                                 avatar="https://staticsns.cdn.bcebos.com/amis/2026-9/1789396948866/%E7%A7%91%E7%A0%94%E4%B8%93%E5%AE%B6.png")]
        text_id = str(uuid.uuid4())
        rich = [{"id": "textId", "version": "1.0", "type": "text",
                 "text": text, "data": {"content": text}}]
        payload = {
            "type": "message",
            "sub_type": "chat_create",
            "client_session_id": str(uuid.uuid4()),
            "session_id": session_id,
            "reply_id": reply_id,
            "uk": "",
            "cid": 0,
            "channel": "kuku_web_genflowpro_v1",
            "device_type": 400,
            "created_at": int(time.time() * 1000),
            "msg_type": 1,
            "sync_type": 0,
            "sync_id": "",
            "v": rand_v(),
            "data": {
                "project_type": 1,
                "text": text,
                "rich_input_params": rich,
                "fsid": [], "quotes": [], "skills": [],
                "experts": [expert] if expert else [],
                "model_name": "auto",
                "model_display_name": "Auto",
                "think_mode": 3,
                "show_text": json.dumps({
                    "skills": [], "experts": show_experts,
                    "model_name": "auto", "model_display_name": "Auto",
                    "think_mode": 3,
                    "richInputContent": [{"type": "text", "text": text}],
                    "fileInfo": [],
                }, ensure_ascii=False),
                "premake_data": {},
                "custom_instructions": "",
                "memory_sign": True,
                "skill_dig_sign": True,
                "client_added": json.dumps({
                    "client_session_id": text_id,
                    "permission_type": 0,
                    "clienttype": COMMON_QS["clienttype"],
                    "app_id": int(COMMON_QS["app_id"]),
                    "web": 1, "channel": COMMON_QS["channel"],
                    "version": COMMON_QS["version"],
                    "bdstoken": self.bdstoken, "uinfo": self.uinfo, "uk": self.uk,
                    "report_channel": "chunlei", "report_source": "home2",
                }, ensure_ascii=False),
            },
        }
        qs = self._qs({"bdstoken": self.bdstoken, "uinfo": self.uinfo, "uk": self.uk})
        r = self.c.post_json(f"{KUKU_HOST}/wenchain/genflowpro/sendmsg?{qs}",
                             payload=payload, headers=self._h(REFERER_APP))
        return r.get("status", {}).get("code") == 0

    def taskcomplete(self, task_id_str, event_type, session_id=None):
        """任务完成上报"""
        payload = {
            "task_from": "kuku_signin_30_makeup",
            "event_type": event_type,
            "task_id_str": str(task_id_str),
            "app_id": int(COMMON_QS["app_id"]),
            "clienttype": int(COMMON_QS["clienttype"]),
            "version": COMMON_QS["version"],
        }
        if session_id:
            payload["session_id"] = session_id
        qs = self._qs({"bdstoken": self.bdstoken, "uinfo": self.uinfo, "uk": self.uk,
                       "jsToken": self.js_token()})
        r = self.c.post_json(
            f"{KUKU_HOST}/api/genflowpro/activity/taskcomplete?{qs}",
            payload=payload, headers=self._h(REFERER_APP))
        return r.get("errno") == 0, r

    def browse_knowledge_square(self):
        """浏览知识广场 (GET feed)"""
        try:
            self.c.get_json(f"{KUKU_HOST}/api/kukuknowledge/feed?{self._qs()}",
                            headers=self._h(REFERER_APP))
        except Exception:
            pass  # 浏览接口失败不影响后续 taskcomplete

    def _detect_task_type(self, task):
        """根据任务信息推断任务类型"""
        name = task.get("task_name", "") or ""
        extra = task.get("task_extra", "") or ""
        if "浏览" in name or "知识广场" in name or "VIEW_KNOWLEDGE" in extra:
            return "browse", "VIEW_KNOWLEDGE_SQUARE"
        if "专家" in name or "EXPERT" in extra:
            return "expert", "EXPERT_CONVERSATION_TASK"
        if "聊" in name or "CONVERSATION" in extra or "对话" in name:
            return "chat", "CONVERSATION_DAILY_TASK"
        # 兜底: 按任务类型编号
        return "chat", "CONVERSATION_DAILY_TASK"

    def makeup_one(self, date):
        """补签单个日期, 返回是否成功"""
        log(f"── 补签 {date}")
        task, resp = self.get_makeup_task(date)
        if task is None:
            log(f"获取补签任务失败: {resp.get('show_msg') or resp}", "ERR")
            return False
        task_id = task.get("task_id_str") or str(task.get("task_id", ""))
        task_name = task.get("task_name", "?")
        kind, event_type = self._detect_task_type(task)
        log(f"任务: {task_name} (类型: {kind})")

        if self.dry_run:
            log("[演练] 跳过实际执行", "WARN")
            return False

        sleep_jitter(1, 2)
        session_id = None
        expert = None
        if kind == "browse":
            self.browse_knowledge_square()
            log("已浏览知识广场")
            time.sleep(10)  # 模拟浏览 10 秒 (任务要求)
        else:  # chat / expert
            sid, rid = self.alloc_session()
            session_id = sid
            sleep_jitter(1, 2.5)
            if kind == "chat":
                text = random.choice(CHAT_POOL)
            else:
                text = random.choice(EXPERT_CHAT_POOL)
                expert = {"skill_id": 1041, "name": "research_expert",
                          "scope": "public", "creator_uk": ""}
            log(f"发送消息: {text[:24]}...")
            ok = self.sendmsg(sid, rid, text, expert=expert)
            if not ok:
                log("发送消息失败", "WARN")
        sleep_jitter(1.5, 3)
        ok, resp = self.taskcomplete(task_id, event_type, session_id)
        if not ok:
            log(f"任务上报失败: {resp.get('show_msg') or resp}", "ERR")
            return False
        log(f"任务完成上报成功 ({event_type})", "OK")
        return True

    # ------------------------------------------------------------- 4 领奖
    def get_js_token(self):
        """活动反作弊 jsToken (getJsToken 接口)

        ⚠️ 这个接口必须带公共参数, 否则 404 (前端 axios 拦截器会自动合并
           KUKU_PROFILE_PARAMS + js_env + app + clienttype)。
        ⚠️ 返回的 jsToken 是一段 JS 字符串, 前端用 eval 执行后才得到
           window.jsToken —— 这里做等价的提取。
        ⚠️ 取不到时不要静默返回空: 空 jsToken 会让 claimreward 返回
           8002 (JSTOKEN_ERROR) / 8001 (HTJ_ERROR), 排查时看不出原因。
        """
        q = dict(COMMON_QS)
        q.update({"js_env": "h5", "app": "universe", "aid": AID_ACTIVITY,
                  "tid": TID_SIGN})
        try:
            r = self.c.get_json(f"{KUKU_HOST}/operation/activitys/api/getJsToken?"
                                f"{urllib.parse.urlencode(q)}",
                                headers=self._h(REFERER_ACT, xhr=True))
        except Exception as ex:
            log(f"getJsToken 请求失败: {type(ex).__name__}", "WARN")
            return ""
        raw = (r.get("data") or {}).get("jsToken") or ""
        if not raw:
            log("getJsToken 返回空 (百度未签发 jsToken)", "WARN")
            return ""
        # 形如 function%20fn%28a%29...fn%28%22TOKEN%22%29 -> 提取 TOKEN
        m = re.search(r'fn%28%22([0-9A-Fa-f]+)%22%29', raw) or \
            re.search(r'fn\("([0-9A-Fa-f]+)"\)', urllib.parse.unquote(raw))
        return m.group(1) if m else ""

    def _cookie_string(self):
        """本单 Cookie 字符串 (name=value; name=value)
        供 htj_bridge 注入 document.cookie —— dfxaf3 需要从中读
        BDUSS / STOKEN / BAIDUID 才能把账号信息编进 jt。"""
        try:
            jar = getattr(self.c, "jar", None)
            if jar is None:
                return ""
            out = []
            for ck in jar:
                out.append(f"{ck.name}={ck.value}")
            return "; ".join(out)
        except Exception:
            return ""

    def gen_jt(self, href=REFERER_ACT):
        """生成领奖 jt: 由百度 sofire 实时签发 (Node 桥接跑官方 dfxaf3 SDK)

        ⚠️ 必须是实例方法 (原为 @staticmethod): sofire 上报要和领奖请求
           用【同一条 91 代理 IP】+【同一套本单设备档案】, 否则百度侧看到
           "登录用代理IP、领奖凭证申请用机房IP" 的矛盾, 以及
           "登录侧每单随机指纹、领奖侧全局写死设备" 的两台设备画像。
           静态方法拿不到 self.c (client) 和 self._profile, 物理上做不到。

        ⚠️ jt 只能来自百度签发。原版本有一条「本地伪造降级路径」
           (30$CODED--v30 + 硬编码错误串 "dfxaf3 failed to load"),
           那是我当初写错的兜底: 伪造凭证没有百度签名, 领到的奖必然被回收,
           而卡密已核销 → 客户既没会员也没卡密。已彻底移除:
           拿不到就明确失败, 不发起领奖请求 —— 宁可不领, 也不拿假凭证去领。
        """
        bridge = os.path.join(SCRIPT_DIR, "jsbridge", "htj_bridge.js")
        if not os.path.exists(bridge):
            raise RuntimeError(f"缺少反作弊凭证组件: {bridge}")
        # ★ 把本单的 91 代理 IP + 本单设备档案传给 Node:
        #   sofire 上报必须和领奖请求走同一条 IP、用同一套设备档案,
        #   否则百度侧看到"登录用代理IP/随机指纹、领奖凭证申请用机房IP/写死设备"。
        env = dict(os.environ)
        env["HTJ_PROXY"] = getattr(self.c, "proxy", "") or ""
        env["HTJ_PROFILE"] = json.dumps(self._profile or {})
        # ★ 账号 Cookie: dfxaf3 在浏览器里靠 document.cookie 拿 BDUSS/STOKEN
        #   编进 jt。Node 里没有页面, 必须显式喂进去, 否则 jt 里没有账号标识,
        #   claimreward 校验失败 → errno=8001 (HTJ_ERROR)。
        env["HTJ_COOKIE"] = self._cookie_string()
        try:
            out = subprocess.run(["node", bridge], capture_output=True, text=True,
                                 timeout=40, env=env)
        except subprocess.TimeoutExpired:
            raise RuntimeError("反作弊凭证生成超时 (不发起领奖)")
        line = out.stdout.strip().splitlines()[-1] if out.stdout.strip() else ""
        try:
            d = json.loads(line)
        except (json.JSONDecodeError, IndexError):
            d = {}
        if not (d.get("ok") and d.get("jt")):
            raise RuntimeError(f"反作弊凭证获取失败 (不发起领奖): {d or line[:200]}")
        # ★ 同时缓存 xaf.getData().Token —— 即前端的 window.jsToken
        #   (AntiRequest antiParams 的组成部分, 之前完全缺失 → 8002/8001)
        self._jt_token = d.get("token") or ""
        return d["jt"]

    def claim_reward(self, day):
        """领取里程碑奖励 (jsToken + 本地生成 jt, 与浏览器降级路径一致)
        限速:
          - 本单内: 两次领奖请求间隔 >= CLAIM_GAP (30s)
          - 跨账号: 任意两个账号的领奖请求间隔 >= CLAIM_GLOBAL_GAP (20s)
            (百度按活动维度聚合, 密度过高会返回 errno=8043 need check)"""
        # ---- 跨账号节流: 先排队, 保证全局密度 ----
        with KukuBot._global_claim_lock:
            gwait = KukuBot.CLAIM_GLOBAL_GAP - (time.time() - KukuBot._global_last_claim_ts)
            if gwait > 0:
                log(f"全局限速: 等待 {int(gwait)} 秒 (控制活动侧请求密度)", "INFO")
                time.sleep(gwait)
            KukuBot._global_last_claim_ts = time.time()
        # ---- 本单内节流 ----
        with self._claim_lock:
            wait = self.CLAIM_GAP - (time.time() - self.c._last_claim_ts)
            if wait > 0:
                log(f"限速: 等待 {int(wait)} 秒 (本单间隔控制)", "INFO")
                time.sleep(wait)
            self.c._last_claim_ts = time.time()
            if self.dry_run:
                log(f"[演练] 跳过领取 day={day} 奖励", "WARN")
                return False
        js_token = self.js_token(refresh=True)
        jt = self.gen_jt()
        params = {"tid": TID_SIGN, "day": day, "hjs": "1", "aid": AID_ACTIVITY,
                  "ev": "reward", "jt": jt, "js_env": "h5", "app": "universe",
                  "clienttype": COMMON_QS["clienttype"]}
        # ★ antiParams 组成 (前端 AntiRequest.getAntiParams 的公式):
        #   antiParams = htjParams{aid,ev,jt} + jsToken + rands + specialParams
        #   jsToken 优先用 xaf.getData().Token (= 前端 window.jsToken),
        #   取不到再退回 getJsToken 接口。
        token = self._jt_token or js_token
        if token:
            params["jsToken"] = token
        qs = urllib.parse.urlencode(params)
        try:
            r = self.c.post_json(f"{KUKU_HOST}/act/v2/kukuai30/claimreward?{qs}",
                                 headers=self._h(REFERER_ACT, xhr=True))
        except Exception as ex:
            log(f"领奖请求异常: {ex}", "ERR")
            return False
        errno = r.get("errno")
        msg = r.get("errmsg") or r.get("show_msg") or ""
        if errno == 0:
            log(f"day={day} 奖励领取成功! ({r.get('data') or ''})", "OK")
            return True
        if errno == 8011:
            # 逆向报告实测: 8011"领取成功，等待下发"是假成功, state 停 1 永不下发
            log(f"day={day} 返回 8011(假成功, 实测永不下发): {msg} —— 按失败处理", "WARN")
            return False
        log(f"day={day} 领奖失败: errno={errno} {msg}", "WARN")
        log("    请到活动页手动领取: https://kuku.baidu.com/operation/activitys/kukuPcSignAct/main")
        return False

    # ------------------------------------------------------------- 5 信息
    def vip_remain(self):
        try:
            r = self.c.get_json(f"{KUKU_HOST}/bizapi/gfpro/getgfvipremain?{self._qs()}",
                                headers=self._h(REFERER_APP))
            d = r.get("data", {})
            return {"uname": d.get("uname", ""), "is_vip": d.get("isVip", False),
                    "vip_end": d.get("totalVipEndTime", 0)}
        except Exception:
            return {}

    def pan_membership(self):
        """网盘侧 SVIP 信息 (纯协议, 用当前会话CK): 到期时间 + 头像 + 用户名"""
        out = {'is_svip': False, 'expire_str': '', 'avatar': '', 'uname': ''}
        try:
            st, raw, _ = self.c.request(
                'https://pan.baidu.com/rest/2.0/membership/user?web=1&clienttype=0&app_id=250528&method=query',
                headers={'Referer': 'https://pan.baidu.com/buy/memberCenter?tag=8&from=homepage',
                         'X-Requested-With': 'XMLHttpRequest'}, timeout=15)
            r = json.loads(raw)
            for p in r.get('product_infos') or []:
                if p.get('product_name') == 'svip2_nd':
                    ts = int(p.get('end_time') or 0)
                    if ts:
                        out['expire_str'] = time.strftime('%Y-%m-%d %H:%M', time.localtime(ts))
            cp = r.get('current_product_v2') or {}
            out['is_svip'] = cp.get('detail_cluster') == 'svip'
        except Exception:
            pass
        try:
            uk = self.uk or ''
            if uk:
                st2, raw2, _ = self.c.request(
                    f'https://pan.baidu.com/pcloud/user/getinfo?query_uk={uk}&clienttype=0',
                    headers={'Referer': 'https://pan.baidu.com/'}, timeout=15)
                ui = json.loads(raw2).get('user_info') or {}
                out['avatar'] = ui.get('avatar_url', '')
                out['uname'] = ui.get('uname', '')
        except Exception:
            pass
        return out

    def reward_tips(self):
        try:
            r = self.c.get_json(f"{KUKU_HOST}/act/v2/kukuai30/rewardtips?tid={TID_SIGN}",
                                headers=self._h(REFERER_ACT, xhr=True))
            return r.get("data", {})
        except Exception:
            return {}

    def lottery_cnt(self):
        try:
            r = self.c.post_form(f"{KUKU_HOST}/act/v2/component/lottery/homeinfo",
                                 form={"tid": TID_LOTTERY, "action": "lottery_cnt",
                                       "comp_ver": "2"},
                                 headers=self._h(REFERER_ACT, xhr=True))
            return (r.get("data") or {}).get("lottery_cnt", 0)
        except Exception:
            return 0


# ============================================================================
# 主流程
# ============================================================================
def print_homepage(data):
    signed = data.get("signed_today")
    log(f"今日已签到: {'是' if signed else '否'} | 累计 {data.get('total_days')} 天 | "
        f"连签 {data.get('continuous_days')} 天")
    awards = data.get("continuous_awards", [])
    if awards:
        state_map = {0: "未达成", 1: "可领取", 2: "已领取"}
        parts = []
        for a in awards:
            s = state_map.get(a.get("state"), str(a.get("state")))
            parts.append(f"{a['day']}天[{a['prize']}:{s}]")
        log("里程碑: " + " | ".join(parts))
    nr = data.get("next_reward_award")
    if nr:
        log(f"下一奖励: {nr} (还差 {data.get('next_reward_days')} 天)")


def judge_account(home):
    """补签资格判断 (目标 = 天卡 day-3, 即最小里程碑):
    - 天卡已领取 → 无效号 (领取过无法重复领, 补签无意义)
    - 天卡已达成 (state=1) → 有效, 直接领取
    - 未达成 → 计算还差几天连签、补签窗口内可补几天, 判断能否凑成
    返回: valid / reason / claimed_desc / target_day / need_days / can_makeup /
          need_makeup / direct_claim
    """
    total = home.get("total_days", 0)
    continuous = home.get("continuous_days", 0)
    claimed = set(home.get("claimed_days") or [])
    awards = sorted(home.get("continuous_awards", []), key=lambda a: a["day"])
    if not awards:
        return {"valid": False, "reason": "无里程碑奖励数据",
                "total": total, "continuous": continuous, "claimed_desc": "",
                "target_day": None, "need_days": 0, "can_makeup": 0,
                "need_makeup": False, "direct_claim": False}

    target = awards[0]   # 天卡 (day-3)
    day = target["day"]
    claimed_desc = ",".join(
        f"day{a['day']}({a['prize']})" for a in awards
        if a.get("state") == 2 or a["day"] in claimed)

    # 天卡已领取 → 不再判定为无效号
    # ⚠️ 实测: 库库活动按【周期】发奖, 已领过天卡的号补签到下一个里程碑后
    #   还能再领一份网盘天卡 (并非终身一次性)。旧版把"已领过"直接判无效,
    #   会把本可再领的号挡在门外 (卡密不核销, 客户白跑一趟)。
    #   改为: 视为有效, 交由 run_flow 按 continuous_awards 的 state 决定领哪个里程碑。
    if target.get("state") == 2 or day in claimed:
        return {"valid": True,
                "reason": f"天卡 (day={day}) 已领取过, 继续推进下一里程碑 (可再领)",
                "total": total, "continuous": continuous,
                "claimed_desc": claimed_desc or f"day{day}",
                "target_day": day, "need_days": 0, "can_makeup": 0,
                "need_makeup": False, "direct_claim": False,
                "already_claimed": True}

    # 天卡已达成, 待领取
    if target.get("state") == 1:
        return {"valid": True, "reason": f"天卡 (day={day}) 已达成, 待领取",
                "total": total, "continuous": continuous,
                "claimed_desc": claimed_desc, "target_day": day,
                "need_days": 0, "can_makeup": 0, "need_makeup": False,
                "direct_claim": True}

    # 未达成: 计算缺口与可补天数
    need_days = max(0, int(day) - int(continuous))
    today = time.strftime("%Y-%m-%d")
    eligible = sorted(set(home.get("makeup_dates") or []), reverse=True)
    eligible = [d for d in eligible if d < today]
    can_makeup = len(eligible)
    enough = can_makeup >= need_days
    reason = (f"天卡未达成, 还差 {need_days} 天连签, "
              f"补签窗口内可补 {can_makeup} 天 → {'可凑成' if enough else '补不齐(需拉新好友, 放弃)'}")
    return {"valid": enough, "reason": reason,
            "total": total, "continuous": continuous,
            "claimed_desc": claimed_desc, "target_day": day,
            "need_days": need_days, "can_makeup": can_makeup,
            "need_makeup": need_days > 0, "direct_claim": False}


def run_flow(bot, no_makeup=False, no_claim=False, dry_run=False,
             makeup_limit=0, makeup_dates=""):
    """完整流程: 登录校验 → 签到 → 补签 → 领奖 → 汇总 (CLI 与 GUI 共用)"""
    # ⚠️ 一单从头到尾锁定同一条 IP: 登录/签到/补签/领奖全程不换线
    #    (换线会导致百度会话 Cookie 与 IP 错配, 触发 errno=32/402013 风控)
    if not bot.ensure_login():
        log("Cookie 已失效, 请重新登录", "ERR")
        return False
    log(f"登录成功 (uk={bot.uk})", "OK")

    vip = bot.vip_remain()
    if vip.get("uname"):
        vip_desc = ""
        if vip.get("vip_end"):
            vip_desc = ", 会员到期: " + time.strftime(
                "%Y-%m-%d %H:%M", time.localtime(vip["vip_end"]))
        log(f"账号: {vip['uname']}{vip_desc}")

    home = bot.homepage()
    print_homepage(home)

    # ---- 补签资格判断 (真假判断: 判定该号还能不能通过补签拿到奖励) ----
    judge = judge_account(home)
    # 网盘侧复核: 活动页 state 可能滞后 (8011 受理后异步发放), 以会员到账为准
    # 天卡=1天: 若账号已是 VIP 且到期时间在 3 天内 → 天卡应已领取过 → 无效号
    vip = bot.vip_remain()
    if vip.get("is_vip") and vip.get("vip_end"):
        remain = vip["vip_end"] - time.time()
        if 0 < remain <= 3 * 86400:
            judge.update(valid=False, direct_claim=False, need_makeup=False,
                         reason=(f"账号已是网盘会员 (到期 "
                                 f"{time.strftime('%m-%d %H:%M', time.localtime(vip['vip_end']))}), "
                                 f"天卡应已领取过 → 无效号"))
    log("─── 补签资格判断 ───")
    log(f"总签到 {judge['total']} 天 | 连签 {judge['continuous']} 天 | "
        f"已领奖励: {judge['claimed_desc'] or '无'}")
    if not judge["valid"]:
        log(f"⛔ 判定: 无效号 —— {judge['reason']}", "WARN")
        log("   (已领取过的号无法重复领取, 补签/做任务均无意义, 本次流程结束)")
        log("=" * 50)
        print_homepage(home)
        return True
    log(f"✅ 判定: 有效号 —— {judge['reason']}")
    if judge["need_makeup"]:
        log(f"   目标: day={judge['target_day']} 奖励 | 还差 {judge['need_days']} 天连签 | "
            f"窗口内可补 {judge['can_makeup']} 天 (最多近5天, 更早需拉新好友)")
    if judge["direct_claim"]:
        log("   奖励已达成, 将先直接领取 (无需补签)")

    # ---- 签到 ----
    if home.get("signed_today"):
        log("今天已签到, 跳过")
    else:
        log("开始每日签到 ...")
        if dry_run:
            log("[演练] 跳过签到", "WARN")
        else:
            sleep_jitter(0.5, 1.5)
            r = bot.signin()
            if r.get("errno") == 0:
                d = r.get("data", {})
                log(f"签到成功! 连签 {d.get('continuous')} 天", "OK")
            else:
                log(f"签到失败: {r.get('show_msg') or r}", "ERR")
            sleep_jitter(1, 2)
            home = bot.homepage()

    # ---- 先试领: 若奖励已达成 (state=1), 直接领, 无需补签 ----
    if not no_claim:
        home = bot.homepage()
        claimable = [a for a in home.get("continuous_awards", [])
                     if a.get("state") == 1]
        if claimable:
            log(f"已有 {len(claimable)} 个奖励达成, 先直接领取 ...")
            for a in claimable:
                log(f"领取 {a['day']} 天奖励: {a['prize']} ...")
                bot.claim_reward(a["day"])
                sleep_jitter(2, 4)
            home = bot.homepage()

    # ---- 补签 (仅补到天卡里程碑) + 领奖 (8001 自动重试) + 如实返回 ----
    # 单步网络异常 (代理抖动/SSL超时) 只跳过该步, 不炸整个流程
    if dry_run:
        log("[演练] 跳过补签与领奖", "WARN")
        return {"ok": True, "claimed": [], "pending": []}
    if no_makeup and no_claim:
        log("跳过补签与领奖 (参数限制)", "WARN")
        return {"ok": True, "claimed": [], "pending": []}

    def safe_homepage(retries=2):
        for i in range(retries + 1):
            try:
                return bot.homepage()
            except Exception as ex:
                log(f"刷新活动页异常 ({i + 1}/{retries + 1}): {ex}", "WARN")
                time.sleep(4)
        return None

    claimed_days_all = []
    pending_days = []

    # 1) 补签到第一个里程碑 (judge.need_days 的精确缺口)
    if not no_makeup:
        home = safe_homepage()
        if home:
            unclaimed = [a for a in home.get("continuous_awards", []) if a.get("state") == 0]
            if unclaimed:
                nm = min(unclaimed, key=lambda a: a["day"])
                continuous = int(home.get("continuous_days") or 0)
                need = max(0, int(nm["day"]) - continuous)
                today = time.strftime("%Y-%m-%d")
                eligible = sorted(set(home.get("makeup_dates") or []), reverse=True)
                eligible = [d for d in eligible if d < today]
                if need > 0 and eligible:
                    take = min(need, len(eligible))
                    log(f"需补签 {need} 天凑连签 (窗口内补 {take} 天): {', '.join(eligible[:take])}")
                    for date in eligible[:take]:
                        try:
                            bot.makeup_one(date)
                        except Exception as ex:
                            log(f"{date} 补签任务网络异常: {ex}, 跳过", "WARN")
                            continue
                        sleep_jitter(2, 5)
                        h2 = safe_homepage()
                        if h2 is None:
                            continue
                        ok_dates = set(h2.get("makeup_success_dates", []))
                        cal = {c["date"]: c["status"] for c in h2.get("calendar", [])}
                        if cal.get(date) == CAL_SIGNED or date in ok_dates:
                            log(f"{date} 补签成功 ✓", "OK")
                        else:
                            log(f"{date} 补签未生效", "WARN")
                        sleep_jitter(1, 2)
                else:
                    log("无漏签日期 / 补签窗口不足")

    # 逆向报告: 补签/签到生效后 ≥10 秒再领, 否则触发 8001 频控 → 8011 假成功
    sleep_jitter(10, 13)

    # 2) 领取所有可领取奖励 (errno=8001 临时限流 → 自动重试 ×4)
    home = safe_homepage()
    if home:
        claimable = [a for a in home.get("continuous_awards", []) if a.get("state") == 1]
        if claimable:
            log(f"发现 {len(claimable)} 个可领取奖励")
        for a in claimable:
            log(f"领取 {a['day']} 天奖励: {a['prize']} ...")
            got_it = False
            # ⚠️ 限流(8001)重试预算收敛: 最多领 2 次, 间隔 15 秒。
            #   旧版是 24 次退避重试 (咬满 8.5 分钟), 实测同一 day=3 在
            #   36 分钟内被百度拒 12 次 —— 那是"异常领奖频次"特征。
            #   8001 语义是"稍后重试"而非"拒绝", 死磕 24 次没有意义。
            backoff = [15]
            for attempt, wait in enumerate(backoff, 1):
                if bot.claim_reward(a["day"]):
                    got_it = True
                    break
                log(f"  第{attempt}次失败, {wait} 秒后重试 (8001=稍后重试)", "WARN")
                time.sleep(wait)
            if got_it:
                claimed_days_all.append(a["day"])
            else:
                pending_days.append(a["day"])
            sleep_jitter(5, 10)
    else:
        log("活动页不可达, 跳过领奖", "ERR")

    if no_claim:
        log("跳过领奖 (参数限制)", "WARN")

    # 3) 真假复核 (以服务端状态为准)
    home = safe_homepage()
    got = list(claimed_days_all)
    pending = list(pending_days)
    if home:
        claimed_now = set(home.get("claimed_days") or [])
        got = [a["day"] for a in home.get("continuous_awards", [])
               if a.get("state") == 2 or a["day"] in claimed_now]
        pending = [a["day"] for a in home.get("continuous_awards", [])
                   if a.get("state") == 1]
        for d in claimed_days_all:
            if d not in got and d not in pending:
                got.append(d)
    if got:
        log(f"✅ 服务端确认已领取: day={','.join(map(str, sorted(set(got))))}", "OK")
    if pending:
        log(f"⏳ 待下发/未完成: day={','.join(map(str, sorted(set(pending))))} "
            f"(若长时间未到账请到活动页确认)", "WARN")

    # ---- 汇总 ----
    if home:
        log("=" * 50)
        print_homepage(home)
        try:
            tips = bot.reward_tips()
            log(f"积分: {tips.get('kukuai_point', 0)} | 抽奖次数: "
                f"{bot.lottery_cnt() or tips.get('lottery_cnt', 0)}")
        except Exception:
            pass
    log("完成! 明天记得再来签到哦~", "OK")
    return {"ok": True, "claimed": sorted(set(got)), "pending": sorted(set(pending))}



def main():
    parser = argparse.ArgumentParser(description="百度网盘会员自动签到脚本")
    parser.add_argument("--login", action="store_true",
                        help="短信验证码协议登录 (输入手机号→验证码→自动保存Cookie)")
    parser.add_argument("--login-qr", action="store_true", help="扫码登录 (备用方式)")
    parser.add_argument("--phone", type=str, default="", help="手机号 (配合 --login 免交互)")
    parser.add_argument("--status", action="store_true", help="仅查看活动状态")
    parser.add_argument("--dry-run", action="store_true", help="演练模式, 不实际执行")
    parser.add_argument("--no-makeup", action="store_true", help="跳过补签")
    parser.add_argument("--no-claim", action="store_true", help="跳过领奖")
    parser.add_argument("--makeup-limit", type=int, default=0,
                        help="最多补签天数 (0=不限)")
    parser.add_argument("--makeup-dates", type=str, default="",
                        help="指定补签日期, 逗号分隔 (默认自动取最近3天)")
    parser.add_argument("--proxy", action="store_true",
                        help="通过代理提取接口换 IP (登录被风控时使用)")
    parser.add_argument("--proxy-url", type=str, default="",
                        help="自定义代理提取接口地址")
    args = parser.parse_args()

    client = Client()
    if args.proxy:
        proxy = get_working_proxy()
        if proxy:
            client.set_proxy(proxy)
        else:
            log("代理提取失败, 将使用本机网络", "WARN")
    bot = KukuBot(client, dry_run=args.dry_run)

    # ---- 登录 ----
    if args.login or args.login_qr:
        if args.login_qr:
            QRLogin(client).login()
        else:
            phone = args.phone.strip() or input("📱 请输入百度账号手机号: ").strip()
            if not re.fullmatch(r"1\d{10}", phone):
                log("手机号格式不正确 (11位, 1开头)", "ERR")
                sys.exit(1)
            sms = SmsLogin(client, jfbym_token=load_jfbym_token())
            sms.login(phone)
        # 登录成功后立即执行签到流程
        log("")
        if not bot.ensure_login():
            log("登录态校验失败, 请重试 --login", "ERR")
            sys.exit(2)

    if not client.load_config():
        log("未找到有效 Cookie, 请先运行: python3 kuku_bot.py --login", "ERR")
        sys.exit(1)

    if args.status:
        if not bot.ensure_login():
            log("Cookie 已失效, 请重新登录: python3 kuku_bot.py --login", "ERR")
            sys.exit(2)
        home = bot.homepage()
        print_homepage(home)
        tips = bot.reward_tips()
        log(f"积分: {tips.get('kukuai_point', 0)} | 抽奖次数: "
            f"{bot.lottery_cnt() or tips.get('lottery_cnt', 0)}")
        return

    ok = run_flow(bot, no_makeup=args.no_makeup, no_claim=args.no_claim,
                  dry_run=args.dry_run, makeup_limit=args.makeup_limit,
                  makeup_dates=args.makeup_dates)
    if not ok:
        sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已取消")
        sys.exit(130)
    except Exception as ex:
        log(f"运行出错: {ex}", "ERR")
        import traceback
        traceback.print_exc()
        sys.exit(1)
