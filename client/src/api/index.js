// @ts-check
/**
 * 後端 API 呼叫（端點定義見 docs/CONTRACT.md）。
 */
import { requestJson, downloadFile } from './http.js';
import {
  UserSchema,
  BracketListSchema,
  YearListSchema,
  BracketImportResultSchema,
  MonthDataSchema,
  PayrollImportResultSchema,
  PayrollSchema,
  StatusResultSchema,
  BracketSchema,
  BracketYearDeleteResultSchema,
  OkResultSchema,
  CopyResultSchema,
} from './schemas.js';
import { pad2 } from '../utils/format.js';

const OkSchema = OkResultSchema;
/** @typedef {import('./schemas.js').BracketYearDeleteResult} BracketYearDeleteResult */
/** @typedef {import('./schemas.js').CopyResult} CopyResult */

/** @typedef {import('./schemas.js').User} User */
/** @typedef {import('./schemas.js').BracketRow} BracketRow */
/** @typedef {import('./schemas.js').MonthData} MonthData */
/** @typedef {import('./schemas.js').Payroll} Payroll */
/** @typedef {import('./schemas.js').PayrollImportResult} PayrollImportResult */
/** @typedef {import('./schemas.js').BracketImportResult} BracketImportResult */
/** @typedef {import('./schemas.js').StatusResult} StatusResult */
/** @typedef {import('./schemas.js').InsuranceType} InsuranceType */

/**
 * @typedef {Object} PayrollUpdateBody
 * @property {string} name
 * @property {string} id_number
 * @property {string} birthday
 * @property {number} base_salary
 * @property {InsuranceType} insurance_type
 * @property {number} pension_rate 勞退自提率（%，0~6）
 * @property {{ source_name: string, amount: number }[]} items 順序即 sort_order
 */

/* ---------- 認證 ---------- */

/**
 * 登入（401 不觸發全域登入逾時處理）。
 * @param {string} username
 * @param {string} password
 * @returns {Promise<User>}
 */
export function login(username, password) {
  return requestJson('/api/auth/login', UserSchema, {
    method: 'POST',
    json: { username, password },
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
 * 新增單一人員。
 * @param {number} year
 * @param {number} month
 * @param {string} employeeNo
 * @param {PayrollUpdateBody} body
 * @returns {Promise<Payroll>}
 */
export function createPayroll(year, month, employeeNo, body) {
  return requestJson('/api/payrolls', PayrollSchema, {
    method: 'POST',
    json: { year, month, employee_no: employeeNo, ...body },
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
