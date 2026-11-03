// dfxaf3.js (百度 sofire 反作弊 SDK) Node 桥接
// 目标: 在 Node 中运行真实 SDK, 生成合法的 31$CODED--v31 jt
// 用法: node htj_bridge.js <aid> <dataApp_b64>
'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const AID = process.argv[2] || '15459';
const DATA_APP = process.argv[3] ||
    'eyJhcHBfa2V5IjoiMTU0NTkiLCJhcHBfdmlldyI6InByb21vdGUiLCJicm93c2VyX3VybCI6Imh0dHBzOi8vc29maXJlLmJhaWR1LmNvbS9kYXRhL3VhL2FiLmpzb24iLCJmb3JtX2Rlc2MiOiIiLCJzZW5kX2ludGVydmFsIjo1MCwic2VuZF9tZXRob2QiOjN9';
const PAGE_URL = 'https://kuku.baidu.com/operation/activitys/kukuPcSignAct/main?utm_source=home2';

// ---------------------------------------------------------------- 网络层
function realRequest(method, urlStr, headers, body, cb) {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
        method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: Object.assign({
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9',
        }, headers),
    };
    if (u.username) {
        opts.auth = decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password);
    }
    const req = mod.request(opts, (res) => {
        const chunks = [];
        let stream = res;
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
        else if (enc.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            // 模拟浏览器 cookie 处理 (简单: 存全局, 附加到后续同域请求)
            (res.headers['set-cookie'] || []).forEach((sc) => {
                const kv = sc.split(';')[0];
                const eq = kv.indexOf('=');
                if (eq > 0) COOKIE_STORE[kv.slice(0, eq)] = kv.slice(eq + 1);
            });
            cb({ status: res.statusCode, responseText: text });
        });
        stream.on('error', (e) => cb({ status: 0, responseText: '', error: String(e) }));
    });
    req.on('error', (e) => cb({ status: 0, responseText: '', error: String(e) }));
    if (body) req.write(body);
    req.end();
}

const COOKIE_STORE = {};
function cookieHeader() {
    return Object.entries(COOKIE_STORE).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ---- 行为模拟: SDK 的鼠标/键盘监听器注册表与派发 ----
const EVENT_LISTENERS = [];
function dispatch(type, props) {
    const ev = Object.assign({
        type,
        clientX: 500, clientY: 400, screenX: 500, screenY: 500,
        pageX: 500, pageY: 400, movementX: 0, movementY: 0,
        keyCode: 0, which: 0, button: 0, detail: 1, timeStamp: Date.now(),
        target: documentShim.body, srcElement: documentShim.body,
        view: undefined, bubbles: true, cancelable: true,
        preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
    }, props || {});
    for (const l of EVENT_LISTENERS) {
        if (l.type !== type) continue;
        try { l.fn(ev); } catch (e) {}
    }
}
// 模拟一段真实感鼠标轨迹 (贝塞尔式移动 + 抖动 + 停顿)
function simulateMouse(seconds) {
    const end = Date.now() + seconds * 1000;
    let x = 300 + Math.random() * 300, y = 200 + Math.random() * 200;
    let targetX = 900 + Math.random() * 300, targetY = 400 + Math.random() * 200;
    return new Promise((resolve) => {
        (function step() {
            if (Date.now() > end) return resolve();
            // 向目标缓动 + 随机抖动
            x += (targetX - x) * 0.08 + (Math.random() - 0.5) * 6;
            y += (targetY - y) * 0.08 + (Math.random() - 0.5) * 6;
            dispatch('mousemove', { clientX: x | 0, clientY: y | 0,
                screenX: (x | 0) + 10, screenY: (y | 0) + 40,
                movementX: ((Math.random() - 0.5) * 10) | 0,
                movementY: ((Math.random() - 0.5) * 10) | 0 });
            if (Math.random() < 0.02) {
                dispatch('mousedown', { clientX: x | 0, clientY: y | 0, button: 0 });
                dispatch('mouseup', { clientX: x | 0, clientY: y | 0, button: 0 });
                dispatch('click', { clientX: x | 0, clientY: y | 0, button: 0 });
            }
            if (Math.random() < 0.01) {
                dispatch('keydown', { keyCode: 65 + Math.floor(Math.random() * 26), which: 65 });
                dispatch('keyup', { keyCode: 65 + Math.floor(Math.random() * 26), which: 65 });
            }
            if (Math.random() < 0.03) {   // 换个目标点, 模拟真实移动
                targetX = 200 + Math.random() * 900;
                targetY = 150 + Math.random() * 500;
            }
            setTimeout(step, 60 + Math.random() * 90);
        })();
    });
}

// ---------------------------------------------------------------- XHR shim
class XMLHttpRequestShim {
    constructor() {
        this.readyState = 0; this.status = 0; this.responseText = '';
        this._headers = {}; this._method = 'GET'; this._url = ''; this._async = true;
        this.withCredentials = false;
        this.onreadystatechange = null; this.onload = null; this.onerror = null;
        this.timeout = 0;
    }
    open(method, url, async) {
        this._method = method; this._url = url;
        this._async = async !== false;
        this.readyState = 1;
    }
    setRequestHeader(k, v) { this._headers[k] = v; }
    getAllResponseHeaders() { return ''; }
    getResponseHeader() { return null; }
    abort() {}
    send(body) {
        const headers = Object.assign({}, this._headers);
        const ck = cookieHeader();
        if (ck) headers['Cookie'] = ck;
        if (body && !headers['Content-Type']) {
            headers['Content-Type'] = 'text/plain;charset=UTF-8';
        }
        // 相对 URL 补全
        let url = this._url;
        if (url.startsWith('//')) url = 'https:' + url;
        else if (url.startsWith('/')) url = 'https://sofire.baidu.com' + url;
        const self = this;
        realRequest(this._method, url, headers, body || null, (res) => {
            self.status = res.status;
            self.responseText = res.responseText;
            self.readyState = 4;
            if (self.onload) self.onload();
            if (self.onreadystatechange) self.onreadystatechange();
        });
    }
    addEventListener() {}
}

// ---------------------------------------------------------------- DOM shims
function makeElement(tag) {
    const el = {
        tagName: (tag || 'div').toUpperCase(), style: {}, children: [],
        attributes: {}, _listeners: {},
        setAttribute(k, v) { this.attributes[k] = v; if (k === 'src') this.src = v; },
        getAttribute(k) { return this.attributes[k] !== undefined ? this.attributes[k] : null; },
        appendChild(c) { this.children.push(c); if (c && c._runOnload) setTimeout(c._runOnload, 0); return c; },
        insertBefore(c) { this.children.push(c); if (c && c._runOnload) setTimeout(c._runOnload, 0); return c; },
        remove() {}, removeChild() {},
        addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
        removeEventListener() {},
    getContext(type) {
        if ((type || '').includes('2d')) {
            return {
                canvas: this, fillStyle: '', font: '', textBaseline: '', globalCompositeOperation: '',
                fillRect() {}, clearRect() {}, strokeRect() {}, beginPath() {}, closePath() {},
                moveTo() {}, lineTo() {}, arc() {}, fill() {}, stroke() {}, clip() {},
                fillText() {}, strokeText() {}, measureText(t) { return { width: String(t || '').length * 7 }; },
                getImageData(x, y, w, h) { return { data: new Uint8Array((w || 1) * (h || 1) * 4), width: w, height: h }; },
                putImageData() {}, createImageData(w, h) { return { data: new Uint8Array((w || 1) * (h || 1) * 4), width: w, height: h }; },
                createLinearGradient() { return { addColorStop() {} }; },
                createRadialGradient() { return { addColorStop() {} }; },
                createPattern() { return {}; },
                save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
                setTransform() {}, transform() {}, drawImage() {}, arcTo() {}, quadraticCurveTo() {},
                bezierCurveTo() {}, rect() {}, isPointInPath() { return false; },
            };
        }
        if ((type || '').includes('webgl')) {
            const gl = { canvas: this };
            const consts = ['ALPHA_BITS', 'ALIASED_LINE_WIDTH_RANGE', 'MAX_VERTEX_ATTRIBS', 'MAX_TEXTURE_SIZE',
                'MAX_VERTEX_TEXTURE_IMAGE_UNITS', 'MAX_RENDERBUFFER_SIZE', 'VENDOR', 'RENDERER', 'VERSION',
                'SHADING_LANGUAGE_VERSION', 'RED_BITS', 'GREEN_BITS', 'BLUE_BITS', 'DEPTH_BITS', 'STENCIL_BITS',
                'SAMPLES', 'MAX_VIEWPORT_DIMS', 'MAX_TEXTURE_IMAGE_UNITS', 'MAX_FRAGMENT_UNIFORM_VECTORS',
                'MAX_VERTEX_UNIFORM_VECTORS', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_VARYING_VECTORS', 'DEPTH_FUNC'];
            consts.forEach((c) => { gl[c] = 8; });
            gl.getParameter = (p) => (typeof p === 'number' ? 8 : 'WebKit WebGL');
            gl.getExtension = () => null;
            gl.getSupportedExtensions = () => [];
            gl.getShaderPrecisionFormat = () => ({ rangeMin: 127, rangeMax: 127, precision: 23 });
            gl.createShader = () => ({}); gl.createBuffer = () => ({}); gl.createProgram = () => ({});
            gl.createTexture = () => ({}); gl.createRenderbuffer = () => ({});
            gl.shaderSource = () => {}; gl.compileShader = () => {}; gl.attachShader = () => {};
            gl.linkProgram = () => {};
            gl.getShaderParameter = () => true; gl.getProgramParameter = () => true;
            gl.useProgram = () => {}; gl.deleteShader = () => {}; gl.getShaderInfoLog = () => '';
            gl.getAttribLocation = () => 0; gl.getUniformLocation = () => ({});
            gl.enable = () => {}; gl.disable = () => {}; gl.viewport = () => {};
            gl.clearColor = () => {}; gl.clear = () => {};
            gl.bindBuffer = () => {}; gl.bufferData = () => {}; gl.vertexAttribPointer = () => {};
            gl.enableVertexAttribArray = () => {}; gl.drawArrays = () => {};
            gl.finish = () => {}; gl.getRenderbufferParameter = () => 8;
            gl.activeTexture = () => {}; gl.bindTexture = () => {}; gl.texParameteri = () => {};
            gl.bindRenderbuffer = () => {}; gl.renderbufferStorage = () => {};
            gl.framebufferRenderbuffer = () => {}; gl.checkFramebufferStatus = () => 36053;
            gl.pixelStorei = () => {}; gl.texImage2D = () => {}; gl.scissor = () => {};
            gl.blendFunc = () => {}; gl.depthMask = () => {}; gl.stencilMask = () => {};
            gl.generateMipmap = () => {}; gl.readPixels = () => {};
            gl.detachShader = () => {}; gl.deleteProgram = () => {}; gl.deleteBuffer = () => {};
            gl.deleteTexture = () => {}; gl.deleteRenderbuffer = () => {}; gl.deleteFramebuffer = () => {};
            gl.createFramebuffer = () => ({}); gl.bindFramebuffer = () => {};
            gl.framebufferTexture2D = () => {}; gl.isContextLost = () => false;
            return gl;
        }
        return null;
    },
        getBoundingClientRect() { return { top: 0, left: 0, width: 1920, height: 1080, right: 1920, bottom: 1080 }; },
        focus() {}, blur() {}, click() {},
        innerText: '', innerHTML: '', value: '', src: '',
        parentNode: { removeChild() {}, insertBefore() {} },
        contentWindow: null,
    };
    return el;
}

const localStorageData = {};
const documentShim = {
    cookie: '',
    title: '库库AI',
    referrer: 'https://kuku.baidu.com/app',
    documentElement: makeElement('html'),
    body: makeElement('body'),
    head: makeElement('head'),
    hidden: false,
    currentScript: null,
    createElement(tag) {
        const el = makeElement(tag);
        if ((tag || '').toLowerCase() === 'script') {
            // SDK 用 script 标签加载资源 — Node 里直接不管 (或报错让其降级)
            el._listeners = {};
        }
        return el;
    },
    createTextNode(t) { return { nodeValue: t }; },
    getElementsByTagName(tag) {
        if ((tag || '').toLowerCase() === 'script') {
            return [makeElement('script')];
        }
        return [makeElement(tag)];
    },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { EVENT_LISTENERS.push({ type, fn, src: 'document' }); },
    removeEventListener() {},
    attachEvent() {}, detachEvent() {},
};
documentShim.location = { href: PAGE_URL, protocol: 'https:', hostname: 'kuku.baidu.com', search: '', hash: '' };
documentShim.all = { length: 0, prototype: {} };   // IE 特征检测
documentShim.compatMode = 'CSS1Compat';
documentShim.contentType = 'text/html';
documentShim.characterSet = 'UTF-8';
documentShim.charset = 'UTF-8';
documentShim.readyState = 'complete';
documentShim.prototype = {};
documentShim.doctype = null;
documentShim.implementation = { hasFeature() { return true; }, createDocument() { return documentShim; } };
documentShim.scripts = [makeElement('script')];
documentShim.forms = []; documentShim.images = []; documentShim.links = []; documentShim.embeds = [];
documentShim.plugins = []; documentShim.styleSheets = [];
documentShim.open = function () { return documentShim; };
documentShim.close = function () {};
documentShim.write = function () {};
documentShim.writeln = function () {};
documentShim.createEvent = function () { return { initEvent() {} }; };
documentShim.createDocumentFragment = function () { return makeElement('#fragment'); };
documentShim.createComment = function (t) { return { nodeValue: t }; };
documentShim.hasFocus = function () { return true; };
documentShim.execCommand = function () { return true; };
documentShim.exitFullscreen = function () {};

// 记录缺失属性访问 (调试用: 环境变量 HTJ_DEBUG=1 时输出)
if (process.env.HTJ_DEBUG) {
    const missingLog = [];
    global.__docProxy = new Proxy(documentShim, {
        get(target, k) {
            if (!(k in target) && typeof k === 'string' && missingLog.length < 200) {
                missingLog.push(k);
            }
            return target[k];
        },
    });
    process.on('exit', () => {
        require('fs').writeFileSync(path.join(__dirname, 'htj_missing.txt'), missingLog.join('\n'));
    });
}

const navigatorShim = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    appName: 'Netscape', appVersion: '5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    platform: 'MacIntel', language: 'zh-CN', languages: ['zh-CN'],
    cookieEnabled: true, onLine: true,
    hardwareConcurrency: 8, maxTouchPoints: 0,
    plugins: { length: 0 }, mimeTypes: { length: 0 },
    connection: { effectiveType: 'wifi', type: 'wifi' },
    webdriver: false,
    javaEnabled() { return false; },
    getBattery() { return Promise.resolve({ charging: true, level: 1 }); },
    prototype: {},
};

const windowShim = {
    location: documentShim.location,
    navigator: navigatorShim,
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1055, colorDepth: 30, pixelDepth: 30 },
    document: documentShim,
    innerWidth: 1920, innerHeight: 945, outerWidth: 1920, outerHeight: 1055,
    devicePixelRatio: 2,
    localStorage: {
        _d: localStorageData,
        getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; },
        setItem(k, v) { this._d[k] = String(v); },
        removeItem(k) { delete this._d[k]; },
        clear() { this._d = {}; },
    },
    sessionStorage: {
        _d: {},
        getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; },
        setItem(k, v) { this._d[k] = String(v); },
        removeItem(k) { delete this._d[k]; },
    },
    history: { length: 2, pushState() {}, replaceState() {} },
    performance: { now() { return Date.now() % 1e7; }, timing: { navigationStart: Date.now() - 8000 } },
    XMLHttpRequest: XMLHttpRequestShim,
    Image: class { constructor() { this._src = ''; } set src(v) { this._src = v; } get src() { return this._src; } },
    addEventListener(type, fn) { EVENT_LISTENERS.push({ type, fn, src: 'window' }); },
    removeEventListener() {},
    attachEvent() {}, detachEvent() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame(cb) { return setTimeout(cb, 16); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    btoa(s) { return Buffer.from(s, 'binary').toString('base64'); },
    atob(s) { return Buffer.from(s, 'base64').toString('binary'); },
    escape: (s) => encodeURIComponent(s),
    unescape: (s) => decodeURIComponent(s),
    parseInt, parseFloat, isNaN, isFinite,
    JSON, Math, Date, Array, Object, String, Number, Boolean, RegExp, Error,
    Uint8Array, Int8Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
    Promise, Map, Set, Symbol, Proxy, Reflect, TextDecoder: undefined, TextEncoder: undefined,
    notificationPermission: 'default',
    chrome: false, opr: false, safari: false,
    external: {},
    crypto: { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; } },
    JSBridge: undefined,
    // 常见 DOM 类原型 (SDK 环境检测用)
    HTMLElement: class HTMLElement {},
    HTMLCanvasElement: class HTMLCanvasElement {},
    HTMLDocument: class HTMLDocument {},
    HTMLInputElement: class HTMLInputElement {},
    Document: class Document {},
    Element: class Element {},
    Node: class Node {},
    Storage: class Storage {},
    Location: class Location {},
    Navigator: class Navigator {},
    Screen: class Screen {},
    CanvasRenderingContext2D: class CanvasRenderingContext2D {},
    WebGLRenderingContext: class WebGLRenderingContext {},
    Event: class Event {},
    MouseEvent: class MouseEvent {},
    KeyboardEvent: class KeyboardEvent {},
    CustomEvent: class CustomEvent {},
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
};
windowShim.self = windowShim;
windowShim.globalThis = windowShim;
windowShim.window = windowShim;
windowShim.top = windowShim;
windowShim.parent = windowShim;
windowShim.frames = windowShim;

// 记录 window 缺失属性 (调试)
const __winMissing = [];
const windowProxy = new Proxy(windowShim, {
    get(target, k, recv) {
        const v = Reflect.get(target, k, recv);
        if (v === undefined && typeof k === 'string' && !k.startsWith('_') && __winMissing.length < 500
            && !['undefined', 'NaN', 'Infinity', ' Symbol'].includes(k)) {
            __winMissing.push(k);
        }
        return v;
    },
});
process.on('exit', () => {
    try {
        require('fs').writeFileSync(path.join(__dirname, 'htj_win_missing.txt'),
            [...new Set(__winMissing)].join('\n'));
    } catch (e) {}
});

// ---------------------------------------------------------------- 加载 SDK
global.window = windowProxy;
Object.defineProperty(global, 'document', { value: (process.env.HTJ_DEBUG ? global.__docProxy : documentShim), configurable: true, writable: true });
Object.defineProperty(global, 'navigator', { value: navigatorShim, configurable: true, writable: true });
Object.defineProperty(global, 'location', { value: documentShim.location, configurable: true, writable: true });
global.screen = windowShim.screen;
global.localStorage = windowShim.localStorage;
global.sessionStorage = windowShim.sessionStorage;
global.XMLHttpRequest = XMLHttpRequestShim;
global.Image = windowShim.Image;
global.btoa = windowShim.btoa;
global.atob = windowShim.atob;
// DOM 类挂到 global (SDK 直接 global.XXX.prototype 做环境检测)
const domClasses = ['HTMLElement', 'HTMLCanvasElement', 'HTMLDocument', 'HTMLInputElement',
    'Document', 'Element', 'Node', 'Storage', 'Location', 'Navigator', 'Screen',
    'CanvasRenderingContext2D', 'WebGLRenderingContext', 'Event', 'MouseEvent',
    'KeyboardEvent', 'CustomEvent', 'MutationObserver'];
const safeDefine = (k, v) => {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch (e) { try { global[k] = v; } catch (e2) {} }
};
domClasses.forEach((k) => safeDefine(k, windowShim[k]));
safeDefine('history', windowShim.history);
safeDefine('performance', windowShim.performance);
safeDefine('chrome', false);
safeDefine('openDatabase', undefined);
safeDefine('indexedDB', undefined);
safeDefine('requestIdleCallback', undefined);
safeDefine('cancelIdleCallback', undefined);

const sdkPath = path.join(__dirname, 'dfxaf3.js');
let sdkSrc = fs.readFileSync(sdkPath, 'utf-8');
// 补丁: getJsEnvCheck 是 IE/环境检测位, Node 环境下直接返回安全值
const envCheckOriginal = 'getJsEnvCheck:function(){var t=g,n=h;return[d(u[t(1166)][n(615)])===n(600)?"1":"0",u[n(614)][t(1540)]===n(614)?"1":"0",-1!==u[n(614)][n(566)]()[n(574)](t(556))?"1":"0"][n(482)](",")}';
if (sdkSrc.includes(envCheckOriginal)) {
    sdkSrc = sdkSrc.replace(envCheckOriginal, 'getJsEnvCheck:function(){return "0,0,0"}');
    console.error(JSON.stringify({ note: 'getJsEnvCheck patched' }));
}

// Object.keys 容错 (SDK 指纹枚举在 shim 下可能拿到 undefined)
const _origKeys = Object.keys;
Object.keys = function (o) {
    try { return _origKeys(o); } catch (e) { return []; }
};

// 干净的错误输出 (SDK 是单行混淆代码, 默认 trace 会被源码淹没)
process.on('uncaughtException', (e) => {
    const fs2 = require('fs');
    fs2.writeFileSync(path.join(__dirname, 'htj_error.txt'),
        `${e.name}: ${e.message}\n${(e.stack || '').split('\n').slice(1, 6).join('\n')}`);
    console.error(JSON.stringify({ ok: false, stage: 'uncaught', error: `${e.name}: ${e.message}` }));
    process.exit(1);
});

try {
    // dfxaf3 是自执行代码, 挂 window.xaf
    (0, eval)(sdkSrc);
} catch (e) {
    console.error(JSON.stringify({ ok: false, stage: 'load', error: `${e.name}: ${e.message}` }));
    process.exit(1);
}

const xaf = windowShim.xaf;

// ===== 探针: 转储 xaf API 表面 =====
console.log(JSON.stringify({ stage: 'xaf-props', ownNames: Object.getOwnPropertyNames(xaf), keys: Object.keys(xaf), proto: Object.getOwnPropertyNames(Object.getPrototypeOf(xaf) || {}) }));
for (const k of Object.getOwnPropertyNames(xaf)) {
  try { console.log(JSON.stringify({ key: k, type: typeof xaf[k] })); } catch (e) {}
}
try {
  xaf.init({ aid: AID, dataApp: DATA_APP });
  console.log(JSON.stringify({ stage: 'after-init', ownNames: Object.getOwnPropertyNames(xaf) }));
  // 调用指纹产出方法
  for (const m of ['getData','getot','hgzAs','reportApi']) {
    try {
      const v = xaf[m]();
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      console.log(JSON.stringify({ method: m, type: typeof v, len: (s ? s.length : 0), value: s ? s.slice(0, 400) : s }));
    } catch (e) { console.log(JSON.stringify({ method: m, err: String(e).slice(0,120) })); }
  }
  // getData 可能的参数形式
  try { const v = xaf.getData('dv'); console.log(JSON.stringify({ method: "getData('dv')", value: String(v).slice(0,300) })); } catch(e){}
  try { const v = xaf.getData('fuid'); console.log(JSON.stringify({ method: "getData('fuid')", value: String(v).slice(0,300) })); } catch(e){}
} catch (e) { console.log(JSON.stringify({ stage: 'init-err', err: String(e).slice(0,150) })); }
process.exit(0);
