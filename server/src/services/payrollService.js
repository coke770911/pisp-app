// @ts-check
/**
 * 月度投保資料查詢與轉換。
 */
import { Op } from 'sequelize';
import { MonthlyPayroll, MonthlyPayrollItem, PAYROLL_STATUS } from '../models/index.js';
import { baseSourceName, normalizePensionRate } from '../../../shared/splitCalc.js';

/** MSSQL 單一查詢參數上限約 2100，IN 條件分批查詢 */
const IN_CHUNK_SIZE = 1000;

/**
 * @typedef {Object} PayrollItemDto
 * @property {number} id
 * @property {string} source_name
 * @property {number} amount
 * @property {number} sort_order
 */

/**
 * @typedef {Object} PayrollDto
 * @property {number} id
 * @property {number} roc_year
 * @property {number} month
 * @property {string} employee_no
 * @property {string} name
 * @property {string} id_number
 * @property {string} birthday
 * @property {string} insurance_type
 * @property {string} base_source_name  Step 0（基準）薪資來源名稱
 * @property {number} base_salary
 * @property {number} pension_rate  勞退自提率（%，0~6）
 * @property {string} status
 * @property {number} source_order
 * @property {PayrollItemDto[]} items
 */

/** @typedef {'none' | 'draft' | 'confirmed'} MonthStatus */

/**
 * 將陣列切成固定大小的區塊。
 * @template T
 * @param {ReadonlyArray<T>} arr
 * @param {number} size
 * @returns {T[][]}
 */
export function chunk(arr, size) {
  /** @type {T[][]} */
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 依 payroll id 取出所有 items（依 sort_order 排序），回傳 payroll_id → items。
 * @param {ReadonlyArray<number>} payrollIds
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<Map<number, PayrollItemDto[]>>}
 */
async function loadItems(payrollIds, transaction) {
  /** @type {Map<number, PayrollItemDto[]>} */
  const map = new Map();
  for (const ids of chunk(payrollIds, IN_CHUNK_SIZE)) {
    const rows = await MonthlyPayrollItem.findAll({
      where: { payroll_id: { [Op.in]: ids } },
      order: [
        ['payroll_id', 'ASC'],
        ['sort_order', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction,
    });
    for (const row of rows) {
      const it = row.get({ plain: true });
      const list = map.get(it.payroll_id) ?? [];
      list.push({ id: it.id, source_name: it.source_name, amount: it.amount, sort_order: it.sort_order });
      map.set(it.payroll_id, list);
    }
  }
  return map;
}

/**
 * @param {import('../models/MonthlyPayroll.js').PayrollInstance} row
 * @param {PayrollItemDto[]} items
 * @returns {PayrollDto}
 */
function toDto(row, items) {
  const p = row.get({ plain: true });
  return {
    id: p.id,
    roc_year: p.roc_year,
    month: p.month,
    employee_no: p.employee_no,
    name: p.name,
    id_number: p.id_number,
    birthday: p.birthday,
    insurance_type: p.insurance_type,
    // 空白（理論上不會出現）一律回「本薪」
    base_source_name: baseSourceName(p.base_source_name),
    base_salary: p.base_salary,
    // 舊資料或異常值一律正規化為 0~6 整數
    pension_rate: normalizePensionRate(p.pension_rate),
    status: p.status,
    source_order: p.source_order,
    items,
  };
}

/**
 * 取得某月全部人員（依 source_order 排序，含 items）。
 * @param {number} year
 * @param {number} month
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<PayrollDto[]>}
 */
export async function loadMonthPayrolls(year, month, transaction) {
  const rows = await MonthlyPayroll.findAll({
    where: { roc_year: year, month },
    order: [
      ['source_order', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });
  const itemMap = await loadItems(
    rows.map((r) => r.get({ plain: true }).id),
    transaction,
  );
  return rows.map((r) => toDto(r, itemMap.get(r.get({ plain: true }).id) ?? []));
}

/**
 * 取得單一人員（含 items）。
 * @param {number} id
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<PayrollDto | null>}
 */
export async function loadPayrollById(id, transaction) {
  const row = await MonthlyPayroll.findByPk(id, { transaction });
  if (!row) return null;
  const itemMap = await loadItems([id], transaction);
  return toDto(row, itemMap.get(id) ?? []);
}

/**
 * 取得某月狀態：無資料 none；任一筆 confirmed 即視為 confirmed；否則 draft。
 * @param {number} year
 * @param {number} month
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<MonthStatus>}
 */
export async function getMonthStatus(year, month, transaction) {
  const total = await MonthlyPayroll.count({ where: { roc_year: year, month }, transaction });
  if (total === 0) return 'none';
  const confirmed = await MonthlyPayroll.count({
    where: { roc_year: year, month, status: PAYROLL_STATUS.CONFIRMED },
    transaction,
  });
  return confirmed > 0 ? 'confirmed' : 'draft';
}

/**
 * 刪除某月所有資料（先刪 items 再刪主檔，不依賴資料庫層 CASCADE）。
 * @param {number} year
 * @param {number} month
 * @param {import('sequelize').Transaction} transaction
 * @returns {Promise<void>}
 */
export async function deleteMonth(year, month, transaction) {
  const rows = await MonthlyPayroll.findAll({ where: { roc_year: year, month }, attributes: ['id'], transaction });
  const ids = rows.map((r) => r.get({ plain: true }).id);
  for (const part of chunk(ids, IN_CHUNK_SIZE)) {
    await MonthlyPayrollItem.destroy({ where: { payroll_id: { [Op.in]: part } }, transaction });
  }
  await MonthlyPayroll.destroy({ where: { roc_year: year, month }, transaction });
}
