// @ts-check
/** 登入狀態（簡易 reactive store） */
import { reactive } from 'vue';
import { fetchMe } from '../api/index.js';
import { ApiError } from '../api/http.js';

/**
 * @typedef {Object} AuthState
 * @property {string | null} username 目前登入者；null = 未登入
 * @property {boolean} checked        是否已向後端確認過身分
 */

/** @type {AuthState} */
export const authState = reactive({ username: null, checked: false });

/**
 * 向後端確認登入狀態（只在尚未確認時呼叫）。
 * 401 視為未登入；其他錯誤（例如網路）也視為未登入，交由登入頁顯示訊息。
 * @returns {Promise<boolean>} 是否已登入
 */
export async function ensureAuth() {
  if (authState.checked) return authState.username !== null;
  try {
    const me = await fetchMe();
    authState.username = me.username;
  } catch (err) {
    if (!(err instanceof ApiError)) console.error(err);
    authState.username = null;
  }
  authState.checked = true;
  return authState.username !== null;
}

/**
 * @param {string} username
 * @returns {void}
 */
export function setLoggedIn(username) {
  authState.username = username;
  authState.checked = true;
}

/** @returns {void} */
export function clearAuth() {
  authState.username = null;
  authState.checked = true;
}
