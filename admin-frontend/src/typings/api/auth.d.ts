declare namespace Api {
  /**
   * namespace Auth
   *
   * backend api module: "auth"
   */
  namespace Auth {
    interface LoginToken {
      token: string;
      refreshToken: string;
      /** 我们后端登录接口直接返回的用户信息 */
      user?: {
        id: number;
        username: string;
        role: 'admin' | 'agent';
        quota?: number;
        used?: number;
      };
    }

    interface UserInfo {
      userId: string;
      userName: string;
      roles: string[];
      buttons: string[];
    }
  }
}
