// @ts-check
/**
 * 後端 API 呼叫（端點定義見 docs/CONTRACT.md）。
 */
import { requestJson, downloadFile } from './http.js';
import {
  UserSchema,
  CaptchaSchema,
  SystemUserSchema,
  SystemUserListSchema,
  BracketListSchema,
  YearListSchema,
  BracketImportResultSchema,
  MonthDataSchema,
  PayrollImportResultSchema,
  PayrollSchema,
  StatusResultSchema,
  BracketSchema,
  BracketYearDeleteResultSchema,
  PayrollMonthDeleteResultSchema,
  OkResultSchema,
  CopyResultSchema,
} from './schemas.js';
import { pad2 } from '../utils/format.js';

const OkSchema = OkResultSchema;
/** @typedef {import('./schemas.js').BracketYearDeleteResult} BracketYearDeleteResult */
/** @typedef {import('./schemas.js').CopyResult} CopyResult */
/** @typedef {import('./schemas.js').PayrollMonthDeleteResult} PayrollMonthDeleteResult */

/** @typedef {import('./schemas.js').User} User */
/** @typedef {import('./schemas.js').Role} Role */
/** @typedef {import('./schemas.js').Captcha} Captcha */
/** @typedef {import('./schemas.js').SystemUser} SystemUser */
/** @typedef {import('./schemas.js').BracketRow} BracketRow */
/** @typedef {import('./schemas.js').MonthData} MonthData */
/** @typedef {import('./schemas.js').Payroll} Payroll */
/** @typedef {import('./schemas.js').PayrollImportResult} PayrollImportResult */
/** @typedef {import('./schemas.js').BracketImportResult} BracketImportResult */
/** @typedef {import('./schemas.js').StatusResult} StatusResult */
/** @typedef {import('./schemas.js').InsuranceType} InsuranceType */

/**
 * PUT /api/payrolls/:id 的 body。
 * 身分證號為人員識別鍵、不可修改，故不放入；職員編號可修改（同月與他人重複回 409）。
 * @typedef {Object} PayrollUpdateBody
 * @property {string} employee_no 職員編號（必填，≤ 20）
 * @property {string} name
 * @property {string} birthday
 * @property {string} base_source_name 基準（Step 0）薪資來源名稱（1~50 字）
 * @property {number} base_salary 基準薪資（第一個薪資來源金額，整數 ≥ 0）
 * @property {InsuranceType} insurance_type
 * @property {number} pension_rate 勞退自提率（%，0~6）
 * @property {{ source_name: string, amount: number }[]} items 順序即 sort_order
 */

/**
 * POST /api/payrolls 的人員資料（年月另傳）：PUT 欄位 + 身分證號（識別鍵，trim + 大寫）。
 * @typedef {PayrollUpdateBody & { id_number: string }} PayrollCreateBody
 */

/* ---------- 認證 ---------- */

/**
 * 登入 body（校內帳號密碼 + 驗證碼）。
 * @typedef {Object} LoginBody
 * @property {string} account
 * @property {string} password
 * @property {string} captchaId
 * @property {string} captchaCode 4 位數字
 */

/**
 * 取得新驗證碼（不觸發全域登入逾時處理）。
 * @returns {Promise<Captcha>}
 */
export function fetchCaptcha() {
  return requestJson('/api/auth/captcha', CaptchaSchema, { skipAuthRedirect: true });
}

/**
 * 登入（401 不觸發全域登入逾時處理）。
 * @param {LoginBody} body
 * @returns {Promise<User>}
 */
export function login(body) {
  return requestJson('/api/auth/login', UserSchema, {
    method: 'POST',
    json: body,
    skipAuthRedirect: true,
  });
}

/** @returns {Promise<void>} */
export async function logout() {
  await requestJson('/api/auth/logout', OkSchema, { method: 'POST', skipAuthRedirect: true });
}

/**
 * 取得目前登入者（401 由路由守衛處理，不觸發全域處理）。
 * @returns {Promise<User>}
 */
export function fetchMe() {
  return requestJson('/api/auth/me', UserSchema, { skipAuthRedirect: true });
}

/* ---------- 系統帳號（admin） ---------- */

/** @returns {Promise<SystemUser[]>} */
export function fetchUsers() {
  return requestJson('/api/users', SystemUserListSchema);
}

/**
 * 新增系統帳號（已存在回 409）。
 * @param {string} account
 * @param {Role} role
 * @returns {Promise<SystemUser>}
 */
export function createUser(account, role) {
  return requestJson('/api/users', SystemUserSchema, { method: 'POST', json: { account, role } });
}

/**
 * 修改角色或啟用狀態。
 * @param {number} id
 * @param {{ role?: Role, is_active?: boolean }} body
 * @returns {Promise<SystemUser>}
 */
export function updateUser(id, body) {
  return requestJson(`/api/users/${id}`, SystemUserSchema, { method: 'PUT', json: body });
}

/**
 * 刪除系統帳號。
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deleteUser(id) {
  await requestJson(`/api/users/${id}`, OkResultSchema, { method: 'DELETE' });
}

/* ---------- 級距 ---------- */

/** @returns {Promise<number[]>} */
export function fetchBracketYears() {
  return requestJson('/api/brackets/years', YearListSchema);
}

/**
 * @param {number} year 民國年
 * @returns {Promise<BracketRow[]>}
 */
export function fetchBrackets(year) {
  return requestJson(`/api/brackets?year=${encodeURIComponent(String(year))}`, BracketListSchema);
}

/**
 * @param {number} year
 * @param {File} file
 * @returns {Promise<BracketImportResult>}
 */
export function importBrackets(year, file) {
  const fd = new FormData();
  fd.append('year', String(year));
  fd.append('file', file);
  return requestJson('/api/brackets/import', BracketImportResultSchema, { method: 'POST', formData: fd });
}

/**
 * 單列級距的可編輯欄位（皆非負整數）
 * @typedef {Object} BracketFields
 * @property {number} salary_limit
 * @property {number} labor_emp
 * @property {number} labor_school
 * @property {number} labor_occupational
 * @property {number} pension_school
 * @property {number} health_emp
 * @property {number} health_school
 */

/**
 * 刪除整個年度級距。
 * @param {number} year
 * @returns {Promise<BracketYearDeleteResult>}
 */
export function deleteBracketYear(year) {
  return requestJson(`/api/brackets?year=${encodeURIComponent(String(year))}`, BracketYearDeleteResultSchema, {
    method: 'DELETE',
  });
}

/**
 * 新增單列級距。
 * @param {number} year
 * @param {BracketFields} fields
 * @returns {Promise<BracketRow>}
 */
export function createBracket(year, fields) {
  return requestJson('/api/brackets', BracketSchema, { method: 'POST', json: { roc_year: year, ...fields } });
}

/**
 * 修改單列級距（roc_year 不可改）。
 * @param {number} id
 * @param {BracketFields} fields
 * @returns {Promise<BracketRow>}
 */
export function updateBracket(id, fields) {
  return requestJson(`/api/brackets/${id}`, BracketSchema, { method: 'PUT', json: fields });
}

/**
 * 刪除單列級距。
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deleteBracket(id) {
  await requestJson(`/api/brackets/${id}`, OkResultSchema, { method: 'DELETE' });
}

/**
 * 複製整年度級距。
 * @param {number} fromYear
 * @param {number} toYear
 * @returns {Promise<BracketImportResult>}
 */
export function copyBrackets(fromYear, toYear) {
  return requestJson('/api/brackets/copy', BracketImportResultSchema, { method: 'POST', json: { fromYear, toYear } });
}

/**
 * 下載年度級距表 xlsx。
 * @param {number} year
 * @returns {Promise<string>} 檔名
 */
export function downloadBracketExport(year) {
  return downloadFile(`/api/brackets/export?year=${encodeURIComponent(String(year))}`, `勞健保級距表_${year}年.xlsx`);
}

/* ---------- 月度薪資 ---------- */

/**
 * @param {number} year
 * @param {number} month
 * @returns {Promise<MonthData>}
 */
export function fetchPayrolls(year, month) {
  return requestJson(`/api/payrolls?year=${year}&month=${month}`, MonthDataSchema);
}

/**
 * @param {number} year
 * @param {number} month
 * @param {File} file
 * @returns {Promise<PayrollImportResult>}
 */
export function importPayrolls(year, month, file) {
  const fd = new FormData();
  fd.append('year', String(year));
  fd.append('month', String(month));
  fd.append('file', file);
  return requestJson('/api/payrolls/import', PayrollImportResultSchema, { method: 'POST', formData: fd });
}

/**
 * @param {number} id
 * @param {PayrollUpdateBody} body
 * @returns {Promise<Payroll>}
 */
export function updatePayroll(id, body) {
  return requestJson(`/api/payrolls/${id}`, PayrollSchema, { method: 'PUT', json: body });
}

/**
 * 新增單一人員（同月身分證號或職員編號重複回 409）。
 * @param {number} year
 * @param {number} month
 * @param {PayrollCreateBody} body
 * @returns {Promise<Payroll>}
 */
export function createPayroll(year, month, body) {
  return requestJson('/api/payrolls', PayrollSchema, {
    method: 'POST',
    json: { year, month, ...body },
  });
}

/**
 * 刪除單一人員（含加項）。
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deletePayroll(id) {
  await requestJson(`/api/payrolls/${id}`, OkResultSchema, { method: 'DELETE' });
}

/**
 * 複製來源月份所有人員與加項為目標月份 draft。
 * @param {{ year: number, month: number }} from
 * @param {{ year: number, month: number }} to
 * @param {boolean} overwrite 目標已有 draft 資料時是否覆蓋
 * @returns {Promise<CopyResult>}
 */
export function copyPayrolls(from, to, overwrite) {
  return requestJson('/api/payrolls/copy', CopyResultSchema, {
    method: 'POST',
    json: { fromYear: from.year, fromMonth: from.month, toYear: to.year, toMonth: to.month, overwrite },
  });
}

/**
 * @param {number} year
 * @param {number} month
 * @returns {Promise<StatusResult>}
 */
export function confirmMonth(year, month) {
  return requestJson('/api/payrolls/confirm', StatusResultSchema, { method: 'POST', json: { year, month } });
}

/**
 * @param {number} year
 * @param {number} month
 * @returns {Promise<StatusResult>}
 */
export function reopenMonth(year, month) {
  return requestJson('/api/payrolls/reopen', StatusResultSchema, { method: 'POST', json: { year, month } });
}

/**
 * 刪除整月明細（已確認月份回 409，需先重新開啟）。
 * @param {number} year
 * @param {number} month
 * @returns {Promise<PayrollMonthDeleteResult>}
 */
export function deletePayrollMonth(year, month) {
  return requestJson(
    `/api/payrolls?year=${encodeURIComponent(String(year))}&month=${encodeURIComponent(String(month))}`,
    PayrollMonthDeleteResultSchema,
    { method: 'DELETE' },
  );
}

/**
 * 下載指定月份的 9 欄明細（含勞退自提）。
 * @param {number} year
 * @param {number} month
 * @returns {Promise<string>} 檔名
 */
export function downloadPayrollExport(year, month) {
  return downloadFile(`/api/payrolls/export?year=${year}&month=${month}`, `個人所得明細_${year}年${pad2(month)}月.xlsx`);
}

/**
 * 下載拆帳報表。
 * @param {number} year
 * @param {number} month
 * @returns {Promise<string>} 檔名
 */
export function downloadSplitReport(year, month) {
  return downloadFile(`/api/reports/split?year=${year}&month=${month}`, `拆帳報表_${year}年${pad2(month)}月.xlsx`);
}
