// @ts-check
/** 登入狀態（簡易 reactive store） */
import { reactive, computed } from 'vue';
import { fetchMe } from '../api/index.js';
import { ApiError } from '../api/http.js';

/** @typedef {import('../api/schemas.js').User} User */
/** @typedef {import('../api/schemas.js').Role} Role */

/**
 * @typedef {Object} AuthState
 * @property {User | null} user  目前登入者；null = 未登入
 * @property {boolean} checked   是否已向後端確認過身分
 */

/** @type {AuthState} */
export const authState = reactive({ user: null, checked: false });

/** 是否已登入 */
export const isLoggedIn = computed(() => authState.user !== null);

/** 目前登入者是否為管理者 */
export const isAdmin = computed(() => authState.user?.role === 'admin');

/** 標題列顯示名稱（無 displayName 時顯示帳號） */
export const currentDisplayName = computed(() => {
  const u = authState.user;
  if (!u) return '';
  return u.displayName.trim() !== '' ? u.displayName : u.account;
});

/** 角色中文名稱 */
export const ROLE_LABELS = /** @type {const} */ ({ admin: '管理者', user: '一般使用者' });

/**
 * @param {Role} role
 * @returns {string}
 */
export function roleLabel(role) {
  return ROLE_LABELS[role];
}

/**
 * 向後端確認登入狀態（只在尚未確認時呼叫）。
 * 401 視為未登入；其他錯誤（例如網路）也視為未登入，交由登入頁顯示訊息。
 * @returns {Promise<boolean>} 是否已登入
 */
export async function ensureAuth() {
  if (authState.checked) return authState.user !== null;
  try {
    authState.user = await fetchMe();
  } catch (err) {
    if (!(err instanceof ApiError)) console.error(err);
    authState.user = null;
  }
  authState.checked = true;
  return authState.user !== null;
}

/**
 * @param {User} user
 * @returns {void}
 */
export function setLoggedIn(user) {
  authState.user = { account: user.account, displayName: user.displayName, role: user.role };
  authState.checked = true;
}

/** @returns {void} */
export function clearAuth() {
  authState.user = null;
  authState.checked = true;
}
