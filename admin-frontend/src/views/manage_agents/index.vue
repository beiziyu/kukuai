<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue';
import { NButton, NSpace, NTag, useDialog, useMessage } from 'naive-ui';
import {
  fetchAgents, fetchCreateAgent, fetchUpdateAgentQuota,
  fetchUpdateAgentStatus, fetchResetAgentPassword, fetchDeleteAgent
} from '@/service/api';

defineOptions({ name: 'ManageAgents' });

const message = useMessage();
const dialog = useDialog();

const loading = ref(false);
const tableData = ref<any[]>([]);

async function load() {
  loading.value = true;
  try {
    const { data, error } = await fetchAgents();
    if (!error && data) tableData.value = data.agents || [];
  } finally {
    loading.value = false;
  }
}

/* ---------------- 新增代理 ---------------- */
const showAdd = ref(false);
const addForm = reactive({ username: '', password: '', quota: 100 });

async function handleAdd() {
  if (!addForm.username || !addForm.password) {
    message.warning('请填写用户名和密码');
    return;
  }
  const { error } = await fetchCreateAgent({ ...addForm });
  if (!error) {
    message.success('代理已创建');
    showAdd.value = false;
    addForm.username = '';
    addForm.password = '';
    addForm.quota = 100;
    load();
  }
}

/* ---------------- 设置额度 ---------------- */
const showQuota = ref(false);
const quotaRow = ref<any>(null);
const quotaValue = ref(0);

function openQuota(row: any) {
  quotaRow.value = row;
  quotaValue.value = row.quota;
  showQuota.value = true;
}

async function handleSetQuota() {
  const { error } = await fetchUpdateAgentQuota(quotaRow.value.id, quotaValue.value);
  if (!error) {
    message.success('额度已更新');
    showQuota.value = false;
    load();
  }
}

/* ---------------- 重置密码 ---------------- */
const showPwd = ref(false);
const pwdRow = ref<any>(null);
const pwdValue = ref('');

function openPwd(row: any) {
  pwdRow.value = row;
  pwdValue.value = '';
  showPwd.value = true;
}

async function handleResetPwd() {
  if (!pwdValue.value) return message.warning('请输入新密码');
  const { error } = await fetchResetAgentPassword(pwdRow.value.id, pwdValue.value);
  if (!error) {
    message.success('密码已重置');
    showPwd.value = false;
  }
}

/* ---------------- 启/禁用 ---------------- */
async function toggleStatus(row: any) {
  const next = row.status === 1 ? 0 : 1;
  const { error } = await fetchUpdateAgentStatus(row.id, next);
  if (!error) {
    message.success(next === 1 ? '已启用' : '已禁用');
    load();
  }
}

/* ---------------- 删除 ---------------- */
function handleDelete(row: any) {
  dialog.warning({
    title: '删除代理',
    content: `确认删除代理「${row.username}」？名下若有未使用卡密将无法删除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      const { error } = await fetchDeleteAgent(row.id);
      if (!error) {
        message.success('已删除');
        load();
      }
    }
  });
}

/* ---------------- 表格列 ---------------- */
const columns = computed(() => [
  { title: 'ID', key: 'id', width: 70 },
  { title: '用户名', key: 'username', width: 150 },
  {
    title: '额度',
    key: 'quota',
    width: 240,
    render(row: any) {
      return h(NSpace, { size: 12 }, {
        default: () => [
          h('span', `已用 ${row.used} / 总额 ${row.quota}`),
          h(NTag, { size: 'small', type: 'info', bordered: false }, { default: () => `剩 ${row.quota - row.used}` })
        ]
      });
    }
  },
  { title: '生成卡密数', key: 'card_count', width: 110 },
  {
    title: '状态',
    key: 'status',
    width: 90,
    render(row: any) {
      return h(NTag, { type: row.status === 1 ? 'success' : 'default', size: 'small' }, {
        default: () => (row.status === 1 ? '正常' : '已禁用')
      });
    }
  },
  { title: '创建时间', key: 'created_at', width: 175 },
  {
    title: '操作',
    key: 'actions',
    width: 260,
    fixed: 'right' as const,
    render(row: any) {
      return h(NSpace, { size: 8 }, {
        default: () => [
          h(NButton, { size: 'small', secondary: true, onClick: () => openQuota(row) }, { default: () => '设额度' }),
          h(NButton, { size: 'small', secondary: true, onClick: () => openPwd(row) }, { default: () => '改密码' }),
          h(
            NButton,
            { size: 'small', secondary: true, type: row.status === 1 ? 'warning' : 'success', onClick: () => toggleStatus(row) },
            { default: () => (row.status === 1 ? '禁用' : '启用') }
          ),
          h(NButton, { size: 'small', secondary: true, type: 'error', onClick: () => handleDelete(row) }, { default: () => '删除' })
        ]
      });
    }
  }
]);

onMounted(load);
</script>

<template>
  <div>
    <NCard :bordered="false" class="card-wrapper" :segmented="{ content: true }">
    <template #header>
      <div class="flex items-center justify-between">
        <span class="font-medium">代理列表</span>
        <NButton type="primary" size="small" @click="showAdd = true">
          <template #icon><SvgIcon icon="mdi:account-plus-outline" /></template>
          新增代理
        </NButton>
      </div>
    </template>

    <NDataTable
      :columns="columns"
      :data="tableData"
      :loading="loading"
      :row-key="(row: any) => row.id"
      :scroll-x="1100"
      size="small"
    />
  </NCard>

  <!-- 新增代理 -->
  <NModal v-model:show="showAdd" preset="dialog" title="新增代理" positive-text="确定" @positive-click="handleAdd">
    <NForm label-placement="left" label-width="80" class="pt-12px">
      <NFormItem label="用户名">
        <NInput v-model:value="addForm.username" placeholder="代理登录名" />
      </NFormItem>
      <NFormItem label="密码">
        <NInput v-model:value="addForm.password" type="password" show-password-on="click" placeholder="代理登录密码" />
      </NFormItem>
      <NFormItem label="卡密额度">
        <NInputNumber v-model:value="addForm.quota" :min="0" :max="999999" class="w-full" />
      </NFormItem>
    </NForm>
  </NModal>

  <!-- 设置额度 -->
  <NModal v-model:show="showQuota" preset="dialog" title="设置卡密额度" positive-text="确定" @positive-click="handleSetQuota">
    <NForm label-placement="left" label-width="80" class="pt-12px">
      <NFormItem label="代理">
        <span>{{ quotaRow?.username }}</span>
      </NFormItem>
      <NFormItem label="新额度">
        <NInputNumber v-model:value="quotaValue" :min="0" :max="999999" class="w-full" />
      </NFormItem>
    </NForm>
  </NModal>

  <!-- 重置密码 -->
  <NModal v-model:show="showPwd" preset="dialog" title="重置代理密码" positive-text="确定" @positive-click="handleResetPwd">
    <NForm label-placement="left" label-width="80" class="pt-12px">
      <NFormItem label="代理">
        <span>{{ pwdRow?.username }}</span>
      </NFormItem>
      <NFormItem label="新密码">
        <NInput v-model:value="pwdValue" type="password" show-password-on="click" placeholder="请输入新密码" />
      </NFormItem>
    </NForm>
  </NModal>
  </div>
</template>

<style scoped>
.card-wrapper { border-radius: 12px; }
</style>
