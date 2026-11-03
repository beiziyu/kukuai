<template>
  <n-card title="协议执行日志" :bordered="false">
    <template #header-extra>
      <n-space align="center">
        <n-button size="small" :type="paused ? 'default' : 'primary'" @click="togglePause">
          {{ paused ? '已暂停' : '自动刷新中' }}
        </n-button>
        <n-button size="small" @click="load">立即刷新</n-button>
        <n-tag size="small" type="info">{{ lines.length }} 行 · {{ lastAt }}</n-tag>
      </n-space>
    </template>
    <div class="log-wrap">
      <pre class="log-box" ref="logBox">{{ text }}</pre>
    </div>
  </n-card>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { NCard, NButton, NSpace, NTag } from 'naive-ui';
import { fetchLogs } from '@/service/api/kami';

const lines = ref<string[]>([]);
const paused = ref(false);
const lastAt = ref('');
const logBox = ref<HTMLElement>();
const text = computed(() => lines.value.join('\n'));
let timer: ReturnType<typeof setInterval> | null = null;

async function load() {
  try {
    const r: any = await fetchLogs(500);
    const body = r?.lines ? r : (r?.data || {});
    if (body && Array.isArray(body.lines)) {
      const el = logBox.value;
      // 仅当用户本来就在底部附近时才自动滚到底; 往上翻看时保持阅读位置
      const nearBottom = el ? (el.scrollHeight - el.scrollTop - el.clientHeight < 80) : true;
      lines.value = body.lines;
      lastAt.value = new Date().toLocaleTimeString();
      await nextTick();
      if (el && nearBottom) el.scrollTop = el.scrollHeight;
    }
  } catch (e) {
    /* 协议层短暂不可达时静默 */
  }
}

function togglePause() {
  paused.value = !paused.value;
}

onMounted(() => {
  load();
  timer = setInterval(() => { if (!paused.value) load(); }, 3000);
});
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.log-wrap { max-height: 70vh; }
.log-box {
  margin: 0; padding: 14px; background: #0a0e13; color: #c9d1d9;
  font: 12.5px/1.6 Consolas, 'SF Mono', monospace; border-radius: 8px;
  overflow-y: auto; max-height: 68vh; white-space: pre-wrap; word-break: break-all;
}
</style>
