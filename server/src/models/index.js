// @ts-check
/**
 * 模型集中匯出並建立關聯。
 */
import { DataTypes } from 'sequelize';
import { z } from 'zod';
import { sequelize } from '../config/database.js';
import { InsuranceBracket } from './InsuranceBracket.js';
import {
  LEGACY_PAYROLL_EMP_INDEX_NAME,
  MonthlyPayroll,
  PAYROLL_IDNO_INDEX,
  PAYROLL_STATUS,
  normalizeIdNumber,
} from './MonthlyPayroll.js';
import { MonthlyPayrollItem } from './MonthlyPayrollItem.js';
import { SystemUser, USER_ROLES, normalizeAccount } from './SystemUser.js';
import { env } from '../config/env.js';

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
 * system_users 補上 token_version 欄位（JWT 撤銷用）。只用 QueryInterface API。
 * @returns {Promise<void>}
 */
async function migrateAddTokenVersion() {
  const qi = sequelize.getQueryInterface();
  const tableName = SystemUser.getTableName();
  const columns = await qi.describeTable(tableName);
  if ('token_version' in columns) return;
  await qi.addColumn(tableName, 'token_version', {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  });
  console.log('[db] 已為 system_users 新增 token_version 欄位');
}

/** showIndex 回傳結構（各方言皆有 name；其他欄位不使用） */
const indexListSchema = z.array(z.object({ name: z.string() }).loose());

/** @typedef {ReturnType<typeof MonthlyPayroll.getTableName>} TableName */

/**
 * 讀取資料表現有索引名稱。
 * @param {TableName} tableName
 * @returns {Promise<Set<string>>}
 */
async function listIndexNames(tableName) {
  const raw = await sequelize.getQueryInterface().showIndex(tableName);
  return new Set(indexListSchema.parse(raw).map((i) => i.name));
}

/**
 * 既有資料的身分證號 trim + 大寫寫回（只更新有變化的列）。
 * @returns {Promise<number>} 更新筆數
 */
async function normalizeExistingIdNumbers() {
  return sequelize.transaction(async (t) => {
    const rows = await MonthlyPayroll.findAll({ attributes: ['id', 'id_number'], transaction: t });
    let changed = 0;
    for (const row of rows) {
      const p = row.get({ plain: true });
      const current = typeof p.id_number === 'string' ? p.id_number : '';
      const normalized = normalizeIdNumber(current);
      if (normalized === p.id_number) continue;
      await MonthlyPayroll.update({ id_number: normalized }, { where: { id: p.id }, transaction: t });
      changed += 1;
    }
    return changed;
  });
}

/**
 * @typedef {Object} IdNumberConflict
 * @property {number} roc_year
 * @property {number} month
 * @property {number} duplicateRows  身分證號與同月他人重複的筆數
 * @property {number} blankRows      身分證號空白的筆數
 */

/**
 * 檢查同月是否有重複或空白身分證號（結果只含年月與筆數，不含身分證號本身）。
 * @returns {Promise<IdNumberConflict[]>}
 */
async function findIdNumberConflicts() {
  const rows = await MonthlyPayroll.findAll({ attributes: ['roc_year', 'month', 'id_number'] });
  /** @type {Map<string, { roc_year: number, month: number, counts: Map<string, number>, blank: number }>} */
  const byMonth = new Map();
  for (const row of rows) {
    const p = row.get({ plain: true });
    const key = `${p.roc_year}-${p.month}`;
    const g = byMonth.get(key) ?? { roc_year: p.roc_year, month: p.month, counts: new Map(), blank: 0 };
    byMonth.set(key, g);
    const idNo = typeof p.id_number === 'string' ? p.id_number : '';
    if (idNo === '') {
      g.blank += 1;
      continue;
    }
    g.counts.set(idNo, (g.counts.get(idNo) ?? 0) + 1);
  }
  /** @type {IdNumberConflict[]} */
  const conflicts = [];
  for (const g of byMonth.values()) {
    let duplicateRows = 0;
    for (const n of g.counts.values()) if (n > 1) duplicateRows += n;
    if (duplicateRows > 0 || g.blank > 0) {
      conflicts.push({ roc_year: g.roc_year, month: g.month, duplicateRows, blankRows: g.blank });
    }
  }
  return conflicts.sort((a, b) => a.roc_year - b.roc_year || a.month - b.month);
}

/**
 * 人員識別鍵改為身分證號的遷移：
 *  1. 移除舊的職員編號唯一索引 uq_monthly_payrolls_year_month_emp
 *  2. 既有資料身分證號 trim + 大寫
 *  3. 檢查同月重複／空白身分證號：有衝突只警告並略過建索引（伺服器照常啟動）；
 *     無衝突且索引不存在 → 建立 uq_monthly_payrolls_year_month_idno
 * 全新資料庫同樣走此流程（sync 不會建立此索引，見 MonthlyPayroll.js 說明）。
 * 只使用 QueryInterface / ORM，不寫 Raw SQL。
 * @returns {Promise<void>}
 */
async function migrateIdNumberKey() {
  const qi = sequelize.getQueryInterface();
  const tableName = MonthlyPayroll.getTableName();

  let indexNames = await listIndexNames(tableName);
  if (indexNames.has(LEGACY_PAYROLL_EMP_INDEX_NAME)) {
    await qi.removeIndex(tableName, LEGACY_PAYROLL_EMP_INDEX_NAME);
    console.log(`[db] 已移除舊索引 ${LEGACY_PAYROLL_EMP_INDEX_NAME}（人員識別鍵改為身分證號）`);
    indexNames = await listIndexNames(tableName);
  }

  const changed = await normalizeExistingIdNumbers();
  if (changed > 0) console.log(`[db] 已將 ${changed} 筆身分證號正規化（去除空白、轉大寫）`);

  const conflicts = await findIdNumberConflicts();
  if (conflicts.length > 0) {
    // 只列年月與筆數，不印出身分證號或姓名
    const detail = conflicts
      .map((c) => `${c.roc_year} 年 ${String(c.month).padStart(2, '0')} 月（重複 ${c.duplicateRows} 筆、空白 ${c.blankRows} 筆）`)
      .join('；');
    console.warn(
      `[db] 警告：下列月份有重複或空白的身分證號，暫不建立唯一索引 ${PAYROLL_IDNO_INDEX.name}：${detail}。請修正資料後重新啟動。`,
    );
    return;
  }

  if (!indexNames.has(PAYROLL_IDNO_INDEX.name)) {
    await qi.addIndex(tableName, {
      name: PAYROLL_IDNO_INDEX.name,
      unique: true,
      fields: [...PAYROLL_IDNO_INDEX.fields],
    });
    console.log(`[db] 已建立唯一索引 ${PAYROLL_IDNO_INDEX.name}`);
  }
}

/**
 * 依 BOOTSTRAP_ADMINS 確保這些帳號存在且為啟用中的管理者
 * （不存在則建立；已存在則升級為 admin 並啟用）。
 * @param {readonly string[]} accounts  已正規化（trim + 小寫）的帳號
 * @returns {Promise<void>}
 */
async function ensureBootstrapAdmins(accounts) {
  for (const raw of accounts) {
    const account = normalizeAccount(raw);
    if (account === '' || account.length > 50) {
      console.warn('[db] BOOTSTRAP_ADMINS 含有無效帳號（空白或超過 50 字），已略過');
      continue;
    }
    await sequelize.transaction(async (t) => {
      const existing = await SystemUser.findOne({ where: { account }, transaction: t });
      if (!existing) {
        await SystemUser.create({ account, role: 'admin', is_active: true, created_by: null }, { transaction: t });
        console.log(`[db] 已建立管理者帳號 ${account}（BOOTSTRAP_ADMINS）`);
        return;
      }
      const cur = existing.get({ plain: true });
      if (cur.role !== 'admin' || !cur.is_active) {
        await existing.update({ role: 'admin', is_active: true }, { transaction: t });
        console.log(`[db] 已將帳號 ${account} 設為啟用中的管理者（BOOTSTRAP_ADMINS）`);
      }
    });
  }
}

/**
 * 依模型定義建立資料表（不做 alter，避免意外變更既有結構），再執行必要的欄位遷移，
 * 最後確保啟動管理者帳號存在。
 * @returns {Promise<void>}
 */
export async function initDatabase() {
  await sequelize.authenticate();
  await sequelize.sync();
  await migrateAddPensionRate();
  await migrateIdNumberKey();
  await migrateAddTokenVersion();
  await ensureBootstrapAdmins(env.BOOTSTRAP_ADMINS);
}

export {
  sequelize,
  InsuranceBracket,
  MonthlyPayroll,
  MonthlyPayrollItem,
  SystemUser,
  PAYROLL_STATUS,
  USER_ROLES,
  normalizeIdNumber,
  normalizeAccount,
};
