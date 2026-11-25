// @ts-check
/** 路由設定（History 模式）與登入守衛 */
import { createRouter, createWebHistory } from 'vue-router';
import { ensureAuth, authState } from '../stores/auth.js';

/**
 * @typedef {Object} AppRouteMeta
 * @property {boolean} [public] true = 不需登入
 * @property {string} [title]   頁面標題
 */

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/payrolls' },
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
      meta: { public: true, title: '登入' },
    },
    {
      path: '/payrolls',
      name: 'payrolls',
      component: () => import('../views/PayrollsView.vue'),
      meta: { title: '月度工作台' },
    },
    {
      path: '/brackets',
      name: 'brackets',
      component: () => import('../views/BracketsView.vue'),
      meta: { title: '年度級距維護' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/payrolls' },
  ],
});

router.beforeEach(async (to) => {
  const meta = /** @type {AppRouteMeta} */ (to.meta);
  const loggedIn = await ensureAuth();
  if (meta.public) {
    // 已登入者進入登入頁 → 直接導回首頁
    if (to.name === 'login' && loggedIn) return { path: '/payrolls' };
    return true;
  }
  if (!loggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  return true;
});

router.afterEach((to, _from, failure) => {
  // 導航被取消（例如未儲存提示選擇留下）時不更新標題
  if (failure) return;
  const meta = /** @type {AppRouteMeta} */ (to.meta);
  document.title = meta.title ? `${meta.title}｜HISP - 人事勞健保加退拆帳系統` : 'HISP - 人事勞健保加退拆帳系統';
});

/**
 * 全域 401：清除登入狀態並導回登入頁（保留原頁面以便登入後返回）。
 * @returns {void}
 */
export function handleSessionExpired() {
  authState.username = null;
  authState.checked = true;
  const current = router.currentRoute.value;
  // 已在登入頁或已在導向中（多個請求同時 401）→ 不重複導向
  if (current.name === 'login' || redirecting) return;
  redirecting = true;
  void router
    .replace({ name: 'login', query: { redirect: current.fullPath, expired: '1' } })
    .finally(() => {
      redirecting = false;
    });
}

/** 是否正在因登入逾時導向登入頁 */
let redirecting = false;
