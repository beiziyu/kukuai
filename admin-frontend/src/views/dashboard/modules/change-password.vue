<script setup lang="ts">
import { ref } from 'vue';
import { useMessage } from 'naive-ui';
import { fetchChangePassword } from '@/service/api';
import { useAuthStore } from '@/store/modules/auth';

defineOptions({ name: 'ChangePassword' });

const authStore = useAuthStore();
const message = useMessage();

const oldPwd = ref('');
const newPwd = ref('');
const confirmPwd = ref('');
const loading = ref(false);

async function submit() {
  if (!oldPwd.value || !newPwd.value) {
    message.error('请填写原密码和新密码');
    return;
  }
  if (newPwd.value.length < 6 || newPwd.value.length > 18) {
    message.error('新密码需 6-18 位');
    return;
  }
  if (newPwd.value !== confirmPwd.value) {
    message.error('两次输入的新密码不一致');
    return;
  }
  loading.value = true;
  const { error } = await fetchChangePassword(authStore.userInfo.role, oldPwd.value, newPwd.value);
  loading.value = false;
  if (error) return;
  message.success('密码已修改，下次登录请用新密码');
  oldPwd.value = '';
  newPwd.value = '';
  confirmPwd.value = '';
}
</script>

<template>
  <NCard :bordered="false" class="card-wrapper" title="修改密码" size="small">
    <NSpace vertical :size="12" class="max-w-360px">
      <NInput v-model:value="oldPwd" type="password" show-password-on="click" placeholder="原密码" />
      <NInput v-model:value="newPwd" type="password" show-password-on="click" placeholder="新密码（6-18 位）" />
      <NInput v-model:value="confirmPwd" type="password" show-password-on="click" placeholder="确认新密码" />
      <NButton type="primary" :loading="loading" @click="submit">确认修改</NButton>
    </NSpace>
  </NCard>
</template>

<style scoped>
.card-wrapper {
  border-radius: 12px;
}
</style>
