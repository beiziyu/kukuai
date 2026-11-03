<template>
  <div class="claim-root">
    <!-- 装饰贴纸 -->
    <svg class="sticker sticker--star" width="52" height="52" viewBox="0 0 52 52" aria-hidden="true">
      <path d="M26 2 31.9 17.9 48.8 18.6 35.5 29.1 40.1 45.4 26 36 11.9 45.4 16.5 29.1 3.2 18.6 20.1 17.9Z"
            fill="#ffd93d" stroke="#161616" stroke-width="3" stroke-linejoin="round" />
    </svg>
    <svg class="sticker sticker--bolt" width="46" height="46" viewBox="0 0 46 46" aria-hidden="true">
      <circle cx="23" cy="23" r="20" fill="#4d96ff" stroke="#161616" stroke-width="3" />
      <path d="M26 9 14 27h8l-3 10 14-19h-9l4-9z" fill="#161616" />
    </svg>

    <main class="card">
      <header class="card-header">
        <h1 class="card-title">
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
            <path d="M15 2 4 15h7l-2 9 12-15h-8l2-7z" fill="#161616" />
          </svg>
          充值中心
        </h1>
        <span class="header-badge">RECHARGE</span>
      </header>

      <div class="card-body">
        <!-- ===== 表单视图 ===== -->
        <section v-show="view === 'form'" class="view" aria-label="充值表单">
          <!-- ===== 登录方式切换（手机号 / 扫码）===== -->
          <div class="login-tabs" role="tablist">
            <button type="button" class="login-tab" :class="{ 'login-tab--active': loginMode === 'sms' }"
                    role="tab" :aria-selected="loginMode === 'sms'" @click="switchToSms">手机号登录</button>
            <button type="button" class="login-tab" :class="{ 'login-tab--active': loginMode === 'qr' }"
                    role="tab" :aria-selected="loginMode === 'qr'" @click="switchToQr">扫码登录</button>
          </div>

          <!-- ===== 手机号登录 ===== -->
          <div v-show="loginMode === 'sms'">
          <div class="field">
            <label class="field-label" for="phone">手机号 <span class="req">*</span></label>
            <input
              id="phone"
              v-model="form.phone"
              class="input"
              :class="{ 'input--error': errors.phone }"
              type="tel"
              inputmode="numeric"
              maxlength="11"
              placeholder="请输入 11 位手机号"
              autocomplete="tel"
              enterkeyhint="next"
              :disabled="recharging"
              @input="onPhoneInput"
              @keydown.enter="focusEl('code')"
            />
            <p v-show="errors.phone" class="field-error">
              <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M7 1 13 12H1z" fill="#d33" />
                <rect x="6.2" y="5" width="1.6" height="4" fill="#fff" />
                <rect x="6.2" y="10.2" width="1.6" height="1.6" fill="#fff" />
              </svg>
              <span>{{ errors.phone }}</span>
            </p>
          </div>

          <div class="field">
            <label class="field-label" for="code">验证码 <span class="req">*</span></label>
            <div class="row">
              <input
                id="code"
                v-model="form.code"
                class="input"
                :class="{ 'input--error': errors.code }"
                type="text"
                inputmode="numeric"
                maxlength="6"
                placeholder="6 位数字验证码"
                autocomplete="one-time-code"
                enterkeyhint="next"
                :disabled="recharging"
                @input="onCodeInput"
                @keydown.enter="focusEl('kami')"
              />
              <button class="btn btn--code" type="button" :disabled="countdown > 0 || sendingCode || recharging" @click="handleSendCode">
                {{ sendingCode ? '发送中…' : countdown > 0 ? `${countdown}s 后重发` : '获取验证码' }}
              </button>
            </div>
            <p v-show="errors.code" class="field-error">
              <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M7 1 13 12H1z" fill="#d33" />
                <rect x="6.2" y="5" width="1.6" height="4" fill="#fff" />
                <rect x="6.2" y="10.2" width="1.6" height="1.6" fill="#fff" />
              </svg>
              <span>{{ errors.code }}</span>
            </p>
          </div>

          </div><!-- /手机号登录 -->

          <!-- ===== 扫码登录 =====
               扫码 tab 下【不显示】卡密输入框和立即充值按钮：
               卡密从 URL ?kami= 带进来，扫码成功后自动领取，不需要用户再点。 -->
          <div v-show="loginMode === 'qr'" class="qr-box">
            <!-- 未获取二维码：只显示一个「获取二维码」按钮 -->
            <div v-if="qrState === 'idle'" class="qr-empty">
              <p class="qr-empty__tip">点击下方按钮获取二维码</p>
              <button type="button" class="btn btn--primary" :disabled="qrLoading" @click="loadQr">
                <span v-if="qrLoading" class="btn-spinner" aria-hidden="true"></span>
                {{ qrLoading ? '获取中…' : '获取二维码' }}
              </button>
            </div>

            <!-- 已获取：二维码 + 刷新按钮 -->
            <template v-else>
              <div class="qr-frame">
                <img v-if="qrImg" :src="qrImg" class="qr-img" alt="扫码登录二维码" />
                <!-- 扫码成功 → 用遮罩盖住二维码，转加载动画，等后端算完 -->
                <div v-if="qrState === 'claiming'" class="qr-mask">
                  <span class="btn-spinner btn-spinner--lg" aria-hidden="true"></span>
                  <p class="qr-mask__title">登录成功</p>
                  <p class="qr-mask__msg">{{ claimMsg }}</p>
                </div>
              </div>
              <p class="qr-tip">
                <template v-if="qrState === 'claiming'">🔒 二维码已失效，请稍候…</template>
                <template v-else-if="qrStatus === 'scanned'">✅ <b>已扫描</b>，请在手机上确认登录</template>
                <template v-else-if="qrStatus === 'expired'">二维码已过期，<b>点下方刷新</b></template>
                <template v-else-if="qrStatus === 'canceled'">已取消，<b>点下方刷新</b></template>
              </p>
              <button v-if="qrState !== 'claiming'" type="button" class="btn btn--code" :disabled="qrLoading" @click="loadQr">
                {{ qrLoading ? '获取中…' : '刷新二维码' }}
              </button>
            </template>
          </div><!-- /扫码登录 -->

          <!-- ===== 以下仅手机号登录显示 ===== -->
          <template v-if="loginMode === 'sms'">
          <div class="field">
            <label class="field-label" for="kami">卡密 <span class="req">*</span></label>
            <input
              id="kami"
              v-model="form.kami"
              class="input"
              :class="{ 'input--error': errors.kami }"
              type="text"
              placeholder="请输入卡密"
              enterkeyhint="done"
              :disabled="recharging"
              @input="errors.kami = ''"
              @keydown.enter="handleClaim"
            />
            <p v-show="errors.kami" class="field-error">
              <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M7 1 13 12H1z" fill="#d33" />
                <rect x="6.2" y="5" width="1.6" height="4" fill="#fff" />
                <rect x="6.2" y="10.2" width="1.6" height="1.6" fill="#fff" />
              </svg>
              <span>{{ errors.kami }}</span>
            </p>
          </div>

          <button class="btn btn--primary" type="button" :disabled="recharging" @click="handleClaim">
            <span v-if="recharging" class="btn-spinner" aria-hidden="true"></span>
            {{ recharging ? '充值中' : '立即充值' }}
          </button>

          <div v-show="recharging" class="progress">
            <div class="progress-bar"></div>
          </div>
          </template><!-- /仅手机号登录 -->

          <p class="secure-note">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="2" y="6" width="10" height="7" fill="#161616" />
              <path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" fill="none" stroke="#161616" stroke-width="1.6" />
            </svg>
            官方通道 · 信息加密传输
          </p>
        </section>

        <!-- ===== 选择登录账号（一个手机号绑了多个号）===== -->
      <section v-show="view === 'accounts'" class="view" aria-label="选择账号">
        <p class="pick-title">该手机号绑定了多个账号</p>
        <p class="pick-sub">请选择要登录的账号</p>
        <div class="pick-list">
          <button
            v-for="a in accounts"
            :key="a.sec_uid"
            class="btn btn--pick"
            type="button"
            :disabled="picking"
            @click="pickAccount(a)"
          >
            <span class="pick-name">{{ a.name || '未命名账号' }}</span>
            <span class="pick-time">最近登录 {{ fmtLogin(a.last_login_time) }}</span>
          </button>
        </div>
      </section>

      <!-- ===== 充值成功 ===== -->
        <section v-show="view === 'success'" class="view result" aria-label="充值结果">
          <div class="result-icon result-icon--ok">
            <svg width="46" height="46" viewBox="0 0 46 46" fill="none" stroke="#161616"
                 stroke-width="5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M10 24 19 33 36 13" />
            </svg>
          </div>
          <h2 class="result-title">充值成功</h2>
          <p class="result-desc">充值已到账，感谢您的使用</p>
          <div class="result-metas">
            <div class="result-meta">充值手机号 <b>{{ maskedPhone }}</b></div>
            <div v-if="memberExpire" class="result-meta">会员到期 <b>{{ memberExpire }}</b></div>
          </div>
        </section>

        <!-- ===== 充值失败 ===== -->
        <section v-show="view === 'failure'" class="view result" aria-label="充值结果">
          <div class="result-icon result-icon--fail">
            <svg width="40" height="40" viewBox="0 0 40 40" stroke="#161616"
                 stroke-width="5" stroke-linecap="round" aria-hidden="true">
              <path d="M9 9 31 31M31 9 9 31" />
            </svg>
          </div>
          <h2 class="result-title">充值失败</h2>
          <p class="result-desc">{{ failReason || '充值失败请联系客服' }}</p>
          <button class="btn btn--primary btn--retry" type="button" @click="retryClaim">
            重新充值
          </button>
        </section>
      </div>
    </main>

    <div class="toast" :class="{ 'toast--show': toastMsg }" role="status" aria-live="polite">{{ toastMsg }}</div>
    <p class="sr-only" role="status" aria-live="polite">{{ liveMsg }}</p>

    <!-- ===== 获取验证码等待遮罩 =====
         「获取验证码」后台要先做设备归因（含固定 5s 等待），给个动画过渡，
         避免用户以为卡死而狂点按钮。 -->
    <div v-if="sendingCode" class="code-mask" role="status" aria-live="polite">
      <div class="code-mask__box">
        <div class="code-spinner" aria-hidden="true">
          <i></i><i></i><i></i>
        </div>
        <p class="code-mask__title">正在进行获取验证码</p>
        <p class="code-mask__sub">请稍等 · 已等待 {{ codeElapsed }} 秒</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { sendCode, claimCard, checkClaimStatus, selectClaimAccount, createQrCode, checkQrStatus, claimByQr } from '@/api';

const route = useRoute();

const PHONE_RE = /^1[3-9]\d{9}$/;
const CODE_RE = /^\d{6}$/;

const view = ref('form'); // form | success | failure
const form = reactive({ phone: '', code: '', kami: '' });
const errors = reactive({ phone: '', code: '', kami: '' });

const sendingCode = ref(false);

/* ---------- 扫码登录 ---------- */
const loginMode = ref<'sms' | 'qr'>('sms');   // 当前登录方式
const qrImg = ref('');          // base64 PNG，直接 <img :src>
const qrToken = ref('');
const qrStatus = ref('');       // new / scanned / confirmed / canceled / expired
const qrLoading = ref(false);
// 扫码区状态：idle=未获取二维码 / shown=已显示 / claiming=登录成功正在充值
const qrState = ref<'idle' | 'shown' | 'claiming'>('idle');
// 扫码领取过程中的实时进度文案（显示在二维码遮罩上，避免用户以为卡死）
const claimMsg = ref('正在充值…');
let qrTimer: any = null;

function stopQrPolling() {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
}

/** 切到扫码：停手机号倒计时；二维码默认空，等用户自己点「获取二维码」 */
async function switchToQr() {
  loginMode.value = 'qr';
  clearInterval(countdownTimer); countdownTimer = null; countdown.value = 0;
  stopQrPolling();
  qrState.value = 'idle';
  qrImg.value = '';
  qrToken.value = '';
  qrStatus.value = '';
}

function switchToSms() {
  loginMode.value = 'sms';
  stopQrPolling();
}

/** 申请二维码（后端会先做设备归因，首次约 15 秒） */
async function loadQr() {
  if (!form.kami.trim()) {
    showToast('请先填写卡密');
    return;
  }
  qrLoading.value = true;
  try {
    const r: any = await createQrCode(form.kami.trim());
    if (r && r.ok) {
      qrImg.value = r.qrcode;
      qrToken.value = r.token;
      qrStatus.value = 'new';
      qrState.value = 'shown';
      // 每 2 秒轮询一次扫码状态
      stopQrPolling();
      qrTimer = setInterval(pollQr, 2000);
    } else {
      showToast((r && r.msg) || '二维码获取失败');
    }
  } catch {
    showToast('二维码获取失败，请重试');
  } finally {
    qrLoading.value = false;
  }
}

async function pollQr() {
  if (!qrToken.value) return;
  try {
    const s: any = await checkQrStatus(qrToken.value, form.kami.trim());
    if (!s || !s.ok) return;
    qrStatus.value = s.status;
    if (s.status === 'confirmed') {
      stopQrPolling();
      qrState.value = 'claiming';      // 二维码盖遮罩转加载动画
      claimMsg.value = '正在充值…';
      showToast('登录成功，正在充值');
      // 已登录 → 直接触发领取（不需要手机号/验证码）
      const r: any = await claimByQr(form.kami.trim());
      if (r && r.success) {
        startPolling(form.kami.trim());
      } else {
        showToast((r && r.msg) || '领取启动失败');
      }
    } else if (s.status === 'canceled' || s.status === 'expired') {
      stopQrPolling();
    }
  } catch { /* 轮询失败不打扰用户，下一轮再试 */ }
}
// 等待遮罩上「已等待 N 秒」的计数器
const codeElapsed = ref(0);
const recharging = ref(false);
const countdown = ref(0);
const toastMsg = ref('');
const liveMsg = ref('');
// 失败页上要显示的具体原因（如「卡密不存在」「卡密已被使用」），空则用默认文案
const failReason = ref('');
// 会员到期时间（成功页显示，如 "2026-11-19 20:15"）
const memberExpire = ref('');
// 一号多账号：等服务端返回账号列表，让用户选登哪个
const accounts = ref<any[]>([]);
const picking = ref(false);

let countdownTimer = null;
let toastTimer = null;
let pollTimer = null;

const maskedPhone = computed(() => {
  const p = form.phone;
  return p && p.length === 11 ? p.slice(0, 3) + '****' + p.slice(7) : p;
});

/* ---------- 工具 ---------- */
function showToast(msg) {
  toastMsg.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastMsg.value = ''; }, 2600);
}

function focusEl(id) {
  const el = document.getElementById(id);
  if (el) el.focus();
}

function onPhoneInput() {
  form.phone = form.phone.replace(/\D/g, '').slice(0, 11);
  errors.phone = '';
}

function onCodeInput() {
  form.code = form.code.replace(/\D/g, '').slice(0, 6);
  errors.code = '';
}

function validate() {
  let ok = true;
  errors.phone = '';
  errors.code = '';
  errors.kami = '';

  if (!PHONE_RE.test(form.phone.trim())) {
    errors.phone = '请输入正确的 11 位手机号';
    ok = false;
  }
  if (!CODE_RE.test(form.code.trim())) {
    errors.code = '请输入 6 位数字验证码';
    ok = false;
  }
  if (!form.kami.trim()) {
    errors.kami = '请输入卡密';
    ok = false;
  }
  return ok;
}

/* ---------- 获取验证码 ---------- */
// 等待遮罩上显示的「已等待秒数」—— 有具体数字在涨，用户才不会觉得卡死
let codeTimer = null;
function startCodeTimer() {
  codeElapsed.value = 0;
  clearInterval(codeTimer);
  codeTimer = setInterval(() => { codeElapsed.value += 1; }, 1000);
}
function stopCodeTimer() {
  clearInterval(codeTimer);
  codeTimer = null;
}

async function handleSendCode() {
  if (!PHONE_RE.test(form.phone.trim())) {
    errors.phone = '请输入正确的 11 位手机号';
    return;
  }
  sendingCode.value = true;
  startCodeTimer();
  try {
    const r = await sendCode({ phone: form.phone.trim() });
    if (r && r.ok) {
      startCountdown(60);
      showToast('验证码已发送，请注意查收');
      liveMsg.value = '验证码已发送';
    } else {
      showToast((r && r.msg) || '发送失败');
    }
  } catch (e) {
    showToast('发送失败，请稍后重试');
  } finally {
    sendingCode.value = false;
    stopCodeTimer();
  }
}

function startCountdown(sec) {
  countdown.value = sec;
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }, 1000);
}

/* ---------- 立即充值 ---------- */
async function handleClaim() {
  if (recharging.value) return;
  if (!validate()) return;

  recharging.value = true;
  failReason.value = '';
  liveMsg.value = '充值中，请稍候';

  const phone = form.phone.trim();
  const code = form.code.trim();
  const kami = form.kami.trim();

  try {
    const r = await claimCard({ phone, code, card_key: kami });
    if (!r || !r.success) {
      stopPolling();
      recharging.value = false;
      // 业务原因直接展示（卡密不存在 / 卡密已被使用），没有就显示默认文案
      failReason.value = (r && r.msg) || '';
      liveMsg.value = '充值失败，请联系客服';
      view.value = 'failure';
      return;
    }

    startPolling(r.kami);
  } catch (e) {
    stopPolling();
    recharging.value = false;
    liveMsg.value = '充值失败，请联系客服';
    view.value = 'failure';
  }
}

/* ---------- 轮询领取结果 ---------- */
// 轮询兜底：超过这个秒数还没出结果就停，避免永远转圈（后端异常时）
const POLL_TIMEOUT_SEC = 120;
let pollStartedAt = 0;

function startPolling(kami: string) {
  stopPolling();
  pollStartedAt = Date.now();
  pollTimer = setInterval(async () => {
    try {
      // 超时兜底：后端卡住（任务线程崩了等）时，至少给用户一个失败而不是永久转圈
      if (Date.now() - pollStartedAt > POLL_TIMEOUT_SEC * 1000) {
        stopPolling();
        recharging.value = false;
        qrState.value = 'idle';
        liveMsg.value = '充值失败，请联系客服';
        view.value = 'failure';
        return;
      }
      const s = await checkClaimStatus(kami);
      // 把服务端进度同步到遮罩文案（扫码登录用；手机号流程不影响）
      if (s && s.result_msg) claimMsg.value = s.result_msg;
      if (s && (s.status === 'success' || s.status === 'failed')) {
        stopPolling();
        recharging.value = false;
        // 协议层的结果属于"技术细节"，失败页保持统一文案
        failReason.value = '';
        if (s.status === 'success') {
          liveMsg.value = '充值成功';
          memberExpire.value = s.member_expire_at || '';
          view.value = 'success';
        } else {
          // 失败：停轮询 + 复位扫码状态（下次重试要能重新取二维码）
          qrState.value = 'idle';
          liveMsg.value = '充值失败，请联系客服';
          view.value = 'failure';
        }
      } else if (s && s.status === 'need_account') {
        // 一号多账号：服务端问「登哪个号」→ 停下让用户选
        stopPolling();
        recharging.value = false;
        accounts.value = Array.isArray(s.accounts) ? s.accounts : [];
        liveMsg.value = '请选择要登录的账号';
        view.value = 'accounts';
      }
    } catch (e) {
      // 网络抖动，继续轮询
    }
  }, 3000);
}

function fmtLogin(ts: any) {
  const n = Number(ts);
  if (!n) return '从未登录';
  const d = new Date(n * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* 用户在多个账号里选了一个 → 用它登录并继续领取 */
async function pickAccount(a: any) {
  if (picking.value) return;
  picking.value = true;
  try {
    const r = await selectClaimAccount(form.kami, a.sec_uid);
    // 后端返回的字段名可能有 ok / success 两种（历史遗留），两种都认
    if (r && (r.ok || r.success)) {
      // 已开始用选定账号登录 → 回到「充值中」并继续轮询
      view.value = 'form';
      recharging.value = true;
      liveMsg.value = '充值中，请稍候';
      startPolling(form.kami);
    } else {
      showToast((r && r.msg) || '选择失败，请重试');
    }
  } catch (e) {
    showToast('选择失败，请稍后重试');
  } finally {
    picking.value = false;
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/* 失败页「重新充值」：回到表单，保留手机号/卡密，清掉验证码和二维码状态。
   服务端在任务结束（含失败）时已经释放会话，重试时会自动换一台新设备，
   前端只需要把状态复位，不需要等旧缓存。 */
function retryClaim() {
  stopPolling();
  recharging.value = false;
  failReason.value = '';
  memberExpire.value = '';
  errors.code = '';
  form.code = '';
  qrState.value = 'idle';
  qrImg.value = '';
  qrToken.value = '';
  qrStatus.value = '';
  claimMsg.value = '正在充值…';
  view.value = 'form';
  liveMsg.value = '请重新获取验证码后再充值';
}

/* URL 带 ?kami=xxx 时自动填入（后台导出的拼接链接点开就能用）
   ⚠️ 已充值过的卡密：直接显示结果页，不再回到表单让人重复填 */
onMounted(async () => {
  document.body.classList.add('claim-body');
  const k = route.query.kami;
  if (!k) return;
  const kamiKey = String(k);
  form.kami = kamiKey;

  try {
    const s = await checkClaimStatus(kamiKey);
    if (!s) return;

    // 卡密根本不存在 → 直接显示「卡密不存在」
    if (s.exist === false) {
      failReason.value = '卡密不存在';
      view.value = 'failure';
      return;
    }

    if (s.status === 'success') {
      // 补回手机号，成功页要显示「充值手机号 133****0730」
      if (s.phone) form.phone = String(s.phone);
      memberExpire.value = s.member_expire_at || '';
      view.value = 'success';
      return;
    }

    if (s.status === 'failed') {
      if (s.phone) form.phone = String(s.phone);
      // 新规则：失败不核销卡密 → 刷新后直接回表单让用户重试（重试自动换新设备）；
      // 老数据卡密已核销的没有重试意义，仍显示失败页。
      if (s.card_status === 1) {
        view.value = 'failure';
      } else {
        view.value = 'form';
        showToast('上次未成功，可重新获取验证码再试');
      }
      return;
    }

    if (s.status === 'need_account') {
      // 刷新页面时正等着选号 → 继续显示选号列表
      accounts.value = Array.isArray(s.accounts) ? s.accounts : [];
      view.value = 'accounts';
      return;
    }

    if (s.status === 'running') {
      // 充值途中刷新了页面 → 继续轮询，别退回表单造成重复提交
      recharging.value = true;
      liveMsg.value = '充值中，请稍候';
      startPolling(kamiKey);
      return;
    }

    if (s.card_status === 1) {
      // 卡密已被核销但查不到订单记录 → 直接判失败
      view.value = 'failure';
    }
  } catch (e) {
    // 查不到状态就正常显示表单
  }
});

onUnmounted(() => {
  document.body.classList.remove('claim-body');
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  stopQrPolling();
  if (codeTimer) { clearInterval(codeTimer); codeTimer = null; }
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  stopPolling();
});
</script>

<style>
/* 客户端页面独占：去掉 body 默认外边距，背景才能铺满 */
body.claim-body {
  margin: 0;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
</style>

<style scoped>
/* ============ Neo-Brutalism 设计变量 ============ */
/* 缺了 box-sizing 重置会导致 width:100% 的输入框按 content-box 计算，
   加上 padding/border 后溢出卡片边界 —— 参考稿里的 * 规则不能省 */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

.claim-root {
  --black: #161616;
  --paper: #fffdf6;
  --yellow: #ffd93d;
  --coral: #ff6b6b;
  --blue: #4d96ff;
  --green: #5fd068;
  --bd: 3px solid var(--black);
  --shadow: 8px 8px 0 var(--black);
  --shadow-sm: 4px 4px 0 var(--black);
  --shadow-press: 1px 1px 0 var(--black);

  position: relative;
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  /* 不用 align-items:center：卡片高于视口时顶部会被裁掉且滚不回去。
     用 flex-start + 卡片 auto 外边距，空间够就居中、不够就正常滚动 */
  align-items: flex-start;
  justify-content: center;
  padding: 40px 20px calc(40px + env(safe-area-inset-bottom, 0px));
  font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
  color: var(--black);
  background-color: var(--yellow);
  background-image: radial-gradient(rgba(22, 22, 22, 0.14) 1.6px, transparent 1.6px);
  background-size: 26px 26px;
}

.sr-only {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* ============ 装饰贴纸 ============ */
.sticker {
  position: fixed;
  z-index: 0;
  filter: drop-shadow(4px 4px 0 rgba(22, 22, 22, 0.9));
}
.sticker--star { top: 8%; left: 9%; transform: rotate(-14deg); animation: floaty 4s ease-in-out infinite; }
.sticker--bolt { bottom: 11%; right: 8%; transform: rotate(10deg); animation: floaty 5s ease-in-out infinite reverse; }
@keyframes floaty { 0%, 100% { translate: 0 0; } 50% { translate: 0 -10px; } }

/* ============ 卡片 ============ */
.card {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 430px;
  /* 垂直居中（空间不足时自动变为自然滚动，配合父级 flex-start 防裁切） */
  margin: auto 0;
  background: var(--paper);
  border: var(--bd);
  box-shadow: var(--shadow);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  background: var(--yellow);
  border-bottom: var(--bd);
}

.card-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 3px;
}
.card-title svg { display: block; flex: none; }

.header-badge {
  flex: none;
  background: var(--black);
  color: var(--yellow);
  font-family: "Arial Black", "PingFang SC", sans-serif;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 3px;
  padding: 5px 9px;
  transform: rotate(4deg);
}

.card-body { padding: 24px 22px 20px; }

.view { animation: pop-in 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2); }
@keyframes pop-in {
  from { opacity: 0; transform: scale(0.96) translateY(10px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}

/* ============ 表单 ============ */
.field { margin-bottom: 18px; }

.field-label {
  display: block;
  font-size: 14px;
  font-weight: 900;
  letter-spacing: 1px;
  margin-bottom: 8px;
}
.field-label .req { color: #d33; }

.input {
  width: 100%;
  font-family: inherit;
  font-size: 16px; /* ≥16px，避免 iOS 聚焦自动放大 */
  font-weight: 700;
  color: var(--black);
  background: #fff;
  border: var(--bd);
  border-radius: 6px;
  padding: 13px 14px;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  transition: box-shadow 0.12s ease, transform 0.12s ease;
}
.input::placeholder { color: #9a958c; font-weight: 500; }
.input:focus { box-shadow: var(--shadow-sm); transform: translate(-1px, -1px); }
.input:disabled { background: #f1eee6; color: #8f8a80; cursor: not-allowed; }
.input--error { border-color: #d33; box-shadow: 3px 3px 0 #d33; }

.field-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
  font-size: 12.5px;
  font-weight: 700;
  color: #d33;
}
.field-error svg { flex: none; }

.row { display: flex; gap: 10px; align-items: stretch; }
.row .input { flex: 1; min-width: 0; }

/* ============ 按钮 ============ */
.btn {
  font-family: inherit;
  font-weight: 900;
  letter-spacing: 2px;
  border: var(--bd);
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  -webkit-appearance: none;
  appearance: none;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  transition: transform 0.08s ease, box-shadow 0.08s ease, background 0.12s ease;
}
.btn:focus-visible { outline: 3px solid var(--blue); outline-offset: 3px; }

.btn--code {
  flex: none;
  font-size: 14px;
  padding: 0 14px;
  background: var(--blue);
  color: #fff;
  box-shadow: var(--shadow-sm);
  white-space: nowrap;
}
.btn--code:hover:not(:disabled) { transform: translate(-2px, -2px); box-shadow: 6px 6px 0 var(--black); }
.btn--code:active:not(:disabled) { transform: translate(2px, 2px); box-shadow: var(--shadow-press); }
.btn--code:disabled {
  background: #cfc9bb;
  color: #6e6a61;
  cursor: not-allowed;
  box-shadow: 2px 2px 0 rgba(22, 22, 22, 0.35);
  transform: none;
}

.btn--primary {
  width: 100%;
  margin-top: 4px;
  font-size: 18px;
  padding: 15px;
  background: var(--coral);
  color: #fff;
  box-shadow: var(--shadow);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.btn--primary:hover:not(:disabled) { transform: translate(-2px, -2px); box-shadow: 10px 10px 0 var(--black); }
.btn--primary:active:not(:disabled) { transform: translate(3px, 3px); box-shadow: 2px 2px 0 var(--black); }
.btn--primary:disabled { background: #e8a0a0; cursor: wait; transform: none; box-shadow: var(--shadow-sm); }

.btn-spinner {
  width: 16px;
  height: 16px;
  flex: none;
  border: 3px solid #fff;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* 充值中进度条 */
.progress {
  margin-top: 14px;
  height: 16px;
  background: #fff;
  border: var(--bd);
  border-radius: 4px;
  overflow: hidden;
}
.progress-bar {
  height: 100%;
  width: 38%;
  background: repeating-linear-gradient(45deg, var(--black) 0 8px, var(--yellow) 8px 16px);
  animation: slide 1.1s linear infinite;
}
@keyframes slide { from { transform: translateX(-110%); } to { transform: translateX(300%); } }


.secure-note {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 2px dashed rgba(22, 22, 22, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 700;
  color: #6e6a61;
}
.secure-note svg { flex: none; }

/* ============ 选号登录 ============ */
.pick-title {
  text-align: center;
  font-size: 17px;
  font-weight: 900;
  letter-spacing: 1px;
}
.pick-sub {
  margin-top: 4px;
  text-align: center;
  font-size: 13px;
  font-weight: 700;
  color: #6e6a61;
}
.pick-list {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.btn--pick {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 13px 14px;
  background: #fff;
  color: var(--black);
  box-shadow: var(--shadow-sm);
  text-align: left;
}
.btn--pick:hover:not(:disabled) { transform: translate(-2px, -2px); box-shadow: 6px 6px 0 var(--black); }
.btn--pick:active:not(:disabled) { transform: translate(2px, 2px); box-shadow: var(--shadow-press); }
.btn--pick:disabled { background: #f1eee6; color: #8f8a80; cursor: wait; }
.pick-name { font-size: 15px; font-weight: 900; letter-spacing: 1px; }
.pick-time { flex: none; font-size: 11.5px; font-weight: 700; color: #6e6a61; }

/* ============ 登录方式切换 ============ */
.login-tabs {
  display: flex;
  gap: 0;
  margin-bottom: 18px;
  border: 3px solid var(--black);
  box-shadow: 4px 4px 0 var(--black);
}
.login-tab {
  flex: 1;
  padding: 10px 0;
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 1px;
  background: #fff;
  border: none;
  cursor: pointer;
}
.login-tab + .login-tab { border-left: 3px solid var(--black); }
.login-tab--active { background: var(--black); color: #fff; }

/* ============ 扫码登录 ============ */
.qr-box { text-align: center; margin-bottom: 18px; }
.qr-frame {
  width: 190px;
  height: 190px;
  margin: 0 auto 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fff;
  border: 3px solid var(--black);
  box-shadow: 6px 6px 0 var(--black);
}
.qr-img { width: 168px; height: 168px; display: block; }
.qr-loading { color: #6e6a61; font-size: 12px; font-weight: 700; }
.qr-loading .btn-spinner { margin-bottom: 8px; }
.qr-tip { margin-bottom: 12px; font-size: 12.5px; font-weight: 700; line-height: 1.6; color: #4a463f; }

/* 未获取二维码的空状态 */
.qr-empty { padding: 12px 0 4px; }
.qr-empty__tip { margin-bottom: 16px; font-size: 13px; font-weight: 700; line-height: 1.8; color: #4a463f; }

/* 扫码成功：遮罩盖住二维码 + 加载动画 */
.qr-frame { position: relative; }
.qr-mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 14px;
  background: rgba(255, 255, 255, 0.97);
  text-align: center;
  color: #4a463f;
}
.qr-mask__title { font-size: 13.5px; font-weight: 900; }
.qr-mask__msg { font-size: 12px; font-weight: 700; color: #6e6a61; line-height: 1.5; }
.btn-spinner--lg { width: 30px; height: 30px; border-width: 4px; }

/* ============ 获取验证码等待遮罩 ============ */
.code-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(17, 17, 17, 0.35);
}
.code-mask__box {
  width: 100%;
  max-width: 290px;
  padding: 22px 18px 20px;
  background: #fff;
  border: 3px solid var(--black);
  box-shadow: 8px 8px 0 var(--black);
  text-align: center;
}
.code-spinner {
  display: flex;
  justify-content: center;
  gap: 9px;
  margin-bottom: 15px;
}
.code-spinner i {
  width: 11px;
  height: 11px;
  background: var(--black);
  animation: codeBounce 0.9s infinite ease-in-out;
}
.code-spinner i:nth-child(2) { animation-delay: 0.15s; }
.code-spinner i:nth-child(3) { animation-delay: 0.3s; }
@keyframes codeBounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.3; }
  40% { transform: translateY(-9px); opacity: 1; }
}
.code-mask__title { font-size: 15px; font-weight: 900; letter-spacing: 1px; }
.code-mask__sub { margin-top: 7px; font-size: 12.5px; font-weight: 700; color: #6e6a61; }

/* ============ 结果视图 ============ */
.result { text-align: center; padding: 14px 4px 6px; }
.result-icon {
  width: 92px;
  height: 92px;
  margin: 0 auto 18px;
  border: var(--bd);
  border-radius: 10px;
  display: grid;
  place-items: center;
  box-shadow: var(--shadow-sm);
  animation: icon-pop 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.4) both;
}
.result-icon--ok { background: var(--green); }
.result-icon--fail { background: var(--coral); }
@keyframes icon-pop {
  0% { transform: scale(0.3) rotate(-14deg); }
  100% { transform: scale(1) rotate(0); }
}
.result-title { font-size: 24px; font-weight: 900; letter-spacing: 3px; }
.result-desc { margin-top: 8px; font-size: 14px; font-weight: 600; color: #57534a; }
/* 成功页信息胶囊：手机号 + 会员到期，竖排 */
.result-metas { margin-top: 14px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.result-metas .result-meta { margin-top: 0; }
/* 失败页的重试按钮：成功页保持固定、无任何操作按钮 */
.btn--retry { margin-top: 22px; }
.result-meta {
  margin-top: 14px;
  display: inline-block;
  border: 2px solid var(--black);
  border-radius: 999px;
  padding: 6px 16px;
  font-size: 13px;
  font-weight: 800;
  background: #fff;
  box-shadow: 3px 3px 0 var(--black);
}

/* ============ Toast ============ */
.toast {
  position: fixed;
  top: 26px;
  left: 50%;
  transform: translateX(-50%) translateY(-16px);
  background: var(--black);
  color: #fff;
  font-size: 14px;
  font-weight: 800;
  padding: 12px 18px;
  border: var(--bd);
  border-radius: 6px;
  box-shadow: var(--shadow-sm);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease, transform 0.2s ease;
  z-index: 50;
  max-width: calc(100vw - 40px);
}
.toast--show { opacity: 1; transform: translateX(-50%) translateY(0); }

/* ============ 响应式 ============ */
@media (max-width: 560px) {
  .sticker { display: none; }
  .claim-root {
    padding: 28px 14px calc(28px + env(safe-area-inset-bottom, 0px));
  }
  .card-header { padding: 14px 16px; }
  .card-title { font-size: 20px; letter-spacing: 2px; }
  .card-body { padding: 20px 16px 16px; }
  .btn--primary { font-size: 17px; padding: 14px; }
}
@media (max-width: 360px) {
  .row { flex-direction: column; }
  .btn--code { padding: 12px; }
  .result-icon { width: 76px; height: 76px; }
  .result-title { font-size: 21px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
</style>
