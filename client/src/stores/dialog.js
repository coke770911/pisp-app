// @ts-check
/** 全域確認對話框與提示訊息 */
import { reactive } from 'vue';

/**
 * @typedef {Object} ConfirmOptions
 * @property {string} title
 * @property {string} message
 * @property {string} [confirmText]
 * @property {string} [cancelText]
 * @property {boolean} [danger] 確認按鈕使用警示色
 * @property {string} [requireText] 需輸入此文字才能確認（防誤刪）
 */

/**
 * @typedef {Object} DialogState
 * @property {boolean} open
 * @property {string} title
 * @property {string} message
 * @property {string} confirmText
 * @property {string} cancelText
 * @property {boolean} danger
 * @property {string} requireText 空字串 = 不需輸入
 * @property {string} inputValue
 * @property {((ok: boolean) => void) | null} resolver
 */

/** @type {DialogState} */
export const dialogState = reactive({
  open: false,
  title: '',
  message: '',
  confirmText: '確定',
  cancelText: '取消',
  danger: false,
  requireText: '',
  inputValue: '',
  resolver: null,
});

/**
 * 開啟確認對話框，回傳使用者是否確認。
 * @param {ConfirmOptions} opts
 * @returns {Promise<boolean>}
 */
export function askConfirm(opts) {
  // 若前一個對話框尚未關閉，視為取消
  if (dialogState.resolver) dialogState.resolver(false);
  return new Promise((resolve) => {
    dialogState.title = opts.title;
    dialogState.message = opts.message;
    dialogState.confirmText = opts.confirmText ?? '確定';
    dialogState.cancelText = opts.cancelText ?? '取消';
    dialogState.danger = opts.danger ?? false;
    dialogState.requireText = opts.requireText ?? '';
    dialogState.inputValue = '';
    dialogState.resolver = resolve;
    dialogState.open = true;
  });
}

/**
 * @param {boolean} ok
 * @returns {void}
 */
export function closeConfirm(ok) {
  // 需輸入確認文字但不相符 → 不允許確認
  if (ok && dialogState.requireText !== '' && dialogState.inputValue.trim() !== dialogState.requireText) return;
  const r = dialogState.resolver;
  dialogState.open = false;
  dialogState.resolver = null;
  if (r) r(ok);
}

/** @typedef {'info' | 'success' | 'error' | 'warning'} ToastKind */

/**
 * @typedef {Object} Toast
 * @property {number} id
 * @property {ToastKind} kind
 * @property {string} text
 */

/** @type {{ items: Toast[] }} */
export const toastState = reactive({ items: [] });

let toastSeq = 0;

/**
 * 顯示右上角提示訊息。
 * @param {string} text
 * @param {ToastKind} [kind]
 * @returns {void}
 */
export function toast(text, kind = 'info') {
  const id = ++toastSeq;
  toastState.items.push({ id, kind, text });
  setTimeout(() => {
    const idx = toastState.items.findIndex((t) => t.id === id);
    if (idx >= 0) toastState.items.splice(idx, 1);
  }, kind === 'error' ? 6000 : 3500);
}
