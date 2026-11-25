// @ts-check
/**
 * 模型集中匯出並建立關聯。
 */
import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import { InsuranceBracket } from './InsuranceBracket.js';
import { MonthlyPayroll, PAYROLL_STATUS } from './MonthlyPayroll.js';
import { MonthlyPayrollItem } from './MonthlyPayrollItem.js';

MonthlyPayroll.hasMany(MonthlyPayrollItem, { foreignKey: 'payroll_id', as: 'items', onDelete: 'CASCADE', hooks: true });
MonthlyPayrollItem.belongsTo(MonthlyPayroll, { foreignKey: 'payroll_id', as: 'payroll', onDelete: 'CASCADE' });

/**
 * 既有資料庫遷移：sync() 不會為已存在的資料表新增欄位，
 * 因此以 QueryInterface 檢查 monthly_payrolls 是否缺 pension_rate，缺則補上（舊資料預設 0）。
 * 只使用 Sequelize QueryInterface API，不寫 Raw SQL。
 * @returns {Promise<void>}
 */
async function migrateAddPensionRate() {
  const qi = sequelize.getQueryInterface();
  const tableName = MonthlyPayroll.getTableName();
  const columns = await qi.describeTable(tableName);
  if ('pension_rate' in columns) return;
  await qi.addColumn(tableName, 'pension_rate', {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  });
  console.log('[db] 已為 monthly_payrolls 新增 pension_rate 欄位（既有資料預設 0）');
}

/**
 * 依模型定義建立資料表（不做 alter，避免意外變更既有結構），再執行必要的欄位遷移。
 * @returns {Promise<void>}
 */
export async function initDatabase() {
  await sequelize.authenticate();
  await sequelize.sync();
  await migrateAddPensionRate();
}

export { sequelize, InsuranceBracket, MonthlyPayroll, MonthlyPayrollItem, PAYROLL_STATUS };
