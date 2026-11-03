import { request } from '../request';

/* ---------------- 管理端 ---------------- */
export function fetchCards(params: { page?: number; size?: number; status?: number; agent_id?: number; q?: string }) {
  return request<any>({ url: '/admin/cards', params });
}
export function fetchGenerateCards(data: { count: number; agent_id?: number | null; note?: string }) {
  return request<any>({ url: '/admin/cards/generate', method: 'post', data });
}
export function fetchDeleteCard(id: number) {
  return request<any>({ url: `/admin/cards/${id}`, method: 'delete' });
}
export function fetchBatchDeleteCards(ids: number[]) {
  return request<any>({ url: '/admin/cards/batch-delete', method: 'post', data: { ids } });
}

/* ---------------- 代理管理 ---------------- */
export function fetchAgents() {
  return request<any>({ url: '/admin/agents' });
}
export function fetchCreateAgent(data: { username: string; password: string; quota: number }) {
  return request<any>({ url: '/admin/agents', method: 'post', data });
}
export function fetchUpdateAgentQuota(id: number, quota: number) {
  return request<any>({ url: `/admin/agents/${id}/quota`, method: 'put', data: { quota } });
}
export function fetchUpdateAgentStatus(id: number, status: number) {
  return request<any>({ url: `/admin/agents/${id}/status`, method: 'put', data: { status } });
}
export function fetchResetAgentPassword(id: number, password: string) {
  return request<any>({ url: `/admin/agents/${id}/password`, method: 'put', data: { password } });
}
export function fetchDeleteAgent(id: number) {
  return request<any>({ url: `/admin/agents/${id}`, method: 'delete' });
}

/* ---------------- 设备池（多用户并发） ---------------- */
/** 设备池状态：预热就绪数 / 目标数 / 活跃会话列表 */
export function fetchPool() {
  return request<any>({ url: '/admin/pool' });
}
/** 管理员设置预热池：台数 + 补池限速 + 是否用完自动补充（可选参数不传 = 不改） */
export function fetchSetWarm(target: number, interval?: number, refill?: boolean) {
  const data: { target: number; interval?: number; refill?: boolean } = { target };
  if (interval !== undefined) data.interval = interval;
  if (refill !== undefined) data.refill = refill;
  return request<any>({ url: '/admin/pool/warm', method: 'post', data });
}

/* ---------------- 代理端 ---------------- */
export function fetchAgentCards(params?: { page?: number; size?: number; q?: string; status?: number }) {
  return request<any>({ url: '/agent/cards', params });
}
/** 代理端数据总览：只返回该代理自己的统计 */
export function fetchAgentStats() {
  return request<any>({ url: '/agent/stats' });
}
export function fetchAgentGenerate(data: { count: number }) {
  return request<any>({ url: '/agent/generate', method: 'post', data });
}
export function fetchAgentDeleteCard(id: number) {
  return request<any>({ url: `/agent/cards/${id}`, method: 'delete' });
}
/** 代理批量删除自己的未使用卡密（已使用的跳过，额度返还） */
export function fetchAgentBatchDeleteCards(ids: number[]) {
  return request<any>({ url: '/agent/cards/batch-delete', method: 'post', data: { ids } });
}
