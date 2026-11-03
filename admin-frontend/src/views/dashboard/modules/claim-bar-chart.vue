<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { fetchStats, fetchAgentStats } from '@/service/api';
import { useAuthStore } from '@/store/modules/auth';
import { useEcharts } from '@/hooks/common/echarts';

defineOptions({ name: 'ClaimBarChart' });

const authStore = useAuthStore();

const stats = ref<any>({});

const { domRef, updateOptions } = useEcharts(() => ({
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  legend: { bottom: '1%', itemStyle: { borderWidth: 0 } },
  grid: { left: '3%', right: '4%', bottom: '12%', top: '12%', containLabel: true },
  xAxis: {
    type: 'category',
    // 第三个柱子按业务口径就是"未使用的卡密数"，不是领取进行中
    data: ['领取成功', '领取失败', '未使用'],
    axisTick: { alignWithLabel: true }
  },
  yAxis: { type: 'value', minInterval: 1 },
  series: [
    {
      name: '次数',
      type: 'bar',
      barWidth: '45%',
      itemStyle: { borderRadius: [6, 6, 0, 0] },
      data: [] as number[]
    }
  ]
}));

function render() {
  updateOptions(opts => {
    opts.series[0].data = [
      Number(stats.value.claimSuccess || 0),
      Number(stats.value.claimFailed || 0),
      // 与 x 轴「未使用」对应：取未使用卡密数
      Number(stats.value.unused || 0)
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
        <span class="font-medium">会员领取结果统计</span>
        <SvgIcon icon="mdi:chart-bar" class="text-18px text-gray-400" />
      </div>
    </template>
    <div ref="domRef" class="h-380px overflow-hidden"></div>
  </NCard>
</template>

<style scoped>
.card-wrapper { border-radius: 12px; }
</style>
