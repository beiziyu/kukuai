<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue';
import { NButton, NSpace, NTag, useDialog, useMessage } from 'naive-ui';
import { fetchAgentCards, fetchAgentGenerate, fetchAgentDeleteCard, fetchAgentBatchDeleteCards } from '@/service/api';
import { localStg } from '@/utils/storage';
import { useAuthStore } from '@/store/modules/auth';

defineOptions({ name: 'AgentCards' });

const message = useMessage();
const dialog = useDialog();
const authStore = useAuthStore();

// API 基地址：dev = http://localhost:3000/api（.env.test）；prod = /api（.env.prod，同源 + nginx 反代）
// ⚠️ 导出用原生 fetch 下载，不能走 axios 实例，必须自己拼基地址
const API_BASE = import.meta.env.VITE_SERVICE_BASE_URL || 'http://localhost:3000/api';
// 领取页地址（复制链接用）：生产在 .env.prod 配 VITE_CLAIM_PAGE_URL
const CLAIM_PAGE = import.meta.env.VITE_CLAIM_PAGE_URL || 'http://localhost:5173/claim';
const claimUrl = (key: string) => `${CLAIM_PAGE}?kami=${encodeURIComponent(key)}`;

const loading = ref(false);
const tableData = ref<any[]>([]);
const agentInfo = ref<any>({ quota: 0, used: 0 });
const checkedRowKeys = ref<number[]>([]);

/* ---------------- 列表分页（与管理端一致） ---------------- */
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
// 卡密搜索关键字（用户 2026-10-20 要求）
const keyword = ref('');
// 状态筛选：全部 / 未使用 / 已使用（用户 2026-10-20 要求）
const filterStatus = ref<number | null>(null);
const statusOptions = [
  { label: '全部状态', value: null },
  { label: '未使用', value: 0 },
  { label: '已使用', value: 1 }
] as any;
// 每页显示条数可选（默认 20）
const pageSizeOptions = [
  { label: '20', value: 20 },
  { label: '50', value: 50 },
  { label: '100', value: 100 },
  { label: '200', value: 200 },
  { label: '500', value: 500 }
] as any;

const genCount = ref(10);
const generating = ref(false);

async function load() {
  loading.value = true;
  try {
    const params: any = { page: page.value, size: pageSize.value };
    if (keyword.value.trim()) params.q = keyword.value.trim();
    if (filterStatus.value !== null && filterStatus.value !== undefined) {
      params.status = filterStatus.value;
    }
    const { data, error } = await fetchAgentCards(params);
    if (!error && data) {
      tableData.value = data.cards || [];
      total.value = data.total || 0;
      if (data.agent) agentInfo.value = data.agent;
    }
  } finally {
    loading.value = false;
  }
}

// 搜索：回到第 1 页再查
function onSearch() {
  page.value = 1;
  load();
}

// 状态筛选：回到第 1 页再查
function onFilterChange() {
  page.value = 1;
  load();
}

function onPageChange(p: number) {
  page.value = p;
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

async function handleGenerate() {
  generating.value = true;
  try {
    const { data, error } = await fetchAgentGenerate({ count: genCount.value });
    if (!error) {
      message.success(`已生成 ${data?.cards?.length || genCount.value} 个卡密`);
      if (data) agentInfo.value = { ...agentInfo.value, used: data.used, quota: data.quota };
      load();
    }
  } finally {
    generating.value = false;
  }
}

async function handleDelete(id: number) {
  const { error } = await fetchAgentDeleteCard(id);
  if (!error) {
    message.success('已删除');
    load();
  }
}

/* ---------------- 批量删除 ---------------- */
function handleBatchDelete() {
  if (!checkedRowKeys.value.length) {
    message.warning('请先勾选要删除的卡密');
    return;
  }
  const ids = [...checkedRowKeys.value];
  dialog.warning({
    title: '批量删除',
    content: `确认删除选中的 ${ids.length} 个卡密？未使用的返还额度，已使用的不返还。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      const { data, error } = await fetchAgentBatchDeleteCards(ids);
      if (!error) {
        message.success(`已删除 ${data?.deleted ?? 0} 个${data?.skipped ? `，跳过 ${data.skipped} 个` : ''}`);
        checkedRowKeys.value = [];
        load();
      }
    }
  });
}

/* ---------------- 导出 Excel ---------------- */
async function exportCards(ids?: number[]) {
  // ⚠️ 必须用 localStg（带 SOY_ 前缀），裸 localStorage.getItem('token') 取不到
  const token = localStg.get('token') || '';
  const qs = new URLSearchParams();
  if (ids?.length) qs.set('ids', ids.join(','));
  const res = await fetch(`${API_BASE}/agent/cards/export?${qs.toString()}`, {
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
  a.download = `kami_agent_${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
  message.success(ids?.length ? `已导出 ${ids.length} 个卡密` : '导出成功');
}

function handleExportSelected() {
  if (!checkedRowKeys.value.length) return message.warning('请先勾选要导出的卡密');
  exportCards([...checkedRowKeys.value]);
}

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

const columns = computed(() => [
  { type: 'selection' as const },
  { title: 'ID', key: 'id', width: 70 },
  { title: '卡密', key: 'card_key', width: 160 },
  {
    title: '状态',
    key: 'status',
    width: 90,
    render(row: any) {
      return h(NTag, { type: row.status === 1 ? 'error' : 'success', size: 'small' }, {
        default: () => (row.status === 1 ? '已使用' : '未使用')
      });
    }
  },
  {
    title: '领取结果',
    key: 'claim_status',
    width: 100,
    render(row: any) {
      // 与管理端一致：成功/失败看最新一条领取订单，未领取过的卡留空
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
  { title: '创建时间', key: 'created_at', width: 175 },
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
          h(NButton, { size: 'small', secondary: true, type: 'error', onClick: () => handleDelete(row.id) }, { default: () => '删除' })
        ].filter(Boolean)
      });
    }
  }
]);

onMounted(load);
</script>

<template>
  <NSpace vertical :size="16">
    <!-- 额度 + 生成 -->
    <NCard :bordered="false" class="card-wrapper" size="small">
      <div class="flex items-center justify-between flex-wrap gap-16px">
        <NSpace :size="32">
          <div>
            <p class="m-0 text-13px text-gray-500">我的额度</p>
            <p class="m-0 text-24px font-bold">{{ agentInfo.quota }}</p>
          </div>
          <div>
            <p class="m-0 text-13px text-gray-500">已使用</p>
            <p class="m-0 text-24px font-bold text-error">{{ agentInfo.used }}</p>
          </div>
          <div>
            <p class="m-0 text-13px text-gray-500">剩余可用</p>
            <p class="m-0 text-24px font-bold text-success">{{ (agentInfo.quota || 0) - (agentInfo.used || 0) }}</p>
          </div>
        </NSpace>

        <NSpace align="end">
          <div>
            <div class="mb-6px text-13px text-gray-500">生成数量</div>
            <NInputNumber v-model:value="genCount" :min="1" :max="100" style="width: 140px" />
          </div>
          <NButton type="primary" :loading="generating" @click="handleGenerate">
            <template #icon><SvgIcon icon="mdi:plus-circle-outline" /></template>
            生成卡密
          </NButton>
        </NSpace>
      </div>
      <p class="m-0 mt-12px text-12px text-gray-400">
        提示：生成会扣除额度；删除未使用卡密会返还额度。
      </p>
    </NCard>

    <!-- 我的卡密 -->
    <NCard :bordered="false" class="card-wrapper" :segmented="{ content: true }">
      <template #header>
        <div class="flex items-center justify-between flex-wrap gap-8px">
          <div class="flex items-center gap-12px">
            <span class="font-medium">我的卡密</span>
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
            <NButton size="small" type="primary" :disabled="!checkedRowKeys.length" @click="handleExportSelected">
              <template #icon><SvgIcon icon="mdi:download" /></template>
              导出选中
            </NButton>
            <NButton size="small" @click="exportCards()">
              <template #icon><SvgIcon icon="mdi:download-outline" /></template>
              导出全部
            </NButton>
            <NButton size="small" type="error" :disabled="!checkedRowKeys.length" @click="handleBatchDelete">
              <template #icon><SvgIcon icon="mdi:delete-sweep-outline" /></template>
              批量删除
            </NButton>
            <NButton size="small" @click="load">
              <template #icon><SvgIcon icon="mdi:refresh" /></template>
              刷新
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
        :scroll-x="1000"
        size="small"
        :pagination="false"
      />

      <!-- 自绘分页条：与管理端一致（Naive 的 pagination 在 remote 模式有坑，见 manage_cards） -->
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
