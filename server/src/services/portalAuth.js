// @ts-check
/**
 * 校內 portal 帳號驗證（廠商 REST API）。
 * - 以 Node 內建 fetch + AbortController 逾時呼叫。
 * - 回應以 zod 驗證；格式不符視為服務故障。
 * - 記錄錯誤時只記 HTTP 狀態與 Code，絕不記錄密碼、API 金鑰或完整回應。
 */
import { z } from 'zod';
import { env } from '../config/env.js';

/**
 * @typedef {{ kind: 'ok', displayName: string } | { kind: 'invalid' } | { kind: 'unavailable' }} PortalAuthResult
 */

/** portal 回應格式（Vendor、Timestamp 只檢查存在與否，不使用其值） */
const portalResponseSchema = z
  .object({
    Ok: z.boolean(),
    Result: z.string().nullish(),
    Code: z.string().nullish(),
    DisplayName: z.string().nullish(),
    Vendor: z.unknown().optional(),
    Timestamp: z.unknown().optional(),
  })
  .loose();

/** 帳密錯誤代碼 */
const INVALID_CREDENTIALS_CODE = 'INVALID_CREDENTIALS';

/**
 * 只取出 Code 用於記錄（必須是短字串，避免把整個回應寫進 log）。
 * @param {unknown} body
 * @returns {string}
 */
function safeCode(body) {
  if (typeof body !== 'object' || body === null || !('Code' in body)) return '-';
  const code = body.Code;
  if (typeof code !== 'string') return '-';
  return /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : '(格式不明)';
}

/**
 * 呼叫 portal 驗證帳密。
 * @param {string} account   使用者輸入的帳號（已 trim + 小寫）
 * @param {string} password  使用者輸入的密碼（原值）
 * @returns {Promise<PortalAuthResult>}
 */
export async function verifyWithPortal(account, password) {
  if (env.PORTAL_AUTH_URL === '' || env.PORTAL_API_KEY === '') {
    console.error('[portal] 未設定 PORTAL_AUTH_URL 或 PORTAL_API_KEY，無法驗證帳密');
    return { kind: 'unavailable' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, env.PORTAL_TIMEOUT_MS));
  try {
    /** @type {Response} */
    let res;
    try {
      res = await fetch(env.PORTAL_AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Key': env.PORTAL_API_KEY },
        body: JSON.stringify({ Account: account, Password: password }),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (err) {
      // 不印出例外物件（可能含請求內容），只記錄類型
      const reason = err instanceof Error && err.name === 'AbortError' ? '逾時' : '網路錯誤';
      console.error(`[portal] 驗證服務呼叫失敗：${reason}`);
      return { kind: 'unavailable' };
    }

    /** @type {unknown} */
    let body;
    try {
      body = await res.json();
    } catch {
      console.error(`[portal] 驗證服務回應非 JSON（HTTP ${res.status}）`);
      return { kind: 'unavailable' };
    }

    if (res.status !== 200) {
      console.error(`[portal] 驗證服務回應異常（HTTP ${res.status}，Code=${safeCode(body)}）`);
      return { kind: 'unavailable' };
    }

    const parsed = portalResponseSchema.safeParse(body);
    if (!parsed.success) {
      console.error(`[portal] 驗證服務回應格式不符（HTTP ${res.status}，Code=${safeCode(body)}）`);
      return { kind: 'unavailable' };
    }

    const data = parsed.data;
    if (data.Ok === true) {
      const displayName = (data.DisplayName ?? '').trim().slice(0, 100);
      return { kind: 'ok', displayName };
    }
    // HTTP 200 且 Ok false（含 Code === INVALID_CREDENTIALS）一律視為帳密錯誤
    if (data.Code !== INVALID_CREDENTIALS_CODE && data.Code) {
      // 非預期代碼仍視為帳密錯誤（契約：Ok false 且 HTTP 200 = 帳密錯誤），但留下紀錄以便追查
      console.warn(`[portal] 驗證失敗代碼：${safeCode(body)}`);
    }
    return { kind: 'invalid' };
  } finally {
    clearTimeout(timer);
  }
}
