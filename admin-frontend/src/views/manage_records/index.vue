<template>
  <n-space vertical size="large">
    <n-space align="center">
      <n-input v-model:value="qPhone" placeholder="手机号搜索" style="width: 180px"
               @keyup.enter="load(1)" clearable />
      <n-input v-model:value="qKami" placeholder="卡密搜索" style="width: 200px"
               @keyup.enter="load(1)" clearable />
      <n-button @click="load(1)">查询</n-button>
      <n-button @click="exportExcel">导出 Excel</n-button>
    </n-space>

    <n-data-table :columns="columns" :data="rows" :row-key="r => r.id"
                  :pagination="false" :loading="loading" :scroll-x="1400" />
    <n-pagination :page="page" :page-size="size" :item-count="total"
                  @update:page="p => load(p)" />

    <n-modal v-model:show="showCk" preset="card" :title="ckTitle" style="width: 560px">
      <n-input type="textarea" :value="ckValue" :rows="6" readonly />
      <template #footer>
        <n-button @click="copyCk">复制全部</n-button>
      </template>
    </n-modal>
  </n-space>
</template>

<script setup lang="ts">
import { ref, onMounted, h } from 'vue';
import { NButton, NTag, NModal, NInput, NSpace, NAvatar, useMessage } from 'naive-ui';
import { request } from '@/service/request';

const rows = ref<any[]>([]); const total = ref(0); const page = ref(1); const size = 20;
const loading = ref(false); const qPhone = ref(''); const qKami = ref('');
const showCk = ref(false); const ckValue = ref(''); const ckTitle = ref('');
const message = useMessage();

const statusText: Record<string, string> = {
  pending: '待发送', sent: '已发短信', running: '执行中',
  success: '成功', failed: '失败',
};
const statusTag = (s: string) => ({
  success: 'success', failed: 'error', running: 'info', sent: 'warning', pending: 'default',
}[s] || 'default');

function copyText(t: string, label: string) {
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (ok) message.success(`${label}已复制`);
  else {
    showCk.value = true; ckTitle.value = label; ckValue.value = t;
  }
}

const columns = [
  { title: 'ID', key: 'id', width: 60 },
  { title: '头像', key: 'avatar', width: 64,
    render: (r: any) => r.avatar
      ? h(NAvatar, { size: 36, src: r.avatar, round: true,
          style: 'border:2px solid #ffb3dd' })
      : h('span', '-') },
  { title: '用户名', key: 'username', width: 110,
    render: (r: any) => r.username || '-' },
  { title: '手机号', key: 'phone', width: 120 },
  { title: '卡密', key: 'card_key', width: 170 },
  { title: '会员到期', key: 'member_expire_at', width: 150,
    render: (r: any) => r.member_expire_at || '-' },
  { title: '状态', key: 'status', width: 90,
    render: (r: any) => {
      const txt = statusText[r.status] || r.status;
      return h(NTag, { type: statusTag(r.status), size: 'small' }, () => txt);
    } },
  { title: '未转换CK', key: 'ck_before', width: 120,
    render: (r: any) => r.ck_before
      ? h(NButton, { size: 'tiny', onClick: () => copyText(r.ck_before, '未转换CK') },
          () => '复制')
      : h('span', '-') },
  { title: '转换后CK', key: 'ck_after', width: 120,
    render: (r: any) => r.ck_after
      ? h(NButton, { size: 'tiny', type: 'primary', ghost: true,
          onClick: () => copyText(r.ck_after, '转换后CK') }, () => '复制')
      : h('span', '-') },
  { title: '创建时间', key: 'created_at', width: 160 },
];

async function load(p = 1) {
  page.value = p; loading.value = true;
  try {
    const params = new URLSearchParams({
      page: String(p), size: String(size),
      phone: qPhone.value || '', kami: qKami.value || '',
    });
    const res = await request<any>({ url: `/admin/claim-records?${params}` });
    rows.value = res.data?.rows || [];
    total.value = res.data?.total || 0;
  } finally {
    loading.value = false;
  }
}

function exportExcel() {
  const params = new URLSearchParams({ phone: qPhone.value || '', kami: qKami.value || '' });
  const token = localStorage.getItem('kami_token') || '';
  fetch(`/api/admin/claim-records/export?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => r.blob()).then(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `claim-records-${Date.now()}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  });
}

function copyCk() {
  const ta = document.createElement('textarea');
  ta.value = ckValue.value;
  document.body.appendChild(ta); ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  message.success('已复制');
}

onMounted(() => load(1));
</script>
