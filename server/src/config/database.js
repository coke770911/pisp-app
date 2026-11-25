// @ts-check
/**
 * Sequelize 連線設定：依 DB_DIALECT 切換 sqlite / mssql。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Sequelize } from 'sequelize';
import { env, SERVER_DIR } from './env.js';

/**
 * 建立 Sequelize 實例。
 * @returns {Sequelize}
 */
function createSequelize() {
  if (env.DB_DIALECT === 'mssql') {
    return new Sequelize(env.MSSQL_DATABASE, env.MSSQL_USER, env.MSSQL_PASSWORD, {
      dialect: 'mssql',
      host: env.MSSQL_HOST,
      port: env.MSSQL_PORT,
      logging: false,
      dialectOptions: {
        options: {
          encrypt: env.MSSQL_ENCRYPT,
          trustServerCertificate: env.MSSQL_TRUST_SERVER_CERTIFICATE,
        },
      },
    });
  }

  // SQLite：路徑相對於 server/，自動建立所在目錄
  /** @type {string} */
  const storage = path.resolve(SERVER_DIR, env.SQLITE_STORAGE);
  fs.mkdirSync(path.dirname(storage), { recursive: true });
  return new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
  });
}

/** @type {Sequelize} */
export const sequelize = createSequelize();
