// 百度官方 dv/g.min.js 的 Node 桥接 —— 生成合法的设备向量 dv (tk...@加密指纹)
// 用法: node dv_bridge.js [UserAgent]   →  stdout 单行 JSON {ok, dv}
// 原理: g.min.js 采集浏览器信息(pageToken+UA+screen+location+行为),
//       用 token 做种子的字典编码 S() 生成 dv, 写入 LG_DV_ARG.dvjsInput
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const UA = process.argv[2] ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 每单独立设备档案 (由 Python 传入 argv[3]): 单内固定, 单间不同
const profile = JSON.parse(process.argv[3] || '{}');

// PageToken 格式 (逆向自抓包): "tk" + Math.random() 小数 + Date.now() 毫秒时间戳
const pageToken = 'tk' + Math.random() + Date.now();

const dvInput = { value: '', type: 'hidden', name: 'dv', id: 'dv_Input' };
const listeners = {};
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, RegExp, Object, Array, String, Number, Boolean,
  parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
  navigator: {
    userAgent: UA, platform: profile.platform || 'MacIntel', language: profile.language || 'zh-CN',
    appVersion: '5.0 (Macintosh)', plugins: [], mimeTypes: [], cookieEnabled: true,
  },
  screen: {
    width: profile.screenW || 1920, height: profile.screenH || 1080,
    availWidth: profile.screenW || 1920, availHeight: (profile.screenH || 1080) - 25,
    colorDepth: profile.colorDepth || 24, pixelDepth: profile.colorDepth || 24,
  },
  location: {
    href: 'https://passport.baidu.com/v2/?login', protocol: 'https:',
    host: 'passport.baidu.com', hostname: 'passport.baidu.com',
    pathname: '/v2/', search: '?login', hash: '',
  },
  history: { length: 1 },
  document: {
    getElementById(id) { return id === 'dv_Input' ? dvInput : null; },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, insertBefore() {} }; },
    getElementsByTagName() { return [{ parentNode: { insertBefore() {} } }]; },
    addEventListener(t, fn) { (listeners['doc_' + t] = listeners['doc_' + t] || []).push(fn); },
    attachEvent() {}, removeEventListener() {},
    cookie: '', documentElement: { insertBefore() {} }, body: { insertBefore() {} },
  },
  Image: function () { return { src: '' }; },
  addEventListener(t, fn) { (listeners['win_' + t] = listeners['win_' + t] || []).push(fn); },
  attachEvent() {}, removeEventListener() {},
  XMLHttpRequest: function () { return { open() {}, send() {}, setRequestHeader() {} }; },
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
sandbox.LG_DV_ARG = {
  PageToken: pageToken, SendMethod: 1, SendInterval: 1000,
  FormId: 'TANGRAM_36__form', DVHost: 'passport.baidu.com',
  BrowserInfo: true, Location: true, ScreenInfo: true, FlashInfo: true, LSIDInfo: true,
};

try {
  vm.createContext(sandbox);
  const sdk = fs.readFileSync(path.join(__dirname, 'dv_g.min.js'), 'utf-8');
  vm.runInContext(sdk, sandbox);
  // 触发 load / DOMContentLoaded 采集 (脚本在页面加载时生成 dv)
  for (const key of ['win_load', 'doc_DOMContentLoaded']) {
    for (const fn of (listeners[key] || [])) { try { fn(); } catch (e) {} }
  }
  const dv = sandbox.LG_DV_ARG.dvjsInput || dvInput.value;
  console.log(JSON.stringify({ ok: !!dv, dv: dv || '' }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e).slice(0, 200) }));
}
