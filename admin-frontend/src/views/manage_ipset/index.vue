<template>
  <n-space vertical size="large">
    <!-- 代理 IP 设置 -->
    <n-card title="代理 IP 设置" :bordered="false">
      <template #header-extra>
        <n-tag type="info" size="small">每次领取自动换 IP · 防风控</n-tag>
      </template>
      <n-space vertical size="large">
        <n-form-item label="代理提取链接" label-placement="top">
          <n-input v-model:value="form.proxy_extract_url" type="textarea" :rows="3"
                   placeholder="http://api.xingyuip.com:6002/api/extract?channel_id=...&channel_secret=...&num=1&auth_mode=password&format=txt" />
        </n-form-item>
        <n-form-item label="启用代理换 IP" label-placement="top">
          <n-switch v-model:value="form.proxy_enabled">
            <template #checked>开启</template>
            <template #unchecked>关闭</template>
          </n-switch>
        </n-form-item>
        <n-form-item label="代理 IP 有效期（分钟）" label-placement="top">
          <n-input-number v-model:value="form.proxy_ttl" :min="0" :max="60" class="w-40">
            <template #suffix>分钟</template>
          </n-input-number>
          <n-text depth="3" class="ml-2">仅用于判断保活间隔是否合理，不参与运行时逻辑</n-text>
        </n-form-item>
        <n-form-item label="代理保活间隔（秒）" label-placement="top">
          <n-input-number v-model:value="form.proxy_keepalive" :min="0" :max="600" class="w-40">
            <template #suffix>秒</template>
          </n-input-number>
          <n-text depth="3" class="ml-2">领取流程进行中每隔该秒数通过本单代理发一次心跳，防止端口空闲过期；0 = 关闭</n-text>
        </n-form-item>
        <n-alert v-if="keepaliveWarning" type="warning" :show-icon="true" class="mb-4">
          {{ keepaliveWarning }}
        </n-alert>
        <n-space>
          <n-button type="primary" :loading="saving" @click="save">保存设置</n-button>
          <n-button :loading="testingProxy" @click="testProxy">测试提取链接</n-button>
        </n-space>
        <n-alert v-if="proxyTestResult" :type="proxyTestResult.ok ? 'success' : 'error'" :show-icon="true">
          {{ proxyTestResult.msg }}
        </n-alert>
      </n-space>
    </n-card>

    <!-- 打码设置 -->
    <n-card title="打码平台设置（图鉴 / 云码）" :bordered="false">
      <n-space vertical size="large">
        <n-form-item label="打码 Token" label-placement="top">
          <n-input v-model:value="form.jfbym_token" type="password" show-password-on="click"
                   placeholder="图鉴打码平台 · 用户中心密钥" />
        </n-form-item>
        <n-space>
          <n-button type="primary" :loading="saving" @click="save">保存设置</n-button>
          <n-button :loading="testingCaptcha" @click="testCaptcha">测试 Token（查余额）</n-button>
        </n-space>
        <n-alert v-if="captchaTestResult" :type="captchaTestResult.ok ? 'success' : 'error'" :show-icon="true">
          {{ captchaTestResult.msg }}
        </n-alert>
        <n-text depth="3" style="font-size: 12px">
          图形验证码自动识别使用此 Token；保存后即时生效，无需重启服务。
        </n-text>
      </n-space>
    </n-card>
  </n-space>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { NCard, NFormItem, NInput, NButton, NSpace, NSwitch, NAlert, NTag, NInputNumber, NText, useMessage } from 'naive-ui';
import { fetchGetSettings, fetchSaveSettings, fetchTestProxy, fetchTestCaptcha } from '@/service/api/kami';

const message = useMessage();
const saving = ref(false);
const testingProxy = ref(false);
const testingCaptcha = ref(false);
const proxyTestResult = ref<{ ok: boolean; msg: string } | null>(null);
const captchaTestResult = ref<{ ok: boolean; msg: string } | null>(null);

const form = ref({
  proxy_extract_url: '',
  jfbym_token: '',
  proxy_enabled: true,
  proxy_keepalive: 0,
  proxy_ttl: 0,
});

/** 保活间隔是否合理：心跳必须赶在端口空闲过期之前 */
const keepaliveWarning = computed(() => {
  const { proxy_keepalive: ka, proxy_ttl: ttl } = form.value;
  if (!ka || !ttl) return '';
  if (ka >= ttl * 60) {
    return `保活间隔 ${ka} 秒 ≥ 代理有效期 ${ttl} 分钟，心跳可能赶在端口过期之后才发出，建议把保活间隔调到 ${Math.max(10, Math.floor(ttl * 60 / 2))} 秒以内`;
  }
  return '';
});

onMounted(async () => {
  const { data, error } = await fetchGetSettings();
  if (!error && data) {
    form.value = {
      proxy_extract_url: data.proxy_extract_url || '',
      jfbym_token: data.jfbym_token || '',
      proxy_enabled: data.proxy_enabled !== false,
      proxy_keepalive: Number(data.proxy_keepalive) || 0,
      proxy_ttl: Number(data.proxy_ttl) || 0,
    };
  }
});

async function save() {
  saving.value = true;
  try {
    const { error } = await fetchSaveSettings(form.value);
    if (error) return message.error('保存失败');
    if (keepaliveWarning.value) message.warning('已保存，但保活间隔与代理有效期不匹配，建议调整');
    else message.success('设置已保存，即时生效');
  } finally {
    saving.value = false;
  }
}

async function testProxy() {
  testingProxy.value = true;
  proxyTestResult.value = null;
  try {
    const { data, error } = await fetchTestProxy(form.value.proxy_extract_url);
    proxyTestResult.value = error ? { ok: false, msg: '请求失败' } : data;
  } finally {
    testingProxy.value = false;
  }
}

async function testCaptcha() {
  testingCaptcha.value = true;
  captchaTestResult.value = null;
  try {
    const { data, error } = await fetchTestCaptcha(form.value.jfbym_token);
    captchaTestResult.value = error ? { ok: false, msg: '请求失败' } : data;
  } finally {
    testingCaptcha.value = false;
  }
}
</script>
