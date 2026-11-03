import { computed, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { defineStore } from 'pinia';
import { useLoading } from '@sa/hooks';
import { localStg } from '@/utils/storage';
import { fetchGetUserInfo, fetchLogin } from '@/service/api';
import { $t } from '@/locales';
import { useRouterPush } from '@/hooks/common/router';
import { SetupStoreId } from '@/enum';
import { useRouteStore } from '../route';
import { useTabStore } from '../tab';
import { clearAuthStorage, getToken } from './shared';

export const useAuthStore = defineStore(SetupStoreId.Auth, () => {
  const route = useRoute();
  const authStore = useAuthStore();
  const routeStore = useRouteStore();
  const tabStore = useTabStore();
  const { toLogin, routerPushByKeyWithMetaQuery } = useRouterPush(false);
  const { loading: loginLoading, startLoading, endLoading } = useLoading();

  const token = ref('');

  const userInfo = reactive({
    userId: '',
    userName: '',
    /** 'admin' = 管理员, 'agent' = 代理 */
    role: 'guest' as 'admin' | 'agent' | 'guest',
    quota: 0,
    used: 0,
    /** Soybean 静态路由权限角色：admin -> R_SUPER, agent -> R_AGENT */
    roles: [] as string[],
    buttons: [] as string[]
  });

  /** is super role in static route */
  const isStaticSuper = computed(() => {
    const { VITE_AUTH_ROUTE_MODE, VITE_STATIC_SUPER_ROLE } = import.meta.env;

    return VITE_AUTH_ROUTE_MODE === 'static' && userInfo.roles.includes(VITE_STATIC_SUPER_ROLE);
  });

  /** Is login */
  const isLogin = computed(() => Boolean(token.value));

  /** Reset auth store */
  async function resetStore() {
    recordUserId();

    clearAuthStorage();
    localStg.remove('userInfo');

    authStore.$reset();

    if (!route.meta.constant) {
      await toLogin();
    }

    tabStore.cacheTabs();
    routeStore.resetStore();
  }

  /** Record the user ID of the previous login session Used to compare with the current user ID on next login */
  function recordUserId() {
    if (!userInfo.userId) {
      return;
    }

    // Store current user ID locally for next login comparison
    localStg.set('lastLoginUserId', userInfo.userId);
  }

  /**
   * Check if current login user is different from previous login user If different, clear all tabs
   *
   * @returns {boolean} Whether to clear all tabs
   */
  function checkTabClear(): boolean {
    if (!userInfo.userId) {
      return false;
    }

    const lastLoginUserId = localStg.get('lastLoginUserId');

    // Clear all tabs if current user is different from previous user
    if (!lastLoginUserId || lastLoginUserId !== userInfo.userId) {
      localStg.remove('globalTabs');
      tabStore.clearTabs();

      localStg.remove('lastLoginUserId');
      return true;
    }

    localStg.remove('lastLoginUserId');
    return false;
  }

  /**
   * Login
   *
   * @param userName User name
   * @param password Password
   * @param [redirect=true] Whether to redirect after login. Default is `true`
   */
  async function login(userName: string, password: string, redirect = true) {
    startLoading();

    try {
      const { data: loginToken, error } = await fetchLogin(userName, password);

      if (!error) {
        const pass = await loginByToken(loginToken);

        if (pass) {
          // 登录成功后立即初始化鉴权路由，确保按角色跳转时目标路由已注册。
          // 否则 router.push({name}) 在守卫注册路由前就解析目标，会抛 “No match”。
          await routeStore.initAuthRoute();

          // 清理跨用户 tab（保留原行为，不阻断跳转）
          checkTabClear();

          // 管理员和代理都落在数据总览（dashboard 内部按角色取各自作用域的统计数据）
          // 管理员 -> 全站数据；代理 -> 自己的数据
          const homeKey = 'dashboard';
          await routerPushByKeyWithMetaQuery(homeKey);

          window.$notification?.success({
            title: $t('page.login.common.loginSuccess'),
            content: $t('page.login.common.welcomeBack', { userName: userInfo.userName }),
            duration: 4500
          });
        }
      } else {
        resetStore();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[login error]', err);
    } finally {
      endLoading();
    }
  }

  async function loginByToken(loginToken: Api.Auth.LoginToken) {
    // 1. stored in the localStorage, the later requests need it in headers
    localStg.set('token', loginToken.token);
    localStg.set('refreshToken', loginToken.refreshToken || '');

    // 2. 我们的后端登录接口直接返回 user 信息（含 role）
    const u = (loginToken.user || {
      id: 0,
      username: '',
      role: 'agent' as const,
      quota: 0,
      used: 0
    }) as {
      id: number;
      username: string;
      role: 'admin' | 'agent';
      quota?: number;
      used?: number;
    };
    Object.assign(userInfo, {
      userId: String(u.id ?? ''),
      userName: u.username || '',
      role: u.role || 'guest',
      quota: Number(u.quota || 0),
      used: Number(u.used || 0),
      // 映射 Soybean 权限角色，用于菜单/路由过滤
      roles: u.role === 'admin' ? ['R_SUPER'] : u.role === 'agent' ? ['R_AGENT'] : []
    });
    localStg.set('userInfo', userInfo);

    token.value = loginToken.token;

    return true;
  }

  async function getUserInfo() {
    // 后端没有独立 getUserInfo 接口，从本地缓存恢复（刷新页面不掉登录态）
    const cached = localStg.get('userInfo');
    if (cached && cached.userId) {
      Object.assign(userInfo, cached);
      return true;
    }
    return false;
  }

  async function initUserInfo() {
    const maybeToken = getToken();

    if (maybeToken) {
      token.value = maybeToken;
      const pass = await getUserInfo();

      if (!pass) {
        resetStore();
      }
    }
  }

  return {
    token,
    userInfo,
    isStaticSuper,
    isLogin,
    loginLoading,
    resetStore,
    login,
    initUserInfo
  };
});
