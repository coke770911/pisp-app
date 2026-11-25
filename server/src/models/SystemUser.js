// @ts-check
/**
 * 系統帳號（白名單）：只有存在且啟用中的帳號能登入本系統。
 * 帳密本身由校內 portal API 驗證，本表不存密碼。
 */
import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

/** 角色值（以字串儲存，不使用 ENUM） */
export const USER_ROLES = /** @type {const} */ (['admin', 'user']);

/** @typedef {(typeof USER_ROLES)[number]} UserRole */

/**
 * @typedef {Object} SystemUserAttributes
 * @property {number} id
 * @property {string} account              校內帳號（trim + 小寫）
 * @property {string | null} display_name  顯示名稱（登入成功時以 portal DisplayName 更新）
 * @property {string} role                 'admin' | 'user'
 * @property {boolean} is_active           是否啟用
 * @property {string | null} created_by    建立者帳號（啟動自動建立時為 null）
 * @property {Date | null} last_login_at   最後登入時間
 * @property {Date} [createdAt]
 * @property {Date} [updatedAt]
 */

/**
 * @typedef {Object} SystemUserCreationAttributes
 * @property {number} [id]
 * @property {string} account
 * @property {string | null} [display_name]
 * @property {string} role
 * @property {boolean} [is_active]
 * @property {string | null} [created_by]
 * @property {Date | null} [last_login_at]
 */

/** @typedef {import('sequelize').Model<SystemUserAttributes, SystemUserCreationAttributes>} SystemUserInstance */

/**
 * 帳號正規化：trim + 小寫。
 * @param {string} account
 * @returns {string}
 */
export function normalizeAccount(account) {
  return account.trim().toLowerCase();
}

/** @type {import('sequelize').ModelStatic<SystemUserInstance>} */
export const SystemUser = sequelize.define(
  'SystemUser',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    account: {
      type: DataTypes.STRING(50),
      allowNull: false,
      // 儲存前一律 trim + 小寫
      set(value) {
        this.setDataValue('account', typeof value === 'string' ? normalizeAccount(value) : '');
      },
    },
    display_name: { type: DataTypes.STRING(100), allowNull: true, defaultValue: null },
    role: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'user' },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_by: { type: DataTypes.STRING(50), allowNull: true, defaultValue: null },
    last_login_at: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
  },
  {
    tableName: 'system_users',
    indexes: [{ name: 'uq_system_users_account', unique: true, fields: ['account'] }],
  },
);
