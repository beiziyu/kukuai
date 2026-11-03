<script setup lang="ts">
import { computed, h, onMounted, reactive, ref, watch } from 'vue';
import { NButton, NSpace, NTag, useDialog, useMessage } from 'naive-ui';
import {
  fetchCards, fetchGenerateCards, fetchDeleteCard, fetchBatchDeleteCards, fetchAgents
} from '@/service/api';
import { localStg } from '@/utils/storage';

defineOptions({ name: 'ManageCards' });

const message = useMessage();
const dialog = useDialog();

// API 基地址：dev = http://localhost:3000/api（.env.test）；prod = /api（.env.prod，同源 + nginx 反代）
// ⚠️ 导出用原生 fetch 下载，不能走 axios 实例，必须自己拼基地址
const API_BASE = import.meta.env.VITE_SERVICE_BASE_URL || 'http://localhost:3000/api';
// 领取页地址（复制链接用）：生产在 .env.prod 配 VITE_CLAIM_PAGE_URL
const CLAIM_PAGE = import.meta.env.VITE_CLAIM_PAGE_URL || 'http://localhost:5173/claim';
const claimUrl = (key: string) => `${CLAIM_PAGE}?kami=${encodeURIComponent(key)}`;

/* ---------------- 列表 ---------------- */
const loading = ref(false);
const tableData = ref<any[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const filterStatus = ref<number | null>(null);
// 卡密搜索关键字（用户 2026-10-20 要求）
const keyword = ref('');

// 每页显示条数可选（默认 20）
const pageSizeOptions = [
  { label: '20', value: 20 },
  { label: '50', value: 50 },
  { label: '100', value: 100 },
  { label: '200', value: 200 },
  { label: '500', value: 500 }
] as any;

const statusOptions = [
  { label: '全部状态', value: null },
  { label: '未使用', value: 0 },
  { label: '已使用', value: 1 }
] as any;
const checkedRowKeys = ref<number[]>([]);

async function load() {
  loading.value = true;
  try {
    const params: any = { page: page.value, size: pageSize.value };
    if (filterStatus.value !== null && filterStatus.value !== undefined) {
      params.status = filterStatus.value;
    }
    if (keyword.value.trim()) params.q = keyword.value.trim();
    const { data, error } = await fetchCards(params);
    if (!error && data) {
      tableData.value = data.cards || [];
      total.value = data.total || 0;
    }
  } finally {
    loading.value = false;
  }
}

function onPageChange(p: number) {
  page.value = p;
  load();
}

// 搜索：回到第 1 页再查（否则可能停在超出总页数的页上）
function onSearch() {
  page.value = 1;
  load();
}

// 改了每页条数：回到第 1 页再拉（否则可能停在超出新总页数的页上，看到空列表）
function onPageSizeChange() {
  page.value = 1; // watch(page) 会同步 jumpPage
  load();
}

// 自绘分页条需要的数据
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const jumpPage = ref(1);

// 页码列表：始终显示 1/2/3 这种，页数多时中间用 … 省略
const pageNumbers = computed(() => {
  const tp = totalPages.value;
  const cur = page.value;
  if (tp <= 7) return Array.from({ length: tp }, (_, i) => i + 1);
  const out: (number | string)[] = [1];
  if (cur > 3) out.push('...');
  for (let i = Math.max(2, cur - 1); i <= Math.min(tp - 1, cur + 1); i++) out.push(i);
  if (cur < tp - 2) out.push('...');
  out.push(tp);
  return out;
});

// 翻页时同步跳页框
watch(page, (p) => { jumpPage.value = p; });

function onFilterChange() {
  page.value = 1;
  load();
}

/* ---------------- 生成 ---------------- */
const generating = ref(false);
const genForm = reactive({ count: 10, note: '', agent_id: null as number | null });

async function handleGenerate() {
  generating.value = true;
  try {
    const { data, error } = await fetchGenerateCards({
      count: genForm.count,
      note: genForm.note,
      agent_id: genForm.agent_id
    });
    if (!error) {
      message.success(`已生成 ${data?.cards?.length || genForm.count} 个卡密`);
      genForm.note = '';
      load();
    }
  } finally {
    generating.value = false;
  }
}

/* ---------------- 删除 ---------------- */
function confirmDelete(id: number) {
  dialog.warning({
    title: '确认删除',
    content: '确认删除此卡密？未使用的返还代理额度，已使用的不返还。',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      const { error } = await fetchDeleteCard(id);
      if (!error) {
        message.success('已删除');
        load();
      }
    }
  });
}

function handleBatchDelete() {
  if (!checkedRowKeys.value.length) {
    message.warning('请先勾选要删除的卡密');
    return;
  }
  const ids = [...checkedRowKeys.value];
  dialog.warning({
    title: '批量删除',
    content: `确认删除选中的 ${ids.length} 个卡密？未使用的返还代理额度，已使用的不返还。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      const { data, error } = await fetchBatchDeleteCards(ids);
      if (!error) {
        message.success(`已删除 ${data?.deleted ?? 0} 个${data?.skipped ? `，跳过 ${data.skipped} 个` : ''}`);
        checkedRowKeys.value = [];
        load();
      }
    }
  });
}

/* ---------------- 导出 ---------------- */
async function exportCards(ids?: number[]) {
  // ⚠️ 必须用 localStg（带 SOY_ 前缀），裸 localStorage.getItem('token') 取不到，会 401
  const token = localStg.get('token') || '';
  const qs = new URLSearchParams();
  if (filterStatus.value !== null && filterStatus.value !== undefined) {
    qs.set('status', String(filterStatus.value));
  }
  if (ids?.length) qs.set('ids', ids.join(','));
  const res = await fetch(`${API_BASE}/admin/cards/export?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    message.error('导出失败');
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kami_export_${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
  message.success(ids?.length ? `已导出 ${ids.length} 个卡密` : '导出成功');
}

function handleExportSelected() {
  if (!checkedRowKeys.value.length) return message.warning('请先勾选要导出的卡密');
  exportCards([...checkedRowKeys.value]);
}

/* ---------------- 复制 ---------------- */
async function copyLink(key: string) {
  const url = claimUrl(key);
  try {
    // ⚠️ navigator.clipboard 只在**安全上下文**（https / localhost）可用。
    //    用 http 访问后台时会直接抛错 —— 这时退化用 execCommand（http 下也能用）。
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url);
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, url.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (!ok) throw new Error('execCommand copy failed');
    }
    message.success('链接已复制');
  } catch {
    // 最后兜底：弹窗把链接显示出来，方便手动复制（弹窗内容可选中）
    dialog.info({
      title: '复制失败，请手动复制',
      content: () => h('div', { style: 'user-select:all;word-break:break-all;font-size:13px' }, url),
      positiveText: '知道了'
    });
  }
}

/* ---------------- 表格列 ---------------- */
const columns = computed(() => [
  { type: 'selection' as const },
  { title: 'ID', key: 'id', width: 70 },
  {
    // ⚠️ 必须 ellipsis：列被压窄时文字会被裁掉，加上之后至少能 hover 看全
    title: '卡密', key: 'card_key', width: 180, ellipsis: { tooltip: true }
  },
  {
    title: '备注',
    key: 'note',
    width: 140,
    ellipsis: { tooltip: true },
    render(row: any) {
      return row.note || h('span', { class: 'text-gray-400' }, '-');
    }
  },
  {
    title: '状态',
    key: 'status',
    width: 90,
    render(row: any) {
      return h(
        NTag,
        { type: row.status === 1 ? 'error' : 'success', size: 'small' },
        { default: () => (row.status === 1 ? '已使用' : '未使用') }
      );
    }
  },
  {
    title: '领取结果',
    key: 'claim_status',
    width: 100,
    render(row: any) {
      // 成功/失败看最新一条领取订单；未领取过的卡（claim_status 为空）留空
      if (row.claim_status === 'success') {
        return h(NTag, { type: 'success', size: 'small' }, { default: () => '成功' });
      }
      if (row.claim_status === 'failed') {
        return h(NTag, { type: 'error', size: 'small' }, { default: () => '失败' });
      }
      if (row.claim_status === 'running' || row.claim_status === 'pending') {
        return h(NTag, { type: 'warning', size: 'small' }, { default: () => '进行中' });
      }
      return h('span', { class: 'text-gray-400' }, '-');
    }
  },
  {
    title: '所属代理',
    key: 'agent_name',
    width: 110,
    render(row: any) {
      return row.agent_name || '平台自营';
    }
  },
  { title: '创建时间', key: 'created_at', width: 170, ellipsis: { tooltip: true } },
  {
    title: '使用时间',
    key: 'used_at',
    width: 170,
    render(row: any) {
      return row.used_at || '-';
    }
  },
  {
    title: '会员到期',
    key: 'member_expire_at',
    width: 150,
    render(row: any) {
      // 只有领取成功的卡才会有会员到期时间
      return row.claim_status === 'success' && row.member_expire_at ? row.member_expire_at : '-';
    }
  },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    fixed: 'right' as const,
    render(row: any) {
      return h(NSpace, { size: 8 }, {
        default: () => [
          h(NButton, { size: 'small', secondary: true, onClick: () => copyLink(row.card_key) }, { default: () => '复制链接' }),
          // 任何状态都能删（已使用的删除后不返还额度）
          h(NButton, { size: 'small', secondary: true, type: 'error', onClick: () => confirmDelete(row.id) }, { default: () => '删除' })
        ].filter(Boolean)
      });
    }
  }
]);

/* ---------------- 代理下拉 ---------------- */
const agentOptions = ref<{ label: string; value: number }[]>([]);
async function loadAgents() {
  const { data, error } = await fetchAgents();
  if (!error && data) {
    agentOptions.value = (data.agents || []).map((a: any) => ({ label: a.username, value: a.id }));
  }
}

onMounted(() => {
  load();
  loadAgents();
});
</script>

<template>
  <NSpace vertical :size="16">
    <!-- 生成卡密 -->
    <NCard :bordered="false" class="card-wrapper" size="small">
      <NSpace align="end" :wrap="true">
        <div>
          <div class="mb-6px text-13px text-gray-500">生成数量</div>
          <NInputNumber v-model:value="genForm.count" :min="1" :max="500" style="width: 140px" />
        </div>
        <div>
          <div class="mb-6px text-13px text-gray-500">备注（选填）</div>
          <NInput v-model:value="genForm.note" placeholder="如：抖音渠道-10月" style="width: 200px" clearable />
        </div>
        <div>
          <div class="mb-6px text-13px text-gray-500">分配给代理（选填）</div>
          <NSelect
            v-model:value="genForm.agent_id"
            :options="agentOptions"
            placeholder="不分配（平台自营）"
            clearable
            style="width: 200px"
          />
        </div>
        <NButton type="primary" :loading="generating" @click="handleGenerate">
          <template #icon><SvgIcon icon="mdi:plus-circle-outline" /></template>
          生成卡密
        </NButton>
      </NSpace>
    </NCard>

    <!-- 卡密列表 -->
    <NCard :bordered="false" class="card-wrapper" :segmented="{ content: true }">
      <template #header>
        <div class="flex items-center justify-between flex-wrap gap-8px">
          <div class="flex items-center gap-12px">
            <span class="font-medium">卡密列表</span>
            <span v-if="checkedRowKeys.length" class="text-13px text-primary">
              已选 {{ checkedRowKeys.length }} 个
            </span>
          </div>
          <NSpace :size="8">
            <NInput
              v-model:value="keyword"
              size="small"
              placeholder="搜索卡密"
              clearable
              style="width: 200px"
              @keyup.enter="onSearch"
              @clear="onSearch"
            >
              <template #prefix><SvgIcon icon="mdi:magnify" /></template>
            </NInput>
            <NButton size="small" @click="onSearch">搜索</NButton>
            <NSelect
              v-model:value="filterStatus"
              :options="statusOptions"
              size="small"
              style="width: 120px"
              @update:value="onFilterChange"
            />
            <NButton size="small" @click="load">
              <template #icon><SvgIcon icon="mdi:refresh" /></template>
              刷新
            </NButton>
            <NButton size="small" type="primary" :disabled="!checkedRowKeys.length" @click="handleExportSelected">
              <template #icon><SvgIcon icon="mdi:download" /></template>
              导出选中
            </NButton>
            <NButton size="small" type="success" @click="exportCards()">
              <template #icon><SvgIcon icon="mdi:file-excel-outline" /></template>
              导出全部
            </NButton>
            <NButton size="small" type="error" :disabled="!checkedRowKeys.length" @click="handleBatchDelete">
              <template #icon><SvgIcon icon="mdi:delete-outline" /></template>
              批量删除
            </NButton>
          </NSpace>
        </div>
      </template>

      <NDataTable
        :columns="columns"
        :data="tableData"
        remote
        :loading="loading"
        :row-key="(row: any) => row.id"
        v-model:checked-row-keys="checkedRowKeys"
        :scroll-x="1300"
        size="small"
        :pagination="false"
      />

      <!-- 自绘分页条：不依赖 Naive UI 的 pagination 事件链（那条链在 remote 模式下有坑：
          点页码不会触发 pagination.onUpdatePage，2026-10-14 实测踩到） -->
      <div v-if="total > 0" class="my-pager">
        <span class="my-pager__total">共 {{ total }} 条 · 第 {{ page }}/{{ totalPages }} 页</span>
        <span class="my-pager__jump">每页</span>
        <NSelect
          v-model:value="pageSize"
          :options="pageSizeOptions"
          size="tiny"
          style="width: 72px"
          @update:value="onPageSizeChange"
        />
        <span class="my-pager__jump">条</span>
        <NButton size="tiny" :disabled="page <= 1" @click="onPageChange(page - 1)">上一页</NButton>
        <template v-for="p in pageNumbers" :key="p">
          <span v-if="p === '...'" class="my-pager__ellipsis">…</span>
          <button v-else type="button" class="my-pager__num" :class="{ 'my-pager__num--active': p === page }" @click="onPageChange(Number(p))">{{ p }}</button>
        </template>
        <NButton size="tiny" :disabled="page >= totalPages" @click="onPageChange(page + 1)">下一页</NButton>
        <span class="my-pager__jump">跳至</span>
        <NInputNumber v-model:value="jumpPage" :min="1" :max="totalPages" size="tiny" style="width: 64px" @keyup.enter="onPageChange(Number(jumpPage))" />
        <NButton size="tiny" @click="onPageChange(Number(jumpPage))">确定</NButton>
      </div>
    </NCard>
  </NSpace>
</template>

<style scoped>
.card-wrapper { border-radius: 12px; }

/* 自绘分页条 */
.my-pager {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 14px;
  justify-content: flex-end;
}
.my-pager__total { margin-right: auto; font-size: 12px; color: #8f8a80; }
.my-pager__num {
  min-width: 26px;
  height: 26px;
  padding: 0 4px;
  border: 1px solid #e2ddd2;
  border-radius: 6px;
  background: #fff;
  font-size: 12px;
  cursor: pointer;
}
.my-pager__num:hover { border-color: #c9c3b6; }
.my-pager__num--active { background: #18a058; border-color: #18a058; color: #fff; font-weight: 700; }
.my-pager__ellipsis { padding: 0 2px; color: #8f8a80; }
.my-pager__jump { font-size: 12px; color: #6e6a61; }
</style>
