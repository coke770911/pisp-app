// @ts-check
/**
 * 月度人員投保主檔。
 */
import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import { DEFAULT_BASE_SOURCE_NAME } from '../../../shared/splitCalc.js';

/** 月份狀態（以 STRING(20) 儲存，不使用 ENUM） */
export const PAYROLL_STATUS = Object.freeze({
  DRAFT: 'draft',
  CONFIRMED: 'confirmed',
});

/** @typedef {'draft' | 'confirmed'} PayrollStatus */
/** @typedef {'勞健' | '公健'} InsuranceType */

/**
 * @typedef {Object} PayrollAttributes
 * @property {number} id
 * @property {number} roc_year
 * @property {number} month
 * @property {string} employee_no
 * @property {string} name
 * @property {string} id_number
 * @property {string} birthday        原樣保存（例：民國 0750101）
 * @property {string} insurance_type  勞健 / 公健
 * @property {string} base_source_name  Step 0（基準）的薪資來源名稱（每人第一筆來源；舊資料為「本薪」）
 * @property {number} base_salary       Step 0（基準）的薪資金額
 * @property {number} pension_rate    勞退自提率（%，0~6）
 * @property {string} status          draft / confirmed
 * @property {number} source_order    Excel 中首次出現順序
 */

/** @typedef {Omit<PayrollAttributes, 'id'> & { id?: number }} PayrollCreationAttributes */
/** @typedef {import('sequelize').Model<PayrollAttributes, PayrollCreationAttributes>} PayrollInstance */

/**
 * 人員識別鍵 = 身分證號：同年月內 (roc_year, month, id_number) 唯一。
 * 注意：此索引刻意「不」放在 define() 的 indexes 內，改由 models/index.js 的遷移建立。
 * 原因：sync() 會自動補建模型宣告但資料表缺少的索引；若既有資料庫同月有重複／空白身分證號，
 * 建索引會失敗而導致伺服器無法啟動。由遷移先檢查衝突，有衝突時只警告並略過建立。
 */
export const PAYROLL_IDNO_INDEX = Object.freeze({
  name: 'uq_monthly_payrolls_year_month_idno',
  fields: Object.freeze(['roc_year', 'month', 'id_number']),
});

/** 舊版唯一索引（以職員編號識別），遷移時移除 */
export const LEGACY_PAYROLL_EMP_INDEX_NAME = 'uq_monthly_payrolls_year_month_emp';

/**
 * 身分證號正規化：去除前後空白並轉大寫。
 * @param {string} value
 * @returns {string}
 */
export function normalizeIdNumber(value) {
  return value.trim().toUpperCase();
}

/** @type {import('sequelize').ModelStatic<PayrollInstance>} */
export const MonthlyPayroll = sequelize.define(
  'MonthlyPayroll',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    roc_year: { type: DataTypes.INTEGER, allowNull: false },
    month: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 12 } },
    // 職員編號：一般欄位（可修改）；同月不得與他人重複由應用層檢查，非 DB 約束
    employee_no: { type: DataTypes.STRING(20), allowNull: false },
    name: { type: DataTypes.STRING(50), allowNull: false, defaultValue: '' },
    // 身分證號：人員識別鍵（必填、trim + 大寫後儲存，不可修改）
    id_number: { type: DataTypes.STRING(20), allowNull: false },
    birthday: { type: DataTypes.STRING(20), allowNull: false, defaultValue: '' },
    insurance_type: { type: DataTypes.STRING(10), allowNull: false },
    // Step 0（基準）的薪資來源名稱：每人第一筆薪資來源（舊資料遷移時預設「本薪」）
    base_source_name: { type: DataTypes.STRING(50), allowNull: false, defaultValue: DEFAULT_BASE_SOURCE_NAME },
    base_salary: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // 勞退自提率（%，0~6；未填為 0）
    pension_rate: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: PAYROLL_STATUS.DRAFT },
    source_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: 'monthly_payrolls',
    // 唯一索引 PAYROLL_IDNO_INDEX 由遷移建立（見上方說明），此處不宣告
  },
);
