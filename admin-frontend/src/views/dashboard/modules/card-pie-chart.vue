<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { fetchStats, fetchAgentStats } from '@/service/api';
import { useAuthStore } from '@/store/modules/auth';
import { useEcharts } from '@/hooks/common/echarts';

defineOptions({ name: 'CardPieChart' });

const authStore = useAuthStore();

const stats = ref<any>({});

const { domRef, updateOptions } = useEcharts(() => ({
  tooltip: { trigger: 'item', formatter: '{b}<br/>{c} 张 ({d}%)' },
  // 图例保留在底部；下方标签会压到图例，所以把圆环缩小并上移，配合加高的容器留出间距
  legend: { bottom: '1%', left: 'center', itemStyle: { borderWidth: 0 } },
  series: [
    {
      name: '卡密状态',
      type: 'pie',
      radius: ['40%', '66%'],
      center: ['50%', '48%'],
      avoidLabelOverlap: true,
      itemStyle: { borderRadius: 10, borderColor: '#fff', borderWidth: 2 },
      label: { show: true, formatter: '{b}\n{c} 张' },
      labelLine: { length: 12, length2: 10 },
      emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
      data: [] as { name: string; value: number }[]
    }
  ]
}));

function render() {
  updateOptions(opts => {
    opts.series[0].data = [
      { name: '未使用', value: Number(stats.value.unused || 0) },
      { name: '已使用', value: Number(stats.value.used || 0) }
    ];
    return opts;
  });
}

async function load() {
  const api = authStore.userInfo.role === 'agent' ? fetchAgentStats : fetchStats;
  const { data, error } = await api();
  if (!error && data) {
    stats.value = data;
    render();
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <NCard :bordered="false" class="card-wrapper" :segmented="{ content: true }">
    <template #header>
      <div class="flex items-center justify-between">
        <span class="font-medium">卡密状态分布</span>
        <SvgIcon icon="mdi:chart-pie" class="text-18px text-gray-400" />
      </div>
    </template>
    <div ref="domRef" class="h-380px overflow-hidden"></div>
  </NCard>
</template>

<style scoped>
.card-wrapper { border-radius: 12px; }
</style>
