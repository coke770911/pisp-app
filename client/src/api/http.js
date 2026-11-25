// @ts-check
/**
 * fetch 封裝：統一錯誤格式、全域 401 處理、檔案下載。
 * 錯誤訊息只取後端 `{ message }`，不顯示任何例外內容。
 */
import { ErrorBodySchema } from './schemas.js';

/** 網路錯誤或無法解析回應時的統一訊息 */
export const SERVICE_UNAVAILABLE_MESSAGE = '服務暫時無法使用';

/** API 錯誤（status = 0 表示網路錯誤） */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    /** @type {number} */
    this.status = status;
  }
}

/**
 * @typedef {Object} RequestOptions
 * @property {'GET' | 'POST' | 'PUT' | 'DELETE'} [method]
 * @property {unknown} [json]           以 JSON 送出的 body
 * @property {FormData} [formData]      以 multipart 送出的 body
 * @property {boolean} [skipAuthRedirect] true = 401 不觸發全域「登入逾時」處理（登入、身分檢查用）
 */

/** @type {(() => void) | null} */
let unauthorizedHandler = null;

/**
 * 設定全域 401 處理函式（main.js 註冊）。
 * @param {() => void} handler
 * @returns {void}
 */
export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler;
}

/**
 * 從錯誤回應取出後端訊息；無法解析時回預設訊息。
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function readErrorMessage(res) {
  try {
    const body = /** @type {unknown} */ (await res.json());
    const parsed = ErrorBodySchema.safeParse(body);
    if (parsed.success && parsed.data.message) return parsed.data.message;
  } catch {
    // 回應不是 JSON，使用預設訊息
  }
  return res.status === 401 ? '登入逾時，請重新登入' : SERVICE_UNAVAILABLE_MESSAGE;
}

/**
 * 送出請求並回傳 Response（非 2xx 時拋出 ApiError）。
 * @param {string} path
 * @param {RequestOptions} [options]
 * @returns {Promise<Response>}
 */
async function send(path, options = {}) {
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/json' };
  /** @type {BodyInit | undefined} */
  let body;
  if (options.formData) {
    body = options.formData;
  } else if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  }

  /** @type {Response} */
  let res;
  try {
    res = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, SERVICE_UNAVAILABLE_MESSAGE);
  }

  if (!res.ok) {
    const message = await readErrorMessage(res);
    if (res.status === 401 && options.skipAuthRedirect !== true && unauthorizedHandler) {
      unauthorizedHandler();
    }
    throw new ApiError(res.status, message);
  }
  return res;
}

/**
 * 送出 JSON 請求並以 schema 驗證回應。
 * @template T
 * @param {string} path
 * @param {{ parse: (data: unknown) => T }} schema
 * @param {RequestOptions} [options]
 * @returns {Promise<T>}
 */
export async function requestJson(path, schema, options = {}) {
  const res = await send(path, options);
  /** @type {unknown} */
  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(res.status, SERVICE_UNAVAILABLE_MESSAGE);
  }
  try {
    return schema.parse(data);
  } catch (err) {
    console.error('API 回應格式不符', path, err);
    throw new ApiError(res.status, '伺服器回應格式不正確');
  }
}

/**
 * 從 Content-Disposition 解析檔名（優先 filename*=UTF-8''，其次 filename=）。
 * @param {string | null} header
 * @param {string} fallback
 * @returns {string}
 */
export function parseFilename(header, fallback) {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // 編碼異常時改用一般 filename
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : fallback;
}

/**
 * 以 fetch blob 下載檔案並觸發瀏覽器存檔。
 * @param {string} path
 * @param {string} fallbackName 無法從標頭取得檔名時使用
 * @returns {Promise<string>} 實際檔名
 */
export async function downloadFile(path, fallbackName) {
  const res = await send(path);
  /** @type {Blob} */
  let blob;
  try {
    blob = await res.blob();
  } catch {
    throw new ApiError(0, SERVICE_UNAVAILABLE_MESSAGE);
  }
  const filename = parseFilename(res.headers.get('Content-Disposition'), fallbackName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

/**
 * 將未知錯誤轉為可顯示的訊息（不顯示例外內容）。
 * @param {unknown} err
 * @returns {string}
 */
export function errorMessage(err) {
  if (err instanceof ApiError) return err.message;
  console.error(err);
  return SERVICE_UNAVAILABLE_MESSAGE;
}
