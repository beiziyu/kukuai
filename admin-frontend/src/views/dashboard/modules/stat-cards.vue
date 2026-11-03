<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { fetchStats, fetchAgentStats } from '@/service/api';
import { useAuthStore } from '@/store/modules/auth';

defineOptions({ name: 'StatCards' });

const authStore = useAuthStore();

interface Stats {
  total: number;
  used: number;
  unused: number;
  claimSuccess: number;
  claimFailed: number;
  claimPending: number;
}

const stats = ref<Stats>({
  total: 0, used: 0, unused: 0,
  claimSuccess: 0, claimFailed: 0, claimPending: 0
});

async function load() {
  // 管理员看全站，代理只看自己 —— 字段名一致，组件共用
  const api = authStore.userInfo.role === 'agent' ? fetchAgentStats : fetchStats;
  const { data, error } = await api();
  if (!error && data) {
    stats.value = {
      total: data.total || 0,
      used: data.used || 0,
      unused: data.unused || 0,
      claimSuccess: data.claimSuccess || 0,
      claimFailed: data.claimFailed || 0,
      claimPending: data.claimPending || 0
    };
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <NGrid cols="s:1 m:2 l:5" responsive="screen" :x-gap="16" :y-gap="16">
    <!-- 卡密总数 -->
    <NGi>
      <NCard :bordered="false" size="small" class="card-wrapper">
        <div class="stat-card" style="background-image: linear-gradient(135deg, #667eea 0%, #764ba2 100%)">
          <div class="stat-info">
            <p class="stat-title">卡密总数</p>
            <span class="stat-value">{{ stats.total }}</span>
          </div>
          <SvgIcon icon="mdi:key-variant" class="stat-icon" />
        </div>
      </NCard>
    </NGi>

    <!-- 已使用 -->
    <NGi>
      <NCard :bordered="false" size="small" class="card-wrapper">
        <div class="stat-card" style="background-image: linear-gradient(135deg, #f093fb 0%, #f5576c 100%)">
          <div class="stat-info">
            <p class="stat-title">已使用卡密</p>
            <span class="stat-value">{{ stats.used }}</span>
          </div>
          <SvgIcon icon="mdi:check-circle-outline" class="stat-icon" />
        </div>
      </NCard>
    </NGi>

    <!-- 未使用 -->
    <NGi>
      <NCard :bordered="false" size="small" class="card-wrapper">
        <div class="stat-card" style="background-image: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)">
          <div class="stat-info">
            <p class="stat-title">未使用卡密</p>
            <span class="stat-value">{{ stats.unused }}</span>
          </div>
          <SvgIcon icon="mdi:timer-sand" class="stat-icon" />
        </div>
      </NCard>
    </NGi>

    <!-- 领取成功 -->
    <NGi>
      <NCard :bordered="false" size="small" class="card-wrapper">
        <div class="stat-card" style="background-image: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)">
          <div class="stat-info">
            <p class="stat-title">领取成功</p>
            <span class="stat-value">{{ stats.claimSuccess }}</span>
          </div>
          <SvgIcon icon="mdi:check-decagram-outline" class="stat-icon" />
        </div>
      </NCard>
    </NGi>

    <!-- 领取失败 -->
    <NGi>
      <NCard :bordered="false" size="small" class="card-wrapper">
        <div class="stat-card" style="background-image: linear-gradient(135deg, #fa709a 0%, #fee140 100%)">
          <div class="stat-info">
            <p class="stat-title">领取失败</p>
            <span class="stat-value">{{ stats.claimFailed }}</span>
          </div>
          <SvgIcon icon="mdi:close-circle-outline" class="stat-icon" />
        </div>
      </NCard>
    </NGi>
  </NGrid>
</template>

<style scoped>
.card-wrapper { border-radius: 12px; }
.stat-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 22px 20px;
  border-radius: 10px;
  color: #fff;
}
.stat-title { margin: 0 0 8px; font-size: 14px; opacity: 0.9; }
.stat-value { font-size: 32px; font-weight: 700; line-height: 1; }
.stat-icon { width: 44px; height: 44px; opacity: 0.85; }
</style>
