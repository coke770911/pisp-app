// @ts-check
/**
 * 環境變數載入與驗證。
 * 以 dotenv 讀取專案根目錄的 .env（已存在於 process.env 的值優先，不會被覆寫），
 * 再以 zod 驗證並轉成明確型別。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/** server/ 目錄的絕對路徑 */
export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

dotenv.config({ path: path.resolve(SERVER_DIR, '../.env'), quiet: true });

/**
 * 字串布林值（'true' / '1' 視為 true）。
 * @param {boolean} defaultValue
 */
function boolString(defaultValue) {
  return z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? defaultValue : ['true', '1', 'yes'].includes(v.trim().toLowerCase())));
}

/**
 * 正整數字串（空字串視為預設值）。
 * @param {number} defaultValue
 */
function intString(defaultValue) {
  return z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return defaultValue;
      const n = Number(v.trim());
      if (!Number.isInteger(n) || n < 0) {
        ctx.addIssue({ code: 'custom', message: `必須為非負整數：${v}` });
        return z.NEVER;
      }
      return n;
    });
}

/** 一般字串（未設定視為空字串） */
const str = z
  .string()
  .optional()
  .transform((v) => (v ?? '').trim());

const envSchema = z.object({
  PORT: intString(9090),
  DB_DIALECT: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim().toLowerCase() || 'sqlite')
    .pipe(z.union([z.literal('sqlite'), z.literal('mssql')])),
  SQLITE_STORAGE: str.transform((v) => v || 'data/hisp.sqlite'),
  MSSQL_HOST: str,
  MSSQL_PORT: intString(1433),
  MSSQL_DATABASE: str,
  MSSQL_USER: str,
  // 密碼不 trim，保留原值
  MSSQL_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? ''),
  MSSQL_ENCRYPT: boolString(true),
  MSSQL_TRUST_SERVER_CERTIFICATE: boolString(true),
  ADMIN_USERNAME: str,
  ADMIN_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? ''),
  SESSION_TTL_HOURS: intString(8),
  COOKIE_SECURE: boolString(false),
  LOGIN_MIN_DELAY_MS: intString(800),
  LOGIN_RATE_LIMIT: intString(10),
  // 反向代理（IIS/nginx）層數；0 = 不信任 X-Forwarded-For
  TRUST_PROXY: intString(0),
});

/** @typedef {z.infer<typeof envSchema>} AppEnv */

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('[env] 環境變數格式錯誤：');
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

/** @type {Readonly<AppEnv>} */
export const env = Object.freeze(parsed.data);
