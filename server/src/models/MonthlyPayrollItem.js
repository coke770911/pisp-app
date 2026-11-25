// @ts-check
/**
 * 逐筆疊加項目（基準 Step 0 以外的薪資來源，依 sort_order 為 Step 1..N）。
 */
import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

/**
 * @typedef {Object} PayrollItemAttributes
 * @property {number} id
 * @property {number} payroll_id   FK → MonthlyPayroll
 * @property {string} source_name  薪資來源
 * @property {number} amount
 * @property {number} sort_order   1, 2, 3…
 */

/** @typedef {Omit<PayrollItemAttributes, 'id'> & { id?: number }} PayrollItemCreationAttributes */
/** @typedef {import('sequelize').Model<PayrollItemAttributes, PayrollItemCreationAttributes>} PayrollItemInstance */

/** @type {import('sequelize').ModelStatic<PayrollItemInstance>} */
export const MonthlyPayrollItem = sequelize.define(
  'MonthlyPayrollItem',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    payroll_id: { type: DataTypes.INTEGER, allowNull: false },
    source_name: { type: DataTypes.STRING(50), allowNull: false },
    amount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    sort_order: { type: DataTypes.INTEGER, allowNull: false },
  },
  {
    tableName: 'monthly_payroll_items',
    indexes: [{ name: 'ix_monthly_payroll_items_payroll', fields: ['payroll_id'] }],
  },
);
