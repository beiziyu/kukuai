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
import { ref, onMounted } from 'vue';
import { NCard, NFormItem, NInput, NButton, NSpace, NSwitch,
         NAlert, NTag, useMessage } from 'naive-ui';
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
});

onMounted(async () => {
  const { data, error } = await fetchGetSettings();
  if (!error && data) {
    form.value = {
      proxy_extract_url: data.proxy_extract_url || '',
      jfbym_token: data.jfbym_token || '',
      proxy_enabled: data.proxy_enabled !== false,
    };
  }
});

async function save() {
  saving.value = true;
  try {
    const { error } = await fetchSaveSettings(form.value);
    if (error) return message.error('保存失败');
    message.success('设置已保存，即时生效');
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
