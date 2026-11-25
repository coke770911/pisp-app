// @ts-check
/**
 * 月度人員投保主檔。
 */
import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

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
 * @property {number} base_salary
 * @property {number} pension_rate    勞退自提率（%，0~6）
 * @property {string} status          draft / confirmed
 * @property {number} source_order    Excel 中首次出現順序
 */

/** @typedef {Omit<PayrollAttributes, 'id'> & { id?: number }} PayrollCreationAttributes */
/** @typedef {import('sequelize').Model<PayrollAttributes, PayrollCreationAttributes>} PayrollInstance */

/** @type {import('sequelize').ModelStatic<PayrollInstance>} */
export const MonthlyPayroll = sequelize.define(
  'MonthlyPayroll',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    roc_year: { type: DataTypes.INTEGER, allowNull: false },
    month: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 12 } },
    employee_no: { type: DataTypes.STRING(20), allowNull: false },
    name: { type: DataTypes.STRING(50), allowNull: false, defaultValue: '' },
    id_number: { type: DataTypes.STRING(20), allowNull: false, defaultValue: '' },
    birthday: { type: DataTypes.STRING(20), allowNull: false, defaultValue: '' },
    insurance_type: { type: DataTypes.STRING(10), allowNull: false },
    base_salary: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // 勞退自提率（%，0~6；未填為 0）
    pension_rate: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: PAYROLL_STATUS.DRAFT },
    source_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: 'monthly_payrolls',
    indexes: [{ name: 'uq_monthly_payrolls_year_month_emp', unique: true, fields: ['roc_year', 'month', 'employee_no'] }],
  },
);
