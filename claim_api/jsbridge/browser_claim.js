/**
 * 浏览器领奖器 (Playwright)
 *
 * 用途: 纯协议路径遇到 errno=8043 (passSpinCode = 百度要求旋转验证码) 时,
 *       改用真实浏览器打开活动页, 点「登录领奖」按钮, 由前端 badjs 弹验证码
 *       并完成领奖。
 *
 * 原理: 活动页「登录领奖」按钮调的就是 /act/v2/kukuai30/claimreward,
 *       与我们协议层同一接口, 区别只在于:
 *         - 前端有完整 antiParams (jt/jsToken/rands/specialParams)
 *         - 8043 时前端 badjs-sdk 会弹旋转验证码, 人工/自动过掉后重发
 *
 * 用法: node browser_claim.js <ckString> [day]
 *   ckString: 形如 "BDUSS=xxx; STOKEN=yyy; ..." (本单完整 Cookie)
 * 输出: JSON { ok, errno, msg, ... }
 */
'use strict';

const { chromium } = require('playwright');

const PAGE = 'https://kuku.baidu.com/operation/activitys/kukuPcSignAct/main?utm_source=home2';
const CK = process.argv[2] || '';
const DAY = parseInt(process.argv[3] || '3', 10);
const PROXY = process.env.HTJ_PROXY || '';
const WAIT_MS = parseInt(process.env.BC_WAIT_MS || '90000', 10);

function out(obj) {
    console.log(JSON.stringify(obj));
    process.exit(obj.ok ? 0 : 1);
}

(async () => {
    let browser;
    try {
        const launchArgs = {
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--window-size=1440,900',
            ],
        };
        if (PROXY) {
            const u = new URL(PROXY);
            launchArgs.proxy = {
                server: `http://${u.hostname}:${u.port}`,
                username: decodeURIComponent(u.username),
                password: decodeURIComponent(u.password),
            };
        }
        browser = await chromium.launch(launchArgs);

        const ctx = await browser.newContext({
            userAgent: ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'),
            locale: 'zh-CN',
            viewport: { width: 1440, height: 900 },
            extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
        });

        // ★ 注入本单账号 Cookie
        const cookies = CK.split(';').map(s => s.trim()).filter(s => s.includes('='))
            .map(s => {
                const i = s.indexOf('=');
                return {
                    name: s.slice(0, i).trim(),
                    value: s.slice(i + 1).trim(),
                    domain: '.baidu.com',
                    path: '/',
                };
            });
        await ctx.addCookies(cookies);

        const page = await ctx.newPage();

        // 捕获 claimreward 的响应 —— 这是唯一权威结果
        let claimResp = null;
        page.on('response', async (r) => {
            if (r.url().includes('/act/v2/kukuai30/claimreward')) {
                try { claimResp = await r.json(); } catch (e) { /* ignore */ }
            }
        });

        await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(4000);

        // 找到 day=DAY 的「登录领奖」按钮并点击
        const clicked = await page.evaluate((day) => {
            const txt = (el) => (el.innerText || el.textContent || '').trim();
            const btns = Array.from(document.querySelectorAll('button, a, div[class*=btn], span[class*=btn]'));
            // 先找文本含「领奖」「领取」的
            let cand = btns.filter(b => {
                const t = txt(b);
                return (t.includes('登录领奖') || t.includes('立即领奖') || t.includes('领奖')
                    || t.includes('领取')) && !t.includes('已领取');
            });
            if (!cand.length) return false;
            // 优先匹配里程碑行里的 (按 day 顺序的第 N 个)
            const target = cand[Math.min(day - 1, cand.length - 1)] || cand[0];
            target.scrollIntoView({ block: 'center' });
            target.click();
            return true;
        }, DAY);

        if (!clicked) {
            await out({ ok: false, stage: 'no-button', msg: '页面找不到领奖按钮' });
        }

        // 等待: 领奖响应 或 验证码出现
        const t0 = Date.now();
        while (Date.now() - t0 < WAIT_MS) {
            if (claimResp && claimResp.errno === 0) {
                await out({ ok: true, errno: 0, data: claimResp.data || '', msg: '领取成功' });
            }
            // 检测旋转验证码 (badjs 的容器)
            const cap = await page.evaluate(() => {
                const sel = ['.passMod_dialog-wrapper', '#passMod_dialog', '[class*=passMod]',
                    '.verify-wrap', '#yidun_slide', '[class*=captcha]'];
                for (const s of sel) {
                    const el = document.querySelector(s);
                    if (el && el.offsetParent !== null) return s;
                }
                return null;
            }).catch(() => null);
            if (cap) {
                // 旋转验证码需要人工转 —— 截图供人工/后续 OCR 处理
                await page.screenshot({ path: '/tmp/bc_captcha.png' }).catch(() => {});
                await out({
                    ok: false, stage: 'captcha', captcha: cap,
                    msg: '出现旋转验证码, 已截图 /tmp/bc_captcha.png',
                    lastResp: claimResp || null,
                });
            }
            await page.waitForTimeout(1500);
        }
        await out({
            ok: false, stage: 'timeout',
            msg: `等待 ${WAIT_MS}ms 未拿到领奖结果`,
            lastResp: claimResp || null,
        });
    } catch (e) {
        out({ ok: false, stage: 'error', msg: `${e.name}: ${e.message}` });
    } finally {
        try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
    }
})();
