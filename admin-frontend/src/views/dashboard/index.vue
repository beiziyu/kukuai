<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAuthStore } from '@/store/modules/auth';
import { fetchAgentStats } from '@/service/api';
import StatCards from './modules/stat-cards.vue';
import CardPieChart from './modules/card-pie-chart.vue';
import ClaimBarChart from './modules/claim-bar-chart.vue';
import ChangePassword from './modules/change-password.vue';

defineOptions({ name: 'AdminDashboard' });

const authStore = useAuthStore();
const cardsRef = ref<InstanceType<typeof StatCards>>();
const pieRef = ref<InstanceType<typeof CardPieChart>>();
const barRef = ref<InstanceType<typeof ClaimBarChart>>();

const isAdmin = computed(() => authStore.userInfo.role === 'admin');
const isAgent = computed(() => authStore.userInfo.role === 'agent');

/* 代理专属：额度概况（/agent/stats 返回） */
const agentInfo = ref<any>({ quota: 0, used: 0, remaining: 0 });

async function loadAgentInfo() {
  const { data, error } = await fetchAgentStats();
  if (!error && data?.agent) {
    agentInfo.value = data.agent;
  }
}

function reloadAll() {
  cardsRef.value?.reload();
  pieRef.value?.reload();
  barRef.value?.reload();
  if (isAgent.value) loadAgentInfo();
}

onMounted(() => {
  if (isAgent.value) loadAgentInfo();
});
</script>

<template>
  <NSpace vertical :size="16">
    <!-- 欢迎条 -->
    <NCard :bordered="false" class="card-wrapper">
      <div class="flex items-center justify-between flex-wrap gap-12px">
        <div>
          <h2 class="text-18px font-bold m-0">
            {{ isAdmin ? '管理后台' : '代理中心' }}
          </h2>
          <p class="text-14px text-gray-500 m-0 mt-4px">
            欢迎回来，{{ authStore.userInfo.userName }}
            <NTag v-if="!isAdmin" size="small" type="success" class="ml-8px">代理</NTag>
            <NTag v-else size="small" type="primary" class="ml-8px">管理员</NTag>
          </p>
        </div>
        <NButton type="primary" @click="reloadAll">
          <template #icon>
            <SvgIcon icon="mdi:refresh" />
          </template>
          刷新数据
        </NButton>
      </div>
    </NCard>

    <!-- 代理额度概况（仅代理可见） -->
    <NCard v-if="isAgent" :bordered="false" class="card-wrapper" size="small">
      <NSpace :size="32" wrap>
        <div>
          <p class="m-0 text-13px text-gray-500">卡密额度</p>
          <p class="m-0 text-24px font-bold">{{ agentInfo.quota }}</p>
        </div>
        <div>
          <p class="m-0 text-13px text-gray-500">已生成</p>
          <p class="m-0 text-24px font-bold text-error">{{ agentInfo.used }}</p>
        </div>
        <div>
          <p class="m-0 text-13px text-gray-500">剩余可用</p>
          <p class="m-0 text-24px font-bold text-success">{{ agentInfo.remaining }}</p>
        </div>
      </NSpace>
    </NCard>

    <!-- 修改密码 -->
    <ChangePassword />

    <!-- 统计卡片 -->
    <StatCards ref="cardsRef" />

    <!-- 图表 -->
    <NGrid :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
      <NGi span="24 s:24 m:12">
        <CardPieChart ref="pieRef" />
      </NGi>
      <NGi span="24 s:24 m:12">
        <ClaimBarChart ref="barRef" />
      </NGi>
    </NGrid>
  </NSpace>
</template>

<style scoped>
.card-wrapper { border-radius: 12px; }
</style>
