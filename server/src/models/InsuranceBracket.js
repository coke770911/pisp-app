// @ts-check
/**
 * 投保級距表（每年度一份）。
 */
import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

/**
 * @typedef {Object} BracketAttributes
 * @property {number} id
 * @property {number} roc_year            民國年
 * @property {number} salary_limit        月投保金額
 * @property {number} labor_emp           勞保費個人
 * @property {number} labor_school        勞保費學校(不含職災)
 * @property {number} labor_occupational  勞保費學校-職災
 * @property {number} pension_school      勞退金-學校
 * @property {number} health_emp          健保費-個人
 * @property {number} health_school       健保費-學校
 */

/** @typedef {Omit<BracketAttributes, 'id'> & { id?: number }} BracketCreationAttributes */
/** @typedef {import('sequelize').Model<BracketAttributes, BracketCreationAttributes>} BracketInstance */

/** @type {import('sequelize').ModelStatic<BracketInstance>} */
export const InsuranceBracket = sequelize.define(
  'InsuranceBracket',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    roc_year: { type: DataTypes.INTEGER, allowNull: false },
    salary_limit: { type: DataTypes.INTEGER, allowNull: false },
    labor_emp: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    labor_school: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    labor_occupational: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    pension_school: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    health_emp: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    health_school: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: 'insurance_brackets',
    indexes: [{ name: 'uq_insurance_brackets_year_limit', unique: true, fields: ['roc_year', 'salary_limit'] }],
  },
);
