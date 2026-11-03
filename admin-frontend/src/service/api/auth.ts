import { request } from '../request';

/**
 * 统一登录：管理端和代理端同一个地址，后端自动识别身份
 * 返回 { token, user: { id, username, role: 'admin' | 'agent', quota?, used? } }
 */
export function fetchLogin(userName: string, password: string) {
  return request<Api.Auth.LoginToken>({
    url: '/auth/login',
    method: 'post',
    data: { username: userName, password }
  });
}

/** 修改自己的密码（管理员/代理通用，按角色走不同接口） */
export function fetchChangePassword(role: string, old_password: string, new_password: string) {
  return request<any>({
    url: role === 'admin' ? '/admin/change-password' : '/agent/change-password',
    method: 'post',
    data: { old_password, new_password }
  });
}

/** 后端无独立 getUserInfo 接口，登录即返回用户信息，这里兜底返回 null */
export function fetchGetUserInfo() {
  return Promise.resolve(null) as any;
}

/**
 * Refresh token
 *
 * @param refreshToken Refresh token
 */
export function fetchRefreshToken(refreshToken: string) {
  return request<Api.Auth.LoginToken>({
    url: '/auth/refreshToken',
    method: 'post',
    data: { refreshToken }
  });
}

/**
 * return custom backend error
 *
 * @param code error code
 * @param msg error message
 */
export function fetchCustomBackendError(code: string, msg: string) {
  return request({ url: '/auth/error', params: { code, msg } });
}

/** 管理后台仪表盘统计 */
export function fetchStats() {
  return request<any>({ url: '/admin/stats' });
}
