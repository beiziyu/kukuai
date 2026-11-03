// moonshad.js Node 桥接: 提供 moonshadV3 签名 (sig/shaOne/time/alg/elapsed)
// 用法: node bridge.js '{"token":"...","username":"..."}'
'use strict';

// 每单独立设备档案 (由 Python 传入 argv[3]): 单内固定, 单间不同
// 避免所有客户共用同一"虚拟设备"被百度判定批量涉诈 (err_no=402013)
const profile = JSON.parse(process.argv[3] || '{}');

// ---- 最小浏览器环境 shim ----
const shim = {
    window: null,
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    document: {
        createElement: () => ({ style: {} }),
        getElementsByTagName: () => [{ appendChild: () => {} }],
        cookie: '',
        location: { href: 'https://passport.baidu.com/', protocol: 'https:' },
    },
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36' },
    location: { href: 'https://passport.baidu.com/', protocol: 'https:' },
};
// 应用本单档案到 shim
if (profile.screenW) { shim.screen.width = profile.screenW; }
if (profile.screenH) { shim.screen.height = profile.screenH; }
if (profile.colorDepth) { shim.screen.colorDepth = profile.colorDepth; }
if (profile.userAgent) { shim.navigator.userAgent = profile.userAgent; }
if (profile.platform) { shim.navigator.platform = profile.platform; }

shim.window = shim;
global.window = shim;
global.screen = shim.screen;
Object.defineProperty(global, 'document', { value: shim.document, configurable: true, writable: true });
Object.defineProperty(global, 'navigator', { value: shim.navigator, configurable: true, writable: true });
Object.defineProperty(global, 'location', { value: shim.location, configurable: true, writable: true });

// 挂载 passFingerPrint (百度官方 fingerprint.js), 让 moonshad 生成非空 rinfo
// 逆向结论: moonshad.js 里 n.rinfo = p({fuid: d(window.passFingerPrint().fuid)})
// 之前 shim 缺这个函数 → rinfo 一直空; 补上后 sig 与 rinfo 天然自洽
(function () {
    const fs = require('fs');
    const path = require('path');
    const vm = require('vm');
    const fpFile = path.join(__dirname, 'fingerprint.js');
    if (!fs.existsSync(fpFile)) return;
    const sb = {
        console, setTimeout, clearTimeout, Date, Math, JSON, RegExp,
        Object, Array, String, Number, Boolean, parseInt, parseFloat,
        encodeURIComponent, decodeURIComponent,
        navigator: shim.navigator, screen: shim.screen,
        location: shim.location, document: shim.document,
    };
    // fingerprint.js 里 canvas/webgl 采集, 用确定性 shim 提供
    // 每单独立 canvas 指纹 (决定 fuid/rinfo.fuid 的关键输入)
    const fakePng = profile.canvasFp
        || 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const c2d = { rect(){},fillRect(){},fillText(){},beginPath(){},arc(){},closePath(){},fill(){},save(){},restore(){},isPointInPath(){return true;} };
    sb.document.createElement = function (t) {
        if (t === 'canvas') return { width:2000,height:200,style:{},
            getContext(x){ return x==='2d'?c2d:null; }, toDataURL(){ return fakePng; } };
        return { style:{}, getContext(){ return null; } };
    };
    sb.window = sb; sb.self = sb; sb.globalThis = sb;
    sb.window.WebGLRenderingContext = function () {};
    vm.createContext(sb);
    try {
        vm.runInContext(fs.readFileSync(fpFile, 'utf-8'), sb);
        if (typeof sb.passFingerPrint === 'function') {
            shim.passFingerPrint = sb.passFingerPrint;
        }
    } catch (e) { /* 失败则保持 rinfo 为空, 不影响签名 */ }
})();

// 加载原版 moonshad.js (webpack UMD)
require('./moonshad.js');

const mv3 = global.window.moonshadV3 || global.moonshadV3;
if (!mv3) { console.error('moonshadV3 not found'); process.exit(1); }

// ---- 与 loginv5.js 一致的按日轮换逻辑 ----
function pickVariant() {
    const h = { OOOOO0: 'OOOO00', O00000: 'OOO00O', O0O00O: 'OOO000',
                O000OO: 'OOO0OO', O0O000: 'O0OOO0' };
    const v = parseInt(Date.now() / 1000 / 86400, 10) % 5;
    return h[Object.keys(h)[v]];
}

const params = JSON.parse(process.argv[2] || '{}');
const name = pickVariant();
const fn = mv3[name];
if (typeof fn !== 'function') { console.error('variant missing: ' + name); process.exit(1); }

const out = fn(Object.assign({}, params));
// 只输出登录需要的字段
// 输出本单设备指纹 fuid (供登录参数 sms 使用, 与 moonshad 内部 rinfo.fuid 同源)
let fuidOut = '';
try {
    if (typeof shim.passFingerPrint === 'function') {
        fuidOut = (shim.passFingerPrint() || {}).fuid || '';
    }
} catch (e) { /* 忽略: 拿不到就留空, 不影响签名 */ }

console.log(JSON.stringify({
    time: out.time, alg: out.alg, sig: out.sig,
    elapsed: out.elapsed || '', shaOne: out.shaOne || '',
    rinfo: out.rinfo || '', variant: name, fuid: fuidOut,
}));
